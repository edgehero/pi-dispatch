import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeZeroTouchFixStore } from "@edgehero/pi-dispatch/zero-touch-fixes";
import { makeZeroTouchService } from "../src/zero-touch-data.mjs";
const base = process.env.VALKEY_TEST_URL;
if (!base && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("Zero touch data integration requires VALKEY_TEST_URL");
const NOW = Date.UTC(2026, 9, 30, 12);

test("the page service repairs confirmed configuration writes only through configured file paths", { skip: base ? false : "VALKEY_TEST_URL not set" }, async () => {
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
    const report = await service.read();
    assert.equal((await store.read(allowed.fix.id)).state, "applied", "the lost metadata completion is repaired without repeating the file write");
    assert.equal((await store.read(denied.fix.id)).state, "pending");
    assert.equal(reads.includes(privatePath), false, "private pending proofs cannot turn into arbitrary host reads");
    assert.equal(report.fixesPartial, true, "the unprovable edit remains visibly uncertain");
    assert.equal(fs.readFileSync(paths.settingsFile, "utf8"), after);
  } finally {
    for (const id of staged) { await redis.del(`zero-touch:fixes:meta:${id}`, `zero-touch:fixes:private:${id}`); await redis.zrem("zero-touch:fixes:index", id); }
    await redis.quit();
  }
});
