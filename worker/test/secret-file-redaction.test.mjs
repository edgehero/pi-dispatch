import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedactor, makeOutputRedactor, makeStreamingRedactor, secretFileRedactionValues } from "../src/redact-secrets.mjs";
import { makeLogSink } from "../src/run-history.mjs";
import { signExitLine } from "../../image/runner/src/exit-line.mjs";

const PEM = "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop0123456789\n-----END PRIVATE KEY-----\n";
const values = secretFileRedactionValues({ DEVICE_SSH_KEY: PEM });

test("a file secret's literal, escaped, line and final-newline spellings redact across every pipe split", () => {
	const redact = makeRedactor({ values });
	for (const value of [PEM, PEM.slice(0, -1), PEM.split("\n")[1], JSON.stringify(PEM), encodeURIComponent(PEM), "é🎈" + PEM]) {
		const raw = Buffer.from(`prefix ${value} suffix`);
		for (let at = 0; at <= raw.length; at++) {
			const stream = makeStreamingRedactor({ values });
			const out = stream.write(raw.subarray(0, at)) + stream.write(raw.subarray(at)) + stream.end();
			assert.equal(out, redact(raw.toString("utf8")), `split ${at}`);
		}
	}
});

test("overlapping values cannot be cut when another match moves the emission boundary", () => {
	const values = ["abcdefghijk", "ijkabcdefghijk", "zabcdefghijk"];
	const input = "prefix zabcdefghijkabcdefghijk suffix";
	for (let size = 1; size <= input.length; size++) {
		const stream = makeStreamingRedactor({ values });
		let out = "";
		for (let at = 0; at < input.length; at += size) out += stream.write(input.slice(at, at + size));
		out += stream.end();
		assert.equal(out, makeRedactor({ values })(input));
	}
});

test("captured logs redact file contents while exit authentication parses the original line", async () => {
	const logsDir = tempDir("secret-files-");
	const key = "1".repeat(64);
	const line = signExitLine(JSON.stringify({ event: "exit", code: 0, reason: "completed", turns: 2, extra: PEM }), key) + "\n";
	const sink = makeLogSink({ logsDir, enabled: true })("file-secret", { exitKey: key, captureRedactor: makeStreamingRedactor({ values }) });
	const raw = `${PEM}${line}`;
	for (const chunk of Buffer.from(raw)) sink.write(Buffer.from([chunk]));
	const result = await sink.close();
	assert.equal(result.exitAuth, "verified");
	assert.equal(result.turns, 2);
	const saved = readFileSync(join(logsDir, "file-secret.log"), "utf8");
	assert.ok(saved.includes("[redacted]"));
	assert.ok(!saved.includes("abcdefghijklmnop"));
});


test("ordinary Unicode is not split into separately encoded surrogate halves", () => {
	const stream = makeStreamingRedactor({ values: ["abcdefgh"] });
	const input = "0123456789🎈000000";
	const chunks = [stream.write(input), stream.end()].map((s) => Buffer.from(s));
	assert.equal(Buffer.concat(chunks).toString(), input);
});

test("renewal extends the streaming tail before a longer credential can be printed", () => {
	const registered = ["shortkey"];
	let redact = makeRedactor({ values: registered });
	const stream = makeStreamingRedactor({ values: registered, redact: (s) => redact(s) });
	let out = stream.write("ordinary prelude ");
	registered.push("a-new-credential-longer-than-the-old-one");
	redact = makeRedactor({ values: registered });
	out += stream.write("a-new-credential-longer-");
	out += stream.write("than-the-old-one");
	out += stream.end();
	assert.equal(out, "ordinary prelude [redacted]");
});

test("stderr interleaving cannot break a stdout secret match", () => {
	const stream = makeOutputRedactor({ values: ["abcdefgh"] });
	const out = stream.write("abcd", "stdout") + stream.write("stderr-warning", "stderr") + stream.write("efgh", "stdout") + stream.end();
	assert.ok(out.includes("[redacted]"));
	assert.ok(!out.includes("abcd") && !out.includes("efgh"));
});
