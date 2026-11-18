import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ARTIFACTS_MANIFEST, artifactLimitsOf, artifactRunDirOf, artifactsDeadline, artifactsWanted, artifactTypeOf, collectArtifacts, makeArtifactsReaper, makeArtifactsRuntime } from "../src/artifacts.mjs";
import { ARTIFACT_DROP_REASONS, recordedArtifacts } from "../src/artifacts-record.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const DAY = 24 * 3600 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SECRET = "ghs_secretvalue1234567890";
const limits = (over = {}) => ({ ...artifactLimitsOf({ maxFiles: 5, maxFileMb: 1, maxRunMb: 2 }), ...over });

function world() {
	const root = tempDir("pi-artifacts-");
	const dir = join(root, "job", "artifacts");
	const store = join(root, "store");
	mkdirSync(dir, { recursive: true });
	const put = (name, bytes) => writeFileSync(join(dir, name), bytes);
	const collect = (over = {}) => collectArtifacts({ dir, storeDir: store, jobId: "gh-abc", limits: limits(), secretValues: [SECRET], retentionDays: 14, now: () => NOW, ...over });
	const manifest = () => JSON.parse(readFileSync(join(store, "gh-abc", ARTIFACTS_MANIFEST), "utf8"));
	const kept = (name) => readFileSync(join(store, "gh-abc", "files", name));
	return { root, dir, store, put, collect, manifest, kept };
}

test("a type is judged by the bytes, never the name", () => {
	assert.equal(artifactTypeOf(PNG), "image/png");
	assert.equal(artifactTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(artifactTypeOf(Buffer.from("GIF89a....")), "image/gif");
	assert.equal(artifactTypeOf(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")])), "image/webp");
	assert.equal(artifactTypeOf(Buffer.from("all 12 tests passed\n")), "text/plain");
	assert.equal(artifactTypeOf(Buffer.from("<svg onload=alert(1)>")), "text/plain", "an SVG is text, and is never served as an image");
	assert.equal(artifactTypeOf(Buffer.from([0x61, 0x00, 0x62])), "application/octet-stream");
	assert.equal(artifactTypeOf(Buffer.from([0xc3, 0x28])), "application/octet-stream", "invalid UTF-8 is binary");
});

test("what is kept: text cleaned of the job's secrets, images as written, by name order, with a manifest", () => {
	const w = world();
	w.put("report.txt", `token ${SECRET} used\n`);
	w.put("after.png", PNG);
	assert.deepEqual(w.collect(), { kept: 2, bytes: w.kept("after.png").length + w.kept("report.txt").length, dropped: {} });
	assert.equal(w.kept("report.txt").toString().includes(SECRET), false, "the secret is gone from the text");
	assert.deepEqual(w.kept("after.png"), PNG);
	const m = w.manifest();
	assert.equal(m.v, 1);
	assert.equal(m.jobId, "gh-abc");
	assert.equal(m.createdAt, new Date(NOW).toISOString());
	assert.equal(m.keepUntil, new Date(NOW + 14 * DAY).toISOString());
	assert.deepEqual(m.files.map((f) => [f.name, f.type, f.scrubbed]), [["after.png", "image/png", false], ["report.txt", "text/plain", true]]);
	assert.match(m.files[0].sha256, /^[a-f0-9]{64}$/);
});

test("every way a file is dropped is counted, and none fails the collection", () => {
	const w = world();
	w.put("ok.txt", "fine\n");
	w.put(".hidden", "x");
	w.put("has space.txt", "x");
	w.put(`name-${SECRET}.txt`, "x");
	w.put("leak.bin", Buffer.concat([Buffer.from([0]), Buffer.from(SECRET)]));
	w.put("big.bin", Buffer.alloc(1024 * 1024 + 1, 1));
	mkdirSync(join(w.dir, "folder"));
	symlinkSync("/etc/passwd", join(w.dir, "link.txt"));
	const got = w.collect();
	assert.equal(got.kept, 1);
	assert.deepEqual(got.dropped, { name: 2, secret: 2, size: 1, type: 2 });
	assert.deepEqual(readdirSync(join(w.store, "gh-abc", "files")), ["ok.txt"]);
	for (const reason of Object.keys(got.dropped)) assert.ok(ARTIFACT_DROP_REASONS.includes(reason), reason);
});

test("the count and the total are limits, in name order", () => {
	const w = world();
	for (const n of [1, 2, 3, 4, 5, 6, 7]) w.put(`f${n}.txt`, "x".repeat(10));
	assert.deepEqual(w.collect({ limits: limits({ maxFiles: 3 }) }), { kept: 3, bytes: 30, dropped: { count: 4 } });
	const t = world();
	for (const n of [1, 2, 3]) t.put(`f${n}.txt`, "y".repeat(40));
	assert.deepEqual(t.collect({ limits: limits({ maxRunBytes: 100 }) }), { kept: 2, bytes: 80, dropped: { total: 1 } });
});

test("nothing written is nothing kept, and a retry replaces its earlier attempt whole", () => {
	const w = world();
	assert.equal(w.collect(), null, "an empty folder leaves no store folder and no record field");
	assert.equal(existsSync(join(w.store, "gh-abc")), false);
	assert.equal(w.collect({ dir: join(w.root, "absent") }), null);
	w.put("a.txt", "first");
	w.collect();
	writeFileSync(join(w.dir, "a.txt"), "second");
	w.put("b.txt", "new");
	w.collect();
	assert.deepEqual(readdirSync(join(w.store, "gh-abc", "files")).sort(), ["a.txt", "b.txt"]);
	assert.equal(w.kept("a.txt").toString(), "second");
	assert.deepEqual(readdirSync(w.store), ["gh-abc"], "no staging or old folder is left beside it");
});

test("a run folder is named from the job id, never `.` or `..`, and the feature off keeps nothing", () => {
	assert.equal(artifactRunDirOf("gh-9a8b:r2"), "gh-9a8b_r2");
	for (const bad of [".", "..", "", null]) assert.equal(artifactRunDirOf(bad), null, String(bad));
	const w = world();
	w.put("a.txt", "x");
	assert.equal(w.collect({ jobId: ".." }), null);
	assert.equal(w.collect({ limits: limits({ maxFiles: 0 }) }), null);
	assert.equal(existsSync(w.store), false);
});

test("the record keeps numbers and closed reasons only", () => {
	assert.deepEqual(recordedArtifacts({ kept: 2, bytes: 10, dropped: { size: 1 } }), { kept: 2, bytes: 10, dropped: { size: 1 } });
	assert.deepEqual(recordedArtifacts({ kept: 0, bytes: 0, dropped: { name: 3 } }), { kept: 0, bytes: 0, dropped: { name: 3 } });
	for (const bad of [null, [], { kept: -1, bytes: 0, dropped: {} }, { kept: 1, bytes: 1.5, dropped: {} }, { kept: 1, bytes: 1, dropped: { evil: 1 } }, { kept: 1, bytes: 1, dropped: { size: 0 } }, { kept: 0, bytes: 0, dropped: {} }, { kept: 1, bytes: 1 }]) {
		assert.equal(recordedArtifacts(bad), null, JSON.stringify(bad));
	}
});

test("the runtime stages a folder for a forge job only, and collects under the record's id", () => {
	const root = tempDir("pi-artifacts-rt-");
	const runtime = makeArtifactsRuntime({ storeDir: join(root, "store"), limits: limits(), retentionDays: 7, now: () => NOW });
	assert.equal(runtime.on, true);
	for (const job of [{ kind: "local" }, { kind: "github", answerDraft: true }, { kind: "github", watch: {} }, { kind: "github", questionGrouping: {} }, { kind: "answer-draft" }]) {
		assert.equal(artifactsWanted(job), false, JSON.stringify(job));
		assert.equal(runtime.stage(job, { jobDir: join(root, "j0") }), null);
	}
	const prepared = { jobDir: join(root, "j1") };
	mkdirSync(prepared.jobDir);
	assert.equal(runtime.stage({ kind: "gitlab", flow: "fix" }, prepared), join(prepared.jobDir, "artifacts"));
	assert.equal(prepared.artifactsDir, join(prepared.jobDir, "artifacts"));
	writeFileSync(join(prepared.artifactsDir, "log.txt"), "done\n");
	assert.deepEqual(runtime.collect("gl-1", prepared), { kept: 1, bytes: 5, dropped: {} });
	assert.ok(existsSync(join(root, "store", "gl-1", "files", "log.txt")));
	assert.equal(makeArtifactsRuntime({ storeDir: join(root, "store"), limits: limits({ maxFiles: 0 }) }).on, false);
});

test("the sweep removes a run at the earlier of its deadline and today's setting, and leftovers after an hour", async () => {
	const root = tempDir("pi-artifacts-reap-");
	const store = join(root, "store");
	const run = (name, createdAt, keepUntil) => {
		mkdirSync(join(store, name, "files"), { recursive: true });
		writeFileSync(join(store, name, ARTIFACTS_MANIFEST), JSON.stringify({ v: 1, jobId: name, createdAt: new Date(createdAt).toISOString(), keepUntil: keepUntil === null ? null : new Date(keepUntil).toISOString(), files: [], dropped: {} }));
	};
	run("gh-old", NOW - 20 * DAY, NOW - 6 * DAY);
	run("gh-new", NOW - DAY, NOW + 13 * DAY);
	run("gh-shortened", NOW - 10 * DAY, NOW + 4 * DAY); // kept 14 days, but the setting is now 7
	run("gh-forever", NOW - 400 * DAY, null); // kept when the setting was 0; today's 7 days cut it
	mkdirSync(join(store, ".tmp-gh-x-aaaa"));
	utimesSync(join(store, ".tmp-gh-x-aaaa"), new Date(NOW - 2 * 3600 * 1000), new Date(NOW - 2 * 3600 * 1000));
	mkdirSync(join(store, ".tmp-gh-y-bbbb")); // just written by a collection in progress
	utimesSync(join(store, ".tmp-gh-y-bbbb"), new Date(NOW), new Date(NOW));
	const logs = [];
	const reap = makeArtifactsReaper({ storeDir: store, retentionDays: 7, now: () => NOW, log: (event, fields) => logs.push({ event, fields }) });
	assert.deepEqual(await reap(), { removed: 4 });
	assert.deepEqual(readdirSync(store).sort(), [".tmp-gh-y-bbbb", "gh-new"]);
	assert.deepEqual(logs, [{ event: "artifacts_reaped", fields: { removed: 4 } }]);
	// With today's setting 0, a run kept with a deadline still goes at it, and one kept with none stays.
	run("gh-kept", NOW - 400 * DAY, null);
	run("gh-due", NOW - 20 * DAY, NOW - DAY);
	assert.deepEqual(await makeArtifactsReaper({ storeDir: store, retentionDays: 0, now: () => NOW })(), { removed: 1 });
	assert.deepEqual(readdirSync(store).sort(), [".tmp-gh-y-bbbb", "gh-kept", "gh-new"]);
	assert.equal(artifactsDeadline({ createdAt: new Date(NOW).toISOString(), keepUntil: null }, 0), null, "0 keeps them");
	assert.equal(await makeArtifactsReaper({ storeDir: join(root, "absent"), now: () => NOW })().then((r) => r.removed), 0);
});

test("the sweep stops when the retention sweep closes, issue #924's contract", async () => {
	const root = tempDir("pi-artifacts-stop-");
	const store = join(root, "store");
	for (const name of ["gh-a", "gh-b", "gh-c"]) {
		mkdirSync(join(store, name), { recursive: true });
		writeFileSync(join(store, name, ARTIFACTS_MANIFEST), JSON.stringify({ v: 1, jobId: name, createdAt: new Date(NOW - 30 * DAY).toISOString(), keepUntil: new Date(NOW - DAY).toISOString(), files: [], dropped: {} }));
	}
	let calls = 0;
	assert.deepEqual(await makeArtifactsReaper({ storeDir: store, retentionDays: 7, now: () => NOW })({ stopped: () => ++calls > 1 }), { removed: 1 });
	assert.equal(readdirSync(store).length, 2, "it stopped after the first entry");
});
