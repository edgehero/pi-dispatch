import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tempDir } from "./helpers/temp-dir.mjs";
import { applyPriorities, readAllocations, readEnvelope, revertAllocation, writeEnvelope } from "../src/read-model.mjs";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";

// The admin's allocation writes against a LIVE Valkey (issue #504 part C; VALKEY_TEST_URL, required in CI). The fakes
// in crud.test.mjs answer before a socket exists; a real fail-fast client has no offline queue, so a write sent before
// it connected refused with "Stream isn't writeable" (found in the lab). Keys live under a random prefix and are
// deleted after, so a deployment's `alloc:*` is never touched. The clock is injected.

const URL = process.env.VALKEY_TEST_URL;
const NOW = Date.parse("2026-10-05T12:00:00Z");
const M = 1_000_000;

test("applyPriorities, revertAllocation, writeEnvelope and readAllocations work on a live Valkey (#504)", { skip: URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
  const prefix = `test504c:${randomBytes(6).toString("hex")}`;
  const dir = tempDir("pd-504c-live-");
  const files = { projects: join(dir, "projects.json"), envelope: join(dir, "envelope.json"), logs: join(dir, "logs") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  const read = () => readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2 * M });
  const raw = makeRedisClient(URL);
  try {
    const r = read();
    const applied = await applyPriorities({ url: URL, envelope: r.envelope, digest: r.digest, projects: r.projects, plan: { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, keepOther: true, host: "live", logsDir: files.logs, now: new Date(NOW), prefix });
    assert.equal(applied.outcome, "applied");
    assert.deepEqual(applied.after.allocations, { _other: 0, platform: 30 * M, shop: 70 * M });
    const seen = await readAllocations({ url: URL, envelope: r.envelope, projects: r.projects, now: new Date(NOW), prefix });
    assert.deepEqual(seen.log.map((x) => x.outcome), ["applied", "neutral"]);
    const back = await revertAllocation({ url: URL, envelope: r.envelope, digest: r.digest, target: seen.log[1], host: "live", logsDir: files.logs, now: new Date(NOW), prefix });
    assert.equal(back.outcome, "reverted");
    const written = await writeEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2 * M, change: { delegation: { minIntervalHours: 0 } }, url: URL, prefix });
    assert.equal(written.ok, true);
    assert.equal(await raw.get(`${prefix}:envelope:expected`), read().digest, "the expected digest names the file now on disk");
    assert.equal(JSON.parse(readFileSync(files.envelope, "utf8")).delegation.minIntervalHours, 0);
  } finally {
    await raw.del(`${prefix}:plan`, `${prefix}:log`, `${prefix}:lock`, `${prefix}:envelope:expected`);
    raw.disconnect();
  }
});

test("two confirmed envelope writes racing: the loser's rollback never takes the winner's expected digest (#504, live Valkey)", { skip: URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
  const prefix = `test504c:${randomBytes(6).toString("hex")}`;
  const dir = tempDir("pd-504c-race-");
  const files = { projects: join(dir, "projects.json"), envelope: join(dir, "envelope.json") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 } }));
  const common = { envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2 * M, url: URL, prefix };
  const digest = () => readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2 * M }).digest;
  const raw = makeRedisClient(URL);
  try {
    await raw.set(`${prefix}:envelope:expected`, digest());
    const { planEnvelopeWrite } = await import("../src/read-model.mjs");
    const planB = planEnvelopeWrite({ ...common, change: { totalUsd: "90" } });
    const planA = planEnvelopeWrite({ ...common, change: { totalUsd: "120" } });
    // B takes the key, then A runs whole inside B's window (key, then file), then B's file write finds the file
    // changed (its pre-confirm inputs no longer match) and B rolls back.
    let a;
    const b = await writeEnvelope({ ...common, change: { totalUsd: "90" }, expect: planB.inputs, afterExpected: async () => {
      a = await writeEnvelope({ ...common, change: { totalUsd: "120" }, expect: planA.inputs });
    } });
    assert.equal(a.ok, true, "A wrote its file");
    assert.match(b.invalid, /changed after this change was built from it/);
    assert.match(b.invalid, /was not put back, because another write changed it meanwhile/);
    assert.equal(JSON.parse(readFileSync(files.envelope, "utf8")).totalUsd, "120");
    assert.equal(await raw.get(`${prefix}:envelope:expected`), digest(), "expected names the file on disk: A's, not the digest B found before A");
  } finally {
    await raw.del(`${prefix}:envelope:expected`);
    raw.disconnect();
  }
});
