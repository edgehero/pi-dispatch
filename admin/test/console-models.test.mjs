import { splitModelEntry, modelIdProblem, providerIdProblem } from "@edgehero/pi-dispatch/model-ref";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGES, loadPageData, parsePageQuery, renderPage, panelIds } from "../src/console/pages.mjs";
import { modelsViewOf, modelsForAgent } from "../src/models-view.mjs";
import { modelRoleForm, MODELS_WORDS } from "../src/console/panels/models.mjs";
import { consoleModelsFixture, MODELS_DRAW, MODELS_PANEL_STATES } from "./helpers/models-goldens.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
const AT = Date.UTC(2026, 9, 31, 12);
const render = async (m, { role = "operator", readOnly = false } = {}) => String((await renderPage("models", { session: { name: "test", role }, query: {}, data: { now: AT, models: m }, readOnly })).html);

test("Models is a static viewer read with no caller-selected data query or live endpoint", async () => {
  assert.deepEqual(PAGES.models, { path: "/models", auth: "viewer", live: false, title: "Models", nav: "Models", icon: "spend" });
  for (const query of ["scope=web", "role=planner", "model=openai%2Fgpt-5", "canary=secret", "limit=1000000"]) assert.ok(parsePageQuery("models", query).refusal);
  const doc = await render(consoleModelsFixture(AT));
  assert.match(doc, /href="\/models">.*?Reload/s); assert.doesNotMatch(doc, /data-live="models"/);
  assert.deepEqual(panelIds("models").filter(p => p !== "p-nav-parked" && p !== "p-headline"), ["p-model-problems", "p-roles", "p-cooldowns", "p-models", "p-proposals"]);
});

test("only Models pays its reader; its one snapshot includes real model waiters and an agent retains the safe view", async () => {
  const calls = [], m = consoleModelsFixture(AT);
  const snapshot = { queue: { counts: {} }, waiting: { rows: [{ jobId: "wait-1", why: "model-cooldown" }] } };
  const deps = { now: () => AT, fleet: { snapshot: async opts => { calls.push(["snapshot", opts]); return snapshot; } }, modelsView: async s => { assert.equal(s, snapshot); calls.push(["models"]); return m; } };
  await loadPageData("overview", {}, deps);
  assert.deepEqual(calls.map(c => c[0]), ["snapshot"]);
  calls.length = 0;
  const data = await loadPageData("models", {}, deps, { role: "operator" });
  assert.deepEqual(calls, [["snapshot", { waiting: true }], ["models"]]); assert.equal(data.models, m);
  const agent = await loadPageData("models", {}, deps, { role: "agent" });
  assert.deepEqual(agent.models, modelsForAgent(m));
  const doc = await render(agent.models, { role: "agent" });
  assert.match(doc, /planner/); assert.match(doc, /openai\/gpt-5/); assert.match(doc, /131,900/);
  assert.doesNotMatch(doc, /data-action=|data-copy|Adopt for|pi-dispatch canary/);
});

test("the actual role resolution keeps scoped users distinct and trigger fallback ordering effective", async () => {
  const m = modelsViewOf({ now: AT, modelRoles: { default: { planner: { model: "anthropic/claude-sonnet-4-5", fallbackModels: ["openai/gpt-5", "example/unpriced"] }, editor: "openai/gpt-5" }, web: { planner: "openai/gpt-5" } }, projects: [{ id: "web", members: ["/srv/web"] }], resolveFolder: folder => folder, entries: [{ run: { model: "role:planner", kind: "local", folder: "/srv/api", flow: "triage" } }, { run: { model: "role:planner", kind: "local", folder: "/srv/web", flow: "fix" } }, { run: { model: "role:editor", kind: "local", folder: "/srv/web", flow: "review", fallbackModels: ["anthropic/claude-sonnet-4-5"] } }], deployment: { provider: "openai", model: "gpt-5" }, cooldowns: [], status: ref => ({ known: true, priced: ref !== "example/unpriced" }), snapshot: { waiting: { rows: [] } } });
  const d = m.roles.find(r => r.scope === "default" && r.role === "planner"), p = m.roles.find(r => r.scope === "web" && r.role === "planner");
  assert.deepEqual(d.triggers.map(t => t.index), [0]); assert.deepEqual(p.triggers.map(t => t.index), [1]);
  const doc = await render(m), text = cardText(doc);
  assert.ok(text.includes("Skipped: unpriced")); assert.ok(text.includes("Project web"));
  assert.ok(doc.indexOf("openai/gpt-5") < doc.indexOf("example/unpriced"), "ordered fallbacks retain order");
  assert.match(doc, /href="\/config\/trigger\?index=0"/); assert.match(doc, /href="\/config\/trigger\?index=1"/);
});

test("cooldown sentences distinguish direct jobs, fallback eligibility, wait kinds and run provenance", async () => {
  const text = cardText(await render(consoleModelsFixture(AT))).replace(/ +([.,])/g, "$1");
  assert.ok(text.includes("No fallback: its jobs start on anthropic/claude-sonnet-4-5."));
  assert.ok(text.includes("First candidate by price and cooldown: openai/gpt-5.")); assert.ok(text.includes(MODELS_WORDS.next));
  assert.ok(text.includes("2026-10-31 12:13:00 UTC")); assert.ok(text.includes("model dollar window"));
  assert.ok(text.includes("This run used fallback openai/gpt-5 for role planner because the primary model was cooling down."));
  assert.ok(!text.includes("Rate limited at") && !text.includes("429") && !text.includes("13 of"));
});

test("canary arithmetic and missing meter denominators remain visible beside linked sources", async () => {
  const m = consoleModelsFixture(AT), text = cardText(await render(m));
  for (const value of ["$0.19", "$0.06", "2 of 2", "1 of 2", "9.4", "11.2", "118,400", "131,900"]) assert.ok(text.includes(value), value);
  assert.ok(text.includes("Known cost: 2 source and 2 candidate runs"));
  const partial = m.canaries[0]; partial.partial = true; partial.rows[1].source = null; partial.sourceStats = { runs: 1, completed: 1, costPerRun: null, averageTurns: null, averageTokens: null, knownCosts: 0, knownTurns: 0, knownTokens: 0 };
  const doc = await render(m), changed = cardText(doc);
  assert.ok(changed.includes("Partial canary comparison") && changed.includes("Not known"));
  assert.ok(changed.includes("Known cost: 0 source and 2 candidate runs"));
  assert.match(doc, /href="\/run\?id=canary-c41f"/); assert.match(doc, /href="\/run\?id=gh-c41f"/);
  assert.ok(changed.includes("gh-c42f (source unavailable)"));
  assert.ok(!doc.includes('href="/run?id=gh-c42f"'), "missing retained source is not represented as a readable source result");
});

test("Edit fixes existing identity, Adopt requires a chosen scope and carries only the retained comparison identity", async () => {
  const m = consoleModelsFixture(AT);
  const edit = String(modelRoleForm(m, { role: m.roles[0], key: "test" }));
  assert.match(edit, /name="scope" value="default"/); assert.match(edit, /name="role" value="planner"/);
  assert.match(edit, /name="fallbackModels" data-type="list" value="openai\/gpt-5"/);
  const adopt = String(modelRoleForm(m, { canary: m.canaries[0], key: "adopt" }));
  assert.match(adopt, /<select[^>]*name="scope"[^>]*required><option value="" selected>Choose a scope/);
  assert.match(adopt, /name="role" value="planner"/); assert.match(adopt, /value="openai\/gpt-5"/);
  assert.match(adopt, /name="canary"[^>]*digest/); assert.doesNotMatch(adopt, /costPerRun|averageTurns|knownCosts/);
  assert.ok(adopt.includes('<fieldset data-config-controls disabled>'), "without script a filled form cannot write");
});

test("viewers, agents and read-only operators see every factual panel and no edit, adopt, removal or command", async () => {
  const m = consoleModelsFixture(AT);
  const op = await render(m); assert.match(op, /data-action="model-role-edit"/); assert.match(op, /pi-dispatch/); assert.match(op, /&lt;cap-usd&gt;/); assert.match(op, /deployment lease holds every other start/);
  for (const opts of [{ role: "viewer" }, { role: "agent" }, { role: "operator", readOnly: true }]) {
    const doc = await render(m, opts), text = cardText(doc);
    for (const fact of ["Model roles", "Cooling down", "$32.46 of $80.00", "Proposals and canaries", "131,900"]) assert.ok(text.includes(fact), `${JSON.stringify(opts)} ${fact}`);
    assert.doesNotMatch(doc, /data-action=|data-copy|Adopt for|Preview removing|pi-dispatch canary/);
  }
});

test("empty and failed sources differ, all required banner states carry actionable fixes, hostile prose is inert", async () => {
  for (const name of MODELS_PANEL_STATES) assertClean(name, String(await MODELS_DRAW[name]()));
  const empty = cardText(String(await MODELS_DRAW["models-empty.viewer"]())), unread = cardText(String(await MODELS_DRAW["models-unreadable.viewer"]()));
  assert.ok(empty.includes("No model roles are configured.")); assert.ok(!unread.includes("No model roles are configured.")); assert.ok(unread.includes("Models unavailable"));
  for (const name of ["models-radius.operator", "models-undeclared.operator", "models-provider-clash.operator", "models-fallback-clash.operator"]) {
    const doc = String(await MODELS_DRAW[name]()); assert.ok(doc.indexOf('id="p-model-problems"') < doc.indexOf('id="p-roles"')); assert.match(doc, /Fix:/);
  }
  const m = consoleModelsFixture(AT); m.proposals[0].label = '<img src=x onerror="alert(1)">';
  const doc = await render(m); assert.ok(doc.includes("&lt;img")); assert.ok(!doc.includes('<img src=x'));
});


test("effective trigger fallback groups replace the role-only forecast and duplicate broad-trigger links do not concatenate", async () => {
  const m = consoleModelsFixture(AT), role = m.roles[1];
  role.next = { kind: "direct", model: role.model };
  role.fallbackGroups = [{ triggers: [{ index: 1, number: 2 }, { index: 1, number: 2, project: "web" }, { index: 3, number: 4 }], fallbackModels: ["openai/gpt-5"], next: { kind: "candidate", model: "openai/gpt-5" } }];
  m.roles = [role];
  const doc = cardDocument(await render(m)), cooldown = doc.within(doc.byId.get("p-cooldowns")), text = cardText(cooldown);
  assert.ok(text.includes("First candidate by price and cooldown: openai/gpt-5"));
  assert.ok(!text.includes("No fallback:"), "a trigger fallback is effective even when the role has none");
  assert.equal((cooldown.match(/href="\/config\/trigger\?index=1"/g) ?? []).length, 1, "the broad trigger has one link within its effective fallback group");
  assert.match(cooldown, /Row 2<\/a>, <a[^>]*>Row 4/);
  assert.ok(!cooldown.includes("<time"), "cooldown ends remain UTC instead of the shared script localizing them");
  assert.ok(!String(await render(m)).includes("</p>}"), "the command explanation carries no stray template brace");
});


test("unread catalog status is not an unpriced refusal or a green configured state, and absent model windows do not waive other caps", async () => {
  const m = consoleModelsFixture(AT); m.models[0] = { ref: "openai/gpt-5", provider: "openai", known: null, priced: null, state: "unknown", windows: [] };
  m.models = [m.models[0]];
  const d = cardDocument(await render(m)), panel = d.within(d.byId.get("p-models")), text = cardText(panel);
  assert.ok(text.includes("Price status unavailable")); assert.ok(text.includes("No model-specific dollar windows are configured; other deployment and scope caps still apply."));
  assert.ok(!text.includes("Unpriced: skipped") && !text.includes("Configured"));
  assert.ok(!panel.includes("tone-ok")); assert.ok(panel.includes("tone-idle"));
});


test("a full primary window makes no admission promise, refused policy models are attention states, and deferred jobs link to Overview", async () => {
  const m = consoleModelsFixture(AT);
  m.roles[0].next = { kind: "candidate", model: m.roles[0].model };
  m.models[0].state = "window-full";
  m.models[0].windows[0].spentMicros = m.models[0].windows[0].capMicros;
  m.models.push({ ref: "example/refused", provider: "example", known: true, priced: true, state: "policy-refused", windows: [] });
  const d = cardDocument(await render(m)), cooldown = d.within(d.byId.get("p-cooldowns")), text = cardText(cooldown);
  assert.ok(text.includes("First candidate by price and cooldown: anthropic/claude-sonnet-4-5"));
  assert.ok(text.includes("a shown candidate may be unable to start"));
  assert.ok(!text.includes("Next eligible candidate"));
  assert.match(cooldown, /href="\/#p-waitlists">gh-77c1<\/a>/);
  assert.match(cooldown, /href="\/#p-waitlists">gh-80e1<\/a>/);
  assert.ok(!cooldown.includes("/run?id=gh-77c1") && !cooldown.includes("/run?id=gh-80e1"));
  const inventory = d.within(d.byId.get("p-models"));
  assert.match(inventory, /badge tone-attention[^>]*><svg[^>]*><use href="#i-refused"><\/use><\/svg>Trigger policy refused/);
  const c = m.canaries[0]; c.partial = true;
  const partial = cardText(await render(m));
  assert.ok(partial.includes("Incomplete or unmetered costs are excluded from exact cost averages"));
  assert.ok(partial.includes("Unknown cost, turns or tokens are not zeroes"));
});


test("a healthy bounded agent projection explains limited observations without inventing an I/O failure", async () => {
  const m = consoleModelsFixture(AT); m.partial = true; m.coverage.notes = [];
  const agent = modelsForAgent(m), text = cardText(await render(agent, { role: "agent" }));
  assert.ok(text.includes("This view uses bounded retained observations. Missing history and pending pickup checks limit what is known."));
  assert.ok(!text.includes("Some sources could not be read"));
});


test("long-name fixture uses accepted maximum reference components and preserves the complete removal label", async () => {
  const doc = String(await MODELS_DRAW["models-long-names.operator"]());
  const primary = `${"p".repeat(64)}/${"m".repeat(64)}`, fallback = `${"f".repeat(64)}/${"n".repeat(64)}`;
  for (const ref of [primary, fallback]) {
    const parsed = splitModelEntry(ref); assert.ok(parsed); assert.equal(parsed.provider.length, 64); assert.equal(parsed.model.length, 64);
    assert.equal(providerIdProblem(parsed.provider), null); assert.equal(modelIdProblem(parsed.model), null); assert.ok(doc.includes(ref));
  }
  assert.ok(cardText(doc).includes(`Preview removing ${"a".repeat(32)}`));
});

test("typed agent conflicts keep their precise refusal and possible local-project warning", async () => {
  for (const [reason, sentence] of [["model-role-unknown", "role that is undeclared"], ["model-role-provider-conflict", "provider conflicts with its role model"], ["model-roles-invalid", "role-expanded model policy is invalid"]]) {
    const m = consoleModelsFixture(AT); m.banners = [{ kind: "role-conflict", reason, index: 0, projectUnknown: true }]; m.roles[0].triggers[0].projectUnknown = true;
    const d = cardDocument(await render(modelsForAgent(m), { role: "agent" }));
    assert.ok(cardText(d.within(d.byId.get("p-model-problems"))).includes(sentence));
    for (const id of ["p-model-problems", "p-roles"]) assert.ok(cardText(d.within(d.byId.get(id))).includes(MODELS_WORDS.possibleProject), id);
  }
});


test("every model state and skipped fallback has a shared glyph-and-word badge, including neutral unknown", async () => {
  const m = consoleModelsFixture(AT);
  const expected = [["cooling-down", "Cooling down", "clock", "attention"], ["window-full", "Dollar window full", "spend", "attention"], ["policy-refused", "Trigger policy refused", "refused", "attention"], ["unknown", "Not known", "info", "idle"], ["available", "Configured", "done", "ok"], ["unpriced", "Unpriced", "attention", "attention"]];
  m.models = expected.map(([state], index) => ({ ref: `example/model-${index}`, provider: "example", known: true, priced: state !== "unpriced", state, windows: [] }));
  const d = cardDocument(await render(m)), inventory = d.byId.get("p-models");
  const badges = d.descendants(inventory).filter(n => n.classes.includes("badge"));
  assert.equal(badges.length, expected.length);
  for (const [index, [, word, icon, tone]] of expected.entries()) {
    const badge = badges[index], markup = d.within(badge);
    assert.ok(badge.classes.includes(`tone-${tone}`)); assert.equal(cardText(markup), word); assert.ok(markup.includes(`<use href="#i-${icon}">`));
  }
  const roles = d.within(d.byId.get("p-roles"));
  assert.match(roles, /badge tone-attention[^>]*><svg[^>]*><use href="#i-attention"><\/use><\/svg>Skipped: unpriced/);
});
