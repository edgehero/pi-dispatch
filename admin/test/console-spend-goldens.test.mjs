import assert from "node:assert/strict";
import { test } from "node:test";
import { SPEND_DRAW, SPEND_HOSTILE_REASON, SPEND_PANEL_STATES, spendFixture, drawSpend } from "./helpers/spend-goldens.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { SPEND_PANELS } from "../src/console/panels/spend.mjs";

const rendered = Promise.all(Object.entries(SPEND_DRAW).map(async ([key, draw]) => [key, await draw()])).then(Object.fromEntries);
const expected = {
  "spend-no-dollar-window.viewer": ["No daily dollar cap is configured", "$7.00"],
  "spend-partial-money.viewer": ["unknown cost", "≥"],
  "spend-unknown-money.viewer": ["unknown cost", "unknown"],
  "spend-plan-model.viewer": ["plan:work", "plan-provider/plan-model"],
  "spend-whatif-runs.viewer": ["The same 3 runs", "$0.30", "API-equivalent amount"],
  "spend-whatif-flow.viewer": ["Per run", "$0.20", "Runs in this window", "fixture"],
  "spend-populated.operator": ["Today", "$2.00", "Held for 1 running jobs"],
  "spend-populated.viewer": ["Full local paths are shown to operators only", "Metered and plan"],
  "spend-costs-unreadable.viewer": ["Costs could not be read. The other Spend views still work."],
  "spend-unknown-holds.operator": ["Holds not published by: old-worker", "Those jobs are not counted as zero"],
  "spend-counters-unreadable.operator": ["The settings file or counters could not be read"],
  "spend-split.operator": ["Why the plan says so", "Preview the plan", "Revert row 2", "Same as row 2", "No split to go back to"],
  "spend-split.viewer": ["Budget split", "History", "0123456789abcdef"],
  "spend-split-no-envelope.viewer": ["No envelope: set an envelope"],
  "spend-split-invalid.operator": ["The envelope does not load"],
  "spend-split-no-plan.viewer": ["No split yet"],
  "spend-split-mismatch.operator": ["Another envelope is in force"],
  "spend-split-unreachable.viewer": ["The queue is not answering"],
  "spend-split-newer.viewer": ["Split not usable: newer"],
  "spend-split-outside-edit.operator": ["The split was edited outside the plan writer"],
  "spend-capacity.viewer": ["Fleet busy", "build3", "mini1", "mini2", "Jobs only: a machine busy with other work reads as idle"],
  "spend-capacity-no-time.viewer": ["No time in this window yet"],
  "spend-capacity-unreadable.viewer": ["Capacity not read; the other Spend views still work"],
  "spend-capacity-truncated.viewer": ["incomplete history", "missing time is never counted as idle"],
  "spend-breakdown.viewer": ["Window spend", "Settled run records only", "Where these numbers come from"],
  "spend-breakdown-unreadable.viewer": ["Costs could not be read"],
  "spend-breakdown-empty.viewer": ["No runs in the spend window", "Try 30 days"],
  "spend-whatif-unknown.viewer": ["Unknown model", "acme/model-1"],
  "spend-whatif-seeded.viewer": ["seeded", "Seeded range, no ledgered run yet"],
  "spend-flows-map.viewer": ["Flows map", "Fit", "What the map cannot see"],
  "spend-flows-list.viewer": ["Flows list", "Flows nothing reaches", "one-shot spent"],
  "spend-flows-selected.viewer": ["Selected trigger", "Runs in map window", "nightly"],
  "spend-flows-spent.viewer": ["Run that spent this one-shot", "review"],
  "spend-flows-invalid.viewer": ["triggers file is invalid", "Nothing is drawn until it loads"],
  "spend-flows-missing.viewer": ["Nothing is drawn until it loads"],
};

test("every Spend state has an explicit nonempty visible assertion and a real whole-page render", async () => {
  assert.deepEqual(Object.keys(expected), [...SPEND_PANEL_STATES]);
  const pages = await rendered;
  for (const [key, pieces] of Object.entries(expected)) {
    assert.ok(pieces.length > 0, key);
    const page = pages[key];
    assert.match(page, /^<!doctype html>\n/, key);
    assertClean(`panels/${key}`, page);
    const visible = cardText(page);
    for (const piece of pieces) assert.ok(visible.includes(piece), `${key}: visible ${JSON.stringify(piece)}`);
  }
});

test("Budget split exposes escaped plan text and structured writes only to operators", async () => {
  const pages = await rendered;
  const operator = pages["spend-split.operator"];
  const viewer = pages["spend-split.viewer"];
  assert.ok(SPEND_HOSTILE_REASON.includes("\u202e"), "the counterexample really contains a directional control");
  assert.ok(operator.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(operator.includes("\\u{202E}") && operator.includes("\\u{0001}"), "invisible controls are drawn as escaped code points");
  assert.ok(!operator.includes("<img src=x"));
  assert.ok(!viewer.includes("Needs") && !viewer.includes("onerror=alert") && !viewer.includes("Why the plan says so"), "viewer markup holds none of the operator reason text");
  for (const action of ["priorities-set", "envelope-set", "allocation-revert"]) {
    assert.ok(operator.includes(`data-action="${action}"`), action);
    assert.ok(!viewer.includes(`data-action="${action}"`), `viewer cannot submit ${action}`);
  }
  assert.ok(!operator.includes("<textarea"), "the budget forms are fields, not a JSON editor");
  assert.ok(cardDocument(operator).nodes.some((node) => node.tag === "input" && node.attrs.name === "index" && node.attrs["data-type"] === "int" && node.attrs.value === "1"), "Revert row 2 carries machine index1");
});

test("flows list has no graph node payload and server selections render real details without executing script", async () => {
  const pages = await rendered;
  const list = pages["spend-flows-list.viewer"];
  assert.ok(list.includes("<table"));
  assert.ok(pages["spend-flows-map.viewer"].includes('aria-label="Zoom out"'));
  assert.ok(!list.includes('id="graph-nodes"') && !list.includes('id="graph"'));
  for (const [key, trigger] of [["spend-flows-selected.viewer", "0"], ["spend-flows-spent.viewer", "1"]]) {
    const page = pages[key];
    assert.ok(page.includes("data-selected-empty hidden"), key);
    assert.ok(page.includes("data-selected-details>"), key);
    assert.ok(page.includes(`data-trigger-index="${trigger}"`), key);
  }
  assert.ok(pages["spend-flows-spent.viewer"].includes("/run?id=gh-spent-one"));
  const plans = cardDocument(pages["spend-plan-model.viewer"]);
  const planMarkup = plans.within(plans.byId.get("p-plan"));
  assert.ok(planMarkup.includes("plan:work"), "the model row carries its actual plan id");
  assert.ok(!planMarkup.includes("$0.00"), "a plan-covered row never becomes a zero-dollar charge");
});

test("the fixture supplies nonzero folds, holds and per-host capacity instead of empty placeholders", () => {
  const p = spendFixture();
  assert.equal(p.fold.provenance.runsTotal, 3);
  assert.equal(p.spend.today.heldMicros, 2000000);
  assert.equal(p.capacity.hosts.length, 3);
  assert.ok(p.capacity.fleet.peak > 0);
  for (const [page, panels] of Object.entries(SPEND_PANELS)) assert.ok(panels.length >= 4, page);
});


test("all five Spend views enforce the local-path boundary even when a viewer asks for full paths", async () => {
  const secret = "/srv/private-operator/work/customer-site";
  for (const page of ["insights", "insights-budget-split", "insights-capacity", "insights-breakdown", "insights-flows"]) {
    const payload = spendFixture();
    payload.budget.dollars.windows.push({ ledger: "scope", name: secret, window: "day", counterMicros: 100, capMicros: 200 });
    payload.budget.scoped.push({ scope: secret, usd: { day: { usedMicros: 100, capMicros: 200 } } });
    payload.fold.byRepo.push({ key: `local:${secret}`, label: secret, kind: "local", runs: 1, tokens: 100, cost: { usd: .1, class: "metered" } });
    const folder = payload.graph.folders.find((f) => f.kind === "local");
    folder.path = secret;
    folder.label = "customer-site";
    for (const query of ["range=7d", "range=7d&paths=full"]) {
      const doc = await drawSpend(page, { role: "viewer", query, payload });
      assert.ok(!doc.includes("private-operator"), `${page} ${query}: no parent path in visible or hidden markup`);
      assertClean(`${page}/hostile-path`, doc);
      if (["insights", "insights-breakdown", "insights-flows"].includes(page)) assert.ok(doc.includes("customer-site"), `${page}: the folder is actually drawn by basename`);
    }
    if (["insights", "insights-breakdown", "insights-flows"].includes(page)) {
      const ordinary = await drawSpend(page, { role: "operator", query: "range=7d", payload });
      assert.ok(!ordinary.includes("private-operator"), `${page}: operators also opt in to full paths`);
      const full = await drawSpend(page, { role: "operator", query: "range=7d&paths=full", payload });
      assert.ok(full.includes(secret), `${page}: the operator opt-in really reveals the same folder`);
    }
  }
});


test("Budget split headlines expose floors, permitted writers and remaining plan validity", async () => {
  const page = (await rendered)["spend-split.operator"];
  const text = cardText(page);
  for (const sentence of ["Floors total $5.00", "Writers: operator-session, portfolio-job", "24 hours left in this plan"]) assert.ok(text.includes(sentence), sentence);
});


test("zero allocation refusals are named as zero and scheduled next fires are times", async () => {
  const pages = await rendered;
  for (const reason of ["allocation-cap", "envelope-mismatch", "portfolio-no-envelope", "portfolio-snapshot-oversize"]) assert.ok(cardText(pages["spend-split.viewer"]).includes(reason), reason);
  const selected = cardDocument(pages["spend-flows-selected.viewer"]);
  const panel = selected.byId.get("p-flows-selected");
  assert.ok(selected.descendants(panel).some((node) => node.tag === "time"), "scheduled next fire is a real time element");
});
