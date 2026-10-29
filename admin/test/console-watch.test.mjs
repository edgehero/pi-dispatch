import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWatchData, parseWatchQuery, publicBoardSummary, watchPanel, watchBoardPanel, getWatchTrace, sourceSummaries, cooldownLeft, decisionTotals } from "../src/console/watch.mjs";
import { parsePageQuery, loadPageData, PAGES } from "../src/console/pages.mjs";
import { lookupRoute } from "../src/console/server.mjs";
import { actionNamed } from "../src/console/actions.mjs";

const PRIVATE = "PRIVATE-WATCH-SAMPLE-6c20<script>alert(1)</script>";
const board = { version: 2, frozen: false, blocks: [{ type: "number", value: 37, title: PRIVATE }, { type: "note", text: PRIVATE }], versions: [{ version: 1, blocks: [] }] };
const store = (calls = []) => ({
  async listRules() { return [{ id: "shop", source: "alerts" }]; },
  async listFindings(rule) { calls.push(["findings", rule]); return [{ id: "f1", count: 37, severity: "error", status: "queued", samples: [PRIVATE] }]; },
  async readBoard(rule) { calls.push(["board", rule]); return board; },
  async readFinding(id, opts) { calls.push(["finding", id, opts]); return opts.private ? { id, samples: [PRIVATE] } : { id }; },
  async readTrace(id, opts) { calls.push(["trace", id, opts]); return [{ kind: "decide", option: "investigate", state: PRIVATE }]; },
});

function view(data, role = "viewer", readOnly = false) { return { query: { rule: "shop", finding: "f1" }, role, readOnly, data: { watch: data } }; }

test("watch queries refuse unknown, duplicate, malformed and missing identifiers before reads", () => {
  for (const query of ["rule=shop&rule=shop", "rule=../secret", "rule=shop&sample=private"]) assert.ok(parseWatchQuery(new URLSearchParams(query)).refusal);
  assert.ok(parseWatchQuery(new URLSearchParams(), { board: true }).refusal);
  assert.deepEqual(parsePageQuery("watch-board", "rule=shop&finding=f1").query, { rule: "shop", finding: "f1" });
  assert.equal(PAGES.watch.auth, "viewer");
  assert.equal(PAGES["watch-board"].live, false, "private evidence is never placed in shared live panels");
});

test("shared page loading asks only for public finding and trace projections", async () => {
  const calls = [];
  const data = await loadPageData("watch-board", { rule: "shop", finding: "f1" }, { watch: store(calls), now: () => 100 });
  assert.deepEqual(calls.filter((c) => c[0] === "finding" || c[0] === "trace"), [["finding", "f1", { private: false }], ["trace", "f1", { private: false }]]);
  for (const role of ["viewer", "operator"]) {
    const out = String(watchBoardPanel(view(data.watch, role)));
    assert.ok(!out.includes("PRIVATE-WATCH"), "a shared/public load contains no private board content");
    assert.ok(!out.includes("<script>"), "agent text is escaped");
    assert.equal(out.includes("/api/watch-trace"), role === "operator");
  }
  assert.deepEqual(publicBoardSummary(board), { version: 2, frozen: false, blockCount: 2, proposalCount: 0, versionCount: 1 });
});

test("unavailable is explicit; empty differs; every collector string is escaped", async () => {
  assert.equal((await loadWatchData(null, {})).unavailable, true);
  assert.equal((await loadWatchData({ listRules() { throw Error(PRIVATE); } }, {})).unavailable, true);
  assert.match(String(watchPanel(view({ unavailable: true }))), /could not be read/);
  assert.match(String(watchPanel(view({ rules: [], findings: [] }))), /No watch rules/);
  const out = String(watchPanel(view({ rules: [{ id: "shop", source: PRIVATE }], findings: [] })));
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(!out.includes("<script>"));
});

test("private evidence route is operator-only and never echoes backend error text", async () => {
  assert.equal(lookupRoute("GET", "/api/watch-trace").route.auth, "operator");
  const calls = [];
  let response;
  const ctx = { searchParams: new URLSearchParams("finding=f1"), deps: { pageDeps: { watch: store(calls) } }, json(status, body) { response = { status, body }; } };
  await getWatchTrace(ctx);
  assert.equal(response.status, 200);
  assert.equal(response.body.finding.samples[0], PRIVATE);
  assert.deepEqual(calls, [["finding", "f1", { private: true }], ["trace", "f1", { private: true }]]);
  ctx.deps.pageDeps.watch.readFinding = () => { throw Error(PRIVATE); };
  await getWatchTrace(ctx);
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response).includes("PRIVATE-WATCH"));
});

test("board controls are operator-only and absent on a read-only console", () => {
  for (const [role, readOnly, present] of [["operator", false, true], ["operator", true, false], ["viewer", false, false]]) {
    const out = String(watchBoardPanel(view({ board }, role, readOnly)));
    assert.equal(out.includes('data-action="board-freeze"'), present);
    assert.equal(out.includes('data-action="board-clear"'), present);
    assert.equal(out.includes('data-action="board-revert"'), present);
  }
});

test("board actions compare the version before preview and preserve it for atomic confirmation", async () => {
  const calls = [];
  const watch = { async readBoard() { return board; }, async mutateBoard(...args) { calls.push(args); return { ok: false, reason: "board-conflict" }; } };
  const ctx = { a: { watch } };
  const action = actionNamed("board-revert");
  const stale = await action.preview({ rule: "shop", expectedVersion: 1, version: 1 }, ctx);
  assert.equal(stale.status, 409);
  const missing = await action.preview({ rule: "shop", expectedVersion: 2, version: 9 }, ctx);
  assert.equal(missing.status, 404);
  const plan = await action.preview({ rule: "shop", expectedVersion: 2, version: 1 }, ctx);
  assert.equal(plan.target, "shop");
  const result = await action.apply({ payload: plan.payload }, ctx);
  assert.deepEqual(calls, [["shop", { action: "revert", version: 1 }, 2]]);
  assert.equal(result.invalid, "board-conflict");
  assert.equal(action.danger, true);
});

test("adoption previews proposed content, refuses frozen or missing proposals and preserves atomic version", async () => {
  const proposal = { id: "p1", blocks: [{ type: "number", value: 37, title: PRIVATE }] };
  const b = { ...board, proposals: [proposal] };
  const calls = [];
  const ctx = { a: { watch: { readBoard: async () => b, mutateBoard: async (...args) => (calls.push(args), { ok: true }) } } };
  const action = actionNamed("board-adopt");
  assert.equal(action.danger, false);
  const plan = await action.preview({ rule: "shop", expectedVersion: 2, proposalId: "p1" }, ctx);
  assert.ok(plan.summary.some((s) => s.includes("PRIVATE-WATCH")), "the operator sees what adoption would keep");
  assert.deepEqual(await action.apply({ payload: plan.payload }, ctx), { ok: true });
  assert.deepEqual(calls, [["shop", { action: "adopt", proposalId: "p1" }, 2]]);
  b.frozen = true;
  assert.equal((await action.preview({ rule: "shop", expectedVersion: 2, proposalId: "p1" }, ctx)).status, 409);
  b.frozen = false;
  assert.equal((await action.preview({ rule: "shop", expectedVersion: 2, proposalId: "missing" }, ctx)).status, 404);
  const output = String(watchBoardPanel(view({ board: b }, "viewer")));
  assert.ok(!output.includes("PRIVATE-WATCH") && !output.includes("p1"), "proposal text is never public");
});

test("watch trigger display includes configured rules before any delivery and omits secret references", async () => {
  const { readTriggers } = await import("../src/read-model.mjs");
  const got = readTriggers({ triggersPath: "/fake", fs: { readFileSync() { return JSON.stringify({ version: 1, watchSources: { alerts: { secretEnv: "PRIVATE_SECRET_REFERENCE" } }, triggers: [{ on: { type: "watch", id: "shop", source: "alerts", maxPerDay: 4 }, run: { kind: "local", folder: "/shop", flow: "triage", mode: "investigate" } }] }); } } });
  assert.equal(got.triggers[0].type, "watch");
  assert.equal(got.triggers[0].source, "alerts");
  assert.equal(got.triggers[0].maxPerDay, 4);
  assert.ok(!JSON.stringify(got).includes("PRIVATE_SECRET_REFERENCE"));
});

test("a chart is fixed SVG with numeric geometry and escaped labels, and all six board kinds are inert", () => {
  const blocks = [
    { type: "line", title: PRIVATE, traceId: "q1", points: [{ x: "start", y: 2 }, { x: "end", y: 5 }] },
    { type: "table", title: PRIVATE, traceId: "q2", columns: [PRIVATE], rows: [[PRIVATE]] },
    { type: "hypotheses", traceId: "q3", items: [PRIVATE] },
    { type: "timeline", traceId: "q4", items: [{ at: "now", text: PRIVATE }] },
  ];
  const output = String(watchBoardPanel(view({ board: { ...board, blocks } }, "operator")));
  assert.match(output, /<polyline fill="none" stroke="currentColor" points="10,90 290,10">/);
  assert.ok(output.includes("&lt;script&gt;"));
  assert.ok(!output.includes("<script>"));
  assert.ok(!output.includes("<style") && !output.includes("<iframe") && !output.includes("<img"));
  assert.ok(!String(watchBoardPanel(view({ board: { ...board, blocks } }, "viewer"))).includes("PRIVATE-WATCH"));
});


test("source delivery and refusal summaries preserve numeric strings and name unknown credential health", () => {
  const data = { sources: [{ id: "alerts", verify: "hmac-sha256" }], rules: [{ id: "shop", source: "alerts", summary: { lastDeliveryAt: "100000", suppressed: "7", capped: "2" } }, { id: "other", source: "alerts", summary: { lastDeliveryAt: "200000", suppressed: "3", capped: "1" } }], findings: [] };
  assert.deepEqual(sourceSummaries(data), [{ id: "alerts", verify: "hmac-sha256", lastDeliveryAt: 200000, suppressed: 10, capped: 3 }]);
  const output = String(watchPanel(view(data)));
  assert.match(output, /1970-01-01T00:03:20.000Z/);
  assert.match(output, /10 suppressed, 3 capped/);
  assert.match(output, /Credential health is unknown/);
});

test("cooldown uses the injected snapshot clock and never invents an expiry", () => {
  const now = 100000;
  assert.equal(cooldownLeft({ dueAt: now - 1000 }, { cooldownMs: 6000 }, now), 5000);
  assert.equal(cooldownLeft({ dueAt: now - 10000 }, { cooldownMs: 6000 }, now), 0);
  assert.equal(cooldownLeft({}, { cooldownMs: 6000 }, now), null);
});

test("model totals count retained decisions, distinguish unrecorded prices and declare truncation floors", () => {
  const findings = [{ decision: { model: "openrouter/classifier", action: "ignore", costUsd: 0.001 } }, { decision: { model: "openrouter/classifier", action: "file_issue" } }, { decision: { model: "bad model text", action: "ignore", costUsd: 100 } }];
  assert.deepEqual(decisionTotals(findings), [{ model: "openrouter/classifier", count: 2, costUsd: 0.001, unpriced: 1, investigate: 0, file_issue: 1, ignore: 1 }]);
  const output = String(watchBoardPanel(view({ board, findings: [...findings, ...Array.from({ length: 997 }, () => ({}))] })));
  assert.match(output, /This is a floor/);
  assert.match(output, /known spend \$0.001000/);
  assert.match(output, /1 without a recorded cost/);
});


test("viewer trace shows deterministic checks and counts, with no arbitrary check fields or private state", () => {
  const data = { board, findings: [], trace: [{ kind: "stream", source: "alerts", signature: "verified", count: 37 }, { kind: "rule", checks: { match: "passed", threshold: "at-window-end", cooldown: "active", cap: "passed" }, state: PRIVATE }] };
  const output = String(watchBoardPanel(view(data)));
  assert.match(output, /signature verified/);
  assert.match(output, /37 events/);
  assert.match(output, /cooldown: active/);
  assert.ok(!output.includes("PRIVATE-WATCH"));
});


test("only an explicit operator page load reads private samples and query state", async () => {
  for (const role of ["viewer", "operator", undefined]) {
    const calls = [];
    const data = await loadPageData("watch-board", { rule: "shop", finding: "f1" }, { watch: store(calls), now: () => 100 }, { role });
    assert.deepEqual(calls.filter((c) => c[0] === "finding" || c[0] === "trace").map((c) => c[2]), [{ private: role === "operator" }, { private: role === "operator" }]);
    const output = String(watchBoardPanel(view(data.watch, role ?? "viewer")));
    assert.equal(output.includes("PRIVATE-WATCH"), role === "operator");
    assert.ok(!output.includes("<script>"));
  }
});

test("quiet issue state is visible but arbitrary stored status and reasons are omitted", () => {
  const data = { rules: [{ id: "shop", source: "alerts", summary: { lastIssueStatus: "uncertain", lastIssueReason: "watch-issue-close-raced" } }], findings: [] };
  assert.match(String(watchPanel(view(data))), /issue uncertain \(watch-issue-close-raced\)/);
  data.rules[0].summary = { lastIssueStatus: "closed", lastIssueReason: PRIVATE };
  const closed = String(watchPanel(view(data)));
  assert.match(closed, /issue closed/);
  assert.ok(!closed.includes("PRIVATE-WATCH"));
});


test("a shared live read stays public even when its caller names an operator", async () => {
  const calls = [];
  await loadPageData("watch-board", { rule: "shop", finding: "f1" }, { watch: store(calls), now: () => 100 }, { role: "operator", live: true });
  assert.deepEqual(calls.filter((c) => c[0] === "finding" || c[0] === "trace").map((c) => c[2]), [{ private: false }, { private: false }]);
});


test("viewers get structural board counts and no agent-authored numeric values", async () => {
  const b = { version: 3, frozen: false, blocks: [{ type: "number", value: 123456789, title: PRIVATE }], proposals: [{ id: "proposal", blocks: [{ type: "number", value: 987654321 }] }], versions: [{ version: 2, blocks: [{ type: "note", text: PRIVATE }] }] };
  const service = store(); service.readBoard = async () => b;
  const loaded = await loadWatchData(service, { rule: "shop" }, { board: true });
  assert.deepEqual(loaded.board, { version: 3, frozen: false, blockCount: 1, proposalCount: 1, versionCount: 1 });
  assert.ok(!JSON.stringify(loaded.board).includes("123456789") && !JSON.stringify(loaded.board).includes("PRIVATE-WATCH"));
  const output = String(watchBoardPanel(view({ board: b }, "viewer")));
  assert.match(output, /Board blocks: 1; proposals: 1; retained versions: 1/);
  assert.ok(!output.includes("123456789") && !output.includes("987654321"));
});

test("trace shows a chosen action beside status, reviewed model, actual cost, time and query counts", () => {
  const data = { board, trace: [{ kind: "decide", status: "answered", action: "investigate", model: "openrouter/typesafe/jev-1.13", modelReviewed: true, costUsd: 0.00002, at: 1000 }, { kind: "query", status: "completed", rows: 37, usage: { cost: 0.001 } }] };
  const viewer = String(watchBoardPanel(view(data)));
  for (const text of ["answered; chose investigate", "model openrouter/typesafe/jev-1.13", "cost $0.000020", "1970-01-01T00:00:01.000Z", "37 rows"]) assert.ok(viewer.includes(text), text);
  assert.ok(!viewer.includes("usage"));
  const operator = String(watchBoardPanel(view(data, "operator")));
  assert.ok(operator.includes("usage") && operator.includes("0.001"));
});

test("public trace rendering rejects malformed scalar metadata even from a private-loaded entry", () => {
  const data = { board, trace: [{ kind: "decide", status: PRIVATE, action: PRIVATE, model: "PRIVATE-MODEL", modelReviewed: false, costUsd: PRIVATE, rows: PRIVATE, at: PRIVATE, confidence: PRIVATE, probabilities: { secret: PRIVATE } }] };
  for (const role of ["viewer", "operator"]) {
    const output = String(watchBoardPanel(view(data, role)));
    assert.ok(!output.includes("PRIVATE-MODEL"));
    // The operator's adopted note remains private by role; the malformed trace metadata adds none.
    const withoutBoard = String(watchBoardPanel(view({ ...data, board: { blocks: [] } }, role)));
    assert.ok(!withoutBoard.includes("PRIVATE-WATCH"), role);
  }
});
