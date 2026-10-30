import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProjectSizingChart, projectSizing, projectSizingChart, projectSpend, projectRuns, projectSize, projectTriggers, projectMembers, projectDelete, projectBundle, projectRecent, projectLimits, projectAllocation } from "../src/console/panels/project.mjs";
import { projectSizeAction } from "../src/project-view.mjs";
import { reasonWords } from "../src/words.mjs";
import { parseDocument as parsePage } from "./helpers/script-dom.mjs";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const DAY = 86_400_000;
const parseDocument = (markup) => parsePage(`<html><body>${markup}</body></html>`);
function fixture() {
  const call = 'dispatch_limit_edit {"index":2,"memory":"4g","cpus":2}';
  return { id: "billing", state: "ready", now: NOW, project: { id: "billing", name: "Billing" }, members: [{ label: "github:acme/billing", local: false, count: 5, last: null }], memberInput: "github:acme/billing", editRefusal: null, deleteRefusal: null, size: { memMiB: 8192, cpuCenti: 400 }, spend: { window: "week", settledMicros: 6_100_000, heldMicros: 2_000_000, usedMicros: 8_100_000, shareMicros: 25_000_000, envelope: true }, sizing: { memory: { current: 8192, suggested: 4096, reason: "oversized" }, cpu: { current: 400, suggested: 200, reason: "underused" }, call, action: projectSizeAction(call, "billing"), words: { memory: "p95 peak 2g", cpu: "p95 0.9 cores", cpuFact: "the median run was held back 4% of its time by this host's CPU ceiling, which a job's cpus do not change" }, series: [{ at: NOW - 20 * DAY, peakMiB: 1024, sizeMiB: 8192, oom: false }, { at: NOW - 10 * DAY, peakMiB: 2048, sizeMiB: 4096, oom: true }] } };
}
const view = (projectView, extra = {}) => ({ role: "operator", readOnly: false, data: { projectView }, ...extra });

test("project chart plots measured peaks, per-run changing size and suggestion on one numeric scale", () => {
  const p = fixture();
  const chart = layoutProjectSizingChart(p.sizing.series, { now: NOW, currentMiB: p.size.memMiB, suggestedMiB: 4096 });
  const [first, second] = chart.points;
  assert.ok(first.x < second.x);
  assert.ok(Math.abs(first.x - (chart.plot.left + (chart.plot.right - chart.plot.left) / 3)) < Number.EPSILON * chart.width, "a third of the dated plot, to floating-point precision");
  assert.equal(first.y, chart.plot.bottom - (1024 / chart.topMiB) * (chart.plot.bottom - chart.plot.top));
  assert.equal(second.y, chart.plot.bottom - (2048 / chart.topMiB) * (chart.plot.bottom - chart.plot.top));
  assert.equal(chart.suggestedY, second.sizeY);
  assert.ok(chart.segments.some((s) => s.x1 === second.x && s.x2 === second.x && s.y1 !== s.y2), "given size changes vertically at the second run");
  assert.ok(chart.segments.some((s) => s.x2 === chart.plot.right && s.mib === 8192), "current size is present at the right edge");
  const markup = String(projectSizingChart(p));
  assert.match(markup, /out-of-memory kill/);
  assert.match(markup, /class="proj-peak proj-peak--oom"/);
  assert.match(markup, /GiB/);
  assert.match(markup, /size given \(solid\)/);
  assert.match(markup, /size given \(solid\): changes per run/);
  assert.match(markup, /suggestion \(dashed\): 4 GiB/);
  assert.ok(!markup.includes("NaN"));
  p.sizing.series = p.sizing.series.map((point) => ({ ...point, sizeMiB: 8192 }));
  assert.match(String(projectSizingChart(p)), /size given \(solid\): 8 GiB/);
});

test("fixed 30-day chart leaves idle gaps and drops points outside its time range", () => {
  const p = fixture();
  const chart = layoutProjectSizingChart([{ at: NOW - 31 * DAY, peakMiB: 4000, sizeMiB: 8192 }, { at: NOW - DAY, peakMiB: 1000, sizeMiB: 8192 }, { at: NOW + DAY, peakMiB: 1000, sizeMiB: 8192 }], { now: NOW, currentMiB: 8192 });
  assert.equal(chart.points.length, 1);
  assert.ok(chart.points[0].x > chart.plot.left + (chart.plot.right - chart.plot.left) * 0.9);
  assert.equal(chart.suggestedY, null);
});

test("an advisory peak above the given size keeps its actual plotted value and the OOM mark", () => {
  const p = fixture();
  p.sizing.series = [{ at: NOW - DAY, peakMiB: 10240, sizeMiB: 8192, oom: true }];
  const chart = layoutProjectSizingChart(p.sizing.series, { now: NOW, currentMiB: 8192, suggestedMiB: 4096 });
  const point = chart.points[0];
  assert.ok(chart.topMiB >= 10240);
  assert.equal(point.y, chart.plot.bottom - (10240 / chart.topMiB) * (chart.plot.bottom - chart.plot.top));
  assert.ok(point.y < point.sizeY, "the 10 GiB peak must plot above its 8 GiB given-size line");
  const markup = String(projectSizingChart(p));
  assert.match(markup, new RegExp(`class="proj-peak proj-peak--oom" cx="${Math.round(point.x * 100) / 100}" cy="${Math.round(point.y * 100) / 100}"`));
  assert.match(markup, /peak 10 GiB, given 8 GiB, out-of-memory kill/);
});

test("chart units sit outside the scaled SVG and numeric labels center on their actual grid coordinates", () => {
  const p = fixture();
  const chart = layoutProjectSizingChart(p.sizing.series, { now: NOW, currentMiB: p.size.memMiB, suggestedMiB: 4096 });
  const markup = String(projectSizingChart(p));
  const svg = /<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(markup)[1];
  assert.ok(markup.indexOf('<p class="proj-chart-unit">GiB</p>') < markup.indexOf("<svg"), "the unit gets its own unscaled line instead of overlapping the maximum tick at phone widths");
  assert.doesNotMatch(svg, /<text\b[^>]*>GiB<\/text>/);
  const values = [...svg.matchAll(/<text class="proj-axis" x="60" y="([\d.]+)" text-anchor="end" dominant-baseline="middle">([\d.]+)<\/text>/g)];
  assert.deepEqual(values.map((m) => [Number(m[1]), Number(m[2])]), chart.ticks.map((t) => [Math.round(t.y * 100) / 100, t.value / 1024]));
  assert.ok(chart.ticks.every((t) => t.y >= 15 && t.y <= chart.height - 37), "the larger phone glyphs have space on both sides of the extreme tick centers");
});

test("spend meter is held-inclusive while headline settles and held are separate", () => {
  const markup = String(projectSpend(view(fixture())));
  assert.match(markup, /\$6\.10/);
  assert.match(markup, /\$2\.00/);
  assert.match(markup, /\$8\.10/);
  assert.match(markup, /aria-valuenow="32"/);
  assert.match(markup, /width="32\.4%"/);
});

test("known total spend leads an unknown held split and the numeric meter remains held-inclusive", () => {
  const p = fixture();
  Object.assign(p.spend, { usedMicros: 13_340_000, settledMicros: null, heldMicros: null, heldIncomplete: true, heldKnownMicros: 0, shareMicros: 39_550_000 });
  const markup = String(projectSpend(view(p)));
  const doc = parseDocument(markup);
  assert.equal(doc.querySelector(".proj-kv b").textContent, "$13.34");
  assert.match(doc.querySelector(".proj-kv").textContent, /spent and held, of a \$39\.55 share/);
  assert.equal(doc.querySelector(".proj-meter-label").textContent, "$13.34 / $39.55");
  assert.match(markup, /split between spent and held is unknown/);
  assert.equal(doc.querySelector('[role="meter"]').getAttribute("aria-valuenow"), "34");
  Object.assign(p.spend, { usedMicros: null, settledMicros: null, shareMicros: null });
  assert.equal(parseDocument(String(projectSpend(view(p)))).querySelector(".proj-kv b").textContent, "unknown", "an unread total is never invented from incomplete holds");
  Object.assign(p.spend, { envelope: false, settledMicros: 3_400_000 });
  const noEnvelope = parseDocument(String(projectSpend(view(p))));
  assert.equal(noEnvelope.querySelector(".proj-kv b").textContent, "$3.40");
  assert.equal(noEnvelope.querySelector('[role="meter"]'), null);
  assert.match(noEnvelope.textContent, /no envelope, so no share/);
});

test("the worst run uses one catalog short reason and never a supplied diagnostic paragraph", () => {
  const p = fixture();
  p.runs24h = { total: 1, counts: { cancelled: 1 }, inLine: 0, worst: { jobId: "gh-stop", host: "build3", outcome: "cancelled", reason: "operator-cancel", reasonSentence: "PRIVATE_DIAGNOSTIC. Three more sentences. A raw tool error." } };
  const markup = String(projectRuns(view(p)));
  assert.match(markup, /class="proj-state tone-idle"/);
  const line = parseDocument(markup).querySelector(".proj-state").textContent;
  const short = reasonWords("operator-cancel").short;
  assert.equal(line, `gh-stop cancelled on build3: ${short.charAt(0).toLowerCase() + short.slice(1)}.`);
  assert.doesNotMatch(markup, /PRIVATE_DIAGNOSTIC|Three more sentences|A raw tool error/);
  p.runs24h.worst.outcome = "refused";
  p.runs24h.worst.reason = "egress-proxy-missing";
  assert.match(String(projectRuns(view(p))), /class="proj-state tone-refused"/);
  assert.match(String(projectRuns(view(p))), /its allowlist proxy is not on this host/);
  assert.doesNotMatch(String(projectRuns(view(p))), /this deployment runs jobs behind an egress policy/);
  p.runs24h.worst.reason = "unpublished-new-reason";
  assert.match(String(projectRuns(view(p))), /no reason is published/);
  assert.doesNotMatch(String(projectRuns(view(p))), /PRIVATE_DIAGNOSTIC|unpublished-new-reason/);
});

test("the members form edits only members and keeps a compact preview with its hint", () => {
  const p = fixture();
  const doc = parseDocument(String(projectMembers(view(p))));
  const form = doc.querySelector('form[data-action="project-edit"]');
  assert.equal(form.querySelectorAll("textarea").length, 1);
  assert.equal(form.querySelector("textarea").getAttribute("name"), "members");
  assert.equal(form.querySelector("textarea").getAttribute("aria-describedby"), "proj-members-hint");
  assert.equal(form.querySelector("label").getAttribute("for"), form.querySelector("textarea").getAttribute("id"));
  assert.equal(form.querySelector("label").textContent.split("github:")[0].trim(), "Members");
  assert.equal(form.querySelector('input[name="name"]'), null);
  assert.equal(form.querySelector('input[name="id"]').getAttribute("value"), "billing");
  assert.equal(form.querySelector("button").textContent, "Preview the edit");
  assert.match(form.querySelector(".proj-edit-hint").textContent, /One repository.*absolute folder per line/);
  assert.equal(form.querySelector("fieldset").hasAttribute("disabled"), true);
  assert.doesNotMatch(String(projectMembers(view(p, { readOnly: true }))), /data-action="project-edit"/);
});

test("memory verdicts use one-decimal GiB without altering worker facts, reasons or the exact call", () => {
  const p = fixture();
  p.sizing.words.memory = "p95 peak 6058m, largest 6082m, over 23 runs";
  p.sizing.words.memoryHeld = "they ask for 12g, but the largest size this host offers is not known here, so no call is offered";
  p.sizing.words.memoryFact = "2 of 23 runs reached the memory limit while stalled for memory more than 1% of their time";
  const wordsBefore = JSON.stringify(p.sizing);
  const markup = String(projectSizing(view(p)));
  assert.match(markup, /Memory: suggest 4\.0 GiB/);
  assert.match(markup, /p95 peak 5\.9 GiB, largest 5\.9 GiB, over 23 runs/);
  assert.match(markup, /they ask for 12\.0 GiB/);
  assert.match(markup, /2 of 23 runs reached the memory limit.*more than 1%/);
  assert.match(markup, /host&#39;s CPU ceiling.*which a job&#39;s cpus do not change/);
  assert.match(markup, /Measured inside the jobs, so advisory/);
  assert.doesNotMatch(markup, /hard limit with no swap|OpenShell creates/);
  assert.match(markup, /dispatch_limit_edit \{&quot;index&quot;:2,&quot;memory&quot;:&quot;4g&quot;,&quot;cpus&quot;:2\}/);
  assert.equal(JSON.stringify(p.sizing), wordsBefore);
  p.sizing.memory.reason = "oom-killed"; p.sizing.memory.suggested = null;
  p.sizing.words.memory = "2 runs ended oom-killed (the largest size killed 8g)";
  assert.match(String(projectSizing(view(p))), /Memory: oom-killed.*2 runs ended oom-killed \(the largest size killed 8\.0 GiB\)/);
});

test("project badges reuse the Runs vocabulary, trigger kinds name their forge, and same-source sizes read once", () => {
  const p = fixture();
  p.recent = ["completed", "refused", "cancelled", "awaiting-input"].map((outcome, i) => ({ jobId: `gh-${i}`, target: "acme/billing#1", outcome, at: NOW, micros: 0 }));
  const recent = String(projectRecent(view(p)));
  for (const label of ["Completed", "Refused", "Cancelled", "Awaiting input"]) assert.match(recent, new RegExp(`>${label}</span>`));
  assert.match(recent, /href="\/run\?id=gh-0"/);
  p.triggers = [{ index: 2, type: "pull_request", forge: "gitlab", flow: "review", count: 2 }, { index: 4, type: "cron", id: "nightly", count: 1 }];
  assert.match(String(projectTriggers(view(p))), /pull request on gitlab → review/);
  assert.match(String(projectTriggers(view(p))), /cron nightly/);
  p.size.memorySource = p.size.cpuSource = "project row";
  assert.match(String(projectSize(view(p))), /From the project row\./);
  assert.doesNotMatch(String(projectSize(view(p))), /Memory from.*CPUs from/);
  p.size.cpuSource = "deployment settings";
  assert.match(String(projectSize(view(p))), /Memory from project row; CPUs from deployment settings/);
});

test("trigger rows keep the full linked identity, human forge description and count in separately wrapping fields", () => {
  const p = fixture();
  const flow = "review-" + "x".repeat(60);
  p.triggers = [{ index: 31, type: "pull_request", forge: "gitlab", flow, count: 999 }, { index: 0, type: "cron", id: "nightly", count: 1 }];
  const doc = parseDocument(String(projectTriggers(view(p))));
  const rows = doc.querySelectorAll(".proj-triggers .rowpill");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector("a").getAttribute("href"), "/config/trigger?index=31");
  assert.equal(rows[0].querySelector("a").textContent, "Trigger 32");
  assert.equal(rows[0].querySelector(".proj-trigger-desc").textContent, `pull request on gitlab → ${flow}`);
  assert.equal(rows[0].querySelector(".end").textContent, "999 runs");
  assert.equal(rows[1].querySelector(".proj-trigger-desc").textContent, "cron nightly");
  assert.equal(rows[1].querySelector(".end").textContent, "1 runs");
});

test("size preview carries the exact existing action fields and role/read-only gates behave independently", () => {
  const p = fixture();
  const operator = String(projectSizing(view(p)));
  assert.match(operator, /data-action="limit-edit"/);
  assert.match(operator, /name="index"\s+value="2"\s+data-type="int"/);
  assert.match(operator, /&quot;memory&quot;:&quot;4g&quot;,&quot;cpus&quot;:2/);
  assert.match(operator, /scoped-limits row 3/);
  assert.match(operator, /data-config-controls disabled/);
  assert.match(operator, /Enable JavaScript/);
  assert.match(operator, /host&#39;s CPU ceiling/);
  const readOnly = String(projectSizing(view(p, { readOnly: true })));
  assert.ok(!readOnly.includes("data-copy"));
  assert.ok(!readOnly.includes("dispatch_limit_edit"));
  assert.ok(!readOnly.includes('data-action="limit-edit"'));
  assert.match(readOnly, /p95 peak 2\.0 GiB/);
  assert.match(readOnly, /class="proj-chart"/);
  const viewer = String(projectSizing(view(p, { role: "viewer" })));
  assert.ok(!viewer.includes("data-copy"));
  assert.ok(!viewer.includes("dispatch_limit_edit"));
  assert.match(viewer, /p95 peak 2\.0 GiB/);
});

test("no applicable size suggestion leaves no preview or call but retains its explanation", () => {
  const p = fixture();
  p.sizing.call = null; p.sizing.action = null; p.sizing.memory.suggested = null; p.sizing.cpu.suggested = null;
  p.sizing.memory.reason = "not-enough-runs";
  p.sizing.words.memory = "2 of the 10 runs with measurements it needs";
  const markup = String(projectSizing(view(p)));
  assert.match(markup, /2 of the 10 runs/);
  assert.ok(!markup.includes("Preview this size"));
  assert.ok(!markup.includes("data-copy"));
});

test("bundle membership and delete refusals appear before pressing, viewers receive no forms", () => {
  const p = fixture();
  p.editRefusal = "Change the bundle in triggers.json first.";
  p.deleteRefusal = "project:billing names this project; remove that row first.";
  const members = String(projectMembers(view(p)));
  assert.match(members, /Change the bundle/);
  assert.ok(!members.includes("data-action"));
  assert.match(String(projectDelete(view(p))), /remove that row first/);
  assert.ok(!String(projectDelete(view(p))).includes("data-action"));
  assert.equal(projectDelete(view(p, { role: "viewer" })), null);
  p.editRefusal = null;
  assert.ok(!String(projectMembers(view(p, { role: "viewer" }))).includes("<form"));
});

test("bundle variable names render only in the person's facts and hostile text stays inert", () => {
  const p = fixture();
  p.bundle = { id: "billing", profile: "vault", format: "dotenv", declared: "env", optedOut: [3], forkReviews: false, last: { jobId: "gh-123", at: "2026-10-30T10:00:00Z", variables: ["DB_URL", "STRIPE_KEY"] } };
  const markup = String(projectBundle(view(p)));
  assert.match(markup, /DB_URL, STRIPE_KEY/);
  assert.match(markup, /trigger 4/);
  assert.match(markup, /2026-10-30T10:00:00\.000Z/);
  p.bundle.id = '<img src=x onerror="alert(1)">';
  assert.ok(!String(projectBundle(view(p))).includes("<img"));
});

test("Recent's stacked rows keep each run's target, outcome, instant and exact cost together", () => {
  const p = fixture();
  p.recent = [{ jobId: "gh-recent", target: "acme/billing#97", outcome: "refused", at: NOW - 1_000, micros: 240_000, costFloor: true }];
  p.totalRuns = 8;
  const markup = String(projectRecent(view(p)));
  assert.match(markup, /class="tbl tbl--stack"/);
  const row = markup.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/)?.[1];
  assert.ok(row);
  assert.match(row, /href="\/run\?id=gh-recent"/);
  assert.match(row, /acme\/billing#97/);
  assert.match(row, />Refused<\/span>/);
  assert.match(row, /data-l="Ended".*datetime="2026-10-30T11:59:59\.000Z"/);
  assert.match(row, /data-l="Cost">at least <span title="\$0\.24">\$0\.24<\/span>/);
  assert.match(markup, /All 8 in Runs, filtered to billing/);
});

test("money stays readable at two decimals while each title retains the exact micro-dollar amount", () => {
  const p = fixture();
  p.spend.settledMicros = 6_123_456;
  p.spend.heldMicros = 2_654_321;
  p.spend.usedMicros = 8_777_777;
  p.spend.shareMicros = 25_987_654;
  const markup = String(projectSpend(view(p)));
  assert.match(markup, /<span title="\$6\.123456">\$6\.12<\/span>/);
  assert.match(markup, /<span title="\$2\.654321">\$2\.65<\/span>/);
  assert.match(markup, /<span title="\$25\.987654">\$25\.99<\/span>/);
  assert.ok(!markup.includes("&lt;span"), "formatted fragments are never stringified into visible markup");
  p.allocation = { window: "week", floorMicros: 10_123_456, shareMicros: 25_987_654, totalMicros: 100_000_000, refused: 0 };
  assert.match(String(projectAllocation(view(p))), /<span title="\$10\.123456">\$10\.12<\/span> a week/);
});

test("normalized null limit fields are omitted and actual settings read in human words", () => {
  const p = fixture();
  p.limits = [{ index: 2, scope: "project:billing", memory: "8g", cpus: 4, day: null, week: null, month: null, concurrent: null, dayUsd: "2.50", weekUsd: null, monthUsd: null, hostShare: 50, minJobs: null }];
  const markup = String(projectLimits(view(p)));
  assert.match(markup, /8 GiB memory, 4 CPUs/);
  assert.match(markup, /title="\$2\.50">\$2\.50<\/span> a day/);
  assert.match(markup, /50% of each host&#39;s budget/);
  assert.match(markup, /not set; a local folder still runs one job at a time/);
  assert.doesNotMatch(markup, /null|day:|week:|concurrent:|minJobs:/);
});
