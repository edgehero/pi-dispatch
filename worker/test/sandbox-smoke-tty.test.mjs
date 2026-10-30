import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxSmokeTty, sandboxSmokeTtyRaw, waitSandboxSmokeTty } from "../../.github/scripts/sandbox-smoke-tty.mjs";

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
