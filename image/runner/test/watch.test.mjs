import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { readWatchMode, assertWatchCompatible, watchToolOptions } from "../src/watch.mjs";

test("optional watch inputs cannot mask the shared job mount readability refusal", () => {
	const source = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const readable = source.indexOf("assertJobInputsReadable([JOB_DIR, GLOBAL_PI_DIR, WORKSPACE]);");
	assert.notEqual(readable, -1, "the shared mount readability gate must remain present");
	for (const call of ["const watchReadOnly = readWatchMode();", "const watchDecisionInput = readWatchDecision();", "const roleInputs = readRoleInputs();"]) assert.ok(source.indexOf(call) > readable, `${call} must follow the common mount gate`);
	assert.ok(source.indexOf("const watchReadOnly = readWatchMode();") < source.indexOf("const modelRuntime = await createJobModelRuntime("), "watch validation remains before runtime construction and spend");
});
test("watch marker absent differs from malformed, symlinked, oversized or unreadable marker", () => {
	assert.equal(readWatchMode({ fs: { lstatSync() { throw Object.assign(new Error(), { code: "ENOENT" }); } } }), false);
	const fs = (raw, { isFile = true, size = raw.length } = {}) => ({ lstatSync: () => ({ isFile: () => isFile, size }), readFileSync: () => raw });
	assert.equal(readWatchMode({ fs: fs('{"version":1,"mode":"investigate"}') }), true);
	for (const raw of ["{}", "null", "[]", "invalid", '{"version":1,"mode":"fix"}', '{"version":1,"mode":"investigate","tools":["bash"]}']) assert.throws(() => readWatchMode({ fs: fs(raw) }));
	assert.throws(() => readWatchMode({ fs: fs("", { isFile: false }) }));
	assert.throws(() => readWatchMode({ fs: fs("", { size: 1025 }) }));
	assert.throws(() => readWatchMode({ fs: { lstatSync() { throw Object.assign(new Error(), { code: "EACCES" }); } } }));
});
test("watch cannot activate command, subprocess, approval, or unreviewed MCP paths", () => {
	assert.doesNotThrow(() => assertWatchCompatible({}));
	for (const cfg of [{ command: "fix" }, { fork: {} }, { recover: true }, { recovering: true }, { awaitInput: true }, { approvalGates: ["push"] }]) assert.throws(() => assertWatchCompatible(cfg));
	assert.throws(() => assertWatchCompatible({}, { roles: {} }));
	assert.throws(() => assertWatchCompatible({}, { mcp: {} }));
	assert.deepEqual(watchToolOptions(["grep"], ["read", "bash", "powershell", "edit", "write", "grep"]), { tools: ["read", "grep", "find", "ls"], excludeTools: ["grep", "bash", "powershell", "edit", "write", "codemode"] });
});
