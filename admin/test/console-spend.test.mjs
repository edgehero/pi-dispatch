import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parsePageQuery,
  pageQueryString,
  PAGES,
  loadPageData,
  renderPage,
  LEGACY_PAGES,
} from "../src/console/pages.mjs";
import {
  responsiveInsightsSvg,
  SPEND_PANELS,
  SPEND_VIEWS,
  flowsMap,
  flowsSelected,
  splitHistory,
  splitEnvelope,
  splitPriorities,
  spendToday,
  spendTabs,
  spendCaps,
} from "../src/console/panels/spend.mjs";
import {
  SPEND_CARD_CSS_HASHES,
  SPEND_DESIGN_CSS,
  SPEND_CSS,
  SPEND_PAINT_TOKENS,
  SPEND_EXTRA_PAINTS,
} from "../src/console/spend-css.mjs";
import { assembleInsightsView } from "../src/insights-assembly.mjs";
import { PD_TOKENS, SVG_EXTRA } from "../src/console/compat-css.mjs";
import { PAGE_CSS, pageCss } from "../src/console/page-css.mjs";
import { SPEND_DRAW, spendFixture } from "./helpers/spend-goldens.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const graph = {
  caps: { windowDays: 30 },
  meta: {},
  folders: [
    {
      key: "folder:/private/repo",
      path: "/private/repo",
      label: "repo",
      kind: "local",
      head: "a".repeat(40),
      triggerIds: ["trigger:3"],
      skillIds: ["skill:fix"],
    },
  ],
  nodes: [
    {
      id: "trigger:3",
      kind: "trigger",
      index: 3,
      onType: "cron",
      cronId: "weekly",
      pattern: "0 0 * * *",
      label: "Weekly",
      folderKey: "folder:/private/repo",
      flow: "fix",
      runs: 2,
      lastOutcome: "completed",
      disarmed: { at: "2026-10-29T10:00:00Z", jobId: "run-one" },
    },
    {
      id: "skill:fix",
      kind: "skill",
      name: "fix",
      label: "fix",
      folderKey: "folder:/private/repo",
      aiTrigger: true,
    },
  ],
  edges: [{ from: "trigger:3", to: "skill:fix", kind: "config" }],
  flags: [],
};
const allocation = {
  window: "week",
  totalMicros: 100_000_000,
  floors: { web: 10_000_000, _other: 0 },
  delegation: true,
  spend: { deployment: 20_000_000, projects: { web: 20_000_000 } },
  envelope: {
    window: "week",
    totalMicros: 100_000_000,
    floors: { web: 10_000_000, _other: 0 },
    defaultWeights: { web: 100, _other: 0 },
    delegation: {
      enabled: true,
      writers: ["operator-session"],
      maxStepPct: 25,
      minIntervalHours: 2,
      maxPlanDays: 7,
    },
  },
  state: {
    planId: "a".repeat(64),
    allocations: { web: 80_000_000, _other: 20_000_000 },
    weights: { web: 100, _other: 0 },
    reasons: { web: "Hostile <script>\u202e" },
    writer: "operator-session",
  },
  log: [
    {
      at: new Date(NOW).toISOString(),
      writer: "default",
      outcome: "applied",
      planId: null,
      weights: { web: 100 },
    },
  ],
};
const view = (over = {}) => ({
  page: "insights-flows",
  role: "operator",
  now: NOW,
  query: { range: "7d", project: "web" },
  data: { insights: { graph, allocation } },
  ...over,
});

test("five Spend pages are viewer reads, non-live and outside the legacy layer", () => {
  assert.equal(SPEND_VIEWS.length, 5);
  for (const [name, path] of SPEND_VIEWS) {
    assert.equal(PAGES[name].path, path);
    assert.equal(PAGES[name].auth, "viewer");
    assert.equal(PAGES[name].live, false);
    assert.ok(!LEGACY_PAGES.includes(name));
    assert.ok(SPEND_PANELS[name].length >= 4);
  }
});

test("queries validate by view, bound select, accept old what-if and canonicalize round trips", () => {
  const cases = [
    ["insights", "range=7d&project=web&whatif=p%2Fm&runs=week"],
    ["insights", "whatif=p%2Fm&flow=fix"],
    ["insights-capacity", "range=24h"],
    ["insights-budget-split", "range=mtd&project=web"],
    ["insights-flows", "range=7d&select=3&view=list&paths=full"],
    ["insights-breakdown", "whatif=p%2Fm&flow=fix"],
  ];
  for (const [name, search] of cases) {
    const got = parsePageQuery(name, new URLSearchParams(search));
    assert.ok(got.query, `${name}: ${got.refusal}`);
    assert.deepEqual(
      parsePageQuery(
        name,
        new URLSearchParams(pageQueryString(name, got.query)),
      ),
      got,
    );
  }
  for (const [name, search] of [
    ["insights", "range=24h"],
    ["insights-capacity", "project=web"],
    ["insights-flows", "select=-1"],
    ["insights-flows", "select=1e9"],
    ["insights-flows", "view=other"],
    ["insights-breakdown", "whatif=p%2Fm"],
    ["insights", "runs=month"],
    ["insights", "project=../../private"],
  ])
    assert.ok(
      parsePageQuery(name, new URLSearchParams(search)).refusal,
      search,
    );
});

test("loads pass role/project/view boundaries and windowed run-set what-if without flow", async () => {
  const calls = [];
  const deps = {
    now: () => NOW,
    insights: async (...args) => (calls.push(args), {}),
    whatIf: async (q) => (calls.push(q), {}),
    fleet: {},
  };
  await loadPageData(
    "insights",
    { range: "7d", project: "web", paths: "full", whatif: "p/m", runs: "week" },
    deps,
    { role: "viewer" },
  );
  assert.deepEqual(calls[0], [
    "7d",
    { view: "spend", fullPaths: false, project: "web", role: "viewer" },
  ]);
  assert.deepEqual(calls[1], {
    model: "p/m",
    flow: null,
    range: "7d",
    project: "web",
    runs: "week",
  });
  calls.length = 0;
  await loadPageData(
    "insights-budget-split",
    { range: "mtd", paths: "full" },
    deps,
    { role: "operator" },
  );
  assert.deepEqual(calls[0], [
    "mtd",
    { view: "budget-split", fullPaths: true, project: null, role: "operator" },
  ]);
});

test("tab links retain only destination-supported filters and keep 24h off spend routes", () => {
  const text = String(
    spendTabs(
      view({
        page: "insights-capacity",
        query: { range: "24h", project: "web", paths: "full" },
      }),
    ),
  );
  assert.match(
    text,
    /href="\/insights\?range=30d&amp;project=web&amp;paths=full"/,
  );
  assert.match(text, /href="\/insights\/capacity\?range=24h&amp;paths=full"/);
});

test("server-selected map is accessible, links spent run and script-free list has no hidden node data", () => {
  const v = view({ query: { range: "7d", project: "web", select: "3" } });
  const map = String(flowsMap(v));
  const selected = String(flowsSelected(v));
  assert.match(map, /tabindex="0" role="button"/);
  assert.match(map, /data-trigger-index="3" aria-pressed="true"/);
  assert.match(map, /data-graph-zoom="fit"/);
  assert.match(selected, /Trigger 4/);
  assert.match(selected, /\/run\?id=run-one/);
  assert.match(selected, /\/runs\?trigger=weekly/);
  const list = String(flowsMap({ ...v, query: { ...v.query, view: "list" } }));
  assert.match(list, /Flows list/);
  assert.match(list, /4\. cron Weekly/);
  assert.doesNotMatch(list, /id="graph-nodes"|id="graph"|script/);
});

test("structured allocation forms use normalized envelope dollars, delegation bounds and human row numbers", () => {
  const v = view();
  const envelope = String(splitEnvelope(v));
  const priorities = String(splitPriorities(v));
  const history = String(splitHistory(v));
  assert.match(envelope, /name="totalUsd"[^>]*value="100"/);
  assert.match(envelope, /name="floor:web"[^>]*value="10"/);
  assert.match(envelope, /data-structured="envelope"/);
  assert.match(priorities, /name="validDays"[^>]*max="7"/);
  assert.match(priorities, /name="weight:web"/);
  assert.match(history, /Revert row 1/);
  assert.match(history, /name="index"[^>]*value="0"/);
  assert.doesNotMatch(
    String(splitHistory({ ...v, role: "viewer" })),
    /data-action|<th>Action/,
  );
  assert.equal(String(splitPriorities({ ...v, role: "viewer" })), "");
});

test("money reconciliation names unknown hosts, leaves missing holds unknown and draws no non-job soft tick", () => {
  const text = String(
    spendToday(
      view({
        data: {
          insights: {
            spend: {
              today: {
                usedMicros: 10_000_000,
                settledMicros: 2_000_000,
                heldMicros: null,
                heldJobs: 2,
                unknownHosts: ["old-host"],
                reconciliationMismatch: true,
              },
            },
          },
        },
      }),
    ),
  );
  assert.match(text, /old-host/);
  assert.match(text, /unknown/);
  assert.match(text, /reconciliation mismatch/);
  const caps = String(
    spendCaps(
      view({
        data: {
          insights: {
            budget: {
              softHoldPct: 80,
              tokens: { spent: 85, cap: 100 },
              dollars: {
                windows: [
                  {
                    name: "deployment",
                    window: "day",
                    counterMicros: 90_000_000,
                    capMicros: 100_000_000,
                  },
                ],
              },
            },
          },
        },
      }),
    ),
  );
  assert.doesNotMatch(caps, /<line/);
  assert.match(caps, /\$90\.00/);
});

for (const [cardName, hash] of Object.entries(SPEND_CARD_CSS_HASHES))
  test(`${cardName} local rules are copied exactly and served under Spend scope`, () => {
    const source = readFileSync(
      new URL(
        `../../design/system/components/${cardName}/preview.html`,
        import.meta.url,
      ),
      "utf8",
    );
    const css = /<style>([\s\S]*?)<\/style>/.exec(source)[1];
    assert.equal(createHash("sha256").update(css).digest("hex"), hash);
    assert.ok(SPEND_DESIGN_CSS.includes(css));
    assert.ok(PAGE_CSS.insights.includes(SPEND_CSS));
    assert.match(
      pageCss({ insights: SPEND_CSS }),
      /body\[data-page="insights"\]/,
    );
  });

test("all five pages render clean HTML from the real slice assembler, across roles", async () => {
  const pricing = {
    listPricedModels: () => [],
    piAiVersion: () => "test",
    getPricedModel: () => null,
    isZeroRated: () => false,
    reprice: () => ({ usd: 0 }),
  };
  const reads = {
    projects: () => ({ projects: [{ id: "web", name: "Web" }] }),
    costs: () => ({ fold: { provenance: { runsTotal: 0 } }, records: [] }),
    graph: () => graph,
    budget: () => ({ dollars: { windows: [] } }),
    allocation: () => allocation,
    capacity: () => ({ noTime: true }),
    sizing: () => null,
    hosts: () => ({ hosts: [] }),
    scan: () => [],
    subscriptions: () => ({ subscriptions: [] }),
    settings: () => ({ overlay: {} }),
  };
  for (const [name] of SPEND_VIEWS)
    for (const role of ["operator", "viewer"]) {
      const insights = await assembleInsightsView({}, "7d", {
        view: name === "insights" ? "spend" : name.slice(9),
        role,
        nowMs: NOW,
        pricing,
        reads,
        envFn: () => ({}),
      });
      const result = await renderPage(name, {
        session: { role },
        query: { range: "7d" },
        data: { now: NOW, insights },
      });
      const text = String(result.html);
      assertClean(`${name}.${role}`, text);
      assert.doesNotMatch(text, /class="legacy"/);
      if (role === "viewer")
        assert.doesNotMatch(text, /Hostile|private\/repo|data-structured/);
    }
});

test("Spend paint mapping is pinned to the renderer palette's existing semantic roles", () => {
  assert.deepEqual(SPEND_PAINT_TOKENS, PD_TOKENS);
  assert.deepEqual(SPEND_EXTRA_PAINTS, SVG_EXTRA);
});
test("viewer full-path requests redact folder caps and local repository labels on every view", async () => {
  const p = {
    graph,
    allocation,
    budget: {
      scoped: [
        { scope: "folder:/private/secret/repo", day: { used: 1, cap: 3 } },
      ],
      dollars: {
        windows: [
          {
            name: "folder:/private/secret/repo",
            ledger: "folder:/private/secret/repo",
            window: "day",
            counterMicros: 1,
            capMicros: 10,
          },
        ],
      },
    },
    fold: {
      byRepo: [
        {
          label: "/private/secret/repo",
          kind: "local",
          cost: { usd: 1, class: "metered" },
        },
      ],
    },
  };
  for (const [name] of SPEND_VIEWS) {
    const result = await renderPage(name, {
      session: { role: "viewer" },
      query: { range: "7d", paths: "full" },
      data: { now: NOW, insights: p },
    });
    assert.doesNotMatch(
      String(result.html),
      /private\/secret|private\/repo|Hostile/,
      name,
    );
  }
});

test("every link from every Spend fixture reaches a page whose query parser accepts it", async () => {
  const paths = new Map(
    Object.entries(PAGES).map(([name, page]) => [page.path, name]),
  );
  let checked = 0;
  for (const [shot, draw] of Object.entries(SPEND_DRAW)) {
    const output = await draw();
    const text = String(output.html ?? output);
    for (const match of text.matchAll(/<a\b[^>]*href="([^"#]+)"/g)) {
      const href = match[1].replaceAll("&amp;", "&");
      if (!href.startsWith("/")) continue;
      const url = new URL(href, "http://console.invalid");
      const name = paths.get(url.pathname);
      assert.ok(name, `${shot}: ${href} is a console page`);
      const got = parsePageQuery(name, url.searchParams);
      checked++;
      assert.equal(got.refusal, undefined, `${shot}: ${href}: ${got.refusal}`);
    }
  }
  assert.ok(checked > 100, `${checked} links were actually inspected`);
});
test("a cron id beyond the runs filter bound falls back to its stable trigger index", () => {
  const p = {
    graph: {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === "trigger" ? { ...n, cronId: "a".repeat(176) } : n,
      ),
    },
  };
  const text = String(
    flowsSelected(
      view({ query: { range: "7d", select: "3" }, data: { insights: p } }),
    ),
  );
  assert.match(text, /href="\/runs\?trigger=3"/);
});


test("Caps says Full from the reader's next-reservation decision before the dollar counter reaches its cap", () => {
  const view = { role: "viewer", query: {}, data: { insights: { budget: { dollars: { windows: [{ name: "deployment", window: "day", counterMicros: 9_000_000, capMicros: 10_000_000, full: true }] } } } } };
  const text = String(spendCaps(view));
  assert.match(text, /spent and held\): Full/);
  assert.match(text, /\$9.00/);
  assert.match(text, /\$10.00/);
  assert.doesNotMatch(text, /<line/);
});

test("legacy chart viewBoxes preserve complete geometry when a card shrinks", () => {
  assert.equal(responsiveInsightsSvg('<svg width="960" height="180" role="img"><g></g></svg>'), '<svg width="960" height="180" role="img" viewBox="0 0 960 180"><g></g></svg>');
  const ready = '<svg width="960" height="180" viewBox="0 0 100 40"></svg>';
  assert.equal(responsiveInsightsSvg(ready), ready);
});


test("count cap observer thresholds match the next start and scoped counters have no soft-hold tick", () => {
  for (const [reserved, word] of [[10, "Full"], [8, "Soft hold"], [7, "Open"], [null, "unknown"]]) {
    const text = String(spendCaps({ role: "viewer", query: {}, data: { insights: { budget: { day: { reserved, cap: 10, state: "ok" }, softHoldPct: 80, scoped: [{ scope: "project:web", day: { used: 8, cap: 10, state: "ok" } }] } } } }));
    assert.ok(text.includes(`Jobs this day: ${word}`), `${reserved} is ${word}`);
    assert.ok(text.includes("project:web jobs day: Open"), "the same count is open under a scoped hard cap");
    assert.equal((text.match(/<line\b/g) ?? []).length, 1, "only the global count has a soft-hold tick");
  }
});


test("Caps names failed dollar/scoped reads instead of silently omitting their rows", () => {
  for (const budget of [{ dollars: { invalid: ["private-error-marker"] } }, { dollars: { countersUnreachable: "private-error-marker" } }, { scopedInvalid: "private-error-marker" }]) {
    const text = String(spendCaps({ role: "viewer", query: {}, data: { insights: { budget } } }));
    assert.match(text, /settings file or counters could not be read/);
    assert.doesNotMatch(text, /private-error-marker/);
  }
});

test("sidebar and KPI facts keep one label/value pair per row at desktop widths", async () => {
  const fixture = spendFixture();
  fixture.allocation.state.reasons = { web: "A longer operator reason must have room to wrap as prose." };
  for (const [name, ids] of [["insights", ["week", "today", "avg", "plan"]], ["insights-budget-split", ["envelope", "plan-reasons", "split-counts"]], ["insights-flows", ["flows-selected"]]]) {
    const out = await renderPage(name, { session: { role: "operator" }, query: { range: "7d", select: "0" }, data: { now: NOW, insights: fixture } });
    for (const id of ids) {
      const section = new RegExp(`<section id="p-${id}" data-panel>([\\s\\S]*?)</section>`).exec(String(out.html))?.[1];
      assert.ok(section, `${name}: ${id} exists`);
      for (const match of section.matchAll(/<dl class="([^"]*)"/g)) assert.ok(match[1].split(" ").includes("facts--1"), `${id}: a desktop facts grid has only one label/value pair per row`);
    }
  }
});
test("cron rearm stays a wire and is never described as a target skill or observed skill chain", () => {
  const p = { graph: { ...graph, edges: [...graph.edges, { from: "trigger:3", to: "trigger:3", kind: "cron-rearm", label: "0 0 * * *" }] } };
  const v = view({ query: { range: "7d", select: "3", view: "list" }, data: { insights: p } });
  const list = String(flowsMap(v));
  assert.match(list, /fix\s+skill/);
  assert.doesNotMatch(list, /skill,\s*trigger/);
  const details = String(flowsSelected(v));
  assert.doesNotMatch(details, /cron-rearm/);
});
