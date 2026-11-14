import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir } from "./helpers/temp-dir.mjs";
import { DEVICE_BROWSERS, DEVICE_END_REASONS, DEVICE_SECRET_RE, DEVICE_SYSTEMS, ENDED_RETENTION_MS, MAX_DEVICES_PER_NAME, REMEMBER_ROLES, TOUCH_INTERVAL_MS, consoleDevicesDir, deviceCookieName, deviceIdOf, deviceLabelOf, devicesDirProblem, devicesState, endDevice, hashDeviceSecret, listDevices, newDeviceSecret, readDevice, reapDevices, rememberDevice, touchDevice } from "../src/console-devices.mjs";

// The remembered-device store (issue #849). Real files, an injected clock, and an injected fs only where a fault has to be forced.

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const HASH = "a".repeat(64);

function store() {
	const root = fs.realpathSync(tempDir("console-devices-"));
	let t = T0;
	const now = () => t;
	return { root, dir: join(root, "console-devices"), now, advance: (ms) => { t += ms; } };
}
const made = (s, extra = {}) => rememberDevice({ dir: s.dir, name: "rob", role: "operator", tokenHash: HASH, generation: 3, label: "Chrome on macOS", now: s.now, ...extra });

test("the folder is beside the tokens file, and the cookie's name differs by deployment", () => {
	assert.equal(consoleDevicesDir("/srv/d/console-tokens.json"), "/srv/d/console-devices");
	assert.match(deviceCookieName("/srv/a/console-tokens.json"), /^pdc_device_[0-9a-f]{10}$/);
	assert.notEqual(deviceCookieName("/srv/a/console-tokens.json"), deviceCookieName("/srv/b/console-tokens.json"));
});

test("a secret is 256 random bits, and only its hash reaches the disk", () => {
	assert.match(newDeviceSecret(), DEVICE_SECRET_RE);
	const s = store();
	const { secret, hash, record } = made(s);
	assert.equal(hash, createHash("sha256").update(secret).digest("hex"), "a one-way hash, checked independently of the function under test");
	assert.equal(hash, hashDeviceSecret(secret));
	assert.deepEqual(fs.readdirSync(s.dir), [`${hash}.json`]);
	const bytes = fs.readFileSync(join(s.dir, `${hash}.json`), "utf8");
	assert.ok(!bytes.includes(secret));
	assert.deepEqual(JSON.parse(bytes), { version: 1, name: "rob", role: "operator", tokenHash: HASH, generation: 3, createdAt: new Date(T0).toISOString(), label: "Chrome on macOS" });
	assert.deepEqual(record, JSON.parse(bytes));
	assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(join(s.dir, `${hash}.json`)).mode & 0o777, 0o600);
});

test("a remembered device reads back, an unknown one is absent, and a malformed hash is absent without touching the disk", () => {
	const s = store();
	const { hash } = made(s);
	assert.equal(readDevice({ dir: s.dir, hash }).record.name, "rob");
	assert.deepEqual(readDevice({ dir: s.dir, hash: "b".repeat(64) }), { absent: true });
	for (const bad of ["../../etc/passwd", "short", null, undefined, 7]) assert.deepEqual(readDevice({ dir: s.dir, hash: bad }), { absent: true }, String(bad));
});

test("a role that may not be remembered is refused, and an agent above all: only an allowlist can stay safe as roles are added", () => {
	assert.deepEqual([...REMEMBER_ROLES], ["operator", "viewer"]);
	const s = store();
	for (const role of ["agent", "auditor", "", null]) {
		assert.match(made(s, { role }).refusal, /cannot be remembered/, String(role));
	}
	assert.equal(fs.existsSync(s.dir), false, "refused before anything is made");
});

test("an entry the store could not bind to is refused", () => {
	for (const extra of [{ name: "Not Valid" }, { tokenHash: "nope" }, { generation: -1 }, { generation: 1.5 }]) {
		const s = store();
		assert.ok(made(s, extra).refusal, JSON.stringify(extra));
	}
});

test("a missing folder is unjudged, never absent: a repointed tokens file must not read as every device revoked", () => {
	const s = store();
	assert.match(readDevice({ dir: s.dir, hash: HASH }).unjudged, /does not exist/);
});

test("a symlinked, foreign-owned or open folder is unjudged, and remembering into one is refused with remove as the fix", () => {
	const link = store();
	fs.mkdirSync(join(link.root, "real"), { mode: 0o700 });
	fs.symlinkSync(join(link.root, "real"), link.dir);
	assert.match(readDevice({ dir: link.dir, hash: HASH }).unjudged, /symbolic link/);
	assert.match(made(link).refusal, /remove the folder/);
	const open = store();
	fs.mkdirSync(open.dir);
	fs.chmodSync(open.dir, 0o750);
	assert.match(readDevice({ dir: open.dir, hash: HASH }).unjudged, /reached by other accounts/);
	assert.doesNotMatch(devicesDirProblem(open.dir).problem, /chmod/, "tightening would make whatever was planted good");
	const foreign = store();
	fs.mkdirSync(foreign.dir, { mode: 0o700 });
	assert.match(readDevice({ dir: foreign.dir, hash: HASH, uid: process.getuid() + 1 }).unjudged, /another account/);
	const file = store();
	fs.writeFileSync(file.dir, "");
	assert.match(devicesDirProblem(file.dir).problem, /is not a folder/);
});

test("one bad record is unjudged and leaves the others readable", () => {
	const s = store();
	const good = made(s);
	const planted = {
		corrupt: () => "{not json",
		"wrong shape": () => JSON.stringify({ version: 1, name: "rob" }),
		"a newer version": () => JSON.stringify({ version: 2, name: "rob", role: "operator", tokenHash: HASH, generation: 0, createdAt: new Date(T0).toISOString(), label: "Chrome on macOS" }),
		"an agent's": () => JSON.stringify({ version: 1, name: "rob", role: "agent", tokenHash: HASH, generation: 0, createdAt: new Date(T0).toISOString(), label: "Chrome on macOS" }),
		"a label that is not from the word lists": () => JSON.stringify({ version: 1, name: "rob", role: "operator", tokenHash: HASH, generation: 0, createdAt: new Date(T0).toISOString(), label: "<img src=x>" }),
	};
	let n = 0;
	for (const [name, bytes] of Object.entries(planted)) {
		const hash = String(n++).repeat(64);
		fs.writeFileSync(join(s.dir, `${hash}.json`), bytes(), { mode: 0o600 });
		assert.ok(readDevice({ dir: s.dir, hash }).unjudged, name);
		assert.equal(readDevice({ dir: s.dir, hash: good.hash }).record.name, "rob", `${name}: the good one still reads`);
	}
	const listed = listDevices({ dir: s.dir });
	assert.deepEqual([listed.devices.length, listed.unreadable], [1, n]);
});

test("a record that is a symlink, open to others or another account's is unjudged", () => {
	const s = store();
	const { hash } = made(s);
	const path = join(s.dir, `${hash}.json`);
	fs.chmodSync(path, 0o640);
	assert.match(readDevice({ dir: s.dir, hash }).unjudged, /reached by other accounts/);
	fs.chmodSync(path, 0o600);
	assert.ok(readDevice({ dir: s.dir, hash }).record, "with its mode restored it reads");
	const other = { ...fs, fstatSync: (fd) => Object.assign(fs.fstatSync(fd), { uid: process.getuid() + 1 }) };
	assert.match(readDevice({ dir: s.dir, hash, fs: other }).unjudged, /another account/);
	fs.linkSync(path, join(s.root, "second-name"));
	assert.match(readDevice({ dir: s.dir, hash }).unjudged, /more than one name/);
	fs.unlinkSync(join(s.root, "second-name"));
	const target = join(s.root, "elsewhere.json");
	fs.renameSync(path, target);
	fs.symlinkSync(target, path);
	assert.ok(readDevice({ dir: s.dir, hash }).unjudged, "O_NOFOLLOW");
});

test("ending a device is durable, keeps the record to say why, and the first reason stands", () => {
	const s = store();
	const { hash } = made(s);
	s.advance(1000);
	assert.deepEqual(endDevice({ dir: s.dir, hash, reason: "removed", now: s.now }), { ok: true });
	const read = readDevice({ dir: s.dir, hash });
	assert.deepEqual(read.record.ended, { reason: "removed", at: new Date(T0 + 1000).toISOString() });
	assert.deepEqual(endDevice({ dir: s.dir, hash, reason: "all", now: s.now }), { ok: true, already: true });
	assert.equal(readDevice({ dir: s.dir, hash }).record.ended.reason, "removed");
	assert.deepEqual(fs.readdirSync(s.dir), [`${hash}.json`], "no temporary left behind");
	assert.throws(() => endDevice({ dir: s.dir, hash, reason: "because", now: s.now }), RangeError);
	assert.deepEqual([...DEVICE_END_REASONS].sort(), ["all", "removed", "replaced", "revoked", "role", "signed-out"]);
});

test("an end against nothing says so, and against something unreadable says why", () => {
	const s = store();
	made(s);
	assert.deepEqual(endDevice({ dir: s.dir, hash: "b".repeat(64), reason: "removed", now: s.now }), { absent: true });
	const bad = "c".repeat(64);
	fs.writeFileSync(join(s.dir, `${bad}.json`), "{", { mode: 0o600 });
	assert.ok(endDevice({ dir: s.dir, hash: bad, reason: "removed", now: s.now }).problem);
});

test("a write that cannot finish leaves the old record and no temporary", () => {
	const s = store();
	const { hash } = made(s);
	const failing = { ...fs, renameSync: () => { throw Object.assign(new Error("no"), { code: "EIO" }); } };
	assert.match(endDevice({ dir: s.dir, hash, reason: "removed", fs: failing, now: s.now }).problem, /EIO/);
	assert.equal(readDevice({ dir: s.dir, hash }).record.ended, undefined);
	assert.deepEqual(fs.readdirSync(s.dir), [`${hash}.json`]);
});

test("a touch never loses an end: it changes the time and not one byte", () => {
	const s = store();
	const { hash } = made(s);
	const path = join(s.dir, `${hash}.json`);
	endDevice({ dir: s.dir, hash, reason: "removed", now: s.now });
	const bytes = fs.readFileSync(path, "utf8");
	s.advance(TOUCH_INTERVAL_MS * 2);
	assert.equal(touchDevice({ dir: s.dir, hash, now: s.now }), true);
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
	assert.equal(readDevice({ dir: s.dir, hash }).record.ended.reason, "removed");
});

test("a touch is at most daily", () => {
	const s = store();
	const { hash } = made(s);
	const mtimeMs = fs.statSync(join(s.dir, `${hash}.json`)).mtimeMs;
	assert.equal(touchDevice({ dir: s.dir, hash, mtimeMs, now: () => mtimeMs + TOUCH_INTERVAL_MS - 1 }), false);
	assert.equal(touchDevice({ dir: s.dir, hash, mtimeMs, now: () => mtimeMs + TOUCH_INTERVAL_MS + 1000 }), true);
	assert.equal(Math.round(fs.statSync(join(s.dir, `${hash}.json`)).mtimeMs / 1000), Math.round((mtimeMs + TOUCH_INTERVAL_MS + 1000) / 1000));
	assert.equal(touchDevice({ dir: s.dir, hash: "b".repeat(64), now: () => mtimeMs + TOUCH_INTERVAL_MS * 3 }), false, "a device gone meanwhile is simply not touched");
});

test("ending a device leaves its last-used time as it was", () => {
	const s = store();
	const { hash } = made(s);
	const path = join(s.dir, `${hash}.json`);
	const earlier = T0 - 5 * 24 * 3600 * 1000;
	fs.utimesSync(path, earlier / 1000, earlier / 1000);
	endDevice({ dir: s.dir, hash, reason: "removed", now: s.now });
	assert.equal(Math.round(fs.statSync(path).mtimeMs), earlier);
});

test("the list says what a page needs and no more", () => {
	const s = store();
	const first = made(s);
	s.advance(1000);
	const second = made(s, { name: "ann", role: "viewer", label: "Firefox on Linux" });
	endDevice({ dir: s.dir, hash: first.hash, reason: "revoked", now: s.now });
	const { devices, unreadable } = listDevices({ dir: s.dir });
	assert.equal(unreadable, 0);
	assert.deepEqual(devices.map((d) => [d.id, d.name, d.role, d.label, d.ended?.reason]), [[deviceIdOf(second.hash), "ann", "viewer", "Firefox on Linux", undefined], [deviceIdOf(first.hash), "rob", "operator", "Chrome on macOS", "revoked"]], "newest first");
	assert.equal(deviceIdOf(first.hash).length, 12);
	assert.deepEqual(listDevices({ dir: join(s.root, "nowhere") }), { devices: [], unreadable: 0, unreadableIds: [] }, "a listing of nothing");
});

test("the cap holds per name, counts only live devices, and leaves others alone", () => {
	const s = store();
	const all = Array.from({ length: MAX_DEVICES_PER_NAME }, () => made(s));
	assert.match(made(s).refusal, /remembered devices, the most/);
	assert.ok(made(s, { name: "ann" }).hash, "another name is unaffected");
	endDevice({ dir: s.dir, hash: all[0].hash, reason: "removed", now: s.now });
	assert.ok(made(s).hash, "a slot freed by ending one");
});

test("makeRoom: at the cap the least recently used live device of that name is ended as removed and named, and this one is remembered (issue #882)", () => {
	const s = store();
	const all = Array.from({ length: MAX_DEVICES_PER_NAME }, () => made(s));
	// Last use is the mtime: one used long ago, the rest recently; an ended one and another name's never count.
	all.forEach((d, i) => fs.utimesSync(join(s.dir, `${d.hash}.json`), (T0 - i * 1000) / 1000, (T0 - i * 1000) / 1000));
	fs.utimesSync(join(s.dir, `${all[5].hash}.json`), (T0 - 86400 * 1000) / 1000, (T0 - 86400 * 1000) / 1000);
	const other = made(s, { name: "ann" });
	fs.utimesSync(join(s.dir, `${other.hash}.json`), 1, 1);
	const room = made(s, { makeRoom: true });
	assert.ok(room.hash, room.refusal);
	assert.deepEqual([room.replaced.hash, room.replaced.record.name, room.replaced.record.ended.reason], [all[5].hash, "rob", "removed"]);
	assert.equal(readDevice({ dir: s.dir, hash: all[5].hash }).record.ended.reason, "removed");
	assert.equal(readDevice({ dir: s.dir, hash: other.hash }).record.ended, undefined, "another name's device is never the one");
	assert.equal(listDevices({ dir: s.dir }).devices.filter((d) => d.name === "rob" && !d.ended).length, MAX_DEVICES_PER_NAME);
	// Without makeRoom the cap still refuses, for the caller that tells a person to remove one.
	assert.equal(made(s).full, true);
	// Below the cap nothing is ended to make room.
	const t = store();
	const one = made(t);
	assert.equal(made(t, { makeRoom: true }).replaced, undefined);
	assert.equal(readDevice({ dir: t.dir, hash: one.hash }).record.ended, undefined);
});

test("reaping removes only dead records past retention and old temporaries", () => {
	const s = store();
	const live = made(s);
	const dead = made(s);
	const recent = made(s);
	endDevice({ dir: s.dir, hash: dead.hash, reason: "removed", now: s.now });
	s.advance(ENDED_RETENTION_MS - 1000);
	endDevice({ dir: s.dir, hash: recent.hash, reason: "removed", now: s.now });
	const bad = "d".repeat(64);
	fs.writeFileSync(join(s.dir, `${bad}.json`), "{", { mode: 0o600 });
	const oldTemp = join(s.dir, `.${HASH}.${"0".repeat(16)}.tmp`);
	fs.writeFileSync(oldTemp, "", { mode: 0o600 });
	const longAgo = (T0 - 7200 * 1000) / 1000;
	fs.utimesSync(oldTemp, longAgo, longAgo);
	const youngTemp = join(s.dir, `.${HASH}.${"1".repeat(16)}.tmp`);
	fs.writeFileSync(youngTemp, "", { mode: 0o600 });
	const nowSec = (T0 + ENDED_RETENTION_MS + 2000) / 1000;
	fs.utimesSync(youngTemp, nowSec, nowSec);
	s.advance(2000);
	assert.equal(reapDevices({ dir: s.dir, now: s.now }), 2);
	assert.ok(readDevice({ dir: s.dir, hash: live.hash }).record, "a live device is never reaped");
	assert.ok(readDevice({ dir: s.dir, hash: recent.hash }).record, "a dead one within retention stays");
	assert.deepEqual(readDevice({ dir: s.dir, hash: dead.hash }), { absent: true });
	assert.ok(fs.existsSync(join(s.dir, `${bad}.json`)), "what it cannot read is the operator's to judge");
	assert.ok(fs.existsSync(youngTemp), "a write that may be in progress");
	assert.equal(fs.existsSync(oldTemp), false);
});

test("a device label is built from closed word lists, whatever the header says", () => {
	const cases = [
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Chrome on macOS"],
		["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox on Linux"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari on macOS"],
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0", "Edge on Windows"],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
		["<script>alert(1)</script>", "Browser on this system"],
		[undefined, "Browser on this system"],
	];
	for (const [ua, label] of cases) assert.equal(deviceLabelOf(ua), label, String(ua));
	for (const b of DEVICE_BROWSERS) for (const s of DEVICE_SYSTEMS) assert.doesNotMatch(`${b} on ${s}`, /[<>"'&]/);
	const s = store();
	assert.equal(made(s, { label: "<img src=x>" }).record.label, "Browser on this system", "a caller cannot widen the list");
});

test("what doctor reads: absent, a problem, or counts", () => {
	const s = store();
	assert.deepEqual(devicesState({ dir: s.dir }), { absent: true });
	const { hash } = made(s);
	made(s);
	endDevice({ dir: s.dir, hash, reason: "removed", now: s.now });
	fs.writeFileSync(join(s.dir, `${"e".repeat(64)}.json`), "{", { mode: 0o600 });
	assert.deepEqual(devicesState({ dir: s.dir }), { live: 1, unreadable: 1, unreadableIds: ["e".repeat(12)] });
	fs.chmodSync(s.dir, 0o755);
	assert.ok(devicesState({ dir: s.dir }).problem);
});

test("a touch uses nothing but the file's times: it cannot rewrite what a revocation just wrote", () => {
	const s = store();
	const { hash } = made(s);
	const touched = [];
	const onlyTimes = new Proxy({}, { get: (_t, name) => { if (name === "lutimesSync") return (path) => touched.push(path); throw new Error(`a touch must not use fs.${String(name)}`); } });
	assert.equal(touchDevice({ dir: s.dir, hash, mtimeMs: 0, fs: onlyTimes, now: () => T0 + TOUCH_INTERVAL_MS }), true);
	assert.deepEqual(touched, [join(s.dir, `${hash}.json`)]);
	assert.equal(touchDevice({ dir: s.dir, hash: "../victim", mtimeMs: 0, fs: onlyTimes, now: () => T0 + TOUCH_INTERVAL_MS }), false, "a hostile hash");
});

test("the limits are the documented ones", () => {
	assert.deepEqual([ENDED_RETENTION_MS, TOUCH_INTERVAL_MS, MAX_DEVICES_PER_NAME], [90 * 24 * 3600 * 1000, 24 * 3600 * 1000, 32]);
});

test("a write is durable: the record is synced before it is renamed, and the folder after", () => {
	const s = store();
	const order = [];
	const spy = { ...fs, fsyncSync: (fd) => { order.push(fs.fstatSync(fd).isDirectory() ? "fsync-dir" : "fsync-file"); return fs.fsyncSync(fd); }, renameSync: (a, b) => { order.push("rename"); return fs.renameSync(a, b); } };
	assert.ok(made(s, { fs: spy }).hash);
	assert.deepEqual(order, ["fsync-file", "rename", "fsync-dir"]);
});

test("a write that fails before the rename leaves no temporary", () => {
	const s = store();
	const { hash } = made(s);
	const failing = { ...fs, fsyncSync: () => { throw Object.assign(new Error("no"), { code: "ENOSPC" }); } };
	assert.match(endDevice({ dir: s.dir, hash, reason: "removed", fs: failing, now: s.now }).problem, /ENOSPC/);
	assert.deepEqual(fs.readdirSync(s.dir), [`${hash}.json`]);
	assert.equal(readDevice({ dir: s.dir, hash }).record.ended, undefined, "and the old record stands");
});

test("each field of a record is judged: a bad one is unjudged, never live", () => {
	const s = store();
	const good = { version: 1, name: "rob", role: "operator", tokenHash: HASH, generation: 0, createdAt: new Date(T0).toISOString(), label: "Chrome on macOS" };
	const cases = { name: { name: "Not Valid" }, tokenHash: { tokenHash: "nope" }, "a fractional generation": { generation: 1.5 }, "a string generation": { generation: "0" }, createdAt: { createdAt: "yesterday" }, "an impossible date": { createdAt: "2026-19-08T00:00:00.000Z" }, "an ended of the wrong type": { ended: "yes" }, "an ended with an unknown reason": { ended: { reason: "because", at: new Date(T0).toISOString() } }, "an ended at an impossible date": { ended: { reason: "removed", at: "2026-99-99T99:99:99.999Z" } } };
	fs.mkdirSync(s.dir, { mode: 0o700 });
	let n = 1;
	for (const [title, change] of Object.entries(cases)) {
		const hash = String(n++ % 10).repeat(64);
		fs.writeFileSync(join(s.dir, `${hash}.json`), JSON.stringify({ ...good, ...change }), { mode: 0o600 });
		assert.ok(readDevice({ dir: s.dir, hash }).unjudged, title);
		fs.unlinkSync(join(s.dir, `${hash}.json`));
	}
	const big = "b".repeat(64);
	fs.writeFileSync(join(s.dir, `${big}.json`), `${JSON.stringify(good)}${" ".repeat(70000)}`, { mode: 0o600 });
	assert.match(readDevice({ dir: s.dir, hash: big }).unjudged, /too large/);
});

test("the folder's other faults: not writable by its owner, gone between the check and the open, or on Windows", () => {
	const ro = store();
	fs.mkdirSync(ro.dir, { mode: 0o700 });
	fs.chmodSync(ro.dir, 0o500);
	assert.match(devicesDirProblem(ro.dir).problem, /cannot be written by its owner/);
	fs.chmodSync(ro.dir, 0o700);
	const racing = store();
	const { hash } = made(racing);
	const vanishing = { ...fs, openSync: (path, flags) => { if (String(path).endsWith(".json")) { fs.rmSync(racing.dir, { recursive: true }); throw Object.assign(new Error("gone"), { code: "ENOENT" }); } return fs.openSync(path, flags); } };
	assert.ok(readDevice({ dir: racing.dir, hash, fs: vanishing }).unjudged, "a folder that went away says nothing about the device");
	const win = store();
	assert.match(devicesDirProblem(win.dir, { create: true, platform: "win32" }).problem, /Windows/);
	assert.equal(fs.existsSync(win.dir), false, "nothing made that doctor would then fail on");
	assert.deepEqual(devicesDirProblem(win.dir, { platform: "win32" }), { absent: true }, "only making one is refused: a Windows console that has none is simply fine");
	assert.deepEqual(devicesState({ dir: win.dir, platform: "win32" }), { absent: true });
	const quoted = store();
	const spaced = join(quoted.root, "my deployment");
	fs.mkdirSync(spaced, { mode: 0o755 });
	assert.ok(devicesDirProblem(spaced).problem.includes(JSON.stringify(spaced)));
});

test("two first remembers racing to make the folder are both fine", () => {
	const s = store();
	fs.mkdirSync(s.dir, { mode: 0o700 });
	const lost = { ...fs, lstatSync: (() => { let first = true; return (p) => { if (first && p === s.dir) { first = false; throw Object.assign(new Error("no"), { code: "ENOENT" }); } return fs.lstatSync(p); }; })() };
	assert.ok(made(s, { fs: lost }).hash, "EEXIST from mkdir is another process having won");
});

test("dead records per name are bounded, oldest first, and only the newest are kept", () => {
	const s = store();
	const dead = [];
	for (let i = 0; i < MAX_DEVICES_PER_NAME + 5; i++) {
		const one = made(s);
		dead.push(one.hash);
		s.advance(1000);
		endDevice({ dir: s.dir, hash: one.hash, reason: "signed-out", now: s.now });
		s.advance(1000);
	}
	assert.ok(made(s).hash, "one more, so the bound is applied after the last end");
	const files = fs.readdirSync(s.dir).filter((n) => n.endsWith(".json"));
	assert.ok(files.length <= MAX_DEVICES_PER_NAME, String(files.length));
	assert.deepEqual(readDevice({ dir: s.dir, hash: dead[0] }), { absent: true }, "the oldest goes first");
	assert.ok(readDevice({ dir: s.dir, hash: dead.at(-1) }).record, "the newest is kept");
	assert.ok(readDevice({ dir: s.dir, hash: dead[Math.floor(dead.length / 2)] }).record, "and one from the middle");
});

test("a device its token has moved on from holds no place, and is ended with the true reason", () => {
	const later = new Date(T0 + 1000).toISOString();
	const byGeneration = store();
	const a = made(byGeneration);
	made(byGeneration, { generation: 4 });
	assert.equal(readDevice({ dir: byGeneration.dir, hash: a.hash }).record.ended.reason, "all");
	const byRotation = store();
	const b = made(byRotation);
	byRotation.advance(2000);
	made(byRotation, { tokenHash: "b".repeat(64), tokenCreatedAt: later });
	assert.equal(readDevice({ dir: byRotation.dir, hash: b.hash }).record.ended.reason, "revoked");
	const byRole = store();
	const c = made(byRole, { role: "viewer" });
	made(byRole);
	assert.equal(readDevice({ dir: byRole.dir, hash: c.hash }).record.ended.reason, "role");
	const full = store();
	Array.from({ length: MAX_DEVICES_PER_NAME }, () => made(full));
	assert.ok(made(full, { generation: 4 }).hash, "the old generation's devices leave room");
});

test("the name on disk is looked at whichever read found the record, and a record gone mid-check is unjudged, never a throw", () => {
	const s = store();
	const { hash } = made(s);
	const renamed = { ...fs, realpathSync: Object.assign(() => join(s.dir, `${hash.toUpperCase()}.json`), { native: () => join(s.dir, `${hash.toUpperCase()}.json`) }) };
	assert.match(readDevice({ dir: s.dir, hash, fs: renamed }).unjudged, /not one this console writes/);
	const gone = { ...fs, realpathSync: Object.assign(() => { throw Object.assign(new Error("no"), { code: "ENOENT" }); }, { native: () => { throw Object.assign(new Error("no"), { code: "ENOENT" }); } }) };
	assert.match(readDevice({ dir: s.dir, hash, fs: gone }).unjudged, /could not be looked at/);
	assert.ok(endDevice({ dir: s.dir, hash, reason: "removed", fs: gone, now: s.now }).problem);
});

test("a stale entry for another role cannot end a device under a newer token", () => {
	const s = store();
	const operator = made(s, { tokenHash: "c".repeat(64), generation: 3 });
	made(s, { role: "viewer", tokenHash: "d".repeat(64), generation: 3 });
	assert.equal(readDevice({ dir: s.dir, hash: operator.hash }).record.ended, undefined);
});

test("a caller holding a stale entry cannot end a newer device", () => {
	const s = store();
	const newer = made(s, { generation: 4 });
	made(s, { generation: 3 });
	assert.equal(readDevice({ dir: s.dir, hash: newer.hash }).record.ended, undefined, "an older generation");
	const r = store();
	r.advance(5000);
	const current = made(r, { tokenHash: "c".repeat(64) });
	made(r, { tokenHash: "d".repeat(64), tokenCreatedAt: new Date(T0).toISOString() });
	assert.equal(readDevice({ dir: r.dir, hash: current.hash }).record.ended, undefined, "an entry older than the device cannot have replaced it");
	made(r, { tokenHash: "e".repeat(64) });
	assert.equal(readDevice({ dir: r.dir, hash: current.hash }).record.ended, undefined, "with no creation time to order by, nothing is ended");
});

test("a listing shows an uppercase record as unreadable, and carries only a device's own fields", () => {
	const s = store();
	const { hash } = made(s);
	endDevice({ dir: s.dir, hash, reason: "removed", now: s.now });
	const record = JSON.parse(fs.readFileSync(join(s.dir, `${hash}.json`), "utf8"));
	record.ended.note = "<script>";
	fs.writeFileSync(join(s.dir, `${hash}.json`), JSON.stringify(record), { mode: 0o600 });
	const valid = { version: 1, name: "rob", role: "operator", tokenHash: HASH, generation: 3, createdAt: new Date(T0).toISOString(), label: "Chrome on macOS" };
	fs.writeFileSync(join(s.dir, `${"F".repeat(64)}.json`), JSON.stringify(valid), { mode: 0o600 });
	const { devices, unreadable, unreadableIds } = listDevices({ dir: s.dir });
	assert.equal(devices[0].lastUsedAt, new Date(fs.statSync(join(s.dir, `${hash}.json`)).mtimeMs).toISOString());
	assert.deepEqual(unreadableIds, ["F".repeat(12)], "a shape this code would otherwise accept, so only its name can be what is wrong");
	assert.deepEqual(Object.keys(devices[0]).sort(), ["createdAt", "ended", "hash", "id", "label", "lastUsedAt", "name", "role"]);
	assert.deepEqual(Object.keys(devices[0].ended).sort(), ["at", "reason"]);
	assert.equal(unreadable, 1);
});

test("reaping keeps a temporary a write may still be using, and removes nothing on a clock that says nothing", () => {
	const s = store();
	const { hash } = made(s);
	const temp = join(s.dir, `.${HASH}.${"2".repeat(16)}.tmp`);
	fs.writeFileSync(temp, "", { mode: 0o600 });
	const aMinuteAgo = (T0 - 60000) / 1000;
	fs.utimesSync(temp, aMinuteAgo, aMinuteAgo);
	assert.equal(reapDevices({ dir: s.dir, now: s.now }), 0);
	assert.ok(fs.existsSync(temp));
	assert.equal(reapDevices({ dir: s.dir, now: () => T0 + 59 * 60 * 1000 }), 0, "under the hour, still kept");
	assert.equal(reapDevices({ dir: s.dir, now: () => T0 + 61 * 60 * 1000 }), 1, "past it, removed");
	fs.writeFileSync(temp, "", { mode: 0o600 });
	fs.utimesSync(temp, aMinuteAgo, aMinuteAgo);
	assert.equal(reapDevices({ dir: s.dir, now: () => NaN }), 0, "a clock that says nothing removes nothing");
	assert.ok(readDevice({ dir: s.dir, hash }).record);
});

test("a label's code names only the listed words", () => {
	const literals = [...deviceLabelOf.toString().matchAll(/\? "([^"]+)"|: "([^"]+)"/g)].map((m) => m[1] ?? m[2]);
	const allowed = new Set([...DEVICE_BROWSERS, ...DEVICE_SYSTEMS, "string", ""]);
	assert.deepEqual(literals.filter((w) => !allowed.has(w)), [], "a word added to the function must be added to the lists");
});

test("every word a label can be built from is reachable, and nothing else is", () => {
	const samples = ["Edg/1 Windows", "Firefox/1 Linux", "Chrome/1 Mac OS X", "Safari/1 iPhone", "Safari/1 iPad", "Chrome/1 Android", "nothing"];
	const seen = samples.map(deviceLabelOf);
	const browsers = new Set(seen.map((l) => l.split(" on ")[0]));
	const systems = new Set(seen.map((l) => l.split(" on ")[1]));
	assert.deepEqual([...browsers].sort(), [...DEVICE_BROWSERS].sort());
	assert.deepEqual([...systems].sort(), [...DEVICE_SYSTEMS].sort());
});
