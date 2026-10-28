import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKEND_NAMES, servesOf, SERVES } from "@edgehero/pi-dispatch/backends";
import { SERVES_TEXT, CUSTODY_TEXT, venueCustody } from "../src/read-model.mjs";
import { phases, noProgress } from "../src/console/kit.mjs";
import { runChat, runSummary, runSandbox, runTranscriptState, runHeadline, runRest, runTail, runSecrets, runModels, runResources, runCostPanel } from "../src/console/panels/run.mjs";
import { pagePanels, renderPage, loadPageData } from "../src/console/pages.mjs";

const AT = Date.UTC(2026, 9, 28, 10);
const record = (extra = {}) => ({ jobId: "gh-pulse", outcome: "completed", reason: null, kind: "github", target: "acme/web#42", host: "mini1", backend: "local", flow: "fix", project: "web", startedAt: new Date(AT - 60_000).toISOString(), endedAt: new Date(AT).toISOString(), ...extra });
const view = (data, role = "operator") => ({ role, query: { id: "gh-pulse" }, readOnly: false, env: {}, now: AT, data });

test("phase chapters bound ticks and escape names; no-progress stripes have a text alternative", () => {
  const p = String(phases({ names: ["plan", "<build>", "test"], index: 1, done: 2, total: 4 }));
  assert.equal((p.match(/<i/g) ?? []).length, 4);
  assert.equal((p.match(/class="on"/g) ?? []).length, 2);
  assert.match(p, /is-done/);
  assert.match(p, /aria-current="step"/);
  assert.match(p, /&lt;build&gt;/);
  for (const total of [null, 0, 33, Infinity]) assert.doesNotMatch(String(phases({ names: ["one"], total, done: 1 })), /<i[ >]/);
  assert.match(String(noProgress()), /role="img" aria-label="The worker reports no progress/);
});

test("#739 running without stream and parked expired transcript use truthful location words", () => {
  const live = view({ run: { missing: true }, chat: { state: "active", mode: "live", jobState: "active" }, transcript: { exists: false }, inbox: { found: false } });
  assert.match(String(runTranscriptState(live)), /Waiting for the run/);
  const parked = view({ run: { record: record({ reason: "awaiting-input" }) }, chat: { state: "parked", mode: "reply" }, transcript: { exists: false } });
  const text = String(runChat(parked));
  assert.match(text, /Read the question on the forge thread/);
  assert.doesNotMatch(text, /below|data-run-question/);
  const kept = String(runChat(view({ ...parked.data, transcript: { exists: true } })));
  assert.match(kept, /<div data-run-question><\/div>/);
  assert.doesNotMatch(kept, /agent question text/);
  assert.match(String(runTail(view({ ...parked.data, transcript: { exists: true } }))), /<div data-run-tail><\/div>/);
});

test("#739 cancelled before start collapses unused panels; saved sessions alone offer a fork", () => {
  const refused = view({ run: { record: record({ outcome: "policy", reason: "operator-cancel", budgetReserved: false, exitCode: null, tokens: null }) } });
  assert.match(String(runRest(refused)), /Nothing ran/);
  for (const render of [runCostPanel, runResources, runTail]) assert.equal(String(render(refused)), "");
  const fork = (session) => String(runChat(view({ run: { record: record({ session }) }, chat: { state: "finished", mode: "fork" } })));
  assert.match(fork({ resumed: false, reason: "promote-failed", bytes: 22 }), /no saved transcript to fork/);
  assert.doesNotMatch(fork(null), /data-copy/);
  assert.match(fork({ resumed: true, bytes: 2000 }), /data-copy/);
});

test("sandbox words come from every venue's declarations and credential custody; retained deadline is shown", () => {
  for (const backend of BACKEND_NAMES) {
    const out = String(runSandbox(view({ run: { record: record({ backend }) } })));
    for (const key of SERVES) assert.ok(out.includes(SERVES_TEXT[key][servesOf(backend)[key]].replace(/'/g, "&#39;")), `${backend}: ${key}`);
    assert.ok(out.includes(CUSTODY_TEXT[venueCustody(backend)].replace(/'/g, "&#39;")), backend);
  }
  const kept = String(runSandbox(view({ run: { record: record() }, sandboxCheck: { retained: true, until: AT + 60_000 } })));
  assert.match(kept, /until <time datetime="2026-10-28T10:01:00.000Z"/);
  assert.match(String(runSandbox(view({ run: { record: record() }, sandboxCheck: { retained: false, why: "swept" } }))), /swept/);
});

test("title cancel guard, trigger numbering and turn budget use the shared state and record facts", () => {
  const v = view({ activeRun: { target: "acme/web#42", host: "mini1", maxTurns: 40 }, chat: { state: "active", jobState: "active", mode: "live" }, run: { missing: true } });
  assert.match(String(runHeadline(v)), /data-action="cancel-active"/);
  assert.doesNotMatch(String(runHeadline({ ...v, role: "viewer" })), /data-action/);
  assert.doesNotMatch(String(runHeadline({ ...v, readOnly: true })), /data-action/);
  const summary = String(runSummary(view({ run: { record: record({ triggerIndex: 0, triggerType: "comment", turns: 14, maxTurns: 40 }) } })));
  assert.match(summary, /row 1/);
  assert.match(summary, /14 of 40/);
});

test("run page has one fixed panel set and static transcript inside the page grid, with long cron IDs", async () => {
  const id = `repeat:${"long-trigger".repeat(10)}:1793181600000`;
  const data = { now: AT, run: { record: record({ jobId: id }) }, chat: { state: "finished", mode: "fork" }, transcript: { exists: false } };
  const ctx = { query: { id }, session: { name: "ops", role: "operator" }, data };
  const got = await renderPage("run", ctx);
  assert.doesNotMatch(String(got.html), /class="legacy"/);
  assert.match(String(got.html), /<h1>repeat:/);
  assert.match(String(got.html), /<section id="p-transcript" data-panel>[\s\S]*?<\/section><div id="transcript"/);
  assert.match(String(got.html), /class="cols"/);
  const panels = await pagePanels("run", ctx);
  assert.ok(panels.some((p) => p.id === "p-headline"));
  assert.ok(panels.every((p) => !p.html.includes('id="transcript"')));
});

test("running facts are loaded only without a record and no extra queue field is serialized", async () => {
  let called = 0;
  const fleet = { runById: async () => ({ missing: true }), runLiveFacts: async () => { called++; return { target: "acme/web#42", kind: "github", host: "mini1", maxTurns: 40 }; } };
  const data = await loadPageData("run", { id: "gh-pulse" }, { fleet, now: () => AT });
  assert.equal(called, 1);
  assert.equal(data.activeRun.maxTurns, 40);
  fleet.runById = async () => ({ record: record() });
  await loadPageData("run", { id: "gh-pulse" }, { fleet, now: () => AT });
  assert.equal(called, 1);
});

test("the viewer page and panel stream render only the viewer card's panels and never private words or actions", async () => {
  const { RUN_VIEWER_PANELS } = await import("../src/console/pages.mjs");
  const progress = { v: 1, turn: 3, steps: 4, failed: 1, interrupted: 0, running: [{ tool: "bash", since: AT - 2000 }], recent: [], phase: { index: 0, done: 1, total: 3 }, phases: ["PRIVATE-PHASE-747"], note: "PRIVATE-NOTE-747", prior: null, startedAt: AT - 60_000, updatedAt: AT, ended: false, outcome: null };
  const data = { now: AT, run: { record: record({ session: { resumed: true }, secretsProfile: "PRIVATE-PROFILE-747", startedAt: new Date(AT - 180_000).toISOString(), endedAt: new Date(AT - 120_000).toISOString(), tokens: { input: 1, output: 2, total: 3, cost: 1 }, resources: { memPeak: 100 } }) }, progress, chat: { state: "active", mode: "live", jobState: "active" }, transcript: { exists: true }, inbox: { found: true, steer: true, state: "active", open: true, entries: [] } };
  const ctx = { query: { id: "gh-pulse" }, session: { name: "view", role: "viewer" }, data };
  const panels = await pagePanels("run", ctx);
  for (const panel of panels) if (!RUN_VIEWER_PANELS.includes(panel.id) && !["p-nav-parked", "p-headline"].includes(panel.id)) assert.equal(panel.html, "", panel.id);
  const payload = panels.map((p) => p.html).join("");
  assert.doesNotMatch(payload, /PRIVATE-PHASE|PRIVATE-NOTE|PRIVATE-PROFILE|data-action|data-copy|<form|<textarea|data-run-question|data-run-tail/);
  assert.match(payload, /Phase 1 of 1: 1 of 3 done/);
  const page = String((await renderPage("run", ctx)).html);
  assert.match(page, /Transcripts are shown to operators only/);
  assert.doesNotMatch(page, /data-transcript data-job|PRIVATE-PHASE|PRIVATE-NOTE|PRIVATE-PROFILE|data-action|data-copy|<form|<textarea/);
});

test("a refusal keeps the static transcript outside swaps but its empty state panel hides the unused box", async () => {
  const { RUN_CSS } = await import("../src/console/run-css.mjs");
  const data = { now: AT, run: { record: record({ outcome: "policy", reason: "operator-cancel", budgetReserved: false, exitCode: null, tokens: null, dollars: null }) } };
  const ctx = { query: { id: "gh-pulse" }, session: { name: "ops", role: "operator" }, data };
  const panels = await pagePanels("run", ctx);
  assert.equal(panels.find((p) => p.id === "p-transcript").html, "");
  const page = String((await renderPage("run", ctx)).html);
  assert.match(page, /<section id="p-transcript" data-panel><\/section><div id="transcript"/);
  assert.match(RUN_CSS, /#p-transcript:empty \+ #transcript \{ display: none; \}/);
});

test("run outcome actions get a full wrapping row so a refused re-run explanation cannot widen a phone", async () => {
  const { RUN_CSS } = await import("../src/console/run-css.mjs");
  assert.match(RUN_CSS, /\.banner__act \{[^}]*grid-column: 1 \/ -1;[^}]*flex-wrap: wrap;/);
  assert.match(RUN_CSS, /\.banner__act \.card__sub \{ flex-basis: 100%; overflow-wrap: anywhere; \}/);
});

test("the parked question leads the main column while live steering stays in the side column", async () => {
  const ctx = (mode) => ({ session: { role: "operator" }, query: { id: "gh-pulse" }, data: { now: AT, run: { record: record({ reason: mode === "reply" ? "awaiting-input" : null }) }, chat: { state: mode === "reply" ? "parked" : "active", mode, jobState: "active" }, transcript: { exists: true } } });
  const parked = String((await renderPage("run", ctx("reply"))).html);
  assert.match(parked, /class="stack run-main"><section id="p-chat" data-panel>/);
  assert.equal((parked.match(/id="p-chat"/g) ?? []).length, 1);
  const live = String((await renderPage("run", ctx("live"))).html);
  assert.match(live, /class="stack run-side"><section id="p-chat" data-panel>/);
});
