import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxSmokeLines, sandboxSmokeTty, sandboxSmokeTtyRaw, sendSandboxSmokeDetach, waitSandboxSmokeTty } from "../../.github/scripts/sandbox-smoke-tty.mjs";

test("Podman detach is two paced terminal keypresses, never a combined two-byte read", async () => {
	const chunks = [];
	let release;
	const boundary = new Promise((resolve) => { release = resolve; });
	const sending = sendSandboxSmokeDetach({ write: (bytes) => chunks.push(Buffer.from(bytes)) }, async (ms) => { assert.equal(ms, 250); await boundary; });
	assert.deepEqual(chunks, [Buffer.from([16])], "the first key is independently available for Podman's one-byte matcher");
	release();
	await sending;
	assert.deepEqual(chunks, [Buffer.from([16]), Buffer.from([17])], "the second key cannot share the first write");
});

test("actual Linux readline controls preserve exact oracle output without mistaking echoed command source for execution", () => {
	const echo = "\u001b[?2004h\u001b]0;pi@container: /workspace\u0007pi@container:/workspace$ node -e 'console.log(\"SANDBOX_CREDE\rNTIALS_CLEAR\")'\r\n";
	assert.equal(sandboxSmokeLines(echo).includes("SANDBOX_CREDENTIALS_CLEAR"), false, "wrapped, echoed source is never an executed result");
	const actual = echo + "\u001b[?2004l\rSANDBOX_CREDENTIALS_CLEAR\r\n\u001b[?2004hpi@container:/workspace$ ";
	assert.equal(sandboxSmokeLines(actual).includes("SANDBOX_CREDENTIALS_CLEAR"), true, "Linux bracketed-paste teardown may appear between newline and result");
	assert.equal(sandboxSmokeLines("\u001b[?2004l\rSANDBOX_CREDENTIAL_KEYS:[\"TOKEN\"]\r\n").some((line) => line.startsWith("SANDBOX_CREDENTIAL_KEYS:")), true);
	assert.equal(sandboxSmokeLines("prefix SANDBOX_CREDENTIALS_CLEAR suffix\r\n").includes("SANDBOX_CREDENTIALS_CLEAR"), false);
	assert.equal(sandboxSmokeLines("SANDBOX_CREDENTIALS_CLEAR").includes("SANDBOX_CREDENTIALS_CLEAR"), false, "a partial chunk is not a complete output line");
});

test("smoke terminal observation accepts native TTY paths but never remote command text", () => {
	assert.equal(sandboxSmokeTty("\r\nSANDBOX_REMOTE_TTY:/dev/pts/17\r\n"), "/dev/pts/17");
	assert.equal(sandboxSmokeTty("SANDBOX_REMOTE_TTY:/dev/ttys003\n"), "/dev/ttys003");
	for (const value of ["/dev/pts/1;id", "/tmp/terminal", "/dev/pts/../file", "/dev/pts/1 $(id)"]) assert.equal(sandboxSmokeTty(`SANDBOX_REMOTE_TTY:${value}\n`), null);
});

test("a live container is not terminal attachment: smoke waits through cooked/partial modes until both flags are raw", async () => {
	const child = { exitCode: null, output: "SANDBOX_REMOTE_TTY:/dev/pts/2\n" };
	const modes = ["isig icanon echo -echoctl", "isig -icanon echo -echoctl", "-isig -icanon -echo -echoctl"];
	let reads = 0;
	const seen = [];
	await waitSandboxSmokeTty({ child, inspect: async (tty) => { assert.equal(tty, "/dev/pts/2"); return modes[reads++]; }, until: async (predicate) => {
		for (let n = 0; n < 3; n++) { const ready = await predicate(); seen.push(ready); if (ready) return true; }
		throw new Error("never attached");
	} });
	assert.deepEqual(seen, [false, false, true]);
	assert.equal(reads, 3);
	assert.equal(sandboxSmokeTtyRaw("icanon -echo -echoctl"), false);
	assert.equal(sandboxSmokeTtyRaw("-icanon echo -echoctl"), false, "-echoctl must not be mistaken for disabled echo");
});

test("an exited terminal or absent TTY marker cannot authorize injected shell input", async () => {
	let inspected = 0;
	const until = (predicate) => predicate();
	assert.equal(await waitSandboxSmokeTty({ child: { exitCode: null, output: "container registered" }, inspect: async () => { inspected++; }, until }), false);
	await assert.rejects(waitSandboxSmokeTty({ child: { exitCode: 2, output: "SANDBOX_REMOTE_TTY:/dev/pts/2\n" }, inspect: async () => { inspected++; }, until }), /exited before its runtime attached/);
	assert.equal(inspected, 0);
});
