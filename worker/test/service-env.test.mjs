// Issue #471: the one resolver doctor and the admin panel read a deployment's service keys through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { deploymentServiceEnv, envFileTrust, resolveServiceEnv, serviceEnvFileOf, serviceEnvLoader } from "../src/service-env.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const fileOf = (text, loader = "systemd") => serviceEnvFileOf(Buffer.from(text), "/d/.env", loader);

test("this shell's value where it sets one, else the file's plain line, and only the keys asked for (#471)", () => {
	const file = fileOf("A=from-file\nB=file-b\nC=file-c\nUNASKED=x\n");
	const r = resolveServiceEnv({ env: { A: "from-shell", OTHER: "kept" }, file, keys: ["A", "B", "D"] });
	assert.equal(r.env.A, "from-shell");
	assert.equal(r.env.B, "file-b");
	assert.equal(r.env.D, undefined, "a key neither sets stays unset, for the caller's default");
	assert.equal(r.env.C, undefined, "a key not asked for is never taken from the file");
	assert.equal(r.env.UNASKED, undefined);
	assert.equal(r.env.OTHER, "kept", "this shell's other variables are carried");
	assert.deepEqual(r.fromFile, { B: "file-b" });
	assert.deepEqual(r.disagreements, [{ key: "A", shell: "from-shell", file: "from-file" }]);
	// An empty shell value is a value: it wins, and differs from the file's.
	const empty = resolveServiceEnv({ env: { A: "" }, file, keys: ["A"] });
	assert.equal(empty.env.A, "");
	assert.deepEqual(empty.disagreements.map((d) => d.key), ["A"]);
	// No file: this shell's environment, untouched and copied.
	const env = { A: "x" };
	const none = resolveServiceEnv({ env, file: null, keys: ["A", "B"] });
	assert.deepEqual(none.env, { A: "x" });
	assert.notEqual(none.env, env, "a copy, so a caller's write cannot reach the shell's object");
});

test("a line the loader reads differently is unread, named by line, and never used (#471)", () => {
	const r = resolveServiceEnv({ env: { B: "shell-b" }, file: fileOf("A=/srv/$USER\nB=\"x$y\"\n"), keys: ["A", "B"] });
	assert.equal(r.env.A, undefined);
	assert.equal(r.env.B, "shell-b");
	assert.deepEqual(r.unread, [{ key: "A", line: 1, shellSet: false }, { key: "B", line: 2, shellSet: true }]);
	assert.deepEqual(r.fromFile, {});
	assert.deepEqual(r.disagreements, [], "an unread line is not a disagreement: its value is unknown");
});

test("a file the service's loader reads differently somewhere gives no value for a key it spells, and says which (#471)", () => {
	// A lone CR is a hazard systemd splits differently: nothing is taken from a file that holds one.
	const file = fileOf("A=a\rB=b\nC=c\n");
	assert.ok(file.hazard, "the fixture carries a hazard");
	const r = resolveServiceEnv({ env: { B: "shell" }, file, keys: ["A", "B", "C", "Z"] });
	assert.deepEqual(r.fromFile, {});
	assert.deepEqual(r.hazardSkipped, ["A", "C"], "each key the file spells, where this shell sets none; Z is not in the file");
	assert.equal(r.env.B, "shell");
});

test("under the cmd wrapper an empty value unsets the key, so the service runs without it (#471)", () => {
	const cmd = resolveServiceEnv({ env: {}, file: fileOf("A=\n", "cmd"), keys: ["A"] });
	assert.equal(cmd.env.A, undefined);
	assert.deepEqual(cmd.fromFile, {});
	const systemd = resolveServiceEnv({ env: {}, file: fileOf("A=\n"), keys: ["A"] });
	assert.equal(systemd.env.A, "", "systemd hands the worker the empty value");
	assert.deepEqual(["linux", "win32", "darwin"].map(serviceEnvLoader), ["systemd", "cmd", "shell"]);
});

test("deploymentServiceEnv reads a regular file once, and says a path it cannot read rather than calling it unset (#471)", () => {
	const dir = tempDir("pi-471-svc-");
	writeFileSync(join(dir, ".env"), "PI_LOGS_DIR=/srv/logs\n");
	const opens = [];
	const reads = [];
	const fs = { ...nodeFs, openSync: (p, f) => (opens.push(p), nodeFs.openSync(p, f)), readFileSync: (x) => (reads.push(typeof x), nodeFs.readFileSync(x)) };
	const r = deploymentServiceEnv({ env: {}, dir, keys: ["PI_LOGS_DIR"], platform: "linux", fs });
	assert.equal(r.env.PI_LOGS_DIR, "/srv/logs");
	assert.equal(r.path, join(dir, ".env"));
	assert.equal(r.unreadable, null);
	assert.deepEqual(opens, [nodeFs.realpathSync(join(dir, ".env"))], "opened once, at its real path");
	assert.deepEqual(reads, ["number"], "and read from that descriptor, never by path");
	// A directory where the file should be: not read at all (a FIFO would hang a synchronous read), and said.
	const odd = tempDir("pi-471-svc-dir-");
	mkdirSync(join(odd, ".env"));
	const d = deploymentServiceEnv({ env: {}, dir: odd, keys: ["PI_LOGS_DIR"], platform: "linux", fs: nodeFs });
	assert.equal(d.unreadable, "not a regular file");
	assert.deepEqual(d.fromFile, {});
	// No file: nothing to say.
	const none = deploymentServiceEnv({ env: {}, dir: tempDir("pi-471-svc-none-"), keys: ["PI_LOGS_DIR"], platform: "linux", fs: nodeFs });
	assert.equal(none.unreadable, null);
	assert.deepEqual(none.fromFile, {});
});

test("envFileTrust: this account's or root's, and writable by nobody else, else named with owner, mode and group, truthfully (#471, gate rounds 1 and 3)", () => {
	const st = (uid, mode, gid = uid) => ({ uid, gid, mode: 0o100000 | mode });
	const names = { ownerName: (id) => ({ 0: "root", 501: "me", 4242: "other" })[id] ?? `uid ${id}`, groupName: (id) => ({ 501: "me", 20: "staff" })[id] ?? `gid ${id}` };
	assert.equal(envFileTrust(st(501, 0o600), 501, names), null);
	assert.equal(envFileTrust(st(501, 0o644), 501, names), null);
	assert.equal(envFileTrust(st(0, 0o644), 501, names), null, "root's");
	assert.equal(envFileTrust(st(501, 0o620, 20), 501, names), "is owned by me with mode 0620, writable by the members of its group staff");
	assert.equal(envFileTrust(st(501, 0o664), 501, names), "is owned by me with mode 0664, writable by the members of its group me (me's own group, which may have no other member; doctor trusts only a file no group can write)", "a user-private group, said as one (round 3: this read 'another account can write')");
	assert.equal(envFileTrust(st(501, 0o602), 501, names), "is owned by me with mode 0602, writable by every account");
	assert.equal(envFileTrust(st(0, 0o666), 501, names), "is owned by root with mode 0666, writable by every account", "root's but open");
	assert.equal(envFileTrust(st(4242, 0o600), 501, names), "is owned by other with mode 0600, not by this account or root");
	assert.equal(envFileTrust(st(4242, 0o600), undefined, names), null, "no uids on this platform");
	assert.equal(envFileTrust(st(4242, 0o600), 501), "is owned by uid 4242 with mode 0600, not by this account or root", "an unknown owner is its number, said as one");
});


test("a key only this shell sets is returned as shellOnly, for a caller that knows a service is installed (#471)", () => {
	const r = resolveServiceEnv({ env: { A: "a", B: "b" }, file: fileOf("B=file\n"), keys: ["A", "B", "C"] });
	assert.deepEqual(r.shellOnly, ["A"]);
	assert.deepEqual(resolveServiceEnv({ env: { A: "a" }, file: null, keys: ["A"] }).shellOnly, [], "no file: nothing to compare with");
});
