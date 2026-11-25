import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeZeroTouchFixStore } from "@edgehero/pi-dispatch/zero-touch-fixes";
import { makeZeroTouchService } from "../src/zero-touch-data.mjs";
import { zeroTouchView } from "../src/zero-touch-view.mjs";
import { zeroTouchQuestions } from "../src/console/panels/zero-touch.mjs";
const base = process.env.VALKEY_TEST_URL;
if (!base && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("Zero touch data integration requires VALKEY_TEST_URL");
const NOW = Date.UTC(2026, 9, 30, 12);

test("the page service proves confirmed configuration writes only through configured file paths, and only a settle commits them (#1076)", { skip: base ? false : "VALKEY_TEST_URL not set" }, async () => {
  const url = new URL(base); url.pathname = "/14";
  const redis = makeRedisClient(url.toString());
  const store = makeZeroTouchFixStore({ redis, now: () => NOW });
  const root = tempDir("zero-touch-data-");
  const paths = { valkeyUrl: url.toString(), logsDir: join(root, "logs"), triggersPath: join(root, "triggers.json"), settingsFile: join(root, "settings.json") };
  fs.mkdirSync(paths.logsDir);
  fs.writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [] }));
  const after = JSON.stringify({ maxTurns: 9 });
  fs.writeFileSync(paths.settingsFile, after);
  const privatePath = join(root, "unrelated-private-file"); fs.writeFileSync(privatePath, after);
  const hash = createHash("sha256").update(after).digest("hex");
  const fix = { kind: "config", runId: "source", scopeId: "f".repeat(64), reason: "secret-unresolved", project: null, groupId: null, triggerIndex: 0 };
  const staged = [];
  const reads = [];
  try {
    const allowed = await store.stage(fix, { privateUndo: { file: paths.settingsFile, afterDigest: hash }, identity: randomUUID() }); staged.push(allowed.fix.id);
    const denied = await store.stage(fix, { privateUndo: { file: privatePath, afterDigest: hash }, identity: randomUUID() }); staged.push(denied.fix.id);
    const service = makeZeroTouchService({ paths, now: () => NOW, fs: { ...fs, readFileSync(path, ...args) { reads.push(path); return fs.readFileSync(path, ...args); } } });
    // The page's read proves and writes nothing: the lost completion waits for a settle, the unprovable edit stays open.
    const report = await service.read();
    assert.equal((await store.read(allowed.fix.id)).state, "pending", "a page view commits nothing");
    assert.deepEqual([report.waiting.fixes, report.fixesPartial], [1, true]);
    assert.ok(report.fixesOpen >= 1, "the edit whose file is not on the allowlist is open: no settle records it");
    // The settle commits what the read proved, without repeating the file write.
    const preview = await service.preview("zero-touch-settle", {});
    assert.equal(preview.plan.settle.fixes, 1);
    assert.equal((await store.read(allowed.fix.id)).state, "pending", "nor does a preview");
    const settled = await service.apply("zero-touch-settle", { payload: { params: {} } });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal((await store.read(allowed.fix.id)).state, "applied", "the lost metadata completion is settled without repeating the file write");
    assert.equal((await store.read(denied.fix.id)).state, "pending");
    assert.equal(reads.includes(privatePath), false, "private pending proofs cannot turn into arbitrary host reads");
    assert.equal(fs.readFileSync(paths.settingsFile, "utf8"), after);
  } finally {
    for (const id of staged) { await redis.del(`zero-touch:fixes:meta:${id}`, `zero-touch:fixes:private:${id}`); await redis.zrem("zero-touch:fixes:index", id); }
    await redis.quit();
  }
});

test("the grouping configuration is said in the word of its file's case: absent configures none, and a file nobody could read is not one that does not load", { skip: base ? false : "VALKEY_TEST_URL not set" }, async () => {
  // Database 14 is not this test's own: other suites use it too. This test only READS it (the service's read of an
  // empty Zero touch store) and leaves it as it found it; should it ever write, it writes under a key prefix of its own.
  const url = new URL(base); url.pathname = "/14";
  const words = async (state) => {
    const root = tempDir("zero-touch-words-");
    const paths = { valkeyUrl: url.toString(), logsDir: join(root, "logs"), triggersPath: join(root, "triggers.json"), settingsFile: join(root, "settings.json") };
    fs.mkdirSync(paths.logsDir);
    fs.writeFileSync(paths.settingsFile, "{}");
    if (state !== "absent") fs.writeFileSync(paths.triggersPath, state === "invalid" ? "{ not json" : JSON.stringify({ triggers: [] }));
    if (state === "unreadable") fs.chmodSync(paths.triggersPath, 0o000);
    const read = await makeZeroTouchService({ paths, now: () => NOW }).read();
    // The card is drawn once tracking has started, which this empty database has not: the report's own grouping, on
    // a window that has.
    const report = { ...read, state: "ready", coverage: { requestedFromMs: NOW - 30 * 86400_000, fromMs: NOW - 30 * 86400_000, toMs: NOW, partial: false, reasons: [] } };
    const view = { role: "operator", query: { days: 30 }, now: NOW, data: { zeroTouch: report } };
    return { grouping: read.grouping, shown: zeroTouchView(report, { role: "operator", windowDays: 30, nowMs: NOW }).grouping, said: String(zeroTouchQuestions(view)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  };
  const UNREAD = "Grouping configuration could not be read. Check the reviewed triggers file before starting a grouping job.";
  const REFUSED = "The triggers file does not load, so the grouping configuration is not known. Fix the reviewed triggers file before starting a grouping job.";
  const invalid = await words("invalid");
  assert.deepEqual([invalid.grouping.state, invalid.grouping.configuration, invalid.shown.configuration], ["configuration-unavailable", "invalid", "invalid"]);
  assert.ok(invalid.said.includes(REFUSED) && !invalid.said.includes(UNREAD));
  const unreadable = await words("unreadable");
  assert.deepEqual([unreadable.grouping.state, unreadable.grouping.configuration, unreadable.shown.configuration], ["configuration-unavailable", "unreadable", "unreadable"]);
  assert.ok(unreadable.said.includes(UNREAD) && !unreadable.said.includes(REFUSED));
  // A file that does not exist configures no grouping, and one that was read is its own answer: neither is worded.
  for (const state of ["absent", "read"]) {
    const got = await words(state);
    assert.ok(got.grouping.state !== "configuration-unavailable" && !Object.hasOwn(got.grouping, "configuration") && !Object.hasOwn(got.shown, "configuration"), state);
    assert.ok(!got.said.includes(UNREAD) && !got.said.includes(REFUSED), state);
  }
});
