import { test } from "node:test";
import assert from "node:assert/strict";
import { NOW } from "../../launch/fixture-deployment.mjs";
import { childrenOf, loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { HOSTS_UNREAD, HOSTS_UNREAD_TEXT } from "../src/console/panels/common.mjs";
import { RUNS_EMPTY, RUNS_HOST_UNREADABLE, RUNS_MIRROR_DEGRADED, RUNS_MIRROR_DEGRADED_EMPTY, RUNS_MIRROR_OFF, RUNS_NONE_WITHOUT_HOST, runsFilters, runsFiltersModel, runsSummary, runsSummaryModel, runsTableModel } from "../src/console/panels/runs.mjs";
import { TRANSCRIPT_UNREAD_TEXT, childSearchText, queuedText } from "../src/console/panels/run.mjs";
import { PROJECT_HOLDS_UNREAD, PROJECT_RUNS_UNREAD } from "../src/console/panels/project.mjs";
import { BREAKDOWN_SCOPE_TEXT, SPEND_PANELS, SPLIT_UNREAD_TEXT, heldLabel } from "../src/console/panels/spend.mjs";
import { capacityHostsText } from "../src/console/panels/capacity-pulse.mjs";
import { assembleInsightsView } from "../src/insights-assembly.mjs";
import { LOADED_WORDS, projectLoadsOf } from "../src/loaded-words.mjs";
import { projectViewForAgent, readProjectView } from "../src/project-view.mjs";
import { readRunsPage } from "../src/read-model.mjs";
import { SPEND_CSS } from "../src/console/spend-css.mjs";
import { RUNS_PAGE_IN_OUTAGE } from "./helpers/no-snapshot.mjs";
import { CONFIGURATION_DRAW } from "./helpers/configuration-goldens.mjs";
import { consoleProjectFixture } from "./helpers/console-project-fixture.mjs";
import { drawPanelState } from "./helpers/panel-goldens.mjs";
import { SPEND_DRAW, allocationUnread, drawSpend, spendFixture } from "./helpers/spend-goldens.mjs";

/**
 * The history pages through a Valkey outage (issue #962, the rule of issue #844): a read that failed says "not known"
 * or "could not be read", and a read that showed emptiness keeps its own sentence. Each test holds both directions.
 * Canned readers at a fixed instant; nothing here reads a Valkey.
 */

/** The words of a page, tags and the scripts' own text dropped. */
const wordsOf = (page) => String(page).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
const VIEWER = { name: "watcher", role: "viewer" };
const OPERATOR = { name: "ops", role: "operator" };
const WINDOW = Object.freeze({
  byOutcome: { completed: 3, refused: 1, failed: 0, "awaiting-input": 0, cancelled: 0, other: 0 },
  byProject: [{ project: "web", count: 4, byOutcome: { completed: 3, refused: 1, failed: 0, "awaiting-input": 0, cancelled: 0, other: 0 }, spentMicros: 110_000, unpriced: 0 }],
  projectsMore: false, byReason: {}, values: {}, spentMicros: 110_000, unpriced: 0,
});
const runsView = (data) => ({ page: "runs", role: "viewer", readOnly: false, query: parsePageQuery("runs", "").query, env: {}, now: NOW, pages: null, data: { subscriptions: [], ...data } });
const record = (over = {}) => ({ jobId: "gh-1", kind: "github", target: "acme/web#4", project: "web", flow: "fix", host: "mini1", backend: "podman", outcome: "completed", startedAt: new Date(NOW - 120_000).toISOString(), endedAt: new Date(NOW - 60_000).toISOString(), ...over });

test("/runs: the All chip, the project chips and the settled spend are floors over a window read in part, and whole over one read whole", () => {
  for (const mark of [{ partial: true }, { floor: true }]) {
    const view = runsView({ runsWindow: { ...WINDOW, ...mark } });
    const m = runsFiltersModel(view);
    assert.deepEqual(m.projects.map((p) => [p.count, p.floor]), [[4, true], [4, true]], JSON.stringify(mark));
    assert.match(wordsOf(runsFilters(view)), /All at least 4 /);
    assert.equal(runsSummaryModel(view).spentFloor, true);
    assert.match(wordsOf(runsSummary(view)), /at least \$0\.11 settled spend/);
  }
  const whole = runsView({ runsWindow: WINDOW });
  assert.deepEqual(runsFiltersModel(whole).projects.map((p) => p.floor), [false, false]);
  assert.ok(!wordsOf(runsFilters(whole)).includes("at least"), "a window read whole counts what it counts");
  assert.match(wordsOf(runsFilters(whole)), /All 4 /);
  assert.match(wordsOf(runsSummary(whole)), / \$0\.11 settled spend/);
  assert.ok(!wordsOf(runsSummary(whole)).includes("at least"));
});

test("/runs: an empty page over a mirror that was not read says so, and \"No run matches.\" only of sides that answered", async () => {
  const foot = (runsPage) => runsTableModel(runsView({ runsPage })).foot;
  assert.deepEqual(foot({ ...RUNS_PAGE_IN_OUTAGE }), [RUNS_MIRROR_DEGRADED_EMPTY]);
  // With this host's files unread the real reader lists no run and answers a mirror it never asked as "off": the foot
  // says nothing of the mirror then, on or off, where it used to say the mirror is off over a fleet that has one.
  let asked = 0;
  const redis = new Proxy({}, { get: (_, key) => (key === "then" ? undefined : () => { asked += 1; throw new Error("asked"); }) });
  const unreadHost = await readRunsPage(redis, { localIndex: { records: () => ({ unreachable: "logs dir unreadable (EACCES)" }) } });
  assert.deepEqual([unreadHost.runs, unreadHost.mirror, asked], [[], "off", 0], "the reader's answer: no run, and a mirror not asked");
  assert.deepEqual(foot(unreadHost), [RUNS_HOST_UNREADABLE, RUNS_NONE_WITHOUT_HOST]);
  assert.ok(!foot(unreadHost).includes(RUNS_MIRROR_OFF) && !foot(unreadHost).includes(RUNS_EMPTY));
  assert.deepEqual(foot({ runs: [], mirror: "truncated", next: null }), [RUNS_MIRROR_DEGRADED_EMPTY]);
  // A read that showed no run keeps its sentence, with the mirror read and with it off.
  assert.deepEqual(foot({ runs: [], mirror: "ok", next: null }), [RUNS_EMPTY]);
  assert.deepEqual(foot({ runs: [], mirror: "off", next: null }), [RUNS_EMPTY, RUNS_MIRROR_OFF]);
  // Rows this host holds are still shown beside the note.
  assert.deepEqual(foot({ runs: [record()], mirror: "unreachable (ECONNREFUSED)", next: null }), ["1 run.", RUNS_MIRROR_DEGRADED]);
  const outage = wordsOf(await drawPanelState("runs-outage.viewer"));
  assert.ok(outage.includes(RUNS_MIRROR_DEGRADED_EMPTY) && !outage.includes(RUNS_EMPTY), "the page in an outage");
  assert.match(outage, /All at least \d/);
  assert.match(outage, /at least \$\d+\.\d\d settled spend/);
  assert.ok(wordsOf(await drawPanelState("runs-empty.viewer")).includes(RUNS_EMPTY), "the control: a mirror that answered with none");
});

const runPage = async (data, session = OPERATOR) => wordsOf((await renderPage("run", { query: { id: "gh-1" }, session, data: { now: NOW, env: {}, run: { record: record({ reason: "awaiting-input", session: { resumed: false, reason: "absent", bytes: 4096 } }), source: "local" }, chat: { state: "parked", mode: "reply", jobState: "completed" }, children: [], childrenSearched: 50, ...data } })).html);

test("the run page: a transcript that could not be read is said so at each place it is named, and one read as absent keeps its reasons", async () => {
  const unread = await runPage({ transcript: { unreachable: true, exists: false } });
  assert.equal(unread.split(TRANSCRIPT_UNREAD_TEXT).length - 1, 3, "the question card, the summary row and the transcript panel");
  for (const said of ["no longer kept", "No live transcript:"]) assert.ok(!unread.includes(said), said);
  const absent = await runPage({ transcript: { exists: false } });
  assert.ok(!absent.includes(TRANSCRIPT_UNREAD_TEXT));
  assert.match(absent, /The live transcript is no longer kept\./);
  assert.equal(absent.split("No live transcript: not published").length - 1, 2, "the summary row and the transcript panel");
  const golden = wordsOf(await drawPanelState("run-history-unread.operator"));
  assert.ok(golden.includes(TRANSCRIPT_UNREAD_TEXT) && !golden.includes("no longer kept"));
});

test("the run page: a refused run's floor line says the hosts could not be read when they were not, and \"not published\" of a read registry", async () => {
  const refused = { run: { record: record({ outcome: "policy", reason: "job-image-missing", tokens: null, dollars: null, budgetReserved: false, exitCode: null }), source: "local" }, chat: { state: "finished", mode: "none" }, transcript: { exists: false } };
  const floor = (words) => /Venue floor \(PI_BACKEND_FLOOR\) (.*?) Same reason/.exec(words)?.[1];
  assert.equal(floor(await runPage({ ...refused, snapshot: null })), HOSTS_UNREAD);
  assert.equal(floor(await runPage({ ...refused, snapshot: { queue: { fleetDegraded: "ECONNREFUSED" }, hostsReadAt: null, hostBudgets: [] } })), HOSTS_UNREAD, "a registry never read");
  assert.equal(floor(await runPage({ ...refused, snapshot: { queue: {}, hostsReadAt: NOW, hostBudgets: [{ name: "mini1" }] } })), "This host has not published a floor.");
});

test("the child run search is incomplete when a page threw, was no list, or was read without a side of the history", async () => {
  const parent = record({ jobId: "gh-parent", startedAt: new Date(NOW - 3_600_000).toISOString() });
  const child = record({ jobId: "gh-child", parentJobId: "gh-parent" });
  const search = (runsPage) => childrenOf({ runsPage }, parent);
  assert.deepEqual(await search(async () => { throw new Error("Valkey does not answer"); }), { children: [], searched: 0, incomplete: true });
  assert.deepEqual(await search(async () => ({ refusal: "no list" })), { children: [], searched: 0, incomplete: true });
  assert.deepEqual(await search(async () => ({ ...RUNS_PAGE_IN_OUTAGE })), { children: [], searched: 0, incomplete: true });
  const partly = await search(async () => ({ runs: [child], mirror: "unreachable (ECONNREFUSED)", next: null }));
  assert.equal(partly.incomplete, true);
  assert.deepEqual(partly.children.map((c) => c.jobId), ["gh-child"], "what this host holds is still found");
  assert.equal((await search(async () => ({ runs: [child], mirror: "ok", unreachable: "logs dir unreadable (EACCES)", next: null }))).incomplete, true, "this host's files unread");
  // A later page that fails leaves the earlier ones counted and the search incomplete.
  let calls = 0;
  const later = await search(async () => { calls += 1; if (calls > 1) throw new Error("down"); return { runs: [record({ jobId: "gh-x" })], mirror: "ok", next: NOW }; });
  assert.deepEqual([later.searched, later.incomplete], [1, true]);
  // The control: every page read, with the mirror on and with it off.
  for (const mirror of ["ok", "off"]) assert.deepEqual(await search(async () => ({ runs: [record({ jobId: "gh-x" })], mirror, next: null })), { children: [], searched: 1, incomplete: false }, mirror);
  // The loader hands the page what the search said.
  const load = async (runsPage) => loadPageData("run", { id: "gh-parent" }, { now: () => NOW, fleet: { runById: async () => ({ record: parent, source: "local" }), runsPage, parkedCount: async () => 0 } }, OPERATOR);
  assert.equal((await load(async () => ({ ...RUNS_PAGE_IN_OUTAGE }))).childrenIncomplete, true);
  assert.equal((await load(async () => ({ runs: [], mirror: "ok", next: null }))).childrenIncomplete, false);
});

test("the run page says an incomplete child search was incomplete, and \"No child run\" only of a complete one", async () => {
  const none = "No child run among the";
  assert.equal(childSearchText({ childrenSearched: 50 }), "No child run among the 50 newest runs.");
  assert.equal(childSearchText({ childrenSearched: 50 }, { found: 2 }), null);
  assert.match(childSearchText({ childrenSearched: 0, childrenIncomplete: true }), /incomplete.*not known\. 0 runs were searched\.$/);
  assert.match(childSearchText({ childrenSearched: 100, childrenIncomplete: true }, { found: 1 }), /incomplete.*may be more than these\. 100 runs were searched\.$/);
  const finished = { chat: { state: "finished", mode: "none" }, transcript: { exists: false } };
  for (const rec of [record(), record({ parentJobId: "gh-0" })]) {
    const data = { ...finished, run: { record: rec, source: "local" } };
    const unread = await runPage({ ...data, childrenSearched: 0, childrenIncomplete: true });
    assert.match(unread, /The search for child runs was incomplete/);
    assert.ok(!unread.includes(none) && !unread.includes("No parent or child runs"), "nothing said of runs that were not read");
    const read = await runPage({ ...data, childrenSearched: 50, childrenIncomplete: false });
    assert.match(read, /No child run among the 50 newest runs\./);
    assert.ok(!read.includes("incomplete"));
  }
  assert.match(await runPage({ ...finished, run: { record: record(), source: "local" }, childrenSearched: 0, childrenIncomplete: true }), /No parent run; child runs not known/);
  assert.match(await runPage({ ...finished, run: { record: record(), source: "local" } }), /No parent or child runs/);
  // Children this host holds are listed, and the note says there may be more.
  const some = await runPage({ ...finished, run: { record: record({ parentJobId: "gh-0" }), source: "local" }, children: [{ jobId: "gh-kid", outcome: "completed", reason: null, startedAt: null }], childrenSearched: 100, childrenIncomplete: true });
  assert.match(some, /gh-kid .*there may be more than these/);
  const golden = wordsOf(await drawPanelState("run-history-unread.operator"));
  assert.ok(golden.includes("The search for child runs was incomplete") && !golden.includes(none));
});

const projectInput = (extra = {}) => ({
  id: "billing", paths: { projectsFile: "/srv/deployment/projects.json", scopedLimitsPath: "/srv/deployment/limits.json" }, now: NOW,
  snapshot: { hostBudgets: [{ name: "mini1", jobs: "[]", jobsMore: "0" }], waiting: { rows: [] } }, ...extra,
  reads: { projects: () => ({ projects: [{ id: "billing", name: "Billing", members: ["github:acme/billing"] }] }), limits: () => ({ limits: [] }), triggers: () => ({ triggers: [] }), settings: () => ({ overlay: {} }), subscriptions: () => ({ subscriptions: [] }), scan: () => [], allocation: () => ({ unset: true }), sizing: () => ({ projects: {} }), edit: () => ({ plan: {} }), delete: () => ({ plan: {} }), fleetRuns: () => ({ runs: [], incomplete: false }), ...(extra.reads ?? {}) },
});

test("the project view: a history or a registry that was not read makes its counts floors and its holds unknown, and a whole read does not", async () => {
  const whole = await readProjectView(projectInput());
  assert.deepEqual([whole.historyIncomplete, whole.spend.floor, whole.spend.heldMicros, whole.spend.heldIncomplete, whole.spend.heldUnread], [false, false, 0, false, false]);
  const noSnapshot = await readProjectView(projectInput({ snapshot: null }));
  assert.deepEqual([noSnapshot.historyIncomplete, noSnapshot.spend.floor, noSnapshot.spend.heldMicros, noSnapshot.spend.heldIncomplete, noSnapshot.spend.heldUnread, noSnapshot.sizingUnreadable], [true, true, null, true, true, true], "no snapshot: the registry and its newest runs were not read");
  const noHistory = await readProjectView(projectInput({ reads: { fleetRuns: () => ({ runs: [], incomplete: true }) } }));
  assert.deepEqual([noHistory.historyIncomplete, noHistory.spend.floor, noHistory.spend.heldMicros], [true, true, 0], "the fleet's pages were not read whole: the hosts were");
  // What an agent's tool is handed says incomplete and holds no number that reads as "null" or a zero nobody read.
  const agent = projectViewForAgent(noSnapshot);
  assert.deepEqual([agent.spend.incomplete, agent.spend.heldMicros, agent.spend.usedMicros], [true, null, null]);
  assert.ok(!JSON.stringify(agent).includes("NaN"));
  assert.equal(projectViewForAgent(whole).spend.incomplete, false);
});

test("/config/project: no \"No retained run\" and no bare count over a history that was not read whole; a whole read keeps both", async () => {
  const draw = async (change) => { const projectView = consoleProjectFixture(NOW); change(projectView); return wordsOf((await renderPage("project", { query: { id: "billing" }, session: OPERATOR, data: { now: NOW, projectView }, theme: null })).html); };
  const empty = (p) => { p.recent = []; p.totalRuns = 0; p.triggers = []; p.triggersKnown = true; p.runs24h = { ...p.runs24h, total: 0, counts: Object.fromEntries(Object.keys(p.runs24h.counts).map((k) => [k, 0])), worst: null }; p.spend = { ...p.spend, envelope: false, settledMicros: 0, usedMicros: 0, heldMicros: 0 }; p.loads = projectLoadsOf([], { historyIncomplete: p.historyIncomplete === true }); };
  const unread = await draw((p) => { p.historyIncomplete = true; p.spend.floor = true; empty(p); p.spend.floor = true; });
  for (const said of ["No retained run recorded this project.", "no retained runs", "All 0 in Runs", "No retained run here was attributed", "Nothing to read", "Either none ran"]) assert.ok(!unread.includes(said), said);
  assert.ok(unread.includes(PROJECT_RUNS_UNREAD));
  assert.match(unread, /Runs, last 24 hours at least 0 no run in what could be read;/);
  assert.match(unread, /At least 0 in Runs, filtered to billing/);
  assert.match(unread, /Spend this week at least \$0\.00/);
  assert.ok(unread.includes(LOADED_WORDS.projectNoneUnread));
  const read = await draw((p) => { p.historyIncomplete = false; empty(p); });
  for (const said of ["No retained run recorded this project.", "Runs, last 24 hours 0 no retained runs;", "All 0 in Runs, filtered to billing", "No retained run here was attributed to a trigger in the last 24 hours.", LOADED_WORDS.projectNone]) assert.ok(read.includes(said), said);
  assert.ok(!read.includes("at least") && !read.includes("Not known"), "a whole read marks nothing a floor");
  // With runs found, an incomplete history still marks the counts.
  const some = await draw((p) => { p.historyIncomplete = true; });
  assert.match(some, /Runs, last 24 hours at least 10 /);
  assert.match(some, /At least 24 in Runs/);
  // Holds over hosts nobody read are not "known from the hosts that reported it"; holds read short still are.
  const holds = (heldUnread) => draw((p) => { p.spend = { ...p.spend, envelope: false, settledMicros: 0, usedMicros: null, heldMicros: null, heldKnownMicros: 0, heldIncomplete: true, heldUnread }; });
  assert.ok((await holds(true)).includes(PROJECT_HOLDS_UNREAD) && !(await holds(true)).includes("known from the hosts that reported it"));
  assert.ok((await holds(false)).includes("Held money is incomplete; $0.00 is known from the hosts that reported it.") && !(await holds(false)).includes(PROJECT_HOLDS_UNREAD));
  const golden = wordsOf(await CONFIGURATION_DRAW["project-history-unread.operator"]());
  assert.ok(golden.includes(PROJECT_RUNS_UNREAD) && !golden.includes("No retained run recorded this project."));
  assert.equal(projectLoadsOf([], { historyIncomplete: true }).sub, "at least 0 runs in the last 7 days");
  assert.equal(projectLoadsOf([]).top, LOADED_WORDS.projectNone);
});

test("Spend: a payload that could not be assembled draws one card that says so in each view, and no card over nothing", async () => {
  for (const [page, panels] of Object.entries(SPEND_PANELS)) {
    const html = await drawSpend(page, { role: "viewer", payload: new Error("assembly failed") });
    const words = wordsOf(html);
    assert.match(words, /This view could not be read The spend history could not be assembled\./, page);
    assert.equal(words.split("This view could not be read").length - 1, 1, `${page}: one card`);
    for (const said of ["No budget split is available.", "$0.00", "0 hosts", "No runs in the spend window", "0 metered", "No daily dollar cap is configured", "Held for"]) assert.ok(!words.includes(said), `${page}: ${said}`);
    const view = { page, role: "viewer", query: {}, now: NOW, data: { insights: null, insightsError: "The spend history could not be assembled." } };
    assert.deepEqual(panels.map(([, draw]) => String(draw(view)) === "").slice(1), panels.slice(1).map(() => true), `${page}: every other panel is empty`);
    assert.ok(!wordsOf(await drawSpend(page, { role: "viewer" })).includes("This view could not be read"), `${page}: the control, a payload that was read`);
  }
  assert.ok(wordsOf(await SPEND_DRAW["spend-insights-error.viewer"]()).includes("This view could not be read"));
});

test("Spend: money held with the hosts unread names no count of jobs, and a read registry keeps its count", async () => {
  const reads = { projects: () => ({ projects: [] }), costs: () => ({ fold: { byFlow: [] }, records: [] }), graph: () => ({}), budget: async () => ({ tokens: {}, dollars: { windows: [] } }), allocation: () => ({ window: "week" }), capacity: () => ({}), sizing: () => ({}), scan: () => [], subscriptions: () => ({ subscriptions: [] }), settings: () => ({ overlay: {} }) };
  const pricing = { piAiVersion: () => "test", getPricedModel: () => ({}), isZeroRated: () => false, reprice: () => ({ usd: 0, ratesVersion: "test" }) };
  const today = async (hosts) => (await assembleInsightsView({}, "7d", { pricing, nowMs: NOW, envFn: () => ({}), reads: { ...reads, hosts: async () => hosts } })).spend.today;
  const unread = await today({ unreachable: "not answering" });
  assert.deepEqual([unread.heldJobs, unread.heldMicros], [null, null]);
  const read = await today({ hosts: [{ name: "mini1", jobsMore: "0", jobs: JSON.stringify([{ id: "gh-live", at: NOW - 1000, h: 2_000_000, ha: NOW - 1000 }]) }] });
  assert.deepEqual([read.heldJobs, read.heldMicros], [1, 2_000_000]);
  assert.deepEqual((await today({ hosts: [] })).heldJobs, 0, "a registry read with no host holds for no job");
  assert.equal(heldLabel(null), "Held for running jobs (how many is not known)");
  assert.equal(heldLabel(undefined), heldLabel(null));
  assert.deepEqual([heldLabel(0), heldLabel(1), heldLabel(2)], ["Held for 0 running jobs", "Held for 1 running job", "Held for 2 running jobs"]);
  const p = spendFixture();
  const page = wordsOf(await drawSpend("insights", { payload: { ...p, spend: { ...p.spend, today: { ...p.spend.today, heldMicros: null, heldJobs: null, hostsUnreadable: true } } } }));
  assert.ok(page.includes(heldLabel(null)));
  for (const said of ["Held for 0 running", "Held for unknown", "Held for null"]) assert.ok(!page.includes(said), said);
  assert.ok(wordsOf(await drawSpend("insights")).includes("Held for 1 running job"), "the control");
});

test("Spend: a split whose read did not answer says so, and \"No budget split is available.\" is kept for one that is unset", async () => {
  const withSplit = (allocation) => { const p = spendFixture(); return drawSpend("insights", { role: "viewer", payload: { ...p, allocation: { ...p.allocation, ...allocation } } }); };
  const unread = wordsOf(await withSplit({ unreachable: "unavailable" }));
  assert.ok(unread.includes(SPLIT_UNREAD_TEXT) && !unread.includes("No budget split is available."));
  const unset = wordsOf(await withSplit({ unset: true }));
  assert.ok(unset.includes("No budget split is available.") && !unset.includes(SPLIT_UNREAD_TEXT));
  assert.ok(!wordsOf(await drawSpend("insights", { role: "viewer" })).includes(SPLIT_UNREAD_TEXT), "a live split draws its weights");
});

test("Capacity: no host count and no peak of none over a registry that was not read; a read registry keeps both", async () => {
  const draw = async (change) => { const p = spendFixture(); change(p.capacity); return wordsOf(await drawSpend("insights-capacity", { role: "viewer", query: "range=24h", payload: p })); };
  const bare = (c) => { c.hosts = []; c.hostCount = 0; c.totalSlots = null; c.fleet = { ...c.fleet, peak: 0 }; };
  const unread = await draw((c) => { bare(c); c.venuesUnreadable = true; });
  assert.doesNotMatch(unread, /\b0 hosts\b/, "no count of hosts nobody read");
  assert.match(unread, new RegExp(`Weighted by slots; how many hosts is ${HOSTS_UNREAD}\\.`));
  assert.match(unread, /Fleet peak not known /);
  assert.ok(unread.includes(HOSTS_UNREAD_TEXT) && !unread.includes("0 jobs at once"));
  const read = await draw((c) => { bare(c); c.venuesUnreadable = false; });
  assert.match(read, /Weighted by slots, 0 hosts\./);
  assert.match(read, /Fleet peak 0 jobs at once/);
  // Hosts the run records name are still counted, as the records' hosts, and a peak they show is theirs.
  const records = await draw((c) => { c.venuesUnreadable = true; c.hostCount = c.hosts.length; c.totalSlots = null; });
  assert.match(records, /Weighted by slots, 3 hosts named by the run records \(the hosts themselves could not be read\)\./);
  assert.match(records, /Fleet peak \d+ jobs at once/);
  assert.equal(capacityHostsText({ hostCount: 1, venuesUnreadable: true }), ", 1 host named by the run records (the hosts themselves could not be read)");
  assert.equal(capacityHostsText({ hostCount: 3 }), ", 3 hosts");
  assert.equal(capacityHostsText({}), "");
});

test("/insights/breakdown says whose records it reads, whatever was read", async () => {
  for (const state of ["spend-breakdown.viewer", "spend-breakdown-empty.viewer", "spend-breakdown-unreadable.viewer"]) assert.ok(wordsOf(await SPEND_DRAW[state]()).includes(BREAKDOWN_SCOPE_TEXT), state);
  assert.ok(!wordsOf(await drawSpend("insights", { role: "viewer" })).includes(BREAKDOWN_SCOPE_TEXT), "the Spend view reads the counters and the hosts too");
});

test("the run banner counts the runs it queued as a floor over an incomplete child search, and never as 0 then", async () => {
  const kid = { jobId: "gh-kid", outcome: "completed", reason: null, startedAt: null };
  assert.equal(queuedText({ children: [kid, kid] }), "It queued 2 runs from /outbox");
  assert.equal(queuedText({ children: [] }), "It queued 0 runs from /outbox");
  assert.equal(queuedText({ children: [kid], childrenIncomplete: true }), "It queued at least 1 runs from /outbox (the search for them was incomplete)");
  assert.equal(queuedText({ children: [], childrenIncomplete: true }), "How many runs it queued from /outbox is not known (the search for them was incomplete)");
  const finished = { chat: { state: "finished", mode: "none" }, transcript: { exists: false } };
  const page = (rec, data) => runPage({ ...finished, run: { record: record(rec), source: "local" }, ...data });
  const partly = await page({}, { children: [kid], childrenSearched: 100, childrenIncomplete: true });
  assert.match(partly, /It queued at least 1 runs from \/outbox \(the search for them was incomplete\)\. gh-kid/);
  const none = await page({ chainRefused: 2 }, { children: [], childrenSearched: 0, childrenIncomplete: true });
  assert.match(none, /How many runs it queued from \/outbox is not known \(the search for them was incomplete\), and 2 more requests were refused/);
  assert.ok(!none.includes("It queued 0 runs"));
  // A complete search keeps its count, a zero beside refused requests included.
  assert.match(await page({}, { children: [kid, kid], childrenSearched: 50 }), /It queued 2 runs from \/outbox\. /);
  assert.match(await page({ chainRefused: 2 }, { children: [], childrenSearched: 50 }), /It queued 0 runs from \/outbox, and 2 more requests were refused/);
});

test("/config/project: the members' counts, the split and its refusals follow what was read", async () => {
  const draw = async (change) => { const projectView = consoleProjectFixture(NOW); change(projectView); return wordsOf((await renderPage("project", { query: { id: "billing" }, session: OPERATOR, data: { now: NOW, projectView }, theme: null })).html); };
  const bare = (p) => { p.members = p.members.map((m) => ({ ...m, count: 0, last: null })); };
  const unread = await draw((p) => { p.historyIncomplete = true; bare(p); p.allocation = { ...p.allocation, split: null, problem: "The allocation could not be read." }; });
  assert.equal(unread.split("at least 0 runs this week · no run in what could be read").length - 1, 2, "each member");
  assert.ok(!unread.includes("no run in view") && !/ repository 0 runs this week/.test(unread));
  assert.match(unread, /Split not known: the allocation could not be read /);
  assert.match(unread, /Refused by the split at least 0 in this week, among retained runs/);
  assert.ok(!unread.includes("No split has been published."));
  const read = await draw((p) => { bare(p); p.allocation = { ...p.allocation, split: null }; });
  assert.equal(read.split(" repository 0 runs this week · no run in view").length - 1, 2);
  assert.match(read, /Split No split has been published\. Refused by the split 0 in this week, among retained runs/);
  // A member whose runs cannot be told apart has no number to mark, and found runs are marked with their link kept.
  const some = await draw((p) => { p.historyIncomplete = true; p.members[1] = { ...p.members[1], count: null, last: null, caveat: "cannot be told apart" }; });
  assert.match(some, /at least 18 runs this week · last gh-e9a0/);
  assert.match(some, / unknown runs this week · cannot be told apart/);
  const golden = wordsOf(await CONFIGURATION_DRAW["project-history-unread.operator"]());
  assert.ok(!golden.includes("no run in view") && golden.includes("at least 0 runs this week"));
});

test("the project view hands what its runs load the one history flag, a missing snapshot included", async () => {
  const noSnapshot = await readProjectView(projectInput({ snapshot: null }));
  assert.equal(noSnapshot.historyIncomplete, true);
  assert.deepEqual([noSnapshot.loads.top, noSnapshot.loads.sub], [LOADED_WORDS.projectNoneUnread, "at least 0 runs in the last 7 days"]);
  const mirror = await readProjectView(projectInput({ snapshot: { hostBudgets: [], waiting: { rows: [] }, runMirror: "unreachable (ECONNREFUSED)" } }));
  assert.equal(mirror.loads.top, LOADED_WORDS.projectNoneUnread, "the snapshot's own mirror word");
  const whole = await readProjectView(projectInput());
  assert.deepEqual([whole.loads.top, whole.loads.sub], [LOADED_WORDS.projectNone, "0 runs in the last 7 days"]);
});

test("/insights/budget-split with the split unread: the envelope file's facts are drawn, and the split is not known", async () => {
  const unread = wordsOf(await drawSpend("insights-budget-split", { role: "viewer", payload: allocationUnread() }));
  assert.match(unread, /Envelope \$50\.00 week\. Delegation on\. Writers: operator-session, portfolio-job\./);
  assert.match(unread, /Allocated unknown 2 projects in the envelope file; what the split allocates is not known\. Floors total \$5\.00; floors come first\./);
  assert.match(unread, /Spent this envelope window unknown of \$50\.00 Which projects are over allocation is not known: the split could not be read\./);
  assert.match(unread, new RegExp(`Plan in force not known ${SPLIT_UNREAD_TEXT.replace(/[.]/g, "\\.")}`));
  for (const said of ["0 projects", "Floors total $0.00", "Delegation off", "No split yet", "0 projects over allocation"]) assert.ok(!unread.includes(said), said);
  assert.ok(wordsOf(await SPEND_DRAW["spend-split-unreachable.viewer"]()).includes("2 projects in the envelope file"));
  // The controls: a split that was read, and an envelope with no split published yet.
  const live = wordsOf(await SPEND_DRAW["spend-split.viewer"]());
  assert.match(live, /Envelope \$50\.00 week\. Delegation on\./);
  assert.match(live, /2 projects; unallocated /);
  assert.ok(!live.includes("in the envelope file") && !live.includes(SPLIT_UNREAD_TEXT));
  const noPlan = wordsOf(await SPEND_DRAW["spend-split-no-plan.viewer"]());
  assert.ok(noPlan.includes("No split yet") && !noPlan.includes(SPLIT_UNREAD_TEXT));
});

test("the Spend error card names no log, is reachable from a run record a fold cannot read, and spans its row", async () => {
  const broken = { now: () => NOW, insights: async () => { throw new Error("fold failed"); }, pricedModels: () => [], fleet: { parkedCount: async () => 0 } };
  const data = await loadPageData("insights", parsePageQuery("insights", "range=7d").query, broken, VIEWER);
  assert.equal(data.insightsError, "The spend history could not be assembled.");
  assert.ok(!/\blog\b/.test(wordsOf(await SPEND_DRAW["spend-insights-error.viewer"]()).split("Not read")[1]), "nothing here writes a log, so none is named");
  // What makes the assembly throw on a real console: a record whose model usage is not a list. No outage does.
  const pricing = { piAiVersion: () => "test", getPricedModel: () => ({}), isZeroRated: () => false, reprice: () => ({ usd: 0, ratesVersion: "test" }) };
  const reads = { projects: () => ({ projects: [] }), costs: () => ({ fold: { byFlow: [] }, records: [] }), graph: () => ({}), budget: async () => ({ tokens: {}, dollars: { windows: [] } }), allocation: () => ({ unset: true }), capacity: () => ({}), sizing: () => ({}), subscriptions: () => ({ subscriptions: [] }), settings: () => ({ overlay: {} }) };
  const bad = { jobId: "gh-bad", flow: "fix", provider: "p", model: "m", endedAt: new Date(NOW - 1000).toISOString(), usage: { v: 1, models: 5 } };
  await assert.rejects(assembleInsightsView({}, "7d", { pricing, nowMs: NOW, envFn: () => ({}), reads: { ...reads, hosts: async () => ({ hosts: [] }), scan: () => [bad] } }), TypeError);
  await assert.doesNotReject(assembleInsightsView({}, "7d", { pricing, nowMs: NOW, envFn: () => ({}), reads: { ...reads, hosts: async () => ({ unreachable: "not answering" }), scan: () => ({ unreachable: "EACCES" }) } }), "an outage of every source answers with its unknowns");
  const card = String(SPEND_PANELS.insights[0][1]({ page: "insights", role: "viewer", query: {}, now: NOW, data: { insights: null, insightsError: data.insightsError } }));
  assert.match(card, /class="card__body sp-unread"/);
  assert.match(SPEND_CSS, /main > div > section:has\(\.sp-unread\) \{ grid-column: 1 \/ -1; \}/);
  assert.ok(!String(await drawSpend("insights", { role: "viewer" })).includes("sp-unread"), "a view that was read has no such card");
});

test("Spend: the average card counts no metered runs over records that were not read, and the peak says whose it is", async () => {
  const p = spendFixture();
  const average = async (payload) => /Average per metered run (.*?) Spend over time/.exec(wordsOf(await drawSpend("insights", { role: "viewer", payload })))[1];
  const unread = await average({ ...p, recent24h: null });
  assert.match(unread, /Metered runs not known: the run records could not be read\. The job cap/);
  assert.doesNotMatch(unread, /\d metered runs?\./);
  assert.match(await average(p), /3 metered runs\. The job cap/);
  const peak = async (venuesUnreadable) => { const q = spendFixture(); q.capacity.venuesUnreadable = venuesUnreadable; return wordsOf(await drawSpend("insights-capacity", { role: "viewer", query: "range=24h", payload: q })); };
  assert.match(await peak(true), /Fleet peak \d+ jobs at once Most jobs at once in one hour, over the hosts the run records name: the hosts themselves could not be read, so the fleet's peak may be higher\./);
  assert.ok(!(await peak(true)).includes("all hosts added"));
  assert.match(await peak(false), /Fleet peak \d+ jobs at once Most jobs at once in one hour, all hosts added\./);
});
