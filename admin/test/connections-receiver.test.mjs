import assert from "node:assert/strict";
import { test } from "node:test";
import { makeReceiverObservations, parseReceiverStatus, RECEIVER_OUTCOMES } from "@edgehero/pi-dispatch/receiver-status";
import { readConnections, modelConnections } from "../src/connections-view.mjs";
import { connectionsForges } from "../src/console/panels/connections.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";

const AT = Date.UTC(2026, 10, 1, 12, 0, 3);
function receiver({ change = () => {}, at = AT } = {}) {
  const observations = makeReceiverObservations({ now: () => at });
  change(observations);
  return { v: 1, name: "mini1", version: "4.3.1", startedAt: at - 100_000, at, port: 49155, bind: "loopback", forges: ["github"], deliveries: observations.snapshot(), ageMs: 0 };
}
const sources = (status) => ({ environment: () => ({ env: { GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "secret" } }), allowlist: () => [], endpoints: () => [], receivers: async () => status });
const snapshot = { hostBudgets: [{ name: "mini1" }], doctor: { hosts: [] }, triggers: { triggers: [{ index: 1, forge: "github", type: "comment" }] } };
const view = (status, extra = {}) => readConnections({ snapshot, reads: sources(status), now: AT, ...extra });
const draw = (facts, role = "operator") => String(connectionsForges({ role, data: { connections: facts } }));

function outcomeCounts(markup) {
  const doc = parseDocument(`<html><body>${markup}</body></html>`);
  const table = doc.querySelectorAll("table").find((n) => n.getAttribute("aria-label") === "mini1 github delivery outcomes");
  assert.ok(table);
  return Object.fromEntries(table.querySelectorAll("tbody tr").map((row) => row.querySelectorAll("td").map((cell) => cell.textContent.trim())));
}

test("Connections shows each receiver's real location, correct totals and last handoff/refusal for both roles (#775)", async () => {
  const row = receiver({ change: (o) => { o.observe("github", 202, "queued"); o.observe("github", 202, "held"); o.observe("github", 401); o.observe("github", 204); } });
  const facts = await view({ hosts: [row], complete: true, more: 0 });
  for (const role of ["operator", "viewer"]) {
    const result = draw(facts, role);
    const counts = outcomeCounts(result);
    assert.equal(counts.queued, "1"); assert.equal(counts.held, "1"); assert.equal(counts.unauthorized, "1"); assert.equal(counts.dropped, "1");
    for (const word of RECEIVER_OUTCOMES) assert.equal(Number(counts[word]), ["queued", "held", "unauthorized", "dropped"].includes(word) ? 1 : 0, word);
    assert.match(result, /href="\/fleet\/host\?name=mini1"/); assert.match(result, /Port 49155.*loopback/);
    assert.match(result, /Last taken/); assert.match(result, /Last refused/); assert.doesNotMatch(result, /only unauthorized|No live receiver reported for github/);
    assert.equal((result.match(/<summary>/g) ?? []).length, 2, "native disclosures work without JavaScript");
  }
});

test("complete maximum-length receiver identities and named links survive reported and unreadable states for both roles (#775)", async () => {
  const name = "W".repeat(64);
  const row = { ...receiver({ change: (o) => o.observe("github", 401) }), name };
  assert.ok(parseReceiverStatus(JSON.stringify(row)), "the maximum identity is valid publication data");
  for (const role of ["operator", "viewer"]) for (const unreadable of [false, true]) {
    const facts = await view({ hosts: [unreadable ? { name, unreadable: true } : row], complete: !unreadable, more: 0 });
    const doc = parseDocument(`<html><body>${draw(facts, role)}</body></html>`);
    const links = doc.querySelectorAll(".cn-receivers a");
    assert.equal(links.length, 1);
    assert.equal(links[0].textContent, name);
    assert.equal(links[0].getAttribute("href"), `/fleet/host?name=${name}`);
    if (unreadable) assert.match(doc.body.textContent, /receiver observation unreadable/);
    else {
      assert.equal(modelConnections(facts).receivers.hosts[0].name, name);
      const table = doc.querySelectorAll("table").find((n) => n.getAttribute("aria-label") === `${name} github delivery outcomes`);
      const counts = Object.fromEntries(table.querySelectorAll("tbody tr").map((tr) => tr.querySelectorAll("td").map((cell) => cell.textContent.trim())));
      assert.equal(counts.unauthorized, "1", "the complete identity still names the actual observations");
    }
  }
});

test("only unauthorized warns only for a nonempty pure refusal window; a drop or malformed request disproves it (#775)", async () => {
  for (const code of [null, 204, 400, 202]) {
    const row = receiver({ change: (o) => { o.observe("github", 401); if (code !== null) o.observe("github", code, code === 202 ? "queued" : undefined); } });
    const markup = draw(await view({ hosts: [row], complete: true, more: 0 }));
    assert.equal(markup.includes("only unauthorized"), code === null);
    if (code === null) assert.match(markup, /Check the webhook secret on both sides/);
  }
  assert.doesNotMatch(draw(await view({ hosts: [receiver()], complete: true, more: 0 })), /only unauthorized/);
});

test("an absent receiver is a warning only after a complete read; malformed, partial and truncated reads stay unknown (#775)", async () => {
  assert.match(draw(await view({ hosts: [], complete: true, more: 0 })), /No live receiver reported for github/);
  for (const status of [{ hosts: [], complete: false, more: 0 }, { hosts: [receiver()], complete: false, more: 3 }, { hosts: [{ name: "mini1", unreadable: true }], complete: false, more: 0 }]) {
    const markup = draw(await view(status)); assert.doesNotMatch(markup, /No live receiver reported for github|only unauthorized/); assert.match(markup, /Counts and receiver absence are unknown/);
  }
});

test("unserved forge refusals remain visible and actionable alongside served forges (#775)", async () => {
  const row = receiver({ change: (o) => o.observe("gitlab", 404) });
  const result = draw(await view({ hosts: [row], complete: true, more: 0 }));
  assert.match(result, /gitlab: deliveries reached an unconfigured route/); assert.match(result, /gitlab.*not served/s); assert.match(result, /mini1 gitlab delivery outcomes/);
});

test("an unserved forge keeps lifetime last-event times after every hourly count has expired (#775)", async () => {
  for (const [status, result, label] of [[404, undefined, "Last refused"], [202, "queued", "Last taken"]]) {
    let clock = AT - 25 * 3_600_000;
    const lastAt = clock;
    const observations = makeReceiverObservations({ now: () => clock });
    observations.observe("gitlab", status, result);
    clock = AT;
    const row = { ...receiver(), startedAt: AT - 26 * 3_600_000, deliveries: observations.snapshot() };
    for (const role of ["operator", "viewer"]) {
      const markup = draw(await view({ hosts: [row], complete: true, more: 0 }), role);
      const doc = parseDocument(`<html><body>${markup}</body></html>`);
      const table = doc.querySelectorAll("table").find((node) => node.getAttribute("aria-label") === "mini1 gitlab delivery outcomes");
      assert.ok(table, "an expired window cannot hide retained last-event evidence");
      assert.match(markup, /gitlab.*\(not served\)/s);
      const rows = table.querySelectorAll("tbody tr");
      assert.deepEqual(rows.map((tr) => tr.querySelectorAll("td")[0].textContent.trim()), RECEIVER_OUTCOMES);
      assert.ok(rows.every((tr) => tr.querySelectorAll("td")[1].textContent === "0"), "all eleven window counts really expired");
      const fact = doc.querySelectorAll(".fact").find((node) => node.querySelector("dt").textContent === label && node.querySelector("time"));
      assert.equal(fact.querySelector("time").getAttribute("datetime"), new Date(lastAt).toISOString());
      assert.doesNotMatch(markup, /gitlab: deliveries reached an unconfigured route|gitlab: only unauthorized/, "lifetime evidence does not invent current-window warnings");
    }
  }
});

test("an unserved route without history stays hidden while a recent filter drop remains visible (#775)", async () => {
  for (const status of [null, 204]) {
    const row = receiver({ change: (o) => { if (status !== null) o.observe("gitlab", status); } });
    const doc = parseDocument(`<html><body>${draw(await view({ hosts: [row], complete: true, more: 0 }))}</body></html>`);
    const table = doc.querySelectorAll("table").find((node) => node.getAttribute("aria-label") === "mini1 gitlab delivery outcomes");
    if (status === null) assert.equal(table, undefined, "a configured route row is not fabricated delivery history");
    else {
      const counts = Object.fromEntries(table.querySelectorAll("tbody tr").map((tr) => tr.querySelectorAll("td").map((cell) => cell.textContent.trim())));
      assert.equal(counts.dropped, "1");
      assert.equal(Object.values(counts).reduce((sum, n) => sum + Number(n), 0), 1);
    }
  }
});

test("the UTC rollover shifts hourly detail and sums consistently while last timestamps survive (#775)", async () => {
  const row = receiver({ at: AT - 10_000, change: (o) => o.observe("github", 202, "queued") });
  const facts = await view({ hosts: [row], complete: true, more: 0 });
  const result = draw(facts);
  const doc = parseDocument(`<html><body>${result}</body></html>`);
  const hourly = doc.querySelectorAll("table").find((n) => n.getAttribute("aria-label") === "mini1 github delivery counts per UTC hour");
  const rows = hourly.querySelectorAll("tbody tr");
  assert.equal(rows.length, 24); assert.equal(rows.at(-1).querySelectorAll("td")[0].textContent, "2026-11-01 12:00 UTC");
  assert.equal(hourly.querySelectorAll("time").length, 0, "UTC buckets cannot be rewritten into local hours by the browser script");
  const scroll = doc.querySelector(".cn-receiver-hours-scroll");
  assert.equal(scroll.getAttribute("tabindex"), "0"); assert.equal(scroll.getAttribute("role"), "region");
  assert.equal(scroll.getAttribute("aria-label"), "mini1 github delivery hours, scroll horizontally");
  assert.equal(rows.at(-1).querySelectorAll("td")[2].textContent, "0"); assert.equal(rows.at(-2).querySelectorAll("td")[2].textContent, "1");
  assert.equal(outcomeCounts(result).queued, "1");
});

test("Setup's publications optout performs no new reads, and the model projection revalidates telemetry (#775)", async () => {
  let called = 0;
  await readConnections({ snapshot, reads: { ...sources(null), receivers: async () => { called++; throw new Error("must not read"); } }, publications: false, now: AT });
  assert.equal(called, 0);
  const row = receiver({ change: (o) => o.observe("github", 401) });
  const facts = await view({ hosts: [row], complete: true, more: 0 });
  const model = modelConnections(facts).receivers;
  assert.equal(model.hosts[0].deliveries.github.counts.unauthorized, 1); assert.equal(model.hosts[0].deliveries.github.lastRefused, AT);
  const hostile = { ...row, address: "SECRET_SENTINEL", deliveryId: "SECRET_SENTINEL", body: "SECRET_SENTINEL" };
  assert.ok(parseReceiverStatus(JSON.stringify(hostile)));
  assert.doesNotMatch(JSON.stringify(modelConnections({ ...facts, receiver: { complete: true, more: 0, hosts: [hostile] } })), /SECRET_SENTINEL/);
  const bad = modelConnections({ ...facts, receiver: { complete: true, more: 0, hosts: [{ ...row, v: 2 }] } }).receivers;
  assert.deepEqual(bad.hosts, []); assert.equal(bad.complete, false);
});

test("a newly started receiver never presents pre-start hours as measured zeroes (#775)", async () => {
  const row = receiver({ change: (o) => o.observe("github", 401) });
  row.startedAt = AT - 10_000;
  const markup = draw(await view({ hosts: [row], complete: true, more: 0 }));
  const doc = parseDocument(`<html><body>${markup}</body></html>`);
  const table = doc.querySelectorAll("table").find((n) => n.getAttribute("aria-label") === "mini1 github delivery counts per UTC hour");
  const rows = table.querySelectorAll("tbody tr");
  assert.equal(rows[0].querySelectorAll("td")[1].textContent, "before receiver started");
  assert.ok(rows[0].querySelectorAll("td").slice(2).every((cell) => cell.textContent === "not observed"));
  assert.match(rows.at(-2).querySelectorAll("td")[1].textContent, /since 2026-11-01 11:59 UTC/);
  assert.equal(rows.at(-1).querySelectorAll("td")[7].textContent, "1", "the actual unauthorized delivery remains counted in its observed hour");
  assert.match(markup, /counts since then within 24 UTC hours/);
});
