import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildHookRun } from "@edgehero/pi-dispatch/hook-runs";
import { readConnections, modelConnections } from "../src/connections-view.mjs";
import { connectionsNotify } from "../src/console/panels/connections.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";

const AT = Date.UTC(2026, 10, 1, 12);
const run = (change = {}) => buildHookRun({ jobId: "gh-1", outcome: "failed", reason: "infra", detail: "exit", code: 0, ...change }, AT - 60_000);
const history = (runs) => ({ hosts: [{ name: "mini1", runs }], partial: false, more: 0 });
const reads = { environment: () => ({ env: {} }), endpoints: () => [], allowlist: () => [] };

test("the published hook reference retains the complete last-run and detail-count cells", () => {
  const reference = readFileSync(new URL("../../design/system/components/ConnectionsScreen/preview.html", import.meta.url), "utf8");
  const doc = parseDocument(reference);
  const table = doc.querySelector("#p-notify table");
  assert.ok(table);
  const rows = table.querySelectorAll("tbody tr");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    assert.equal(cells.length, 3, "a last-run colspan must not drop the retained-count cell");
    assert.equal(cells[1].getAttribute("data-l"), "Last hook run", "the phone retains a readable last-run label");
    assert.equal(cells[2].getAttribute("data-l"), "Retained runs by detail", "the phone retains its count label");
    assert.ok(cells.every((cell) => Number(cell.getAttribute("colspan") ?? 1) === 1));
  }
  const first = rows[0].querySelectorAll("td");
  assert.equal(first[0].textContent, "mini1");
  assert.equal(first[1].querySelector("time").getAttribute("datetime"), "2026-10-08T15:11:00Z");
  assert.match(first[1].textContent, /gh-f0c2.*timeout.*Run: failed/);
  assert.deepEqual(Object.fromEntries([...first[2].textContent.matchAll(/(exit|timeout):\s*(\d+)/g)].map((match) => [match[1], Number(match[2])])), { exit: 2, timeout: 1 });
  const second = rows[1].querySelectorAll("td");
  assert.equal(second[1].textContent, "no hook run published");
  assert.equal(second[2].textContent, "none");
});

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
