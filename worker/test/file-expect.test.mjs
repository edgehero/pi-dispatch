import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { join } from "node:path";
import { expectRefusal, fileSnapshot } from "../src/file-expect.mjs";
import { writeTriggers } from "../src/triggers-file.mjs";
import { writeOverlay } from "../src/runtime-settings.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #642: the triggers and settings writers take the console's `expect` (the `{ path, text }` snapshots its preview
// was built from) and re-check it right before the rename. Real files, because the property is about what is on disk.

const CRON = (id) => ({ on: { type: "cron", id, pattern: "0 3 * * *" }, run: { kind: "local", folder: "/tmp", flow: "nightly", task: "t" } });
const triggersText = (list) => `${JSON.stringify({ triggers: list }, null, 2)}\n`;

test("fileSnapshot: text, null for a missing file only, and a marker no file can equal for an unreadable one", () => {
	const dir = tempDir("pd-642-snap-");
	const p = join(dir, "f.json");
	assert.equal(fileSnapshot(realFs, p), null);
	realFs.writeFileSync(p, "x\n");
	assert.equal(fileSnapshot(realFs, p), "x\n");
	assert.equal(fileSnapshot(realFs, dir).startsWith("\u0000unreadable:"), true, "a directory reads as unreadable, never as missing");
	assert.equal(expectRefusal(realFs, null), null, "no expectation refuses nothing");
	assert.equal(expectRefusal(realFs, [{ path: p, text: "x\n" }]), null);
	assert.match(expectRefusal(realFs, [{ path: p, text: "y\n" }]), /changed after this change was built from it .*nothing was written/);
});

test("writeTriggers with expect: a file changed since the preview refuses inside the lock, writes nothing and leaves no tmp", () => {
	const dir = tempDir("pd-642-trig-");
	const path = join(dir, "triggers.json");
	realFs.writeFileSync(path, triggersText([CRON("a")]));
	const expect = [{ path, text: fileSnapshot(realFs, path) }];
	// Another session writes between the preview and the confirm.
	realFs.writeFileSync(path, triggersText([CRON("a"), CRON("b")]));
	const res = writeTriggers({ triggersPath: path, expect, mutate: (list) => [...list, CRON("c")] });
	assert.match(res.invalid, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} changed after this change was built from it \\(another session wrote it\\); nothing was written`));
	assert.equal(realFs.readFileSync(path, "utf8"), triggersText([CRON("a"), CRON("b")]), "the other session's file stands");
	assert.deepEqual(realFs.readdirSync(dir), ["triggers.json"], "no tmp and no lock left behind");
});

test("writeTriggers with a holding expect writes, and without one writes exactly as before", () => {
	const dir = tempDir("pd-642-trig-ok-");
	const path = join(dir, "triggers.json");
	realFs.writeFileSync(path, triggersText([CRON("a")]));
	const ok = writeTriggers({ triggersPath: path, expect: [{ path, text: fileSnapshot(realFs, path) }], mutate: (list) => [...list, CRON("b")] });
	assert.deepEqual(ok, { ok: true });
	assert.equal(realFs.readFileSync(path, "utf8"), triggersText([CRON("a"), CRON("b")]));
	const plain = writeTriggers({ triggersPath: path, mutate: (list) => list.slice(0, 1) });
	assert.deepEqual(plain, { ok: true });
	assert.equal(realFs.readFileSync(path, "utf8"), triggersText([CRON("a")]));
	// A missing file snapshot (null) holds while the file is still missing: an "add the first trigger" preview.
	const fresh = join(dir, "new.json");
	assert.deepEqual(writeTriggers({ triggersPath: fresh, expect: [{ path: fresh, text: null }], mutate: () => [CRON("z")] }), { ok: true });
});

test("writeOverlay with expect: refuses a changed settings file, removes its own tmp, and leaves the file alone", () => {
	const dir = tempDir("pd-642-set-");
	const path = join(dir, "settings.json");
	realFs.writeFileSync(path, `${JSON.stringify({ model: "a" }, null, 2)}\n`);
	const expect = [{ path, text: fileSnapshot(realFs, path) }];
	realFs.writeFileSync(path, `${JSON.stringify({ model: "b" }, null, 2)}\n`);
	const res = writeOverlay(path, { model: "c" }, { expect });
	assert.match(res.invalid, /settings\.json changed after this change was built from it .*nothing was written/);
	assert.equal(JSON.parse(realFs.readFileSync(path, "utf8")).model, "b");
	assert.deepEqual(realFs.readdirSync(dir), ["settings.json"], "the refused write's tmp is gone");
	assert.deepEqual(writeOverlay(path, { model: "c" }, { expect: [{ path, text: fileSnapshot(realFs, path) }] }), { ok: true });
	assert.equal(JSON.parse(realFs.readFileSync(path, "utf8")).model, "c");
});

test("writeOverlay: a stranger's `<file>.tmp` is never taken or overwritten (a tmp of its own, created exclusively)", () => {
	const dir = tempDir("pd-642-set-tmp-");
	const path = join(dir, "settings.json");
	realFs.writeFileSync(`${path}.tmp`, "another writer's bytes\n");
	assert.deepEqual(writeOverlay(path, { model: "m" }), { ok: true });
	assert.equal(realFs.readFileSync(`${path}.tmp`, "utf8"), "another writer's bytes\n");
	assert.deepEqual(realFs.readdirSync(dir).sort(), ["settings.json", "settings.json.tmp"]);
});

test("writeTriggers re-checks expect INSIDE the lock: a writer landing after the lock is taken is still caught, before the rename", () => {
	const dir = tempDir("pd-642-trig-lock-");
	const path = join(dir, "triggers.json");
	realFs.writeFileSync(path, triggersText([CRON("a")]));
	const expect = [{ path, text: fileSnapshot(realFs, path) }];
	const order = [];
	// A real fs that records the critical steps, and lets "another session" write the file the moment this writer's tmp is
	// on disk: after the lock is held and the mutate has read the file, before the rename. A re-check made before the lock
	// (or before the tmp) would have passed and written over that session's change.
	const fs = {
		...realFs,
		openSync: (p, flags, ...rest) => (order.push(p.endsWith(".lock") ? "lock" : `open:${p}`), realFs.openSync(p, flags, ...rest)),
		readFileSync: (p, ...rest) => (order.push(p === path ? "read" : `read:${p}`), realFs.readFileSync(p, ...rest)),
		writeFileSync: (p, data, ...rest) => {
			realFs.writeFileSync(p, data, ...rest);
			if (p.endsWith(".tmp")) {
				order.push("tmp");
				realFs.writeFileSync(path, triggersText([CRON("a"), CRON("other")]));
			}
		},
		renameSync: (a, b) => (order.push("rename"), realFs.renameSync(a, b)),
		unlinkSync: (p) => (order.push(p.endsWith(".lock") ? "unlock" : "unlink-tmp"), realFs.unlinkSync(p)),
	};
	const res = writeTriggers({ triggersPath: path, expect, mutate: (list) => [...list, CRON("mine")], fs });
	assert.match(res.invalid, /changed after this change was built from it/);
	assert.equal(realFs.readFileSync(path, "utf8"), triggersText([CRON("a"), CRON("other")]), "the other session's write stands");
	assert.deepEqual(order, ["lock", "read", "tmp", "read", "unlink-tmp", "unlock"], "lock, mutate's read, tmp, THEN the expect read, under the lock; no rename");
	// Without the interloper the same sequence renames, the re-check still between the tmp and the rename.
	order.length = 0;
	fs.writeFileSync = (p, data, ...rest) => (p.endsWith(".tmp") && order.push("tmp"), realFs.writeFileSync(p, data, ...rest));
	assert.deepEqual(writeTriggers({ triggersPath: path, expect: [{ path, text: fileSnapshot(realFs, path) }], mutate: (list) => [...list, CRON("mine")], fs }), { ok: true });
	assert.deepEqual(order, ["lock", "read", "tmp", "read", "rename", "unlock"]);
});

test("writeOverlay creates its tmp exclusively: a file already at that name is refused and left untouched, never overwritten", () => {
	const dir = tempDir("pd-642-set-wx-");
	const path = join(dir, "settings.json");
	realFs.writeFileSync(path, `${JSON.stringify({ model: "a" }, null, 2)}\n`);
	const random = (n) => Buffer.alloc(n, 0xcd);
	const tmp = `${path}.${process.pid}.${"cd".repeat(6)}.tmp`;
	realFs.writeFileSync(tmp, "planted\n");
	const res = writeOverlay(path, { model: "b" }, { random });
	assert.deepEqual(res, { invalid: "settings write failed (EEXIST)" });
	assert.equal(realFs.readFileSync(tmp, "utf8"), "planted\n", "the file at the tmp name is not overwritten");
	assert.equal(JSON.parse(realFs.readFileSync(path, "utf8")).model, "a", "and the settings file is not replaced by it");
	realFs.unlinkSync(tmp);
	assert.deepEqual(writeOverlay(path, { model: "b" }, { random }), { ok: true });
	assert.deepEqual(realFs.readdirSync(dir), ["settings.json"]);
});
