import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDocument } from "./helpers/card-structure.mjs";
import { drawSpend, spendFixture } from "./helpers/spend-goldens.mjs";
import { spendTabs, spendControls, capacityHosts, capacityKey, capacityCoverage, splitRows, splitSpentKpi, spendSplit, spendWeek, spendTokens, spendToday, spendAverage } from "../src/console/panels/spend.mjs";

// Read the rendered controls, rather than accepting a panel heading as evidence
// that the design's navigation and scoping controls exist.
test("all five Spend tabs are real links with exactly one current destination", () => {
  const paths = ["/insights", "/insights/budget-split", "/insights/capacity", "/insights/breakdown", "/insights/flows"];
  const pages = ["insights", "insights-budget-split", "insights-capacity", "insights-breakdown", "insights-flows"];
  for (let i = 0; i < pages.length; i++) {
    const text = String(spendTabs({ page: pages[i], query: { range: "7d", project: "web" } }));
    const links = [...text.matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)];
    assert.equal(links.length, 5);
    assert.deepEqual(links.map((m) => m[1].split("?")[0]), paths);
    assert.deepEqual(links.filter((m) => m[2].includes('aria-current="page"')).map((m) => m[1].split("?")[0]), [paths[i]]);
  }
});

test("Spend controls render actual range and project links, while Capacity and split keep their own scope", () => {
  const view = (page) => ({ page, query: { range: "7d", project: "web" }, data: { insights: { projects: [{ id: "web", name: "Web" }, { id: "ops", name: "Operations" }] } } });
  const spend = String(spendControls(view("insights")));
  for (const range of ["7d", "30d", "mtd"]) assert.match(spend, new RegExp(`href="/insights\\?range=${range}&amp;project=web"`));
  assert.match(spend, /href="\/insights\?range=7d&amp;project=ops"/);
  assert.match(spend, /href="\/insights\?range=7d">All projects/);
  const capacity = String(spendControls(view("insights-capacity")));
  assert.match(capacity, /range=24h/);
  assert.doesNotMatch(capacity, /project=|aria-label="Projects"/);
  const split = String(spendControls(view("insights-budget-split")));
  assert.match(split, /aria-label="Projects"/);
  assert.doesNotMatch(split, /aria-label="Spend window"/);
});

const viewOf = (payload, role = "viewer", query = {}) => ({ role, query, now: payload.nowMs, data: { insights: payload } });

test("Capacity hosts render venues, three state shares, a chart and distinct operational fact groups", () => {
  const p = spendFixture();
  p.capacity.hosts[0].venues = ["docker", "podman", "<script>bad-venue</script>"];
  const text = String(capacityHosts(viewOf(p)));
  assert.match(text, /docker/);
  assert.match(text, /podman/);
  assert.doesNotMatch(text, /bad-venue/);
  assert.match(text, /class="cp-trio"/);
  assert.match(text, /class="cp-chart/);
  assert.match(text, /class="cp-facts"/);
  for (const label of ["busy", "idle", "no data", "Jobs at once", "Full", "Promised", "CPU used", "Wait for a slot", "Projects by run time"]) assert.ok(text.includes(label), label);
  // The chart has different visual primitives for average, peak and configured slots.
  assert.match(text, /class="cp-bar"/);
  assert.match(text, /class="cp-peak-line"/);
  assert.match(text, /class="cp-slots"/);
  const bars = [...text.matchAll(/<rect class="cp-bar"[^>]*height="([0-9.]+)"/g)];
  assert.ok(bars.length > 0 && bars.every((bar) => Number(bar[1]) > 0));
  p.capacity.hosts[0].buckets[0].coveredMs = 0;
  p.capacity.hosts[0].truncated = true;
  const truncated = String(capacityHosts(viewOf(p)));
  assert.match(truncated, /class="cp-gap"/);
  assert.match(truncated, /class="cp-hatch"/);
  assert.match(truncated, /History truncated/);
});

test("Capacity chart key explains the five distinct chart marks", () => {
  const text = String(capacityKey());
  for (const label of ["average", "most", "slots", "no data", "idle"]) assert.ok(text.toLowerCase().includes(label), label);
  assert.match(text, /cp-key/);
});

test("money and token KPIs contain proportionate green meters with accessible percentages", () => {
  const p = spendFixture();
  p.spend.week = { usedMicros: 25_000_000, capMicros: 100_000_000 };
  p.spend.tokens = { used: 25_000, cap: 100_000 };
  p.spend.today = { usedMicros: 25_000_000, capMicros: 100_000_000, settledMicros: 20_000_000, heldMicros: 5_000_000, heldJobs: 2, counterConfigured: true };
  p.spend.average = { costMicros: 25_000_000, runs: 4, largestMicros: 50_000_000 };
  p.spend.jobCapMicros = 100_000_000;
  for (const render of [spendWeek, spendTokens, spendToday, spendAverage]) {
    const text = String(render(viewOf(p)));
    assert.match(text, /class="pbar tone-ok"/);
    assert.match(text, /role="meter"[^>]*aria-valuenow="25"/);
    assert.match(text, /class="pbar__fill" width="25\.0%"/);
  }
});

test("Spend shows a combined share strip driven by weights rather than spend or allocated dollars", () => {
  const p = spendFixture();
  p.allocation.state.weights = { web: 3, ops: 1 };
  p.allocation.state.allocations = { web: 10_000_000, ops: 40_000_000 };
  const text = String(spendSplit(viewOf(p)));
  const strip = text.match(/<svg[^>]*class="sp-split[\s\S]*?<\/svg>/)?.[0];
  assert.ok(strip, "one combined weight-share strip");
  const widths = [...strip.matchAll(/<rect[^>]*width="([0-9.]+)%"/g)].map((m) => Number(m[1]));
  assert.deepEqual(widths, [75, 25]);
  assert.match(text, /75%/);
  assert.match(text, /25%/);
  assert.match(text, /pm-weekly/);
  assert.match(text, /acme\/model-1/);
  // Project filtering does not change the denominator of the envelope-wide strip.
  const selected = String(spendSplit(viewOf(p, "viewer", { project: "web" })));
  assert.match(selected, /75%/);
});

test("Budget split explains provenance, validity and all four allocation marks", () => {
  const p = spendFixture();
  const text = String(splitRows(viewOf(p)));
  for (const label of ["Written by", "Applied", "Valid until", "Step", "Envelope", "pm-weekly"]) assert.ok(text.includes(label), label);
  assert.match(text, /2026-10-09/);
  for (const mark of ["alloc", "spent", "floor", "over"]) assert.match(text, new RegExp(`al-k--${mark}`));
  assert.match(text, /held included/i);
  assert.doesNotMatch(text, /data-action=/);
});


test("Capacity coverage shows each actual count and preserves unknown instead of inventing zero", () => {
  const p = spendFixture();
  p.capacity.coverageCounts = { used: 37, refusedBeforeSlot: 11, retried: 5, withoutSize: 3, running: 2, liveNotCounted: null };
  const text = String(capacityCoverage(viewOf(p)));
  for (const [label, value] of [["Runs counted", "37"], ["Refused before a slot", "11"], ["Retried", "5"], ["Without a size", "3"], ["Running now", "2"], ["Live runs not counted", "unknown"]]) {
    assert.match(text, new RegExp(`<dt>${label}</dt><dd>${value}</dd>`));
  }
});

test("Capacity tooltips reference one escaped list across all host charts", () => {
  const p = spendFixture();
  p.capacity.hosts[0].buckets[0].coveredMs = 0;
  const text = String(capacityHosts(viewOf(p)));
  const hidden = text.match(/<ol id="insights-tips"[^>]* hidden>([\s\S]*?)<\/ol>/);
  assert.ok(hidden, "script-free hidden tooltip list");
  const entries = [...hidden[1].matchAll(/<li>([\s\S]*?)<\/li>/g)];
  const refs = [...text.matchAll(/data-tip="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(refs.length > 20, "all host buckets contribute tooltips");
  assert.deepEqual([...new Set(refs)].sort((a, b) => a - b), entries.map((_, i) => i));
  assert.ok(entries.some((e) => e[1].includes("no data, neither busy nor idle")));
  assert.ok(entries.some((e) => e[1].includes("average") && e[1].includes("peak")));
  assert.doesNotMatch(hidden[1], /<(?:script|svg|img)\b/);
});


test("Spend renders its three cost cards together and separates main charts from the contextual column", async () => {
  const doc = cardDocument(await drawSpend());
  const costs = doc.nodes.find((n) => n.classes.includes("spend-costs"));
  assert.ok(costs?.classes.includes("cards-3"));
  for (const id of ["p-byflow", "p-bymodel", "p-byproject"]) assert.ok(doc.byId.get(id)?.ancestors.includes(costs), id);
  const main = doc.nodes.find((n) => n.classes.includes("spend-main"));
  const side = doc.nodes.find((n) => n.classes.includes("spend-side"));
  for (const id of ["p-over", "p-sizes", "p-split"]) assert.ok(doc.byId.get(id)?.ancestors.includes(main), id);
  for (const id of ["p-caps", "p-whatif", "p-plan"]) assert.ok(doc.byId.get(id)?.ancestors.includes(side), id);
});

test("published all-zero split weights remain known rather than being described as missing", () => {
  const p = spendFixture();
  p.allocation.state.weights = { web: 0, ops: 0 };
  const text = String(spendSplit(viewOf(p)));
  assert.doesNotMatch(text, /weights were not published/i);
  assert.match(text, /weights[^<]*zero|zero[^<]*weights/i);
});


test("an unknown allocation is never classified as zero or over allocation", () => {
  const p = spendFixture();
  p.allocation.state.allocations.web = null;
  p.allocation.spend.projects.web = 1000000;
  const view = viewOf(p);
  assert.match(String(splitSpentKpi(view)), /0 projects over allocation/);
  const rows = String(splitRows(view));
  assert.doesNotMatch(rows, /class="al-bar__spent--over"/);
  assert.match(rows, /unknown/);
});
