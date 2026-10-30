import { TRIGGER_LIST_PANEL_STATES } from "./helpers/trigger-list-goldens.mjs";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { html } from "../src/console/html.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";
import { ROLES as PAGE_ROLES, SHOTS, STATIC_SHOTS } from "./helpers/console-pages-harness.mjs";
import { SPEND_PANEL_STATES } from "./helpers/spend-goldens.mjs";
import { FLEET_PANEL_STATES } from "./helpers/fleet-goldens.mjs";
import { PANEL_STATES } from "./helpers/panel-goldens.mjs";

// Issue #737: every design card in scope has an element ledger, `fixtures/console-ledger/<Card>.json`, and
// each thing the card draws is accounted for in it. A ledger copies what it needs of its card (the README's panel list,
// and one element per README bullet, panel id, "server provides" item, browser state and sample value) rather than
// reading design/system: it was written while the design lived outside this repository, and a card the design rebuilds
// must not move a console test unseen. Reading the cards here is a later bolt (#752).
//
// AN ELEMENT: `{ el, kind, status, as?, panel?, source?, holds?, sentence?, roles?, golden?, shows?, reason? }`.
//   - `el` the card's own words for it; `kind` where the card has it: `readme` (its README or what its preview draws
//     as design), `panel` (a panel id the card names), `provides` (a "The server provides" item), `state` (a state the
//     browser script switches to; for the ConfirmStates, LiveStates, SignIn and AccessStates cards each one is a row of
//     `helpers/client-states.mjs`, held by `console-client-states.test.mjs`) or `sample` (a sample value, a fixture id,
//     a demo listing).
//   - `status`, the truth about it: `real` (the console has it and had it before this pull request: `source` cites
//     the function or constant), `new` (this pull request adds it: `source` cites what it adds), `absent` (the console
//     does not have it, and says so: `sentence` is the exported constant a person in one of `roles` reads instead, in a
//     `golden` of that role), or `illustrative` (only the card has it, as a demo, a sample or a part another issue
//     builds: `reason` says which). An absent or illustrative element cites no source: nothing in the code is it.
//   - `as` the repo's name for it where the card's differs (a card's panel id mapped to the page's, `p-link-wait` to
//     `p-link`); `panel` the repo panel that draws a non-panel element.
//   - `source` and `sentence` are `<path from the repository root>#<export>`; a sentence may name a string inside an
//     exported object (`#SIGN_IN_NOTICES.wrong.title`). `holds` is text the cited export's own text contains (a
//     function's source, a string, an object's JSON), for a source broader than the element.
//   - `golden` the rendered goldens that show it: `<shot>.<role>` (`fixtures/console/`, the page and static goldens)
//     or `panels/<state>.<role>` (`fixtures/console/panels/`, the panel goldens). Each must hold the panel's
//     `id="<id>" data-panel` (for a real or new panel, `as` or `el`; for `panel`), the `sentence` and the `shows` text.
//     `shows` is one string or an array of visible strings/markup fragments; phase 6 claims check these inside their panel.
//   - `reason` why, required for illustrative, and said wherever the console's version departs from the card's.

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const LEDGER_DIR = new URL("./fixtures/console-ledger/", import.meta.url);
const GOLDEN_DIR = new URL("./fixtures/console/", import.meta.url);

/** The cards whose ledgers are in, each with the pull request of issue #737 that builds it. Each page's pull request adds its own. */
const IN_SCOPE_CARDS = Object.freeze({
  TriggersScreen: 750, TriggersViewer: 750, TriggersPhone: 750,
  ConfigScreen: 750, TriggerDetail: 750, TriggerEditor: 750,
  SpendScreen: 749, SpendBudgetSplit: 749, SpendCapacity: 749, SpendBreakdown: 749, TopologyScreen: 749, SpendPhone: 749,
  FleetScreen: 6, FleetPartPaused: 6, HostDetail: 6, VenueDetail: 6,
  RunLive: 5, RunEnded: 5, RunRefused: 5, RunParked: 5, RunRecovered: 5, RunSandboxed: 5, RunChatStates: 5, RunViewer: 5, Transcript: 5, FactsAndLevels: 5,
  Shell: 1,
  Status: 1,
  SignIn: 2,
  AccessStates: 2,
  ErrorPage: 2,
  AuditScreen: 2,
  ConfirmStates: 2,
  LiveStates: 2,
  Actions: 2,
  CardsAndBanners: 2,
  FieldsDiffCommand: 2,
  OverviewScreen: 3,
  OverviewAllClear: 3,
  OverviewPhone: 3,
  SetupScreen: 3,
  TimelineAndWaitlists: 3,
  RunsScreen: 4,
  RunsPhone: 4,
  DataTable: 4,
  ParkedPhone: 4,
});

/** The cards outside #737, with the issues that build them (decided 2026-10-23): no ledger here. */
const ISSUE_OWNED_CARDS = Object.freeze({
  ApprovalRequest: Object.freeze([649]),
  ForkRun: Object.freeze([648]),
  ModelsScreen: Object.freeze([716, 717]),
  WatchScreen: Object.freeze([735]),
  WatchBoard: Object.freeze([743]),
});

/**
 * THE REVERSE CHECK: every panel a golden draws is named by some card's ledger, so no screen grows a panel that no card
 * accounts for. It runs over the goldens whose screens are drawn from cards that have their ledgers (the audit log, the
 * sign-in and link pages, the error pages, since PR 3 the overview, and since PR 4 the runs list and the parked inbox);
 * the other screens' cards land with their own pull requests, and PR 8 makes this list every golden, page and panel
 * alike.
 */
const REVERSE_CHECKED = Object.freeze([
  "triggers.operator", "triggers.viewer", "triggers-filtered.operator", "triggers-filtered.viewer", "trigger-check.operator", "trigger-check.viewer",
  ...TRIGGER_LIST_PANEL_STATES.map(key => `panels/${key}`),
  "config.operator", "config.viewer", "trigger.operator", "trigger.viewer", "trigger-add.operator",
  ...["trigger-editor-no-webhook.operator", "trigger-cron.operator", "trigger-spent.operator", "trigger-file-invalid.operator", "trigger-readonly.viewer", "trigger-editor-refusals.operator"].map(key=>`panels/${key}`),
  ...SPEND_PANEL_STATES.map((key) => `panels/${key}`),
  ...FLEET_PANEL_STATES.map((key) => `panels/${key}`),
  "fleet.operator", "fleet.viewer", "host.operator", "host.viewer", "venue.operator", "venue.viewer",
  "run.operator", "run.viewer", "run-live.operator", "run-live.viewer",
  "overview.operator",
  "overview.viewer",
  "overview-host.operator",
  "overview-host.viewer",
  "runs.operator",
  "runs.viewer",
  "runs-filtered.operator",
  "runs-filtered.viewer",
  "runs-problems.operator",
  "runs-problems.viewer",
  "runs-search.operator",
  "runs-search.viewer",
  "parked.operator",
  "parked.viewer",
  "audit.operator",
  "audit.viewer",
  "login.anonymous",
  "login-code.anonymous",
  "error-404.operator",
  "error-404.viewer",
  "error-400.operator",
  "error-403.viewer",
  "error-421.anonymous",
  "error-503.anonymous",
]);

const KINDS = Object.freeze(["readme", "panel", "provides", "state", "sample"]);
const STATUSES = Object.freeze(["real", "new", "absent", "illustrative"]);
const ROLES = Object.freeze(["operator", "viewer", "anonymous"]);
const KEYS = Object.freeze(["el", "kind", "status", "as", "panel", "source", "holds", "sentence", "roles", "golden", "shows", "reason"]);
/** What an absent or illustrative element may not carry: nothing in the code is it. */
const CODE_KEYS = Object.freeze(["as", "panel", "source", "holds", "shows"]);
const GOLDEN_RE = /^(?:panels\/)?[a-z0-9]+(?:-[a-z0-9]+)*\.(operator|viewer|anonymous)$/;
const REF_RE = /^((?:admin|worker)\/src\/[A-Za-z0-9_/-]+\.(?:mjs|ts))#([A-Za-z_$][\w$]*)((?:\.[A-Za-z0-9_-]+)*)$/;
const PANEL_ID_RE = /^(?:p|cf)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every ledger file, parsed, by card name. */
function loadLedgers() {
  const out = new Map();
  if (!existsSync(LEDGER_DIR)) return out;
  for (const file of readdirSync(LEDGER_DIR).sort()) {
    const text = readFileSync(new URL(file, LEDGER_DIR), "utf8");
    out.set(file.replace(/\.json$/, ""), { file, ledger: JSON.parse(text) });
  }
  return out;
}

const LEDGERS = loadLedgers();

/** Each element with its ledger's card, for the checks that walk them all. */
const ELEMENTS = [...LEDGERS.values()].flatMap(({ ledger }) => (Array.isArray(ledger.elements) ? ledger.elements.map((e) => ({ card: ledger.card, e })) : []));

const where = (card, e) => `${card}: "${e.el}"`;

const modules = new Map();
/** The module at `path` (from the repository root): its exports, or for a `.ts` file its text. */
async function moduleAt(path) {
  if (!modules.has(path)) {
    const file = `${REPO}${path}`;
    if (!existsSync(file)) modules.set(path, null);
    else if (path.endsWith(".ts")) modules.set(path, { ts: readFileSync(file, "utf8") });
    else modules.set(path, { exports: await import(pathToFileURL(file).href) });
  }
  return modules.get(path);
}

/** `ref` (`path#export.key...`) resolved: `{ value }`, or `{ missing }` saying what is not there. */
async function resolveRef(ref) {
  const m = REF_RE.exec(ref);
  if (m === null) return { missing: "not a <path>#<export> reference" };
  const [, path, name, dotted] = m;
  const mod = await moduleAt(path);
  if (mod === null) return { missing: `no file ${path}` };
  if (mod.ts !== undefined) {
    const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name}\\b`).test(mod.ts);
    if (!declared) return { missing: `${path} declares no export ${name}` };
    return dotted === "" ? { value: mod.ts } : { missing: "a .ts reference names no key" };
  }
  if (!Object.hasOwn(mod.exports, name)) return { missing: `${path} has no export ${name}` };
  let value = mod.exports[name];
  for (const key of dotted.split(".").slice(1)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return { missing: `${name}${dotted} has no ${key}` };
    value = value[key];
  }
  return { value };
}

/** An export's own text, for `holds`: a function's source, a string as it is, anything else as JSON. */
function textOf(value) {
  if (typeof value === "function") return Function.prototype.toString.call(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/** A golden's markup by its key, or null when the file is not there. */
function goldenText(key) {
  const url = new URL(`${key}.html`, GOLDEN_DIR);
  return existsSync(url) ? readFileSync(url, "utf8") : null;
}

/** Whether `doc` shows `text`: as written (markup, a template's literal text) or as `html` escapes a value. */
const shows = (doc, text) => doc.includes(text) || doc.includes(String(html`${text}`));

/** Whether `doc` draws panel `id` (a panel element carries `id` then `data-panel`, and nothing else). */
const drawsPanel = (doc, id) => doc.includes(`id="${id}" data-panel`);

/** The role a golden key is rendered for. */
const roleOf = (key) => GOLDEN_RE.exec(key)?.[1] ?? null;

/** The panel ids `doc` draws. */
const panelsIn = (doc) => [...doc.matchAll(/ id="([^"]+)" data-panel[\s>]/g)].map((m) => m[1]);

/**
 * Run `fn(expect)` and fail with every problem it found, said at once: a ledger is a long list, and its first problem
 * alone would hide the rest. `expect(ok, message)` records `message` when `ok` is false.
 */
async function collect(fn) {
  const problems = [];
  await fn((ok, message) => {
    if (!ok) problems.push(message);
  });
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
}

/** The golden `key`'s markup, or null with a problem said: a ledger that names a golden needs it rendered. */
function goldenOf(expect, card, e, key) {
  const doc = goldenText(key);
  expect(doc !== null, `${where(card, e)}: its golden ${key} (fixtures/console/${key}.html) exists`);
  return doc;
}

test("a ledger for every in-scope card, and none for a card outside the list", () => collect((expect) => {
  for (const name of Object.keys(IN_SCOPE_CARDS)) expect(LEDGERS.has(name), `${name}: admin/test/fixtures/console-ledger/${name}.json exists`);
  for (const [name, { file }] of LEDGERS) {
    expect(Object.hasOwn(IN_SCOPE_CARDS, name), `${file}: a ledger for a card in scope (IN_SCOPE_CARDS), or a stray file`);
    expect(file === `${name}.json`, `${file}: a ledger file is <Card>.json`);
  }
}));

test("cards outside the console redesign are their issues' (by number) and carry no redesign ledger", () => collect((expect) => {
  for (const [name, issues] of Object.entries(ISSUE_OWNED_CARDS)) {
    expect(Array.isArray(issues) && issues.length > 0 && issues.every((n) => Number.isSafeInteger(n) && n > 0), `${name}: built with its issue, named by number`);
    expect(!Object.hasOwn(IN_SCOPE_CARDS, name), `${name} belongs to its own issue, not the console redesign`);
    expect(!LEDGERS.has(name), `${name}: no redesign ledger for a screen owned by its own issue`);
  }
}));

test("each ledger's shape: its card, its pull request, the README's panels and closed element fields", () => collect((expect) => {
  for (const [name, { ledger }] of LEDGERS) {
    expect(JSON.stringify(Object.keys(ledger)) === JSON.stringify(["card", "pr", "panels", "elements"]), `${name}: the ledger's keys are card, pr, panels, elements, in that order`);
    expect(ledger.card === name, `${name}.json names its card`);
    expect(ledger.pr === IN_SCOPE_CARDS[name], `${name}: built in PR ${IN_SCOPE_CARDS[name]}`);
    const panels = Array.isArray(ledger.panels) ? ledger.panels : [];
    expect(Array.isArray(ledger.panels) && panels.every((p) => typeof p === "string" && p !== ""), `${name}: panels is the README's list`);
    expect(new Set(panels).size === panels.length, `${name}: each panel listed once`);
    expect(Array.isArray(ledger.elements) && ledger.elements.length > 0, `${name}: elements`);
    const els = (ledger.elements ?? []).map((e) => e.el);
    expect(new Set(els).size === els.length, `${name}: each element once`);
  }
  for (const { card, e } of ELEMENTS) {
    const w = where(card, e);
    for (const k of Object.keys(e)) expect(KEYS.includes(k), `${w}: no field ${k} (an element takes ${KEYS.join(", ")})`);
    expect(typeof e.el === "string" && e.el.trim() !== "", `${w}: el`);
    expect(KINDS.includes(e.kind), `${w}: kind is one of ${KINDS.join(", ")}`);
    expect(STATUSES.includes(e.status), `${w}: status is one of ${STATUSES.join(", ")}`);
    for (const k of ["as", "panel", "source", "holds", "sentence", "reason"]) if (k in e) expect(typeof e[k] === "string" && e[k] !== "", `${w}: ${k} is a non-empty string`);
    if ("shows" in e) {
      const pieces = Array.isArray(e.shows) ? e.shows : [e.shows];
      expect(pieces.length > 0 && pieces.every((piece) => typeof piece === "string" && piece.trim() !== ""), `${w}: shows contains visible strings`);
    }
    if ("panel" in e) expect(PANEL_ID_RE.test(e.panel), `${w}: panel is a repo panel id`);
    if (e.kind === "panel" && "as" in e) expect(PANEL_ID_RE.test(e.as), `${w}: a panel's as is the repo's panel id`);
    if ("golden" in e) {
      const golden = Array.isArray(e.golden) ? e.golden : [];
      expect(golden.length > 0, `${w}: golden lists one or more`);
      for (const g of golden) expect(GOLDEN_RE.test(g), `${w}: ${g} is <shot>.<role> or panels/<state>.<role>`);
      expect(new Set(golden).size === golden.length, `${w}: each golden once`);
    }
    if ("holds" in e) expect("source" in e, `${w}: holds is text of its source`);
    if ("shows" in e) expect("golden" in e, `${w}: shows is text of its goldens`);
    if (e.status === "real" || e.status === "new") {
      expect("source" in e, `${w}: a ${e.status} element cites its source`);
      expect(!("roles" in e), `${w}: roles belong to an absent element`);
    }
    if (e.status === "absent") {
      expect("sentence" in e, `${w}: an absent element cites the sentence a person reads instead`);
      expect(Array.isArray(e.roles) && e.roles.length > 0 && e.roles.every((r) => ROLES.includes(r)), `${w}: roles, of ${ROLES.join(", ")}`);
      expect("golden" in e, `${w}: an absent sentence is shown in a golden`);
      for (const k of CODE_KEYS) expect(!(k in e), `${w}: an absent element cites nothing in the code (${k})`);
    }
    if (e.status === "illustrative") {
      expect("reason" in e, `${w}: an illustrative element carries its reason`);
      for (const k of [...CODE_KEYS, "sentence", "roles", "golden"]) expect(!(k in e), `${w}: an illustrative element cites nothing in the code (${k})`);
    }
  }
}));

test("every golden a ledger names is one the harnesses draw: a page, a static page or a panel state", () => collect((expect) => {
  const drawn = new Set([...SHOTS.flatMap(([shot]) => PAGE_ROLES.map((role) => `${shot}.${role}`)), ...STATIC_SHOTS, ...PANEL_STATES.map((s) => `panels/${s}`)]);
  for (const { card, e } of ELEMENTS) for (const key of e.golden ?? []) expect(drawn.has(key), `${where(card, e)}: ${key} is a golden the harnesses draw (SHOTS and ROLES, STATIC_SHOTS, or panel-goldens.mjs PANEL_STATES)`);
  for (const key of REVERSE_CHECKED) expect(drawn.has(key), `REVERSE_CHECKED: ${key} is a golden the harnesses draw`);
}));

test("every panel the card's README lists is accounted for by a panel element", () => collect((expect) => {
  for (const [name, { ledger }] of LEDGERS) {
    const panels = new Set((ledger.elements ?? []).filter((e) => e.kind === "panel").map((e) => e.el));
    for (const p of ledger.panels ?? []) expect(panels.has(p), `${name}: the README's panel ${p} is an element of kind panel`);
  }
}));

test("every source resolves to an export, holding the text it is cited for", () => collect(async (expect) => {
  for (const { card, e } of ELEMENTS.filter(({ e }) => "source" in e)) {
    const w = where(card, e);
    expect(!/#[^#]*\./.test(e.source), `${w}: a source names an export, not a key inside one`);
    const r = await resolveRef(e.source);
    expect(!("missing" in r), `${w}: ${e.source}: ${r.missing}`);
    if ("holds" in e && !("missing" in r)) expect(textOf(r.value).includes(e.holds), `${w}: ${e.source} holds ${JSON.stringify(e.holds)}`);
  }
}));

test("every sentence is an exported string", () => collect(async (expect) => {
  for (const { card, e } of ELEMENTS.filter(({ e }) => "sentence" in e)) {
    const w = where(card, e);
    const r = await resolveRef(e.sentence);
    expect(!("missing" in r), `${w}: ${e.sentence}: ${r.missing}`);
    if (!("missing" in r)) expect(typeof r.value === "string" && r.value.trim() !== "", `${w}: ${e.sentence} is a string that says something`);
  }
}));

test("every real or new panel is drawn in each golden it names", () => collect((expect) => {
  for (const { card, e } of ELEMENTS) {
    const w = where(card, e);
    const live = e.status === "real" || e.status === "new";
    if (live && e.kind === "panel") expect("golden" in e, `${w}: a ${e.status} panel names the golden that draws it`);
    for (const key of e.golden ?? []) {
      const doc = goldenOf(expect, card, e, key);
      if (doc === null) continue;
      if (live && e.kind === "panel") expect(drawsPanel(doc, e.as ?? e.el), `${w}: ${key} draws id="${e.as ?? e.el}" data-panel`);
      if ("panel" in e) expect(drawsPanel(doc, e.panel), `${w}: ${key} draws its panel ${e.panel}`);
    }
  }
}));

test("each element's sentence and shown text are in every golden it names", () => collect(async (expect) => {
  for (const { card, e } of ELEMENTS.filter(({ e }) => "golden" in e && ("sentence" in e || "shows" in e))) {
    const w = where(card, e);
    const said = "sentence" in e ? (await resolveRef(e.sentence)).value : undefined;
    for (const key of e.golden) {
      const doc = goldenOf(expect, card, e, key);
      if (doc === null) continue;
      if (typeof said === "string") expect(shows(doc, said), `${w}: ${key} says ${e.sentence} (${JSON.stringify(said)})`);
      if ("shows" in e) for (const piece of Array.isArray(e.shows) ? e.shows : [e.shows]) expect(shows(doc, piece) || cardText(doc).includes(piece), `${w}: ${key} shows ${JSON.stringify(piece)}`);
    }
  }
}));

test("every absent element's sentence is in a golden of each role that should read it", () => collect(async (expect) => {
  for (const { card, e } of ELEMENTS.filter(({ e }) => e.status === "absent")) {
    const w = where(card, e);
    const said = (await resolveRef(e.sentence)).value;
    for (const role of e.roles ?? []) {
      const theirs = (e.golden ?? []).filter((key) => roleOf(key) === role);
      expect(theirs.length > 0, `${w}: a golden rendered for the ${role}`);
      const docs = theirs.map((key) => goldenText(key)).filter((doc) => doc !== null);
      expect(docs.length === theirs.length, `${w}: the ${role}'s goldens ${theirs.join(", ")} exist`);
      expect(typeof said === "string" && docs.some((doc) => shows(doc, said)), `${w}: the ${role} reads ${e.sentence} in ${theirs.join(" or ")}`);
    }
  }
}));

test("the reverse check: every panel the screens of the ledgered cards draw is named by a card", () => collect((expect) => {
  const named = new Set(ELEMENTS.flatMap(({ e }) => [
    ...(e.kind === "panel" && (e.status === "real" || e.status === "new") ? [e.as ?? e.el] : []),
    ...("panel" in e ? [e.panel] : []),
  ]));
  for (const key of REVERSE_CHECKED) {
    expect(GOLDEN_RE.test(key), `${key} is a golden key`);
    const doc = goldenText(key);
    expect(doc !== null, `the golden ${key} (fixtures/console/${key}.html) exists`);
    if (doc === null) continue;
    const drawn = panelsIn(doc);
    expect(drawn.length > 0, `${key} draws a panel`);
    for (const id of drawn) expect(named.has(id), `${key}: the panel ${id} is named by some card's ledger (kind panel, as, or an element's panel)`);
  }
}));


// #748 was able to pass export-only ledgers while rendering generic tables. A claim now needs visible evidence
// in its own panel, so an unrelated heading elsewhere on the page cannot make a missing element look complete.
test("Fleet redesign ledger claims carry visible evidence in the panel they describe", () => collect((expect) => {
  const documents = new Map();
  for (const { card, e } of ELEMENTS.filter(({ card, e }) => ["FleetScreen", "FleetPartPaused", "HostDetail", "VenueDetail", "SpendScreen", "SpendPhone", "SpendBudgetSplit", "SpendCapacity", "SpendBreakdown", "TopologyScreen"].includes(card) && ["new", "real"].includes(e.status))) {
    const w = where(card, e);
    expect(Array.isArray(e.golden) && e.golden.length > 0, `${w}: cite a rendered state, not only an export`);
    expect("shows" in e, `${w}: name the actual visible output proving this claim`);
    // Spend tabs and controls live in the title bar, outside every data-panel section.
    const titleBar = ["admin/src/console/panels/spend.mjs#spendTabs", "admin/src/console/panels/spend.mjs#spendControls"].includes(e.source);
    if (e.kind !== "panel" && e.source?.includes("/panels/") && !titleBar) expect("panel" in e, `${w}: scope renderer evidence to its panel`);
    for (const key of e.golden ?? []) {
      if (!documents.has(key)) { const raw = goldenText(key); documents.set(key, raw === null ? null : cardDocument(raw)); }
      const doc = documents.get(key);
      if (doc === null) { expect(false, `${w}: ${key} exists`); continue; }
      const id = e.kind === "panel" ? (e.as ?? e.el) : e.panel;
      const node = id ? doc.byId.get(id) : null;
      if (id) expect(Boolean(node), `${w}: evidence panel ${id} exists in ${key}`);
      const markup = node ? doc.within(node) : id ? "" : doc.source;
      for (const piece of Array.isArray(e.shows) ? e.shows : typeof e.shows === "string" ? [e.shows] : []) expect(shows(markup, piece) || cardText(markup).includes(piece), `${w}: ${key}'s ${id ?? "page"} contains ${JSON.stringify(piece)}`);
    }
  }
}));

test("every Fleet redesign state is evidenced by its card ledger, beyond merely naming its panels", () => {
  const represented = new Set(ELEMENTS.filter(({ card }) => ["FleetScreen", "FleetPartPaused", "HostDetail", "VenueDetail"].includes(card)).flatMap(({ e }) => e.shows ? e.golden ?? [] : []));
  assert.deepEqual(FLEET_PANEL_STATES.filter((key) => !represented.has(`panels/${key}`)), [], "each rendered state must prove a visible piece in a card ledger");
});

test("every Spend state is evidenced by its card ledger with visible state-specific facts", () => {
  const cards = ["SpendScreen", "SpendBudgetSplit", "SpendCapacity", "SpendBreakdown", "TopologyScreen", "SpendPhone"];
  const represented = new Set(ELEMENTS.filter(({ card, e }) => cards.includes(card) && e.kind === "state" && e.shows).flatMap(({ e }) => e.golden ?? []));
  assert.deepEqual(SPEND_PANEL_STATES.filter((key) => !represented.has(`panels/${key}`)), []);
});

// A list claim needs the actual facts/result state in its panel. A named export or a matching heading alone
// cannot establish receiver parity, bounded schedule projection, truthful history or viewer policy.
test("Triggers cards cite visible list/check evidence for every behavior and exceptional state", () => {
  const cards = new Set(["TriggersScreen", "TriggersViewer", "TriggersPhone"]);
  const entries = ELEMENTS.filter(({ card, e }) => cards.has(card) && ["new", "real"].includes(e.status));
  for (const { card, e } of entries) {
    assert.ok(e.golden?.length, `${card}/${e.el}: rendered evidence`);
    if (e.kind !== "panel") assert.ok(e.shows?.length, `${card}/${e.el}: concrete visible output`);
    if (e.kind !== "panel" && e.source.includes("/panels/")) assert.ok(e.panel, `${card}/${e.el}: panel-scoped evidence`);
  }
  const represented = new Set(entries.flatMap(({ e }) => e.golden ?? []));
  assert.deepEqual(TRIGGER_LIST_PANEL_STATES.filter(key => !represented.has(`panels/${key}`)), [], "every exceptional state proves a concrete ledger claim");
});
