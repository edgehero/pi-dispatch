import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PAGES, panelIds } from "../src/console/pages.mjs";

// Every published-source card is either a checked element ledger or has an explicit disposition. This is a scope
// check, not proof that a screen works: each ledger and its behavioral/browser tests supply that evidence. Family
// variants share a route; proposed cards do not justify adding unrelated pages to #751.
const OUTSIDE_LEDGERS = Object.freeze({
  Cover: "The design artifact's hand-written cover, not an application route.",
  ConceptMap: "A guide to the existing services, not an application route.",
  Glossary: "A vocabulary guide, not an application route.",
  SampleStory: "The sample deployment's story, not an application route.",
  JourneyAnswer: "A storyboard joining existing screens, not an application route.",
  JourneyFailure: "A storyboard joining existing screens, not an application route.",
  JourneySetup: "A storyboard; browser setup remains proposed in SetupScreen under #774.",
  FleetPhone: "The built FleetScreen route at phone width (#748), covered by its family ledger and browser sweep.",
  FleetViewer: "The built FleetScreen route as a viewer (#748), covered by its family ledger and role tests.",
  RunLivePhone: "The built RunLive route at phone width (#747), covered by its family ledger and browser sweep.",
  ApprovalRequest: "Built separately by #649; approval request state belongs to the run and parked pages.",
  ForkRun: "Built separately by #648; managed forks belong to the run page.",
  WatchScreen: "Built separately by #735; its existing /watch route stays separate.",
  WatchBoard: "Built separately by #743; its existing /watch/board route stays separate.",
  DispatchersScreen: "Proposed by #776; grew from #735, outside #751.",
  DispatcherScreen: "Proposed by #776; grew from #735, outside #751.",
});

function assertDispositionOwner(card, disposition, preview) {
  if (!/aria-label="Design status: (?:Planned|Proposed)"/.test(preview)) return;
  const note = preview.match(/<span class="ds-status__n">([^<]*)<\/span>/)?.[1];
  const owner = note?.match(/#\d+/)?.[0];
  assert.ok(owner, `${card}: a future screen must keep its published owning issue`);
  assert.equal(disposition.match(/#\d+/)?.[0], owner, `${card}: disposition must name its published owning issue first`);
}

const COMPONENTS = new URL("../../design/system/components/", import.meta.url);
const LEDGERS = new URL("./fixtures/console-ledger/", import.meta.url);
const CARDS = Object.freeze({
  ModelsScreen: { page: "models", path: "/models" },
  SandboxesScreen: { page: "sandboxes", path: "/runs/sandboxes", auth: "operator" },
  ZeroTouchScreen: { page: "zero-touch", path: "/runs/zero-touch" },
  ZeroTouchViewer: { page: "zero-touch", path: "/runs/zero-touch" },
  SecretsScreen: { page: "secrets", path: "/config/secrets" },
  ConnectionsScreen: { page: "connections", path: "/config/connections" },
  ProjectDetail: { page: "project", path: "/config/project" },
});

test("every published design card has a checked ledger or an explicit issue/family/guide disposition", () => {
  const cards = readdirSync(COMPONENTS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const ledgerCards = readdirSync(LEDGERS).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  for (const card of Object.keys(OUTSIDE_LEDGERS)) {
    assert.match(OUTSIDE_LEDGERS[card], /#\d+|artifact|guide|storyboard|deployment.s story/, `${card}: its owning issue or guide purpose is explicit`);
    assert.ok(!ledgerCards.includes(card), `${card}: remove the exclusion when its ledger arrives`);
    // The ribbon's first issue owns the future screen; older worker prerequisites can follow it. A new owning
    // issue must update this disposition even when the directory inventory itself has not changed.
    const preview = readFileSync(new URL(`${card}/preview.html`, COMPONENTS), "utf8");
    assertDispositionOwner(card, OUTSIDE_LEDGERS[card], preview);
  }
  assert.deepEqual([...ledgerCards, ...Object.keys(OUTSIDE_LEDGERS)].sort(), cards,
    "a new or removed card needs its own ledger or an explicitly reviewed disposition; no published card is forgotten");
});

test("a future-card owner cannot drift to a prerequisite or disappear while the card inventory stays the same", () => {
  for (const [card, prerequisite] of [["DispatcherScreen", "#735"]]) {
    const preview = readFileSync(new URL(`${card}/preview.html`, COMPONENTS), "utf8");
    assertDispositionOwner(card, OUTSIDE_LEDGERS[card], preview);
    assert.ok(OUTSIDE_LEDGERS[card].includes(prerequisite), "the prerequisite is a real counterexample to a substring check");
    for (const note of [`${prerequisite}, replacing the screen's issue`, "No owning issue yet."]) {
      const changed = preview.replace(/(<span class="ds-status__n">)[^<]*/, `$1${note}`);
      assert.notEqual(changed, preview, `${card}: the published ribbon actually changed`);
      assert.throws(() => assertDispositionOwner(card, OUTSIDE_LEDGERS[card], changed), { code: "ERR_ASSERTION" });
    }
  }
});

test("the three #751 cards map to real viewer routes and every README/preview panel maps to its page", () => {
  for (const [card, spec] of Object.entries(CARDS)) {
    assert.equal(PAGES[spec.page]?.path, spec.path, card);
    assert.equal(PAGES[spec.page]?.auth, spec.auth ?? "viewer", card);
    assert.equal(PAGES[spec.page]?.live, spec.page === "sandboxes", `${card}: drawn on demand`);
    const ledger = JSON.parse(readFileSync(new URL(`${card}.json`, LEDGERS), "utf8"));
    const readme = readFileSync(new URL(`${card}/README.md`, COMPONENTS), "utf8");
    const panelLine = readme.match(/\*\*Panels\.\*\* ([^\n]+)/)?.[1];
    assert.ok(panelLine, `${card}: the source card names its panels`);
    const readmePanels = [...panelLine.matchAll(/`(p-[a-z-]+)`/g)].map((match) => match[1]);
    const preview = readFileSync(new URL(`${card}/preview.html`, COMPONENTS), "utf8");
    const previewPanels = [...preview.matchAll(/\bid="(p-[a-z-]+)"[^>]*\bdata-panel/g)].map((match) => match[1]);
    assert.deepEqual(ledger.panels, readmePanels, `${card}: ledger covers the published README`);
    assert.deepEqual(previewPanels, readmePanels, `${card}: source preview and README describe the same complete screen`);
    const mapped = ledger.elements.filter((element) => element.kind === "panel").map((element) => element.as ?? element.el);
    assert.deepEqual([...mapped].sort(), [...panelIds(spec.page)].filter((id) => !["p-nav-parked", "p-headline"].includes(id)).sort(),
      `${card}: every card panel reaches the implementation and every implementation panel is accounted for`);
  }
});
