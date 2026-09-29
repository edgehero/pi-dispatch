import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { PACKAGED_EGRESS_PROXY_CONF, backupStamp, describeConfDifference, judgeProxyConfCopy, readPackagedProxyConf, replaceProxyConfCopy } from "../src/egress-conf-copy.mjs";

// Issue #484: the comparison and the refresh `doctor` and `up` share, on a real disk.
const NOW = () => Date.UTC(2026, 8, 29, 10, 15, 0);

test("the package's rules are the shipped deploy/egress-proxy.conf, read from the module (#484)", () => {
	assert.equal(PACKAGED_EGRESS_PROXY_CONF, new URL("../deploy/egress-proxy.conf", import.meta.url).pathname);
	assert.equal(readPackagedProxyConf(), readFileSync(new URL("../deploy/egress-proxy.conf", import.meta.url), "utf8"));
});

test("a copy is judged absent, the same, differing (with a line count) or unreadable, and the package's failure is its own state (#484)", () => {
	const dir = tempDir("pi-conf-judge-");
	const path = join(dir, "egress-proxy.conf");
	const packaged = () => "a\nb\nc\n";
	assert.deepEqual(judgeProxyConfCopy({ path, read: (p) => readFileSync(p, "utf8"), readPackaged: packaged }), { state: "absent" });
	writeFileSync(path, "a\nb\nc\n");
	assert.deepEqual(judgeProxyConfCopy({ path, read: (p) => readFileSync(p, "utf8"), readPackaged: packaged }), { state: "same" });
	writeFileSync(path, "a\nx\n");
	const differs = judgeProxyConfCopy({ path, read: (p) => readFileSync(p, "utf8"), readPackaged: packaged });
	assert.equal(differs.state, "differs");
	assert.equal(differs.summary, "1 line of it not in the package's copy, 2 lines of the package's not in it");
	assert.equal(differs.packaged, "a\nb\nc\n", "the text a refresh writes is the text compared");
	assert.equal(describeConfDifference("b\na\n", "a\nb\n"), "the same lines, in another order");
	assert.deepEqual(judgeProxyConfCopy({ path: dir, read: (p) => readFileSync(p, "utf8"), readPackaged: packaged }), { state: "unreadable", error: "EISDIR" });
	const broken = judgeProxyConfCopy({ path, read: (p) => readFileSync(p, "utf8"), readPackaged: () => readFileSync(join(dir, "gone")) });
	assert.equal(broken.state, "no-package");
	assert.equal(broken.error, "ENOENT");
});

test("a refresh writes a temp file beside the copy and renames it over, keeping the old bytes and mode as a backup (#484)", () => {
	const dir = tempDir("pi-conf-replace-");
	const path = join(dir, "egress-proxy.conf");
	writeFileSync(path, "old rules\n");
	chmodSync(path, 0o640);
	const before = statSync(path).ino;
	const renames = [];
	const fs = { ...realFs, renameSync: (from, to) => (renames.push([from, to]), realFs.renameSync(from, to)) };
	const done = replaceProxyConfCopy({ path, text: "new rules\n", fs, now: NOW, random: () => "r4nd" });
	assert.deepEqual(done, { ok: true, backup: `${path}.bak-20260929T101500Z` });
	assert.equal(readFileSync(path, "utf8"), "new rules\n");
	assert.equal(readFileSync(done.backup, "utf8"), "old rules\n");
	assert.deepEqual(renames, [[join(dir, ".egress-proxy.conf.tmp-r4nd"), path]], "one rename, from the same directory");
	assert.notEqual(statSync(path).ino, before, "a new file renamed in, not the old one written in place");
	assert.equal(statSync(path).mode & 0o777, 0o640);
	assert.deepEqual(readdirSync(dir).sort(), ["egress-proxy.conf", "egress-proxy.conf.bak-20260929T101500Z"], "no temp file left");
	// A second refresh in the same second finds the backup name taken and replaces nothing.
	const again = replaceProxyConfCopy({ path, text: "newer\n", fs: realFs, now: NOW });
	assert.equal(again.ok, false);
	assert.match(again.reason, /the backup .*bak-20260929T101500Z could not be written \(EEXIST\), so the copy was not touched/);
	assert.equal(readFileSync(path, "utf8"), "new rules\n");
	assert.equal(readFileSync(done.backup, "utf8"), "old rules\n", "the first backup is never overwritten");
});

test("a refresh follows no symlink: a linked copy or a linked parent is refused and nothing is written anywhere (#484)", () => {
	const dir = tempDir("pi-conf-link-");
	const outside = join(dir, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "target.conf"), "someone else's\n");
	const folder = join(dir, "deploy");
	mkdirSync(folder);
	const linked = join(folder, "egress-proxy.conf");
	symlinkSync(join(outside, "target.conf"), linked);
	const file = replaceProxyConfCopy({ path: linked, text: "new\n", fs: realFs, now: NOW });
	assert.equal(file.ok, false);
	assert.match(file.reason, /is a symlink, and the file it points to is not this folder's to replace/);
	assert.ok(lstatSync(linked).isSymbolicLink(), "the link is left as it is");
	assert.equal(readFileSync(join(outside, "target.conf"), "utf8"), "someone else's\n");
	assert.deepEqual(readdirSync(folder), ["egress-proxy.conf"], "no backup, no temp file");

	const linkedDir = join(dir, "linked-deploy");
	symlinkSync(outside, linkedDir);
	writeFileSync(join(outside, "egress-proxy.conf"), "theirs\n");
	const parent = replaceProxyConfCopy({ path: join(linkedDir, "egress-proxy.conf"), text: "new\n", fs: realFs, now: NOW });
	assert.equal(parent.ok, false);
	assert.match(parent.reason, /linked-deploy is a symlink, and the new file would be written wherever it leads/);
	assert.equal(readFileSync(join(outside, "egress-proxy.conf"), "utf8"), "theirs\n");
	assert.deepEqual(readdirSync(outside).sort(), ["egress-proxy.conf", "target.conf"]);
});

test("a failed write of the new file leaves the copy as it was and removes the temp file (#484)", () => {
	const dir = tempDir("pi-conf-fail-");
	const path = join(dir, "egress-proxy.conf");
	writeFileSync(path, "old\n");
	const fs = { ...realFs, renameSync: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } };
	const done = replaceProxyConfCopy({ path, text: "new\n", fs, now: NOW, random: () => "x" });
	assert.equal(done.ok, false);
	assert.match(done.reason, /could not be written beside it \(EXDEV\); the copy is as it was/);
	assert.equal(readFileSync(path, "utf8"), "old\n");
	assert.ok(!readdirSync(dir).some((n) => n.includes(".tmp-")), "the temp file is removed");
	assert.equal(backupStamp(NOW()), "20260929T101500Z");
});

test("a copy that differs only in its line endings is said to, naming which side has which (PR #491's review)", () => {
	assert.equal(describeConfDifference("a\r\nb\r\n", "a\nb\n"), "only in its line endings, CRLF here and LF in the package's");
	assert.equal(describeConfDifference("a\nb\n", "a\r\nb\r\n"), "only in its line endings, LF here and CRLF in the package's");
	// A real difference beside CRLF is still counted as lines.
	assert.match(describeConfDifference("a\r\nx\r\n", "a\nb\n"), /^\d+ lines? of it not in the package's copy/);
	const judged = judgeProxyConfCopy({ path: "/x", read: () => "a\r\nb\r\n", readPackaged: () => "a\nb\n" });
	assert.equal(judged.state, "differs", "still a difference: the bytes are not the package's");
});
