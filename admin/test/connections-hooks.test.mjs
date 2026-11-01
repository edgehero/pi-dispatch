import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHookRun } from "@edgehero/pi-dispatch/hook-runs";
import { readConnections, modelConnections } from "../src/connections-view.mjs";
import { connectionsNotify } from "../src/console/panels/connections.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";

const AT = Date.UTC(2026, 10, 1, 12);
const run = (change = {}) => buildHookRun({ jobId: "gh-1", outcome: "failed", reason: "infra", detail: "exit", code: 0, ...change }, AT - 60_000);
const history = (runs) => ({ hosts: [{ name: "mini1", runs }], partial: false, more: 0 });
const reads = { environment: () => ({ env: {} }), endpoints: () => [], allowlist: () => [] };

test("Connections alone reads history using live names; Setup opts out; model projection gets safe records and counts", async () => {
  const calls = [];
  const options = { now: AT, redis: {}, snapshot: { hostBudgets: [{ name: "mini1" }] }, reads: { ...reads, hookRuns: (_redis, opts) => { calls.push(opts); return history([run({ code: 3 }), run({ detail: "timeout", code: null })]); } } };
  const view = await readConnections(options);
  assert.deepEqual(calls, [{ names: ["mini1"] }]);
  const model = modelConnections(view);
  assert.deepEqual(model.hookRuns.hosts[0].counts, { exit: 1, timeout: 1 });
  assert.equal(model.hookRuns.hosts[0].runs[0].code, 3);
  await readConnections({ ...options, publications: false });
  assert.equal(calls.length, 1, "the shared Setup metadata read does not read published history");
  const down = await readConnections({ ...options, reads: { ...reads, hookRuns: () => { throw Error("private-token"); } } });
  assert.equal(down.notify.history.partial, true);
  assert.doesNotMatch(JSON.stringify(modelConnections(down)), /private-token/);
  assert.equal(modelConnections({ notify: { history: history([{ ...run(), jobId: "private/path" }]) } }).hookRuns.hosts[0].counts, null);
});

test("both human roles get actual last outcome and retained counts; hook errors are distinguishable without colour", () => {
  for (const role of ["operator", "viewer"]) for (const fields of [{ code: 3 }, { code: 1000 }, { code: 3221225477 }, { detail: "timeout", code: null }, { detail: "unresolvable", code: null }]) {
    const facts = { hook: null, unknown: false, triggers: [], history: history([run(fields), run()]) };
    const markup = String(connectionsNotify({ role, data: { connections: { notify: facts } } }));
    const doc = parseDocument(`<html><body>${markup}</body></html>`);
    assert.equal(doc.querySelector('a[href="/run?id=gh-1"]').textContent, "gh-1");
    assert.ok(doc.querySelector('a[href="/fleet/host?name=mini1"]'));
    assert.match(markup, /datetime="2026-11-01T11:59:00.000Z"/);
    const status = doc.querySelector(".tone-attention");
    assert.match(status.textContent, fields.detail === "timeout" ? /timeout/ : fields.detail === "unresolvable" ? /unresolvable/ : new RegExp(`exit \\(exit ${fields.code}\\)`));
    assert.match(doc.body.textContent, /Run: failed.*infra/);
    assert.match(doc.body.textContent, /exit: (?:1|2)/);
    assert.doesNotMatch(markup, /<form/);
  }
  for (const current of [{ partial: false, more: 0, hosts: [] }, { partial: false, more: 0, hosts: [{ name: "mini1", runs: [], absent: true }] }]) {
    const markup = String(connectionsNotify({ role: "viewer", data: { connections: { notify: { triggers: [], history: current } } } }));
    assert.match(markup, /no hook run published/);
    assert.doesNotMatch(markup, /healthy|delivered|tone-ok/);
  }
  const unavailable = String(connectionsNotify({ role: "viewer", data: { connections: { notify: { triggers: [], history: { partial: true, more: 0, hosts: [] } } } } }));
  assert.match(unavailable, /hook history unavailable/);
  assert.doesNotMatch(unavailable, /no hook run published/);
});
