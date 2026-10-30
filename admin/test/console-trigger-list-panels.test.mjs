import { readFileSync } from "node:fs";
import { TRIGGERS_CSS } from "../src/console/triggers-css.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { triggerListGolden } from "./helpers/trigger-list-goldens.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";

const text = markup => cardText(markup);
const panel = (page, id) => { const doc = cardDocument(page); return doc.within(doc.byId.get(id)); };
test("list uses actual schedule and saved-row facts, not the card's sample totals", async () => {
  const page = await triggerListGolden();
  const github = panel(page, "p-tr-github");
  assert.match(github, /\/config\/trigger\?index=1/);
  assert.match(github, /\/config\/trigger\?index=2/);
  assert.match(text(github), /at least 1/);
  assert.match(text(github), /completed/);
  assert.match(text(panel(page, "p-tr-count")), /Editing or renumbering.*older configuration/);
  assert.ok(!page.includes("PRIVATE TASK CANARY"));
  const unknown = await triggerListGolden({ state: "history-unknown", role: "viewer" });
  assert.match(text(panel(unknown, "p-tr-github")), /History unavailable/);
  assert.ok(!text(panel(unknown, "p-tr-github")).includes("0 runs in 30 days"));
});
test("missing owning zone keeps published next fire but never invents a full set of future dots", async () => {
  const known = await triggerListGolden();
  const unknown = await triggerListGolden({ state: "zone-unknown" });
  const circles = page => [...panel(page, "p-tr-week").matchAll(/class="wk-next"/g)].length;
  assert.ok(circles(known) > circles(unknown));
  assert.equal(circles(unknown), 1, "one independently published next instant survives, no host zone is guessed");
  assert.match(text(panel(unknown, "p-tr-week")), /timezone/);
});
test("viewer and deployment read-only retain facts/check but cannot add or edit", async () => {
  for (const opts of [{ role: "viewer" }, { readOnly: true }]) {
    const page = await triggerListGolden(opts);
    assert.ok(!page.includes("Add a trigger"));
    assert.ok(!/data-action="trigger-(?:add|edit|delete|fire)"/.test(page));
    assert.match(page, /data-trigger-check/);
    assert.match(page, /href="\/triggers\/check"/);
    assert.match(page, /<fieldset\s+data-trigger-check-fields\s+disabled>/, "without script event text cannot leak through form navigation");
  }
});
test("checker golden results come from the receiver-backed evaluator, including counterexamples and safe refusals", async () => {
  const matched = await triggerListGolden({ role: "viewer", check: "match" });
  const unmatched = await triggerListGolden({ role: "viewer", check: "no-match" });
  const invalid = await triggerListGolden({ role: "viewer", check: "invalid" });
  assert.match(text(panel(matched, "p-tr-check")), /Rule 2 would match with flow fix/);
  assert.match(text(panel(matched, "p-tr-check")), /not a promise.*paid job/);
  assert.match(text(panel(unmatched, "p-tr-check")), /No rule would match this description/);
  assert.ok(!unmatched.includes("Rule 2 would match"));
  assert.match(text(panel(invalid, "p-tr-check")), /The event could not be checked/);
  assert.ok(!invalid.includes("unsupported"), "refusal never quotes the invalid request");
});
test("kind filters change actual rule membership while unfiltered summary facts remain intact", async () => {
  const all = await triggerListGolden();
  const comments = await triggerListGolden({ kind: "comment" });
  const github = panel(comments, "p-tr-github");
  assert.match(github, /\/config\/trigger\?index=2/);
  assert.ok(!github.includes('/config/trigger?index=1'));
  assert.ok(!text(github).includes("Costs more: 2 independent sandboxes"));
  assert.equal(text(panel(comments, "p-tr-count")), text(panel(all, "p-tr-count")), "filters do not pretend to edit configuration or narrow summary scope");
  assert.ok(!panel(comments, "p-tr-schedule").includes('/config/trigger?index=0'));
  assert.match(comments, /href="\/triggers\?kind=label"/);
});
test("rule chips reflect selected capabilities and escape every configured string", async () => {
  const page = await triggerListGolden({ extraTriggers: [{ index: 7, type: "comment", forge: "forgejo", phrase: '<img src=x onerror="unsafe">', flow: "safe-flow", model: '<script>unsafe</script>', backend: "openshell", resume: true, steer: true, awaitInput: true, recover: true, secrets: 2, secretBundle: false, mcp: ["search"], instructions: true }] });
  const forgejo = panel(page, "p-tr-forgejo");
  for (const phrase of ["venue openshell", "keeps a session", "may wait for a person", "takes messages", "recovers a lost run", "2 secret variables", "no project secret bundle", "MCP: search", "standing instructions"]) assert.ok(text(forgejo).includes(phrase), phrase);
  assert.ok(!forgejo.includes('<img src=x') && !forgejo.includes('<script>unsafe'));
  assert.ok(text(forgejo).includes('<img src=x onerror="unsafe">'), "configured text remains visible as text");
  assert.ok(!text(panel(page, "p-tr-github")).includes("venue openshell"), "capabilities do not bleed between rules");
});
test("chart markers and legend distinguish observed history, projections and scope-specific quiet windows", async () => {
  const page = await triggerListGolden();
  const week = panel(page, "p-tr-week");
  assert.equal([...week.matchAll(/class="wk-ran"/g)].length, 0, "forge history never fabricates cron runs");
  assert.ok([...week.matchAll(/class="wk-next"/g)].length > 1);
  assert.match(week, /class="wk-now"/);
  assert.match(week, /class="wk-quiet"/);
  for (const phrase of ["recorded run", "projected fire", "quiet window", "Next 7 days, UTC", "Forge repository quiet windows do not hold cron", "global windows can hold it"]) assert.ok(text(week).includes(phrase), phrase);
});

test("Triggers stylesheet is byte-identical to its published generator source", () => {
  const source = readFileSync(new URL("../../design/tools/triggers_controls.py", import.meta.url), "utf8");
  const pasted = /^TRIGGERS_CSS = """([^]*?)"""/m.exec(source);
  assert.ok(pasted, "one literal stylesheet in the published source");
  assert.equal(TRIGGERS_CSS, pasted[1]);
});

test("empty incomplete history stays unknown while explicitly complete empty history is zero", async () => {
  const incomplete = await triggerListGolden({ recordsOverride: [], complete: false });
  const complete = await triggerListGolden({ recordsOverride: [], complete: true });
  const partialRules = text(panel(incomplete, "p-tr-github"));
  assert.match(partialRules, /unknown runs in 30 days.*unknown spend/);
  assert.ok(!partialRules.includes("at least 0") && !partialRules.includes("$0"));
  assert.match(text(panel(incomplete, "p-tr-spend")), /unknown/);
  assert.ok(!text(panel(incomplete, "p-tr-spend")).includes("$0"));
  assert.match(text(panel(complete, "p-tr-github")), /0 runs in 30 days/);
  assert.match(text(panel(complete, "p-tr-spend")), /\$0/);
  assert.ok(!text(panel(complete, "p-tr-spend")).includes("unknown"));
});
test("label conjunctions remain complete and PR selectors apply only to labeled deliveries", async () => {
  for (const type of ["label", "pull_request"]) {
    const page = await triggerListGolden({ extraTriggers: [{ index: 8, type, forge: "forgejo", flow: "review", any: ["alternative-a"], all: ["required-b"], none: ["excluded-c"], ...(type === "pull_request" ? { action: ["opened", "labeled", "review_submitted"] } : {}) }] });
    const shown = text(panel(page, "p-tr-forgejo"));
    assert.match(shown, /any of alternative-a and all of required-b and none of excluded-c/);
    assert.ok(!shown.includes("alternative-a or required-b"));
    if (type === "pull_request") {
      assert.match(shown, /opened, labeled, review_submitted/);
      assert.match(shown, /labels on labeled deliveries matching/);
    } else assert.ok(!shown.includes("labels on labeled deliveries"));
  }
});
