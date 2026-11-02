import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { modelRunRecord } from "../src/read-model.mjs";
import { runDocument, safeRunOf } from "../src/console/run-api.mjs";
import { stateOf } from "../src/console/live.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";
import { NEWER_RECORD_MODEL_NOTE } from "../src/newer-release.mjs";
import { RECORD_CORE_FIELDS, sanitizeJobId } from "@edgehero/pi-dispatch/run-history";

/**
 * A run record's `reason` leaves the admin only as a token (issue #737): every reader that hands a record's reason out of
 * this process (the model-callable `dispatch_runs`, `/api/run`, `/api/state`) goes through words.mjs `recordReason`, so
 * an older worker's free text (a forge's API path, an internal address, a bidi override) reaches no model, no script and
 * no terminal. A token is handed out as it is, and a record whose reason is a token or none is the record as it was.
 * The same projection lets through this build's own sentences beside a record a newer pi-dispatch wrote (issue #761),
 * the one `dispatch_runs` gives among them, and no other note.
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
  writeFileSync(join(logsDir, "gh-ok.json"), JSON.stringify(record("gh-ok", "cost-cap")));
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
    assert.equal(parsed.runs.find((r) => r.jobId === "gh-ok").reason, "cost-cap", "a catalogued reason is handed out as it is");
    for (let i = 0; i < FREE.length; i += 1) {
      const one = await textOf({ jobId: `gh-f${i}` });
      assert.deepEqual(leaks(one), [], `by id: ${JSON.stringify(FREE[i])}`);
      assert.equal(JSON.parse(one).reason, null);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("dispatch_runs, by id and as a list, hands the model the newer record's note, and withholds every other note (#761)", async () => {
  // The model reads only the registered tool's output, after the projection every operational read goes through; a
  // test of `modelRunRecord` alone cannot see that projection drop the note (it withholds `note` as prose).
  const synthetic = JSON.parse(readFileSync(fileURLToPath(new URL("../../worker/test/fixtures/run-records/synthetic-v2.json", import.meta.url)), "utf8"));
  const saved = Object.fromEntries(["PI_LOGS_DIR", "VALKEY_URL"].map((k) => [k, process.env[k]]));
  const logsDir = tempDir("pd-761-note-tool-");
  // The newer record carries a note of its own, which its cut to the core drops; a released record's note is prose.
  writeFileSync(join(logsDir, `${sanitizeJobId(synthetic.jobId)}.json`), JSON.stringify({ ...synthetic, note: "PRIVATE-NEWER-NOTE" }));
  writeFileSync(join(logsDir, "gh-noted.json"), JSON.stringify({ ...record("gh-noted", "cost-cap"), note: "PRIVATE-OPERATOR-NOTE" }));
  writeFileSync(join(logsDir, "gh-mimic.json"), JSON.stringify({ ...record("gh-mimic", "cost-cap"), note: `${NEWER_RECORD_MODEL_NOTE}.` }));
  Object.assign(process.env, { PI_LOGS_DIR: logsDir, VALKEY_URL: "not-a-url" });
  try {
    const tools = [];
    indexMod.default(new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) }));
    const runs = tools.find((t) => t.name === "dispatch_runs");
    const read = async (params) => JSON.parse((await runs.execute("id", params, undefined, undefined, { hasUI: false, ui: {} })).content[0].text);
    const core = Object.fromEntries([...RECORD_CORE_FIELDS, "v"].map((k) => [k, synthetic[k]]));
    const list = await read({ limit: 50 });
    assert.equal(list.runs.length, 3);
    const byId = await read({ jobId: synthetic.jobId });
    for (const [at, newer] of [["the list", list.runs.find((r) => r.jobId === synthetic.jobId)], ["by id", byId]]) {
      assert.deepEqual(newer, { ...core, newer: true, note: NEWER_RECORD_MODEL_NOTE }, at);
    }
    // Any other note is withheld, by id and in the list: an operator's prose, and one that only resembles the sentence.
    for (const jobId of ["gh-noted", "gh-mimic"]) {
      const one = await read({ jobId });
      assert.equal(one.jobId, jobId);
      assert.equal(Object.hasOwn(one, "note"), false, `${jobId} by id`);
      assert.equal(Object.hasOwn(list.runs.find((r) => r.jobId === jobId), "note"), false, `${jobId} in the list`);
    }
    assert.equal(JSON.stringify(list).includes("PRIVATE-"), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  // The projection itself: the sentence passes only as the value of `note`, and only whole.
  assert.deepEqual(agentReadProjection({ note: NEWER_RECORD_MODEL_NOTE }), { note: NEWER_RECORD_MODEL_NOTE });
  for (const note of ["PRIVATE-NOTE", NEWER_RECORD_MODEL_NOTE.slice(1), ` ${NEWER_RECORD_MODEL_NOTE}`, [NEWER_RECORD_MODEL_NOTE]]) assert.deepEqual(agentReadProjection({ note }), {}, JSON.stringify(note).slice(0, 40));
  assert.deepEqual(agentReadProjection({ notes: NEWER_RECORD_MODEL_NOTE, summary: NEWER_RECORD_MODEL_NOTE }), {}, "under any other field it is prose like any other");
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
