import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agentReadProjection } from "../src/agent-read.mjs";
import { LOADED_CSS, LOADED_CSS_SHA256 } from "../src/console/loaded-css.mjs";
import { renderPage } from "../src/console/pages.mjs";
import { PAGE_CSS } from "../src/console/page-css.mjs";
import { outcomeCell } from "../src/console/panels/common.mjs";
import { loadedList, wordsHtml } from "../src/console/panels/loaded-parts.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { LOADED_WORDS, loadedFold, loadedOf, loadedRows, loadedVerdict, outcomeBanner, outcomeNote, projectLoadsOf, wordsText } from "../src/loaded-words.mjs";
import { projectViewForAgent } from "../src/project-view.mjs";
import { forgeRepoLinkOf, modelRunRecord } from "../src/read-model.mjs";
import { parseRunFilter, runMatches } from "../src/run-filter.mjs";
import { runForAgent } from "../src/tool-reads.mjs";
import { outcomeKey } from "../src/words.mjs";
import { HOST_LOADS, HOSTILE_LOADED, LOADED_SAMPLES as S, SCRIPT, billingRecords, loadedField } from "./helpers/loaded-samples.mjs";

// Issue #800: what the console's surfaces do with `loaded-words.mjs`: the run page's card and banner, the Runs list and its
// filter, `/api/run`'s neighbours, and every read that must NOT carry the field to a model.

const lineOf = (v) => [v.lead, v.bold, v.rest, ...v.then.flatMap((part) => [part.bold, part.rest])].filter(Boolean).join(" ");

/** The whole run page around a record, as a person would read it. */
const pageOf = async (record, role = "operator", extra = {}) => String((await renderPage("run", { query: { id: record.jobId }, session: { name: "ops", role }, data: { now: Date.parse(record.endedAt) + 60_000, env: {}, run: { record, source: "local" }, chat: { state: "finished", mode: "none", jobState: "completed" }, transcript: { exists: false }, children: [], childrenSearched: 50, ...extra } })).html);

test("a hostile or malformed `loaded` never renders raw: the page says it could not be read", async () => {
  for (const [at, loaded] of HOSTILE_LOADED.entries()) {
    const page = await pageOf({ ...S.everything(), loaded });
    assert.ok(page.includes(LOADED_WORDS.invalid), `${at}`);
    assert.ok(!page.includes(SCRIPT) && !page.includes("alert(1)"), `${at}: nothing of it reaches the page`);
  }
  // The image is the worker's own value and the rebuild does not hold it to a charset, so the escaper is what stands here.
  // Whatever the rebuild does with it, the page never draws it as markup.
  const badImage = await pageOf({ ...S.everything(), loaded: { ...loadedField(), image: SCRIPT } });
  assert.ok(!badImage.includes(SCRIPT));
  assert.doesNotMatch(badImage, /<script>alert/);
});

test("the outcome stays completed: the filter finds a run that lacked something under problems, and outcome=completed still does too", () => {
  const filter = (query) => parseRunFilter(new URLSearchParams(query)).filter;
  const plain = S.everything();
  for (const lacking of [S.noFlow(), S.extensionFailed()]) {
    assert.equal(lacking.outcome, "completed");
    assert.equal(outcomeKey(lacking.outcome, lacking.reason), "completed");
    assert.equal(runMatches(lacking, filter("problems=1")), true);
    assert.equal(runMatches(lacking, filter("outcome=completed")), true);
  }
  assert.equal(runMatches(plain, filter("problems=1")), false);
  assert.equal(runMatches(S.dropped(), filter("problems=1")), false, "a dropped extension is no problem");
  assert.equal(runMatches(S.notRecorded(), filter("problems=1")), false, "an older record stays quiet");
  assert.equal(runMatches(S.mcpTimeout(), filter("problems=1")), true, "a failed run was already a problem");
});

test("a name in the record's other strings goes through the shape held here and the panels' escaper: `<script>` never renders", async () => {
  const hostile = { ...S.noFlow(), host: SCRIPT, target: `${SCRIPT}#12`, flow: SCRIPT, provider: SCRIPT, model: SCRIPT, jobId: "gh-hostile" };
  const v = loadedVerdict(hostile);
  assert.ok(!lineOf(v).includes("<script"), lineOf(v));
  assert.equal(lineOf(v), "Ran without its flow. This repository has no such skill at its base commit, and no skills folder, overlay or staged package ships one.");
  for (const row of loadedRows(hostile)) assert.ok(!`${wordsText(row.value)} ${wordsText(row.more)}`.includes("<script"), row.label);
  for (const row of loadedFold(hostile)) assert.ok(!`${wordsText(row.name)} ${wordsText(row.from)}`.includes("<script"), row.kind);
  const page = await pageOf(hostile);
  const at = page.indexOf('id="p-loaded" data-panel');
  const panel = page.slice(at, page.indexOf("data-panel", at + 30));
  assert.ok(!panel.includes("<script") && !panel.includes(SCRIPT), "the panel holds no raw markup");
  // The escaper is the second belt, and it stands alone: if a name got past every shape, it would still be text.
  const drawn = String(loadedList([{ icon: "box", label: "pi", value: [SCRIPT, { code: SCRIPT }, { b: SCRIPT }, { muted: SCRIPT }, { repository: SCRIPT }], more: [SCRIPT] }]));
  assert.ok(!drawn.includes("<script"), drawn);
  assert.ok(drawn.includes("&lt;script&gt;"));
  assert.ok(!String(wordsHtml([{ run: SCRIPT }])).includes("<script"), "a run id is text too");
});

test("no model read carries what a run loaded: each way a record reaches a model or an agent", () => {
  const record = S.noFlow();
  // `dispatch_runs`, by id and as a list.
  const model = modelRunRecord(record);
  assert.equal(Object.hasOwn(model, "loaded"), false);
  assert.equal(model.jobId, record.jobId, "the rest of the record stands");
  assert.equal(Object.hasOwn(modelRunRecord(record, { list: true }), "loaded"), false);
  assert.equal(Object.hasOwn(runForAgent(record), "loaded"), false);
  assert.equal(Object.hasOwn(modelRunRecord(runForAgent(record), { list: true }), "loaded"), false);
  // Beside each key the projection already rebuilds, and on a record of every shape the fixtures hold.
  assert.equal(Object.hasOwn(modelRunRecord({ ...record, bundle: { id: "b", variables: [], shadowed: [] } }), "loaded"), false);
  assert.equal(Object.hasOwn(modelRunRecord({ ...record, modelWhy: "primary" }), "loaded"), false);
  const maximal = JSON.parse(readFileSync(new URL("../../worker/test/fixtures/run-records/next.maximal.json", import.meta.url), "utf8"));
  assert.ok(maximal.loaded, "the fixture holds the field, or this proves nothing");
  assert.equal(JSON.stringify(modelRunRecord(maximal)).includes("pi-lint"), false, "no name of it survives anywhere in what a model reads");
  assert.equal(Object.hasOwn(modelRunRecord({ ...record, v: 2 }), "loaded"), false, "a newer release's record is its core");
  const plain = S.notRecorded();
  assert.equal(modelRunRecord(plain), plain, "a record with no such key is the same object, as ever");
  // The agent role's reads of `/api/run`, `/api/state` and a page's data.
  const agent = agentReadProjection({ run: { jobId: "gh-1", loaded: loadedOf(record), outcomeNote: outcomeNote(record) }, runs: [record], hostLoads: HOST_LOADS, projectView: { loads: projectLoadsOf([record]) }, sandboxRun: record });
  assert.equal(JSON.stringify(agent).includes("pi-lint"), false);
  assert.deepEqual(agent.run, { jobId: "gh-1" });
  assert.equal(Object.hasOwn(agent, "hostLoads"), false);
  assert.equal(Object.hasOwn(agent, "sandboxRun"), false);
  assert.deepEqual(agent.projectView, {});
  // `dispatch_projects`' rebuild names its keys, so a project's card cannot ride along.
  const view = { id: "billing", state: "ready", spend: {}, loads: projectLoadsOf(billingRecords()) };
  assert.equal(JSON.stringify(projectViewForAgent(view)).includes("git-guard"), false);
});

test("the viewer reads the same lines as an operator, with no button, in every state that has one", async () => {
  const text = (page) => {
    const at = page.indexOf('id="p-loaded" data-panel');
    return page.slice(at, page.indexOf("</section>", at));
  };
  for (const record of [S.noFlow(), S.extensionFailed(), S.mcpFailed(), S.mcpTimeout(), S.hostDiffers()]) {
    const operator = text(await pageOf(record, "operator", { hostLoads: HOST_LOADS }));
    const viewer = text(await pageOf(record, "viewer", { hostLoads: HOST_LOADS }));
    assert.match(operator, /class="btn btn--sm"/, record.jobId);
    assert.doesNotMatch(viewer, /class="btn/, record.jobId);
    const withoutButtons = operator.replace(/ ?<a class="btn btn--sm"[^>]*>(?:<svg[\s\S]*?<\/svg>)?[^<]*<\/a>/g, " ").replace(/ {2,}/g, " ");
    assert.equal(viewer, withoutButtons, "the same words, whatever the button");
  }
});

test("the old MCP line stays only when a record has no `loaded`, and a read that failed is no error page", async () => {
  const trigger = { mcp: ["linear"], phrase: "@pi" };
  assert.ok((await pageOf(S.notRecorded(), "operator", { trigger })).includes("the record does not say which connected"));
  assert.ok(!(await pageOf(S.mcpConnected(), "operator", { trigger })).includes("the record does not say which connected"));
  const failed = await pageOf(S.hostDiffers(), "operator", { hostLoads: null });
  assert.ok(failed.includes("Everything trigger 3 asks for loaded."));
  assert.ok(!failed.includes("does not have it"));
});

test("the fold is a details element, the card's words, and the page draws the panel after p-run for both roles", async () => {
  const page = await pageOf(S.everything());
  assert.ok(page.indexOf('id="p-run" data-panel') < page.indexOf('id="p-loaded" data-panel'));
  assert.ok(page.indexOf('id="p-loaded" data-panel') < page.indexOf('id="p-progress" data-panel'));
  assert.match(page, /<details class="ld-more"><summary>Each item, and where it came from<\/summary>/);
  assert.ok(page.includes(LOADED_WORDS.foot));
  assert.ok(page.includes(`href="${"https://github.com/acme/web"}"`), "Read them there links the repository");
  const viewer = await pageOf(S.everything(), "viewer");
  assert.ok(viewer.includes(LOADED_WORDS.foot));
  // A record a newer release wrote shows its core alone.
  const newer = await pageOf({ jobId: "gh-v2", outcome: "completed", startedAt: new Date(0).toISOString(), endedAt: new Date(1000).toISOString(), host: "mini1", kind: "github", attempt: 1, project: "web", v: 2 });
  const at = newer.indexOf('id="p-loaded" data-panel');
  assert.equal(newer.slice(at, newer.indexOf("</section>", at)), 'id="p-loaded" data-panel>');
});

test("the list cell and the banner say the note in the attention tone; every other run draws as it did", async () => {
  const cell = (record) => String(outcomeCell(record));
  assert.match(cell(S.noFlow()), /badge tone-attention/);
  assert.ok(cell(S.noFlow()).includes("Completed, without its flow"));
  assert.ok(cell(S.extensionFailed()).includes("Completed, with a failed extension"));
  for (const record of [S.everything(), S.notRecorded(), S.dropped(), S.leftOut()]) assert.match(cell(record), /badge tone-idle/, record.jobId);
  const banner = (page) => page.slice(page.indexOf('id="p-outcome" data-panel'), page.indexOf('id="p-workspace" data-panel'));
  const noFlow = banner(await pageOf(S.noFlow()));
  assert.match(noFlow, /banner tone-attention/);
  assert.ok(noFlow.includes("Completed, without its flow: finished in"));
  assert.ok(noFlow.includes("Read what it did before you trust it."));
  assert.ok(noFlow.includes("/config/trigger?index=2"));
  const failed = banner(await pageOf(S.extensionFailed()));
  assert.ok(failed.includes("Completed, with a failed extension: finished in"));
  assert.ok(failed.includes("https://github.com/acme/api"), "where it is fixed");
  const viewer = banner(await pageOf(S.noFlow(), "viewer"));
  assert.ok(viewer.includes("Completed, without its flow: finished in"), "a viewer reads the same word");
  assert.ok(!viewer.includes("/config/trigger?index=2"), "with no button");
  assert.match(banner(await pageOf(S.everything())), /banner tone-ok/);
  assert.equal(outcomeBanner(S.everything()), null);
});

test("the repository link: the forge's own, by the record's checks, and none for a local run or a target it cannot read", () => {
  const env = { GITLAB_URL: "https://gitlab.example.com/sub", FORGEJO_URL: "https://code.example.org", AZURE_ORG_URL: "https://dev.azure.com/acme" };
  assert.equal(forgeRepoLinkOf({ kind: "github", target: "acme/web#12" }, env), "https://github.com/acme/web");
  assert.equal(forgeRepoLinkOf({ kind: "gitlab", target: "group/sub/project!3" }, env), "https://gitlab.example.com/sub/group/sub/project");
  assert.equal(forgeRepoLinkOf({ kind: "forgejo", target: "acme/web#12" }, env), "https://code.example.org/acme/web");
  assert.equal(forgeRepoLinkOf({ kind: "azure", target: "proj/repo#7" }, env), "https://dev.azure.com/acme/proj/_git/repo");
  for (const record of [{ kind: "local", target: "local:site" }, { kind: "github", target: "../evil#1" }, { kind: "github", target: "acme/web" }, { kind: "github", target: "<script>#1" }, { kind: "gitlab", target: "a/b#1" }, {}, null]) {
    assert.equal(forgeRepoLinkOf(record, record?.kind === "gitlab" ? {} : env), null, JSON.stringify(record));
  }
});

test("what the hosts published, beside what they beat out: a live host with no record still has its pi, and a failed read says so", async () => {
  const rows = [{ name: "mini1", image: "pi-job:4.3.1", piVersion: "1.5.0" }, { name: "mini2", image: "pi-job:4.3.1", piVersion: "1.5.0" }];
  const seen = {};
  const got = await readHostLoadsView({}, {
    now: () => 5,
    readHosts: async (_r, options) => { seen.prune = options.prune; return { hosts: rows }; },
    readLoads: async (_r, options) => { seen.names = options.names; return { hosts: [{ name: "mini1", state: "current", at: 1, packages: [], extensions: [] }, { name: "mini2", state: "unknown", why: "absent" }], more: 0 }; },
  });
  assert.equal(seen.prune, false, "a console that looks removes nothing");
  assert.deepEqual(seen.names, ["mini1", "mini2"]);
  assert.equal(got.hosts[1].piVersion, "1.5.0");
  assert.equal(got.hosts[1].state, "unknown");
  assert.equal(got.hosts[0].image, "pi-job:4.3.1");
  const down = await readHostLoadsView({}, { readHosts: async () => ({ unreachable: "x" }), readLoads: async () => ({ unreachable: "x" }) });
  assert.deepEqual(down, { unreachable: true, hosts: [], more: 0 });
  const thrown = await readHostLoadsView({}, { readHosts: async () => { throw new Error("no"); }, readLoads: async () => { throw new Error("no"); } });
  assert.equal(thrown.unreachable, true);
  const partial = await readHostLoadsView({}, { readHosts: async () => ({ hosts: rows }), readLoads: async () => ({ unreachable: "x" }) });
  assert.equal(partial.hosts[0].state, "unknown");
  assert.equal(partial.hosts[0].piVersion, "1.5.0", "the beat still names the pi a shell would have");
  // No client at all, as a console with no Valkey has: the real readers answer rather than throw.
  assert.equal((await readHostLoadsView(null)).unreachable, true);
});

test("the page CSS is the exact published generator source, served on the pages that draw the card, and scoped there", () => {
  const generator = readFileSync(new URL("../../design/tools/gen_loaded.py", import.meta.url), "utf8");
  const css = /\nLOADED_CSS = """([\s\S]*?)"""/.exec(generator)?.[1];
  assert.equal(LOADED_CSS, css);
  assert.equal(LOADED_CSS_SHA256, createHash("sha256").update(css).digest("hex"));
  assert.ok(PAGE_CSS.run.endsWith(LOADED_CSS));
  assert.doesNotMatch(LOADED_CSS, /\.c2-/, "nothing of the sample pages' stylesheet: the console ships none of it");
});
