import assert from "node:assert/strict";
import { test } from "node:test";
import { readWatchMode, assertWatchCompatible, watchToolOptions } from "../src/watch.mjs";
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
