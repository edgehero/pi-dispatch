import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionsEndpoints, connectionsForges } from "../src/console/panels/connections.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";

const context = (endpoints, extra = {}) => ({ role: "viewer", data: { connections: { endpoints, egress: { hosts: [] }, providers: [], receiver: { port: 3000 }, forges: [], ...extra } } });
const documentOf = (markup) => parseDocument(`<html><body>${String(markup)}</body></html>`);

test("endpoint occupancy distinguishes real fleet zero, failed reads and uncounted gates while retaining capacity", () => {
  const endpoint = { id: "model", host: "mini1.lan", port: 11434, keyless: true, slots: 4 };
  for (const [counting, used, first, reason] of [
    ["fleet", 0, "0 of 4", null],
    ["fleet", 2, "2 of 4", null],
    ["fleet", null, "unknown", "4 declared here"],
    ["per-machine", 0, "not counted", "4 declared · per-machine endpoint, no fleet bound"],
    ["worker-name-absent", 0, "not counted", "4 declared · PI_WORKER_NAME not declared in .env, no fleet bound"],
    ["unknown", null, "unknown", "4 declared · fleet counting unavailable"],
    [undefined, 0, "unknown", "4 declared · fleet counting unavailable"],
  ]) {
    const doc = documentOf(connectionsEndpoints(context([{ ...endpoint, counting, used }])));
    const row = doc.querySelector("tbody tr");
    const cell = row.querySelectorAll("td").at(-1);
    assert.ok(cell.textContent.replace(/\s+/g, " ").startsWith("Fleet leases: "+first), `${counting}: ${cell.textContent}`);
    if (reason) {
      assert.match(cell.textContent, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(cell.textContent, /(?:0|null|unknown|not counted) of 4/);
      assert.equal(cell.classList.contains("wide"), true, "the complete observation fact gets the stacked table's full phone row");
    } else {
      assert.equal(cell.classList.contains("wide"), true, "fleet and host occupancy share one full-width phone fact");
    }
    assert.match(row.textContent, /model.*mini1\.lan:11434.*keyless/);
  }
  const capped = String(connectionsEndpoints(context([{ ...endpoint, counting: "fleet", used: 5 }])));
  assert.match(capped, /5 of 4.*leases exceed the current declaration/);
  assert.equal(documentOf(capped).querySelector("tbody tr").querySelectorAll("td").at(-1).classList.contains("wide"), true);
});

test("delivery guidance directs quiet 401/404 refusals to forge history and qualifies receiver-log help", () => {
  const doc = documentOf(connectionsForges(context([])));
  const note = doc.querySelector(".cn-note").textContent;
  assert.equal(note, "Delivery health is not published. Check the forge's delivery history for 401/404 refusals; the receiver log can help with 503 or enqueue failures.");
  assert.doesNotMatch(note, /all failures|every 503|history or the receiver/);
});
