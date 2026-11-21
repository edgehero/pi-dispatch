import assert from "node:assert/strict";
import { test } from "node:test";
import * as panels from "../src/console/panels/connections.mjs";
import { modelConnections } from "../src/connections-view.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";
import { consoleConnectionsFixture } from "./helpers/configuration-goldens.mjs";

// Issue #970: the pollers' heartbeats on Connections, a second line under GitHub's polling, in words rather than a golden.
const AT = Date.UTC(2026, 10, 21, 12);
const RUNNING = "0123456789abcdef";
const poller = (fields = {}) => ({ v: 1, name: "mini2", version: "5.4.2", startedAt: AT - 3_600_000, at: AT - 12_000, ttlMs: 360_000, nextAt: AT + 48_000, intervalSeconds: 60, repos: 2, triggers: "current", refusal: null, running: RUNNING, rejected: null, rejectedAt: null, ageMs: 12_000, ...fields });
const kept = (fields = {}) => poller({ triggers: "kept", refusal: "refused", rejected: "fedcba9876543210", rejectedAt: AT - 30_000, ...fields });
const draw = (name, value, options = {}) => String(panels[name]({ role: "operator", data: { connections: value }, ...options }));
/** The words as read: `cardText` leaves a space where a tag closed before punctuation ("mini2 ,"). */
const words = (markup) => cardText(markup).replace(/ ([,:;.])/g, "$1");

/** The Connections facts with `pollers` as the heartbeats' source, and any other change to the fixture's reads. */
const facts = (pollers, change = () => {}, options = {}) => consoleConnectionsFixture(AT, { ...options, change: (snapshot, reads) => { reads.pollers = pollers; change(snapshot, reads); } });

/** GitHub's Polling cell, as drawn for `role` (an operator who may act unless `readOnly`). */
function pollingCell(value, options = {}) {
  const doc = cardDocument(draw("connectionsForges", value, options));
  const row = doc.nodes.find((node) => node.tag === "tr" && cardText(doc.within(node)).startsWith("github"));
  assert.ok(row, "the github row");
  const rowDoc = cardDocument(doc.within(row));
  const cell = rowDoc.nodes.find((node) => node.tag === "td" && node.attrs["data-l"] === "Polling");
  assert.ok(cell, "its Polling cell");
  return rowDoc.within(cell);
}

/** The labelled state `word` in `markup`, with its tone and glyph beside the word. */
function marked(markup, word, glyph, tone) {
  const doc = cardDocument(markup);
  const hit = doc.nodes.find((node) => node.classes.includes("cn-state") && cardText(doc.within(node)) === word);
  assert.ok(hit, `${word}: a labelled state`);
  assert.ok(hit.classes.includes(`tone-${tone}`), `${word}: its tone`);
  assert.ok(doc.descendants(hit).some((node) => node.tag === "use" && node.attrs.href === `#i-${glyph}`), `${word}: its glyph`);
}

test("a reporting poller is a second line under GitHub's polling: its host, linked, and its beat age", async () => {
  const value = await facts(async () => ({ hosts: [poller()], complete: true, more: 0 }));
  const cell = pollingCell(value);
  assert.equal(words(cell), "on · 60 s App installation repositories poller running on mini2, beat 12s ago");
  assert.match(cell, /<a href="\/fleet\/host\?name=mini2">mini2<\/a>/);
  assert.equal(value.problems.some((p) => p.kind === "poller"), false, "a poller on the current file is no problem");
});

test("a poller on an older triggers file is in the attention tone, with the command for an operator and a sentence for anyone else", async () => {
  const value = await facts(async () => ({ hosts: [kept()], complete: true, more: 0 }));
  const operator = pollingCell(value);
  marked(operator, "on an older triggers file", "attention", "attention");
  assert.match(words(operator), /poller on mini2, beat 12s ago: on an older triggers file Run pi-dispatch triggers check on that host\.$/);
  assert.match(operator, /<span class="code">pi-dispatch triggers check<\/span>/);
  for (const options of [{ role: "viewer" }, { readOnly: true }]) {
    const cell = pollingCell(value, options);
    marked(cell, "on an older triggers file", "attention", "attention");
    assert.match(words(cell), /on an older triggers file An operator can check the triggers file on that host\.$/, JSON.stringify(options));
    assert.doesNotMatch(cell, /pi-dispatch triggers check/, "no command to copy");
  }
});

test("the older file is a problem after every other, so each banner keeps its place, and it leads only alone", async () => {
  const alone = await facts(async () => ({ hosts: [kept()], complete: true, more: 0 }));
  assert.deepEqual(alone.problems.map((p) => p.kind), ["poller"]);
  assert.deepEqual(alone.problems[0], { kind: "poller", host: "mini2", title: "The poller runs on an older triggers file", text: "The poller on mini2 refused the current triggers.json and polls with the last copy that loaded, so a trigger added or changed since does not apply to the events it polls.", fix: "Run pi-dispatch triggers check on that host and correct the file; the poller takes it at its next cycle.", run: null });
  const banner = cardText(draw("connectionsProblems", alone));
  assert.match(banner, /^The poller runs on an older triggers file The poller on mini2 refused the current triggers\.json/);
  const missing = await facts(async () => ({ hosts: [kept({ refusal: "missing", rejected: null })], complete: true, more: 0 }));
  assert.match(missing.problems[0].text, /^The poller on mini2 found no triggers\.json and polls/);
  for (const problem of ["proxy", "forge", "endpoints"]) {
    const value = await facts(async () => ({ hosts: [kept()], complete: true, more: 0 }), () => {}, { problem });
    assert.equal(value.problems[0].kind, problem, `${problem} still leads`);
    assert.equal(value.problems.at(-1).kind, "poller", `${problem}: the poller's is last`);
    assert.doesNotMatch(cardText(draw("connectionsProblems", value)), /older triggers file/);
  }
});

test("with none reporting and polling on, a complete read says no poller reported and an incomplete one poller not known", async () => {
  const none = pollingCell(await facts(async () => ({ hosts: [], complete: true, more: 0 })));
  marked(none, "no poller reported", "info", "attention");
  assert.match(cardText(none), /App installation repositories no poller reported$/);
  for (const source of [async () => ({ hosts: [], complete: false, more: 0 }), async () => { throw new Error("PRIVATE_DETAIL"); }]) {
    const unknown = pollingCell(await facts(source));
    marked(unknown, "poller not known", "info", "attention");
    assert.doesNotMatch(unknown, /PRIVATE_DETAIL|no poller reported/);
  }
  const unreadable = pollingCell(await facts(async () => ({ hosts: [{ name: "mini2", unreadable: true }], complete: false, more: 0 })));
  marked(unreadable, "heartbeat unreadable", "info", "attention");
  // Polling off (no POLL_REPOS, no App): nothing to say of a poller that is not reported.
  const off = await facts(async () => ({ hosts: [], complete: true, more: 0 }), (_, reads) => { reads.environment = () => ({ env: { GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "fixture-only" } }); });
  assert.equal(cardText(pollingCell(off)), "off");
});

test("a view read without heartbeats draws the polling cell as before, and the agent's model never carries them", async () => {
  const without = await facts(async () => undefined);
  assert.equal(Object.hasOwn(without, "pollers"), false);
  assert.equal(cardText(pollingCell(without)), "on · 60 s App installation repositories");
  const value = await facts(async () => ({ hosts: [kept()], complete: true, more: 0 }));
  assert.equal(value.pollers.hosts[0].name, "mini2");
  const model = modelConnections(value);
  assert.equal(Object.hasOwn(model, "pollers"), false);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(`${RUNNING}|fedcba9876543210|older triggers`));
});
