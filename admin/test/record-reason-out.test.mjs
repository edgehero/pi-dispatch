import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { modelRunRecord } from "../src/read-model.mjs";
import { runDocument, safeRunOf } from "../src/console/run-api.mjs";
import { stateOf } from "../src/console/live.mjs";

/**
 * A run record's `reason` leaves the admin only as a token (issue #737): every reader that hands a record's reason out of
 * this process (the model-callable `dispatch_runs`, `/api/run`, `/api/state`) goes through words.mjs `recordReason`, so
 * an older worker's free text (a forge's API path, an internal address, a bidi override) reaches no model, no script and
 * no terminal. A token is handed out as it is, and a record whose reason is a token or none is the record as it was.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

const FREE = ["GET /repos/acme/secret failed", "connect ECONNREFUSED 10.0.0.7:6379", "host\u202eevil", "Not-A-Token", "x".repeat(65)];
const record = (jobId, reason) => ({ jobId, kind: "github", target: "acme/web#1", flow: "fix", outcome: "failed", reason, startedAt: "2026-10-20T10:00:00.000Z", endedAt: "2026-10-20T10:05:00.000Z" });
const leaks = (text) => FREE.filter((f) => text.includes(f) || text.includes(JSON.stringify(f).slice(1, -1)));

test("modelRunRecord hands a model a record's reason only when it is a token, and a record whose reason is one as it is", () => {
  for (const reason of FREE) {
    for (const list of [false, true]) {
      const out = modelRunRecord(record("gh-1", reason), { list });
      assert.equal(out.reason, null, `${JSON.stringify(reason)}${list ? " (a list)" : ""}`);
      assert.equal(out.jobId, "gh-1", "the rest of the record is its own");
    }
  }
  for (const reason of ["container-lost", null]) {
    const rec = record("gh-2", reason);
    assert.equal(modelRunRecord(rec), rec, `${reason}: the same object`);
  }
  const bare = { jobId: "gh-3", outcome: "completed" };
  assert.equal(modelRunRecord(bare), bare, "a record with no reason field is left without one");
});

test("dispatch_runs, by id and as a list, returns no record reason that is no token", async () => {
  const saved = Object.fromEntries(["PI_LOGS_DIR", "VALKEY_URL"].map((k) => [k, process.env[k]]));
  const logsDir = tempDir("pd-737-reason-tool-");
  FREE.forEach((reason, i) => writeFileSync(join(logsDir, `gh-f${i}.json`), JSON.stringify(record(`gh-f${i}`, reason))));
  writeFileSync(join(logsDir, "gh-ok.json"), JSON.stringify(record("gh-ok", "container-lost")));
  // A Valkey URL the client refuses at once, so the list is this host's files alone, never a timeout.
  Object.assign(process.env, { PI_LOGS_DIR: logsDir, VALKEY_URL: "not-a-url" });
  try {
    const tools = [];
    indexMod.default(new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) }));
    const runs = tools.find((t) => t.name === "dispatch_runs");
    const textOf = async (params) => (await runs.execute("id", params, undefined, undefined, { hasUI: false, ui: {} })).content[0].text;
    const list = await textOf({ limit: 50 });
    assert.deepEqual(leaks(list), [], "the list");
    const parsed = JSON.parse(list);
    assert.equal(parsed.runs.length, FREE.length + 1);
    assert.equal(parsed.runs.find((r) => r.jobId === "gh-ok").reason, "container-lost", "a token is handed out as it is");
    for (let i = 0; i < FREE.length; i += 1) {
      const one = await textOf({ jobId: `gh-f${i}` });
      assert.deepEqual(leaks(one), [], `by id: ${JSON.stringify(FREE[i])}`);
      assert.equal(JSON.parse(one).reason, null);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("/api/run and /api/state hand out a record's reason only when it is a token", async () => {
  for (const reason of FREE) {
    assert.equal(safeRunOf("gh-1", record("gh-1", reason)).reason, null, JSON.stringify(reason));
    const fleet = {
      runById: async () => ({ record: record("gh-1", reason), source: "local" }),
      jobStatus: async () => ({ found: false, state: null, continuesAs: null, queuedAs: null }),
      runsPage: async () => ({ runs: [], next: null, mirror: "ok" }),
    };
    const { doc } = await runDocument(fleet, "gh-1");
    assert.deepEqual(leaks(JSON.stringify(doc)), [], `/api/run: ${JSON.stringify(reason)}`);
    assert.equal(doc.run.reason, null);
  }
  assert.equal(safeRunOf("gh-1", record("gh-1", "container-lost")).reason, "container-lost");
  // The day's refusals, the one list of reasons the state document carries.
  const top = [...FREE.map((reason) => ({ reason, count: 2 })), { reason: "scope-cap", count: 1 }];
  for (const role of ["operator", "viewer"]) {
    const state = stateOf({ refusals24h: { count: 11, top } }, role, { now: 1 });
    assert.deepEqual(leaks(JSON.stringify(state)), [], `/api/state, ${role}`);
    assert.deepEqual(state.refusals24h, { count: 11, top: [{ reason: "scope-cap", count: 1 }] });
  }
});

test("modelRunRecord rebuilds failover facts for model reads and lists (#716)", async () => {
  const { MODEL_WHY, PROVIDER_FAILURE_KINDS } = await import("@edgehero/pi-dispatch/model-failover-protocol");
  for (const list of [false, true]) {
    for (const modelWhy of MODEL_WHY) for (const kind of PROVIDER_FAILURE_KINDS) {
      const out = modelRunRecord({ jobId: "gh-1", modelWhy, providerFailure: { kind, resetAt: 1234, message: "PRIVATE-PROVIDER-ERROR" } }, { list });
      assert.equal(out.modelWhy, modelWhy);
      assert.deepEqual(out.providerFailure, { kind, resetAt: 1234 });
      assert.equal(JSON.stringify(out).includes("PRIVATE-PROVIDER-ERROR"), false);
    }
    for (const providerFailure of ["PRIVATE-PROVIDER-ERROR", { kind: "PRIVATE-PROVIDER-ERROR" }, { kind: "rate-limited", resetAt: -1 }, { kind: "rate-limited", resetAt: "123" }]) {
      const out = modelRunRecord({ jobId: "gh-1", modelWhy: "PRIVATE-PROVIDER-ERROR", providerFailure }, { list });
      assert.equal(out.modelWhy, undefined);
      assert.equal(out.providerFailure, undefined);
      assert.equal(JSON.stringify(out).includes("PRIVATE-PROVIDER-ERROR"), false);
    }
  }
});
