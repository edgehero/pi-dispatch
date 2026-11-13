// What a trigger's jobs get, on its page (issue #800, the TriggerEnvironment card): the real page over a real triggers file, the real script
// over that page's own markup, and the real planner on what the script sends.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildHostLoads, hostLoadsKey } from "@edgehero/pi-dispatch/host-loads";
import { agentReadProjection } from "../src/agent-read.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { PAGE_CSS } from "../src/console/page-css.mjs";
import { PAGES, loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { EDIT_FIELDS, HAND_FIELDS } from "../src/console/panels/trigger.mjs";
import { TRIGGER_GETS_CSS, TRIGGER_GETS_CSS_SHA256 } from "../src/console/trigger-gets-css.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { readTriggerEditor } from "../src/read-model.mjs";
import { wordsText } from "../src/loaded-words.mjs";
import { CARD_FIELDS, triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { TRIGGER_GETS_WORDS as W, readTriggerGetsEntry, triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { cardPreview, cardReadme, cardText } from "./helpers/card-structure.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { HOST_LOADS, LOADED_SAMPLES as S } from "./helpers/loaded-samples.mjs";
import { Event, runConsoleScript } from "./helpers/script-dom.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { GETS_ENTRY, GETS_HOST_ENV, GETS_MCP_JSON, TRIGGER_GETS_PATH, fileOnlyFs, getsFile, getsHostLoads, triggerGetsPage } from "./helpers/trigger-gets-goldens.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const HOUR = 3_600_000;
const COMMENT = Object.freeze({ index: 2, type: "comment", flow: "fix", packages: true, forge: "github" });
const lineOf = (parts) => wordsText(parts);
const VIEWER_SESSION = Object.freeze({ name: "watcher", role: "viewer" });
const panelOf = (page, id) => {
  const at = page.indexOf(`<section id="${id}" data-panel>`);
  assert.ok(at >= 0, `the page draws ${id}`);
  return page.slice(at, page.indexOf("</section>", at));
};
const textOf = (markup) => markup.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const namesIn = (markup) => [...markup.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]);

/** What the hosts published, each written by the real builder and read back by the real reader beside what its host beats out. */
async function published(hosts, { live = Object.keys(hosts) } = {}) {
  const strings = new Map(Object.entries(hosts).filter(([, row]) => row !== null && typeof row === "object").map(([name, row]) => [hostLoadsKey(name), JSON.stringify(buildHostLoads({ at: NOW - HOUR, every: 24, by: { uid: 1000, worker: true }, ...row }))]));
  for (const [name, row] of Object.entries(hosts)) if (typeof row === "string") strings.set(hostLoadsKey(name), row);
  const redis = { smembers: async () => Object.keys(hosts), mget: async (...keys) => keys.map((key) => strings.get(key) ?? null) };
  return readHostLoadsView(redis, { now: () => NOW, readHosts: async () => ({ hosts: live.map((name) => ({ name, image: "pi-job:4.3.1", piVersion: "1.5.0" })) }) });
}
const pills = async (hosts, trigger = COMMENT, options = {}) => Object.fromEntries(triggerGetsOf({ trigger, hostLoads: await published(hosts, options), liveHosts: options.live ?? Object.keys(hosts) }).pills.map((pill) => [pill.name, pill.word]));

/** The quote under each row, for a real record, beside a file that says something else. */
function quoted(record, trigger = COMMENT) {
  const out = triggerGetsOf({ trigger, records: [record], hostLoads: null, liveHosts: [] });
  return { out, last: Object.fromEntries(Object.entries(out.last).map(([label, parts]) => [label, lineOf(parts)])), quote: lineOf(out.quote) };
}

test("no key has two editors: the card takes CARD_FIELDS, the Edit form EDIT_FIELDS, and neither names the other's", async () => {
  assert.deepEqual([...EDIT_FIELDS], ["backend", "maxTurns", "progress", "statusComment", "steer", "recover"]);
  assert.deepEqual(EDIT_FIELDS.filter((key) => CARD_FIELDS.includes(key)), []);
  assert.deepEqual(HAND_FIELDS.filter((key) => CARD_FIELDS.includes(key) || EDIT_FIELDS.includes(key)), []);
  for (const stays of ["image", "secrets", "skillsDir"]) assert.ok(HAND_FIELDS.includes(stays) && !CARD_FIELDS.includes(stays), `${stays} stays where it is`);
  const page = await triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, mcp: ["linear"] } } });
  const edit = namesIn(panelOf(page, "p-trigger-edit"));
  const gets = panelOf(page, "p-trigger-gets");
  for (const key of CARD_FIELDS) assert.ok(!edit.includes(key), `the Edit form does not offer ${key}`);
  for (const key of EDIT_FIELDS) assert.ok(!namesIn(gets).includes(key), `the card does not offer ${key}`);
  assert.deepEqual(namesIn(gets).filter((name) => name !== "index" && name !== "pageDigest").sort(), ["flow", "maxCostUsd", "model", "provider"], "a card's text fields, each once");
  for (const key of ["models", "fallbackModels"]) assert.ok(gets.includes(`data-gets-add="${key}"`), key);
  assert.ok(gets.includes('data-gets-list="mcp"') && gets.includes('data-gets-list="excludeTools"') && gets.includes('data-gets-flag="packages"'));
  const run = panelOf(page, "p-trigger-run");
  for (const key of CARD_FIELDS) assert.ok(!run.includes(`run.${key}`), `What it runs no longer lists run.${key}`);
  assert.ok(run.includes("are in What its jobs get"), "and says where they went");
});

test("a new trigger has no card yet, so the add form keeps its flow and its model, and says where the rest are changed", async () => {
  const parsed = parsePageQuery("trigger-add", "");
  const data = await loadPageData("trigger-add", parsed.query, { now: () => NOW, env: {}, fleet: { snapshot: async () => ({}) }, triggerEditor: () => ({ forges: ["github"], backends: [], flows: [], defaults: {} }) }, { role: "operator" });
  const page = String((await renderPage("trigger-add", { query: parsed.query, session: { name: "ops", role: "operator" }, data })).html);
  const panel = panelOf(page, "p-trigger-add");
  for (const key of ["flow", "provider", "model", "maxTurns", "backend"]) assert.ok(namesIn(panel).includes(key), key);
  assert.ok(textOf(panel).includes("Once it exists, a person changes its job cap, allowed models and MCP servers on its page"));
  assert.ok(!textOf(panel).includes("The console never sets the job cap"), "that sentence is false now");
});

test("the digest is the entry's, from the read that drew the form, in an operator's form alone", async () => {
  const page = await triggerGetsPage();
  const digest = /name="pageDigest" value="([a-f0-9]{64})"/.exec(panelOf(page, "p-trigger-gets"))?.[1];
  assert.equal(digest, triggerEntryDigest(JSON.parse(getsFile()).triggers[2]));
  // A viewer's page and a read-only console's hold no form and no digest, in the page or in what the page was drawn from.
  for (const who of [{ role: "viewer" }, { role: "operator", readOnly: true }]) {
    const seen = await triggerGetsPage(who);
    assert.ok(!seen.includes("pageDigest"), JSON.stringify(who));
    assert.ok(!seen.includes(digest), JSON.stringify(who));
    const panel = panelOf(seen, "p-trigger-gets");
    assert.doesNotMatch(panel, /<(?:input|select|textarea|form|button)\b/, `${JSON.stringify(who)}: no control at all`);
    assert.doesNotMatch(panel, /data-gets-/, JSON.stringify(who));
    assert.ok(textOf(panel).includes("Model") && textOf(panel).includes("Last run on mini1"), "the same rows");
  }
  const fs = fileOnlyFs(getsFile());
  assert.equal(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 2, fs }).pageDigest, undefined, "asked for only when a form is drawn");
  assert.equal(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 2, withDigest: true, fs }).pageDigest, digest);
  assert.equal(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 9, withDigest: true, fs }), null);
  assert.equal(readTriggerGetsEntry({ triggersPath: "/nowhere", index: 2, withDigest: true, fs }), null);
  assert.equal(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 0, withDigest: true, fs: fileOnlyFs(JSON.stringify({ triggers: [null] })) }), null, "a row that is no trigger has nothing to draw");
  // What a viewer's or a read-only console's page is drawn from holds none of it either, whoever draws it next.
  for (const who of [{ role: "viewer" }, { role: "operator", readOnly: true }]) {
    const parsed = parsePageQuery("trigger", "index=2");
    const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => ({ readAt: NOW, triggers: { triggers: [] }, runs: [] }) }, triggerEditor: () => ({}), pricedModels: () => ["a/b"] }, who);
    assert.ok(data.triggerGets.trigger);
    assert.equal(data.triggerGets.pageDigest, undefined, JSON.stringify(who));
    assert.equal(data.modelChoices, undefined, JSON.stringify(who));
  }
  // And a viewer drawn from an operator's data, which no route does, gets no form.
  const parsedOp = parsePageQuery("trigger", "index=2");
  const operatorData = await loadPageData("trigger", parsedOp.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => ({ readAt: NOW, triggers: { triggers: [] }, runs: [] }) }, triggerEditor: () => ({}) }, { role: "operator" });
  assert.ok(operatorData.triggerGets.pageDigest);
  const crossed = String((await renderPage("trigger", { query: parsedOp.query, session: { name: "watcher", role: "viewer" }, data: operatorData })).html);
  assert.ok(!crossed.includes("pageDigest") && !crossed.includes(operatorData.triggerGets.pageDigest));
  // The values beside it are that same read's, not the snapshot's, which can be older.
  const newer = { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, flow: "review" } };
  const raced = await triggerGetsPage({ deps: { fs: fileOnlyFs(getsFile(newer)) } });
  const raceForm = panelOf(raced, "p-trigger-gets");
  assert.ok(raceForm.includes('name="flow" type="text" value="review"'), "the form says what the digest covers");
  assert.ok(raceForm.includes(triggerEntryDigest(JSON.parse(getsFile(newer)).triggers[2])));
});

test("the page is not live, so no redraw refreshes the digest under a person who is editing", () => {
  assert.equal(PAGES.trigger.live, false);
});

test("a row the file does not give back offers no form, and says so; the rows still read from the last read", async () => {
  const page = await triggerGetsPage({ deps: { fs: { readFileSync: () => { throw new Error("gone"); } } } });
  const panel = panelOf(page, "p-trigger-gets");
  assert.doesNotMatch(panel, /<form\b/);
  assert.ok(textOf(panel).includes(W.unreadRow));
  // A snapshot that failed: the card still reads the file, and does not call the history empty.
  const fs = fileOnlyFs(getsFile());
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => { throw new Error("down"); } }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const down = panelOf(String((await renderPage("trigger", { query: parsed.query, session: { name: "ops", role: "operator" }, data })).html), "p-trigger-gets");
  assert.ok(textOf(down).includes(W.historyUnread));
  assert.ok(!textOf(down).includes(W.noRun));
});

test("a file a newer release wrote draws no card: its entries may use fields this build cannot read, and a change would be refused", async () => {
  const text = JSON.stringify({ version: 999, triggers: JSON.parse(getsFile()).triggers });
  assert.equal(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 2, withDigest: true, fs: fileOnlyFs(text) }), null);
  const { readTriggers } = await import("../src/read-model.mjs");
  const snapshot = { readAt: NOW, triggers: readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs: fileOnlyFs(text) }), runs: [], waiting: { rows: [] } };
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs: fileOnlyFs(text), fleet: { snapshot: async () => snapshot }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const page = String((await renderPage("trigger", { query: parsed.query, session: { name: "ops", role: "operator" }, data })).html);
  assert.equal(panelOf(page, "p-trigger-gets").replace(/<section[^>]*>/, ""), "");
  // The row can still be read when only the snapshot says the file is bad: the snapshot's word stands.
  const bad = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs: fileOnlyFs(getsFile()), fleet: { snapshot: async () => ({ ...snapshot, triggers: { invalid: "broken" } }) }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const badPage = String((await renderPage("trigger", { query: parsed.query, session: { name: "ops", role: "operator" }, data: bad })).html);
  assert.equal(panelOf(badPage, "p-trigger-gets").replace(/<section[^>]*>/, ""), "");
});

test("a page that came from a refused run says a change here is not linked to it, because the banner above says changes are", async () => {
  const fs = fileOnlyFs(getsFile());
  const { readTriggers } = await import("../src/read-model.mjs");
  const snapshot = { readAt: NOW, triggers: readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs }), runs: [], waiting: { rows: [] } };
  const parsed = parsePageQuery("trigger", "index=2&becauseRun=gh-1");
  assert.equal(parsed.query.becauseRun, "gh-1");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const page = String((await renderPage("trigger", { query: parsed.query, session: { name: "ops", role: "operator" }, data })).html);
  assert.ok(textOf(panelOf(page, "p-trigger-gets")).includes(W.notLinked));
  assert.ok(!textOf(panelOf(await triggerGetsPage(), "p-trigger-gets")).includes(W.notLinked));
});

test("a watch rule's run takes only some of these fields, so its page offers no form", async () => {
  const page = await triggerGetsPage({ entry: { on: { type: "watch", id: "w", source: "s" }, run: { kind: "local", folder: "/x", flow: "fix", task: "T", mode: "investigate" } } });
  const panel = panelOf(page, "p-trigger-gets");
  assert.doesNotMatch(panel, /<form\b/);
  assert.ok(textOf(panel).includes(W.watch));
});

test("an agent's page has no card, and its data holds nothing of the card: no record's list, no digest, no publication", async () => {
  const file = getsFile();
  const reads = [];
  const fs = { readFileSync: (...args) => { reads.push(args[0]); return file; } };
  const snapshot = { readAt: Date.parse("2026-10-08T15:39:08Z"), triggers: { triggers: [{ ...COMMENT }], count: 3 }, runs: [S.everything()], waiting: { rows: [] }, hostBudgets: [] };
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => snapshot.readAt, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot }, hostLoads: async () => getsHostLoads(), triggerEditor: () => ({}), pricedModels: () => ["anthropic/x"] }, { role: "agent" });
  assert.deepEqual(reads, [], "it never reads the entry for an agent");
  for (const key of ["triggerGets", "hostLoads", "modelChoices"]) assert.equal(data[key], undefined, key);
  const held = JSON.stringify(data);
  for (const word of ["pageDigest", "lint_file", "pi-lint"]) assert.ok(!held.includes(word), word);
  assert.equal(data.triggerDetail.history, undefined, "the run list a person's card reads");
  // The belt: however it arrives, the projection drops them.
  assert.deepEqual(agentReadProjection({ triggerGets: { pageDigest: "a" }, modelChoices: ["x"], history: [{ jobId: "gh-1" }] }), {});
  const page = String((await renderPage("trigger", { query: parsed.query, session: { name: "bot", role: "agent" }, data })).html);
  assert.equal(panelOf(page, "p-trigger-gets").replace(/<section[^>]*>/, ""), "");
  assert.equal(panelOf(page, "p-trigger-gets-how").replace(/<section[^>]*>/, ""), "");
});

test("with no script the page reads truly and offers no control that does nothing", async () => {
  const panel = panelOf(await triggerGetsPage(), "p-trigger-gets");
  // Every control is inside the one disabled fieldset, which only the script enables, and the bar is hidden until it shows it.
  const open = panel.indexOf("<fieldset data-config-controls disabled>");
  const close = panel.indexOf("</fieldset>");
  assert.ok(open >= 0 && close > open);
  assert.equal([...panel.matchAll(/<form\b/g)].length, 1, "one form");
  for (const match of panel.matchAll(/<(?:input|select|textarea|button)\b/g)) assert.ok(match.index > open && match.index < close, panel.slice(match.index, match.index + 80));
  assert.ok(panel.includes('<div class="te-bar" role="status" data-gets-bar hidden>'));
  assert.ok(panel.includes(`<noscript><p class="muted">${W.noScript}</p></noscript>`));
  assert.ok(panel.includes('class="te-pend" hidden'), "nothing reads as changed");
  assert.ok(panel.includes('<button class="btn" type="reset">Discard</button>'), "Discard is the form's own reset");
  // Nothing inline for the CSP: the handler is the document's, by the form's own attributes.
  assert.doesNotMatch(panel, /\son[a-z]+=|style=|javascript:/);
  assert.match(CONSOLE_SCRIPT, /form\[data-structured="trigger-gets"\]/);
});

test("the browser holds no money or policy: its part of the script compares what was drawn with what is there, and says the server's words", () => {
  const from = CONSOLE_SCRIPT.indexOf("function getsLists");
  const to = CONSOLE_SCRIPT.indexOf("function bodyOf");
  const part = CONSOLE_SCRIPT.slice(from, to);
  assert.ok(from > 0 && to > from);
  assert.doesNotMatch(part, /cap|cost|usd|micro|floor|version|skew|widen|mcp|provider|model/i, "no rule of the planner's");
  assert.doesNotMatch(part, /innerHTML|insertAdjacentHTML/, "text alone, from the server's attributes");
});

test("a body the script sends is one the real planner plans, and its Undo puts the file back", async () => {
  const dir = tempDir("pd-800-gets-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: null, globalPiDir: join(dir, "overlay") };
  nodeFs.writeFileSync(paths.triggersPath, getsFile());
  nodeFs.writeFileSync(paths.settingsFile, "{}");
  nodeFs.mkdirSync(paths.globalPiDir);
  nodeFs.writeFileSync(join(paths.globalPiDir, "mcp.json"), JSON.stringify(GETS_MCP_JSON));
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", ...GETS_HOST_ENV }, now: () => NOW, deploymentDir: dir });
  const before = nodeFs.readFileSync(paths.triggersPath, "utf8");
  const w = runConsoleScript(CONSOLE_SCRIPT, await triggerGetsPage());
  const form = w.document.querySelector('form[data-action="trigger-environment-edit"]');
  const linear = form.querySelector('[data-gets-value="linear"]');
  linear.checked = true;
  linear.dispatchEvent(new Event("change", { bubbles: true }));
  const packages = form.querySelector('[data-gets-flag="packages"]');
  packages.checked = false;
  packages.dispatchEvent(new Event("change", { bubbles: true }));
  w.submit(form);
  const body = w.fetch.calls.at(-1).body;
  const operator = { surface: "console", role: "operator", name: "ops" };
  const planned = await service.preview(body, operator);
  assert.ok(planned.plan, JSON.stringify(planned));
  assert.deepEqual(planned.plan.changes.map((change) => change.key), ["mcp", "packages"]);
  assert.deepEqual(await service.apply(planned, operator), { ok: true });
  const written = JSON.parse(nodeFs.readFileSync(paths.triggersPath, "utf8")).triggers[2].run;
  assert.deepEqual(written.mcp, ["linear"]);
  assert.equal(written.packages, false);
  assert.equal(written.flow, "fix", "a key not sent stands");
  const undone = await service.preview(planned.plan.inverse.body, operator);
  assert.deepEqual(await service.apply(undone, operator), { ok: true });
  assert.equal(nodeFs.readFileSync(paths.triggersPath, "utf8"), before, "byte for byte");
});

test("a host alone reads as alone, whichever way it is alone, and a venue a host does not bless is no host of this trigger", async () => {
  assert.deepEqual(await pills({ mini1: {} }), { mini1: "the only host" });
  assert.deepEqual(await pills({ mini1: {}, mini2: null }), { mini1: "the only one known", mini2: "unknown" });
  const page = await triggerGetsPage({ live: [{ name: "mini1", backends: { blessed: ["local"], default: "local" } }, { name: "build3", backends: { blessed: ["podman"], default: "podman" } }, { name: "mini2" }], entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, backend: "local" } } });
  const panel = textOf(panelOf(page, "p-trigger-gets"));
  assert.ok(!/build3 (?:also|without|unknown|the)/.test(panel), "build3 refuses this venue, so it has no pill");
  assert.ok(/mini1 the only one known/.test(panel), panel.slice(0, 300));
});

test("each problem of the quoted run goes under the row it belongs to, in the record's words, and a repository's way is a link", async () => {
  const noFlow = await recordThroughPipeline({ exit: { code: 0, reason: "stop" }, turnsOnLine: 3, flowFound: false });
  const flow = quoted(noFlow).out.problems;
  assert.equal(flow.Skills.bold, "Ran without its flow.");
  assert.ok(flow.Skills.rest.startsWith("pi found no skill named fix: not in acme/web at its base commit"), flow.Skills.rest);
  assert.equal(flow.Extensions, undefined);
  assert.equal(flow.MCP, undefined);
  const failed = { ...S.extensionFailed() };
  assert.equal(quoted(failed).out.problems.Extensions.state, "extension-failed");
  const both = quoted(S.bothLacked()).out.problems;
  assert.ok(both.Skills && both.Extensions, "both of a run's problems, each under its own row");
  const stopped = quoted(S.mcpFailed()).out.problems;
  assert.equal(stopped.MCP.state, "mcp-failed");
  assert.equal(quoted(S.mcpTimeout()).out.problems.MCP.state, "mcp-stopped");
  assert.deepEqual(quoted(S.everything()).out.problems, {}, "a fine run has none to say");
  // On the page: a way to the commit that ran, for an operator, and none to this page itself.
  const page = await triggerGetsPage({ records: [S.noFlow()] });
  const panel = panelOf(page, "p-trigger-gets");
  assert.ok(textOf(panel).includes("Ran without its flow."));
  assert.ok(!panel.includes("Open trigger 3"), "the trigger is this page");
  const viewer = panelOf(await triggerGetsPage({ role: "viewer", records: [S.noFlow()] }), "p-trigger-gets");
  assert.ok(textOf(viewer).includes("Ran without its flow."), "a viewer reads the same line");
  assert.ok(!viewer.includes("btn--sm"), "and no button");
});

test("MCP: each server with what each host says of it, flagged where one lacks it, and the job's own forge on no host's list", async () => {
  const linear = { name: "linear", transport: "http", where: "mcp.example.com", exposure: "codemode", enabled: true, keys: ["LINEAR_API_KEY"] };
  const loads = await published({ a: { mcp: [linear] }, off: { mcp: [{ ...linear, enabled: false }] }, none: { mcp: [] }, silent: null, blind: { mcp: [linear], unread: ["mcp"] } });
  const view = triggerGetsOf({ trigger: { ...COMMENT, mcp: ["linear"] }, hostLoads: loads, liveHosts: ["a", "off", "none", "silent", "blind"] });
  const row = view.mcp.items.find((item) => item.name === "linear");
  assert.equal(row.on, true);
  assert.equal(row.sub, "http · mcp.example.com · codemode · uses LINEAR_API_KEY by name");
  assert.equal(row.tag, "a; off on off; not on none; unknown on silent and blind");
  assert.equal(row.lacks, true);
  assert.equal(view.mcp.items.find((item) => item.name === "forge").tag, "", "no host lacks it: it is the job's own");
  // A forge with no forge server of its own has no such switch, and a local trigger none.
  assert.ok(!triggerGetsOf({ trigger: { ...COMMENT, forge: "forgejo" }, hostLoads: loads, liveHosts: ["a"] }).mcp.items.some((item) => item.name === "forge"));
  assert.ok(!triggerGetsOf({ trigger: { ...COMMENT, forge: null }, hostLoads: loads, liveHosts: ["a"] }).mcp.items.some((item) => item.name === "forge"));
  // Past its cap a list cannot say a server is missing.
  const capped = await published({ wide: { mcp: Array.from({ length: 40 }, (_, at) => ({ ...linear, name: `s${at}` })) } });
  assert.equal(triggerGetsOf({ trigger: { ...COMMENT, mcp: ["linear"] }, hostLoads: capped, liveHosts: ["wide"] }).mcp.items.find((item) => item.name === "linear").tag, "unknown on wide");
  // Two hosts that define one server two ways do not get one sentence, and whether that reaches these jobs depends on whether they name it.
  const differ = await published({ a: { mcp: [linear] }, b: { mcp: [{ ...linear, where: "other.example" }] } });
  assert.equal(triggerGetsOf({ trigger: { ...COMMENT, mcp: ["linear"] }, hostLoads: differ, liveHosts: ["a", "b"] }).mcp.items.find((item) => item.name === "linear").sub, "defined differently by host");
  assert.equal(triggerGetsOf({ trigger: COMMENT, hostLoads: differ, liveHosts: ["a", "b"] }).mcp.items.find((item) => item.name === "linear").sub, "not on for these jobs; turning it on would differ by host");
  const nothing = triggerGetsOf({ trigger: { ...COMMENT, forge: null }, hostLoads: await published({ a: {} }), liveHosts: ["a"] });
  assert.equal(nothing.mcp.none, true);
});

test("tools: pi's own, a named server's and an extension's are chips, and an entry nothing offers still stays on the list", async () => {
  const page = panelOf(await triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, mcp: ["linear"], excludeTools: ["bash", "mcp__linear__*", "codemode"] } } }), "p-trigger-gets");
  for (const name of ["read", "bash", "edit", "write", "powershell", "grep", "find", "ls", "codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "mcp__linear__*"]) assert.ok(page.includes(`data-gets-list="excludeTools" data-gets-value="${name}" data-gets-inverse`), name);
  assert.match(page, /<input type="checkbox" data-gets-list="excludeTools" data-gets-value="bash"/, "removed reads unticked");
  assert.match(page, /<input type="checkbox" checked data-gets-list="excludeTools" data-gets-value="read"/);
  assert.ok(textOf(page).includes(W.lastWay), "the rule, and how far the preview holds it");
  assert.ok(textOf(page).includes("all of linear’s tools"));
  // An extension's tool is a chip of its own list, named from the record, and it says whose it is.
  assert.ok(textOf(page).includes("From pi-lint, as gh-9575 loaded it on mini1"));
  assert.ok(page.includes('data-gets-list="excludeExtensionTools" data-gets-value="lint_file" data-gets-inverse data-gets-on="lint_file on" data-gets-off="lint_file off"'));
  assert.ok(textOf(page).includes(W.extensionToolChip));
  // With no server named, there are no server chips and no such rule to state.
  const plain = panelOf(await triggerGetsPage(), "p-trigger-gets");
  assert.ok(!plain.includes('data-gets-value="codemode"'));
  assert.ok(!textOf(plain).includes(W.lastWay));
  assert.ok(textOf(plain).includes(W.serverToolsLater));
  // report_progress is drawn only where a job has it, and says where it comes from.
  assert.ok(textOf(plain).includes(W.jobTool), "this trigger sets run.progress");
  const noProgress = panelOf(await triggerGetsPage({ records: [], entry: { on: GETS_ENTRY.on, run: { kind: "github", flow: "fix" } } }), "p-trigger-gets");
  assert.ok(!textOf(noProgress).includes(W.jobTool));
  assert.ok(textOf(panelOf(await triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, excludeTools: ["bash", "mcp__gone__*"] } } }), "p-trigger-gets")).includes("Also in the file"), "drawn, so it stays on the list");
  // The loader refuses such a file, and a display reads it leniently, so it must not fall off the list on the next edit.
  const odd = triggerGetsOf({ trigger: { ...COMMENT, excludeTools: ["bash", "mcp__gone__*"] }, liveHosts: [] }).tools;
  assert.deepEqual(odd.other, [{ name: "mcp__gone__*", label: "mcp__gone__*", on: false }]);
  // report_progress is said only where a job would have it.
  assert.equal(triggerGetsOf({ trigger: COMMENT, liveHosts: [] }).tools.jobTool, false);
  assert.equal(triggerGetsOf({ trigger: { ...COMMENT, progress: true }, liveHosts: [] }).tools.jobTool, true);
});

test("extensions: each has its switch, says where it is, and what is read from a record says whose it is", async () => {
  const panel = panelOf(await triggerGetsPage(), "p-trigger-gets");
  assert.ok(panel.includes('data-gets-list="excludeExtensions" data-gets-value="pi-lint" data-gets-inverse data-gets-on="pi-lint back on" data-gets-off="pi-lint left out"'));
  assert.ok(panel.includes('data-gets-list="excludeExtensions" data-gets-value="git-guard"'));
  assert.ok(textOf(panel).includes(W.extensionSwitch));
  const text = textOf(panel);
  assert.ok(text.includes("pi-lint 1.4.2 staged on build3 and mini1, unknown on mini2 · 2 tools, 1 prompt template, as gh-9575 loaded it"), text.slice(0, 2000));
  assert.ok(text.includes("git-guard in the overlay on build3, not on mini1, unknown on mini2"));
  assert.ok(text.includes("The repository’s own"));
  // Off, the file's own words, and nothing of a record claims these jobs load them.
  const off = textOf(panelOf(await triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, packages: false } } }), "p-trigger-gets"));
  assert.ok(off.includes(W.packagesOff));
  assert.ok(off.includes(W.extensionsMoot));
  assert.ok(!off.includes("as gh-9575 loaded it · ") && !off.includes("0.9.0 staged on build3 and mini1, unknown on mini2 · 3 tools"), off.slice(0, 1800));
  // A viewer has no switch, so no sentence about what off writes.
  const seen = textOf(panelOf(await triggerGetsPage({ role: "viewer" }), "p-trigger-gets"));
  assert.ok(seen.includes(W.packagesLoad) && !seen.includes(W.packagesOn));
  assert.ok(!seen.includes(W.extensionSwitch), "nor what off does");
  assert.ok(seen.includes("pi-lint 1.4.2: on"), "and each says what it is");
});

test("the flow row says each host's answer, reads no answer from a doctor run about another flow, and a command is no flow", async () => {
  const flow = (tier, name = "fix", pkg = null) => ({ flows: [{ trigger: 2, flow: name, tier, package: pkg, repo: "unknown" }] });
  const view = (hosts, trigger = COMMENT) => published(hosts).then((loads) => triggerGetsOf({ trigger, hostLoads: loads, liveHosts: Object.keys(hosts) }).flow);
  assert.equal((await view({ a: flow("overlay"), b: flow("package", "fix", "pi-test-runner"), c: flow("none"), d: flow("repository"), e: flow("trigger"), f: flow("unknown") })).doctor, "a finds fix from the overlay; b finds fix from pi-test-runner; c finds fix in no tier; d finds fix from the repository; e finds fix from its skills folder; f finds fix in no tier a host can see.");
  assert.equal((await view({ a: flow("overlay", "other"), b: null })).doctor, "a has no answer for it; b has no answer to read.");
  assert.equal((await view({ a: flow("overlay") }, { ...COMMENT, flow: null })).doctor, null, "no flow, so nothing to answer");
  const command = await triggerGetsPage({ entry: { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "ship" } } });
  const panel = panelOf(command, "p-trigger-gets");
  assert.ok(!namesIn(panel).includes("flow"), "no flow to change on a command's trigger");
  assert.ok(textOf(panel).includes(`ship , ${W.command}`) || textOf(panel).includes(`ship, ${W.command}`), textOf(panel).slice(0, 1500));
  const forge = await view({ a: flow("unknown") });
  assert.equal(forge.forge, true);
  assert.equal((await view({ a: flow("none") }, { ...COMMENT, forge: null })).forge, false, "a local trigger's repository is on its host");
});

test("the card sits above What it runs, in the main column, and its How beside it", async () => {
  const page = await triggerGetsPage();
  const at = (id) => page.indexOf(`<section id="${id}" data-panel>`);
  assert.ok(at("p-trigger-runs") < at("p-trigger-gets") && at("p-trigger-gets") < at("p-trigger-run"));
  assert.ok(at("p-trigger-edit") < at("p-trigger-gets-how") && at("p-trigger-gets-how") < at("p-trigger-trust"));
  assert.ok(textOf(panelOf(page, "p-trigger-gets-how")).includes(W.noTool));
  assert.equal(W.noTool, "No tool reaches this action; dispatch_trigger_edit keeps today’s scope.");
  // Whoever has no form is not told to change it in place.
  const viewer = textOf(panelOf(await triggerGetsPage({ role: "viewer" }), "p-trigger-gets-how"));
  assert.ok(viewer.includes(W.viewer) && viewer.includes(W.noTool) && !viewer.includes("Change it in place"));
  const frozen = textOf(panelOf(await triggerGetsPage({ readOnly: true }), "p-trigger-gets-how"));
  assert.ok(frozen.includes(W.readOnly) && !frozen.includes("Change it in place"));
  assert.ok(textOf(panelOf(page, "p-trigger-gets-how")).includes("Change it in place"));
});

test("the page CSS is the exact published generator source, served on the trigger page and scoped there", () => {
  const generator = readFileSync(new URL("../../design/tools/gen_trigger_env.py", import.meta.url), "utf8");
  const css = /\nTRIGGER_GETS_CSS = """([\s\S]*?)"""/.exec(generator)?.[1];
  assert.equal(TRIGGER_GETS_CSS, css);
  assert.equal(TRIGGER_GETS_CSS_SHA256, createHash("sha256").update(css).digest("hex"));
  assert.ok(PAGE_CSS.trigger.endsWith(TRIGGER_GETS_CSS));
  assert.ok(PAGE_CSS.trigger.includes(".ld-st"), "a problem's line is the loaded card's own");
  assert.doesNotMatch(TRIGGER_GETS_CSS, /\.c2-/, "nothing of the sample pages' stylesheet: the console ships none of it");
});

test("the cards say what the write side says: their words are the planner's, Built, and nothing on them waits", async () => {
  const dir = tempDir("pd-800-gets-card-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: null, globalPiDir: join(dir, "overlay") };
  nodeFs.writeFileSync(paths.triggersPath, getsFile());
  nodeFs.writeFileSync(paths.settingsFile, "{}");
  nodeFs.mkdirSync(paths.globalPiDir);
  nodeFs.writeFileSync(join(paths.globalPiDir, "mcp.json"), JSON.stringify(GETS_MCP_JSON));
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", PI_MAX_COST_USD: "2", ...GETS_HOST_ENV }, now: () => NOW, deploymentDir: dir, readHostLoads: async () => getsHostLoads(), readSkew: async () => ({ rows: [{ jobId: "gh-c9e1", queue: "pi-jobs", field: "mcp" }], incomplete: false }) });
  const operator = { surface: "console", role: "operator", name: "ops" };
  const pageDigest = triggerEntryDigest(GETS_ENTRY);
  const card = cardText(cardPreview("TriggerEnvironmentChange"));
  const straight = (text) => text.replaceAll("’", "'").replace(/\s+/g, " ").replace(/ ([.,;:)])/g, "$1");
  const held = (line) => assert.ok(straight(card).includes(line), `the card says: ${line}`);
  const planned = await service.preview({ index: 2, pageDigest, mcp: ["linear"], excludeTools: ["bash"] }, operator);
  assert.ok(planned.summary.includes("The services reading this file use it from their next reload, for the jobs they queue after that."), "a line the card must carry");
  for (const line of planned.summary) held(line);
  held(planned.plan.undo);
  held(`Confirm: change ${planned.plan.row}`);
  const cost = await service.preview({ index: 2, pageDigest, model: "claude-opus-5-5" }, operator);
  held(cost.refusal);
  assert.ok(cost.refusal.includes("$2.654295 for a short task's first call"), cost.refusal);
  const excluded = await service.preview({ index: 2, pageDigest, mcp: ["linear"], excludeTools: ["codemode", "tool_search", "mcp__linear__*", "read_mcp_resource"] }, operator);
  held(excluded.refusal.split(" linear: ")[0]);
  assert.ok(excluded.refusal.startsWith("On every host"), excluded.refusal);
  assert.ok(W.lastWay.includes("The preview refuses that where the file alone decides it, and warns where this host’s overlay routes it so"), "the Tools row says how far the check it just ran holds");
  held(excluded.refusal.slice(excluded.refusal.indexOf("Remove the server from")).replaceAll("`", ""));
  // With no deployment's cap in the way, the thin cap previews and says so; and with no key passed, the server warns.
  const elsewhere = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5" }, now: () => NOW, deploymentDir: dir });
  const thin = await elsewhere.preview({ index: 2, pageDigest, model: "claude-opus-5-5", maxCostUsd: "2.62144" }, operator);
  assert.ok(thin.plan, JSON.stringify(thin));
  held(thin.summary.find((line) => line.includes("clears this $2.62144 job cap")));
  const unpassed = await elsewhere.preview({ index: 2, pageDigest, mcp: ["linear"] }, operator);
  const [warning, tail] = unpassed.plan.warnings;
  held(warning.split(" linear: ")[0]);
  held(warning.slice(warning.indexOf("`run.secrets` is set")).replaceAll("`", ""));
  held(straight(tail));
  assert.ok(straight(card).includes("This trigger changed since the page drew it"));
  const stale = await service.preview({ index: 2, pageDigest: "a".repeat(64), mcp: ["linear"] }, operator);
  assert.ok(stale.refusal.startsWith("This trigger changed since the page drew it"));
  // The card's rows say what the page says: each fixed sentence the panel draws is on the card, word for word.
  const page = straight(cardText(cardPreview("TriggerEnvironment")));
  for (const sentence of [W.fileSays, W.repositoryPart, W.extensionSwitch, W.newExtension, W.packagesOn, W.serverRefused, W.toolsOn, W.extensionToolChip, W.serverToolsLater, W.jobTool, W.elsewhere, W.noTool, W.flowPicker]) assert.ok(page.includes(straight(sentence)), sentence);
  // What each card is not to say.
  for (const name of ["TriggerEnvironment", "TriggerEnvironmentChange"]) {
    const words = `${cardText(cardPreview(name))} ${cardReadme(name)}`;
    assert.doesNotMatch(words, /\braise|\braising/i, `${name}: a trigger cannot, and the sentence says who can move it`);
    assert.doesNotMatch(cardText(cardPreview(name)), /(?:MCP|Tools|Job cap|Flow|Model|Provider)[^.]*→/, `${name}: a Confirm says it in words`);
    assert.ok(!/\$2\.62(?:144)?\b(?! job cap)/.test(words) || words.includes("clears this $2.62144 job cap"), `${name}: the amount is the planner's`);
    assert.ok(!words.includes("No run yet"), `${name}: a run that aged out was a run`);
    assert.match(cardPreview(name), /aria-label="Design status: Built"/, name);
    assert.ok(!words.includes("wait on a later pull request") && !words.includes("What waits"), `${name}: what the status said waits is built`);
    assert.ok(cardReadme(name).includes("`run.excludeExtensions`"), `${name}: the README names it`);
  }
  assert.ok(cardReadme("TriggerEnvironmentChange").includes("A digest of the trigger's entry as the page read it"), "of the entry");
  assert.ok(!cardReadme("TriggerEnvironmentChange").includes("digest of the file"));
  for (const false_ of ["The preview does not check", "$2.62144 for one call", "Adding run.mcp refuses", "New deliveries use this"]) assert.ok(!straight(cardText(cardPreview("TriggerEnvironmentChange"))).includes(false_), false_);
});

test("an agent's page does not point at a card it does not draw", async () => {
  const fs = fileOnlyFs(getsFile());
  const { readTriggers } = await import("../src/read-model.mjs");
  const snapshot = { readAt: NOW, triggers: readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs }), runs: [], waiting: { rows: [] } };
  const parsed = parsePageQuery("trigger", "index=2");
  const draw = async (role) => {
    const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role });
    return String((await renderPage("trigger", { query: parsed.query, session: { name: role, role }, data })).html);
  };
  assert.ok(!(await draw("agent")).includes("are in What its jobs get"));
  assert.ok((await draw("viewer")).includes("are in What its jobs get"));
});

test("a Confirm elsewhere on the page drops what the card holds, and the page says so before it happens", async () => {
  const page = await triggerGetsPage();
  assert.ok(textOf(panelOf(page, "p-trigger-edit")).includes(W.reloadDrops), "where the other Confirm is");
  assert.ok(textOf(panelOf(page, "p-trigger-gets").slice(panelOf(page, "p-trigger-gets").indexOf("data-gets-bar"))).includes(W.reloadDrops), "and in the bar, where the changes are");
  assert.ok(!textOf(panelOf(await triggerGetsPage({ role: "viewer" }), "p-trigger-gets")).includes(W.reloadDrops), "a viewer holds no change");
});

test("no field of the card takes a refusal: the bar says it, whichever row or word it names", async () => {
  const panel = panelOf(await triggerGetsPage(), "p-trigger-gets");
  assert.ok(!panel.includes("data-field-error"), "another row's refusal reads run.flow as well as this one's");
  assert.ok(!panel.includes("data-form-error"), "nor under the form, a line above the bar that says it");
});

test("with Valkey down, the real reader's page says what is unread: the file was read, and the card offers its form", async () => {
  const dir = tempDir("pd-800-gets-down-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), logsDir: join(dir, "logs"), globalPiDir: join(dir, "overlay"), valkeyUrl: "redis://127.0.0.1:1/0" };
  nodeFs.writeFileSync(paths.triggersPath, getsFile());
  nodeFs.writeFileSync(paths.settingsFile, "{}");
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths, fleet: { snapshot: async () => { throw new Error("connect ECONNREFUSED"); } }, hostLoads: async () => ({ unreachable: true, hosts: [] }), triggerEditor: () => ({}) }, { role: "operator" });
  const page = String((await renderPage("trigger", { query: parsed.query, session: { name: "ops", role: "operator" }, data })).html);
  assert.ok(!page.includes("could not be read.</p>") || !textOf(page).includes("The triggers file could not be read"), "the file was read");
  assert.ok(!textOf(page).includes("The triggers file could not be read"));
  assert.ok(!textOf(page).includes("This row does not exist"));
  assert.ok(panelOf(page, "p-trigger-gets").includes('name="pageDigest"'), "the form the file gave");
  assert.ok(textOf(panelOf(page, "p-trigger-change")).includes(W.othersUnread));
  assert.ok(textOf(panelOf(page, "p-trigger-runs")).includes(W.historyUnread), "and the history is unread, not empty");
  assert.ok(!textOf(panelOf(page, "p-trigger-runs")).includes("No runs were found"));
  assert.ok(textOf(panelOf(page, "p-trigger-on")).includes("comment"), "What starts it is the file's");
  // A file that truly cannot be read still says so.
  const gone = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { ...paths, triggersPath: join(dir, "nope.json") }, fleet: { snapshot: async () => { throw new Error("down"); } }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const gonePage = String((await renderPage("trigger", { query: parsed.query, session: { name: "ops", role: "operator" }, data: gone })).html);
  assert.ok(textOf(gonePage).includes("The triggers file could not be read"));
  assert.ok(!textOf(gonePage).includes(W.othersUnread), "and does not say it read it");
});

test("a flow doctor found nowhere is drawn with attention, for whoever reads the card, and the page holds no such note otherwise", async () => {
  const entry = { on: { type: "cron", pattern: "0 9 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "fix", task: "Run it." } };
  const answer = (tier, repo) => ({ flows: [{ trigger: 2, flow: "fix", tier, package: null, repo }] });
  const loads = (one) => ({ more: 0, hosts: HOST_LOADS.hosts.map((row) => (row.state === "current" ? { ...row, ...one } : row)) });
  const line = "As doctor last read it, a job on build3 and mini1 would not find fix: it is not at the repository’s HEAD, nor in any other tier this trigger loads from.";
  for (const role of ["operator", "viewer"]) {
    const panel = panelOf(await triggerGetsPage({ role, entry, records: [], loads: loads(answer("none", "absent")) }), "p-trigger-gets");
    const note = panel.indexOf('<p class="te-note tone-attention">');
    assert.ok(note >= 0 && textOf(panel.slice(note)).includes(line), role);
  }
  assert.ok(!textOf(panelOf(await triggerGetsPage({ entry, records: [], loads: loads(answer("overlay", "absent")) }), "p-trigger-gets")).includes("would not find"));
});

test("the flow picker says it is not the whole list where it is drawn, and what it leaves out is what its readers cannot list", async () => {
  const how = async (options) => textOf(panelOf(await triggerGetsPage(options), "p-trigger-gets-how"));
  assert.ok((await how({})).includes(`The flow picker is not the whole list. ${W.flowPicker}`));
  assert.ok(!(await how({ role: "viewer" })).includes(W.flowPicker), "a viewer has no picker");
  assert.ok(!(await how({ readOnly: true })).includes(W.flowPicker), "a read-only console has no picker");
  // The sentence holds while no tier the editor lists is a skills folder, and while the card asks nothing else. Each is real: the reader, not a list of its tiers.
  const absent = () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); };
  const listed = { skills: [{ name: "listed" }] };
  const editor = readTriggerEditor({ paths: { settingsFile: "/none/settings.json", triggersPath: "/none/triggers.json", globalPiDir: "/none/pi" }, env: {}, folder: "/srv/web", fs: { readFileSync: absent, existsSync: () => false, readdirSync: absent, statSync: absent }, folderSkillsFn: () => listed, overlaySkillsFn: () => listed, stagedSkillsFn: () => listed });
  assert.deepEqual(editor.flows.map((entry) => entry.tier), ["repository", "overlay", "packages"]);
  const names = triggerGetsOf({ trigger: { ...COMMENT, skillsDir: "/srv/skills" }, editor, liveHosts: [] }).flow.choices.map((entry) => entry.name);
  assert.deepEqual(names, ["fix", "listed"]);
});

/** A trigger's page for this role, over the real reader of a real file, as `loadPageData` hands each its own copy. */
async function fileShownTo(role, entry) {
  const file = getsFile(entry);
  const fs = fileOnlyFs(file);
  const { readTriggers } = await import("../src/read-model.mjs");
  const snapshot = { readAt: NOW, triggers: readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs }), runs: [], waiting: { rows: [] }, hostBudgets: [] };
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot }, hostLoads: async () => null, triggerEditor: () => ({ defaults: { backend: "docker", maxCostUsd: "no per-job dollar cap" } }) }, { role });
  const page = String((await renderPage("trigger", { query: parsed.query, session: { name: role, role }, data })).html);
  return { page, data, text: textOf(page).replace(/&lt;/g, "<").replace(/&gt;/g, ">") };
}
const FULL_ENTRY = Object.freeze({ on: { type: "comment", phrase: "@pi please" }, run: { kind: "gitlab", flow: "fix", provider: "anthropic", model: "claude-sonnet-5-5", maxCostUsd: "1.50", models: ["anthropic/claude-sonnet-5-5"], fallbackModels: ["anthropic/claude-haiku-4-5"], mcp: ["linear"], excludeTools: ["bash", "mcp__linear__*"], excludeExtensions: ["pi-secret-ext"], excludeExtensionTools: ["secret_tool"], packages: false, progress: true, statusComment: true, image: "registry.example/secret image:1", instructions: "Standing words of the operator.", secrets: { SOME_KEY: "op://vault/item" } } });

test("an agent's page has the rows no card draws for it, each as its read holds it, and claims nothing of what its read does not", async () => {
  const { page, text, data } = await fileShownTo("agent", FULL_ENTRY);
  const row = (key, value) => assert.ok(page.includes(`<dt>${key}</dt><dd>${value}</dd>`) || text.includes(`${key} ${value}`), `${key} ${value}`);
  // The card's fields, which the narrowed tables would otherwise leave nowhere on this page.
  row("run.flow", "fix");
  row("run.provider", "anthropic");
  row("run.model", "claude-sonnet-5-5");
  row("run.maxCostUsd", "1.50");
  row("run.models", '["anthropic/claude-sonnet-5-5"]');
  row("run.fallbackModels", '["anthropic/claude-haiku-4-5"]');
  // Set, and the names stay out: no server's name reaches an agent, and a tool pattern holds one. `[]` is what the read holds, and what the page said.
  row("run.mcp", "set, and its names are not in an agent’s read");
  row("run.excludeTools", "set, and its names are not in an agent’s read");
  row("run.packages", "false");
  row("run.excludeExtensions", "set, and its names are not in an agent’s read");
  row("run.excludeExtensionTools", "set, and its names are not in an agent’s read");
  // What the read withholds is said to be, and is not there. Each of these read as a fact of the file: "not set", "local" or a forge's rule.
  assert.deepEqual(["forge", "phrase", "progress", "secrets", "instructions", "image"].filter((key) => data.snapshot.triggers.triggers[2][key] !== undefined && data.snapshot.triggers.triggers[2][key] !== null), [], "the premise: the read holds none of them");
  for (const key of ["Forge", "Phrase or schedule", "Who may fire it", "run.kind", "run.progress", "run.secrets", "run.instructions", "run.image"]) row(key, "not in an agent’s read");
  assert.ok(text.includes("Whether it has instructions is not in an agent’s read."));
  for (const never of ["No instructions are set.", "This trigger has instructions.", "set (operator only)", "GitHub association", "The actor must be", "Hosts missing its required secret"]) assert.ok(!text.includes(never), never);
  assert.ok(text.includes("Write its phrase and a flow to choose another flow"));
  assert.doesNotMatch(text, /undefined/);
  for (const held of ["@pi please", "secret image", "Standing words", "SOME_KEY", "op://", "linear", "bash", "pi-secret-ext", "secret_tool"]) assert.ok(!text.includes(held) && !page.includes(`>${held}<`), held);
  assert.ok(!page.includes("mcp__linear"), "a server's name in a tool pattern is a server's name");
  // Whatever the deployment's defaults are, this read has none of them, so it says none of them.
  assert.ok(!text.includes("deployment default:"), "the editor's defaults are withheld whole");
  assert.ok(!text.includes("docker") && !text.includes("(deployment default)"), "nor which venue is the deployment's");
  assert.ok(text.includes("The deployment’s default venue is not in an agent’s read."));
  assert.ok(!text.includes("Secret profile:"), "the secret bundles are withheld whole, so what they would say is not said");
  // A venue the file itself names is the file's to say.
  const named = await fileShownTo("agent", { ...FULL_ENTRY, run: { ...FULL_ENTRY.run, backend: "local" } });
  assert.ok(named.text.includes("local (trigger override)") && !named.text.includes("default venue"));
  // A key the read does hold and the file does not set is not set, and a command it cannot read is not a flow of the deployment's.
  const bare = await fileShownTo("agent", { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "run-tests" } });
  assert.ok(bare.text.includes("run.image not set"));
  assert.ok(bare.text.includes("run.excludeTools not set"), "the display holds null for no list, so it is known not set");
  assert.ok(bare.text.includes("run.command not in an agent’s read"));
  assert.ok(bare.text.includes("→ not in an agent’s read") && !bare.text.includes("→ deployment default"));
  // A schedule's rule holds whatever its forge, so it is still said.
  const schedule = await fileShownTo("agent", { on: { type: "cron", pattern: "0 9 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "fix", task: "Run it." } });
  assert.ok(schedule.text.includes("Who may fire it This deployment's scheduler starts it"), "the facts");
  assert.ok(schedule.text.includes("deployment's scheduler starts it on its schedule; an operator may fire it by hand. Each forge delivery"), "the trust model");
  assert.ok(schedule.text.includes("The schedule's owning host runs a cron trigger's local folder"));
  const pull = await fileShownTo("agent", { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "fix" } });
  assert.ok(pull.text.includes('Phrase or schedule ["opened"]') || pull.page.includes("&quot;opened&quot;"));
});

test("a person's page keeps one editor for each key and says where the rows went, and with no card to point at it draws them", async () => {
  const { page, text } = await fileShownTo("viewer", FULL_ENTRY);
  assert.ok(text.includes("are in What its jobs get."));
  assert.ok(!page.includes("<dt>run.flow</dt>") && !text.includes("run.flow fix"), "the card has it");
  assert.ok(text.includes("Write @pi please <flow> to choose another flow"));
  assert.ok(text.includes("deployment default: "), "this view reads the defaults, so it says them");
  assert.ok(text.includes("docker") && text.includes("(deployment default)"));
  assert.ok(text.includes("Secret profile:"));
  assert.ok(!text.includes("not in an agent’s read"));
  for (const says of ["This trigger has instructions.", "Forge gitlab", "Who may fire it The actor must be a GitLab project member", "run.kind gitlab", "run.progress true", "Hosts missing its required secret"]) assert.ok(text.includes(says), says);
  // No card over a file the snapshot calls invalid, and the rows it would have drawn are not lost with it.
  const fs = fileOnlyFs(getsFile(FULL_ENTRY));
  const snapshot = { readAt: NOW, triggers: { invalid: "triggers file failed its check" }, runs: [], waiting: { rows: [] } };
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "viewer" });
  const invalid = textOf(String((await renderPage("trigger", { query: parsed.query, session: VIEWER_SESSION, data })).html));
  assert.ok(!invalid.includes("are in What its jobs get."), "no card, so nothing points at one");
  assert.ok(invalid.includes("run.flow"));
});

test("turning the staged packages on over a file's false is planned, takes the key away, and its Undo puts the file back", async () => {
  const entry = { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, packages: false } };
  const dir = tempDir("pd-800-gets-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: null, globalPiDir: join(dir, "overlay") };
  nodeFs.writeFileSync(paths.triggersPath, getsFile(entry));
  nodeFs.writeFileSync(paths.settingsFile, "{}");
  nodeFs.mkdirSync(paths.globalPiDir);
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", ...GETS_HOST_ENV }, now: () => NOW, deploymentDir: dir });
  const before = nodeFs.readFileSync(paths.triggersPath, "utf8");
  const w = runConsoleScript(CONSOLE_SCRIPT, await triggerGetsPage({ entry }));
  const form = w.document.querySelector('form[data-action="trigger-environment-edit"]');
  const packages = form.querySelector('[data-gets-flag="packages"]');
  assert.equal(packages.checked, false, "the file says false");
  packages.checked = true;
  packages.dispatchEvent(new Event("change", { bubbles: true }));
  w.submit(form);
  const body = w.fetch.calls.at(-1).body;
  assert.equal(body.packages, null);
  const operator = { surface: "console", role: "operator", name: "ops" };
  const planned = await service.preview(body, operator);
  assert.ok(planned.plan, JSON.stringify(planned));
  assert.deepEqual(planned.plan.changes.map((change) => change.key), ["packages"]);
  assert.deepEqual(await service.apply(planned, operator), { ok: true });
  assert.equal(Object.hasOwn(JSON.parse(nodeFs.readFileSync(paths.triggersPath, "utf8")).triggers[2].run, "packages"), false, "the key is gone, not written true");
  const undone = await service.preview(planned.plan.inverse.body, operator);
  assert.deepEqual(await service.apply(undone, operator), { ok: true });
  assert.equal(nodeFs.readFileSync(paths.triggersPath, "utf8"), before, "byte for byte");
});

test("a page with no live host reads the pills of what published, and says no host is the only one", async () => {
  const entry = GETS_ENTRY;
  const one = { more: 0, hosts: [{ ...HOST_LOADS.hosts.find((row) => row.state === "current"), image: null, piVersion: null, flows: [] }] };
  const panel = textOf(panelOf(await triggerGetsPage({ entry, live: [], loads: one, records: [] }), "p-trigger-gets"));
  assert.ok(!panel.includes("the only host"), panel.slice(0, 300));
  assert.ok(panel.includes("the only one known"), panel.slice(0, 300));
  assert.ok(panel.includes("No live host is listed just now, so these are the hosts that last published, running or not."));
});

test("a page that cannot match runs to a row says nothing of its runs, while the run and the queue read fine", async () => {
  const run = { ...S.everything(), jobId: "gh-aaa1" };
  const draw = async (triggers, { snapshot = { readAt: NOW, triggers, runs: [run], waiting: { rows: [] }, hostBudgets: [] }, role = "operator", fs = fileOnlyFs("") } = {}) => {
    const parsed = parsePageQuery("trigger", "index=2");
    const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role });
    return String((await renderPage("trigger", { query: parsed.query, session: { name: role, role }, data })).html);
  };
  const dir = tempDir("pd-800-runs-");
  const failed = join(dir, "triggers.json");
  nodeFs.mkdirSync(failed);
  const { readTriggers } = await import("../src/read-model.mjs");
  const unreadable = readTriggers({ triggersPath: failed });
  assert.deepEqual(unreadable, { unreadable: "EISDIR" });
  for (const [what, triggers] of [["a failed read", unreadable], ["no file", readTriggers({ triggersPath: join(dir, "absent.json") })]]) {
    for (const role of ["operator", "agent"]) {
      const page = textOf(await draw(triggers, { role, fs: { readFileSync: () => { throw Object.assign(new Error("x"), { code: "EISDIR" }); } } }));
      for (const never of ["No runs were found", "the queue could not be read", "Jobs in line now", "runs in the last 24 hours"]) assert.ok(!page.includes(never), `${what}, ${role}: ${never}`);
    }
  }
  // A file that does not load still gives the page its row, and the runs cannot be matched to it.
  const invalid = textOf(panelOf(await draw({ invalid: "triggers file failed its check" }, { fs: fileOnlyFs(getsFile()) }), "p-trigger-runs"));
  assert.ok(invalid.includes("This page could not match runs to this row, so it says nothing of them."), invalid);
  for (const never of ["No runs were found", "the queue could not be read", "runs in the last 24 hours"]) assert.ok(!invalid.includes(never), never);
  // The file read: the same run is its row's, no run is what it says where none is, and the queue is what the queue is.
  const read = readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs: fileOnlyFs(getsFile()) });
  const fine = textOf(panelOf(await draw(read, { fs: fileOnlyFs(getsFile()) }), "p-trigger-runs"));
  assert.ok(fine.includes("gh-aaa1"), fine);
  assert.ok(fine.includes("none in view"), fine);
  const noRuns = textOf(panelOf(await draw(read, { fs: fileOnlyFs(getsFile()), snapshot: { readAt: NOW, triggers: read, runs: [], waiting: { rows: [] }, hostBudgets: [] } }), "p-trigger-runs"));
  assert.ok(noRuns.includes("No runs were found in the available history."), noRuns);
  const queueDown = textOf(panelOf(await draw(read, { fs: fileOnlyFs(getsFile()), snapshot: { readAt: NOW, triggers: read, runs: [], waiting: { unreachable: "down" }, hostBudgets: [] } }), "p-trigger-runs"));
  assert.ok(queueDown.includes("the queue could not be read"), "the sentence stands where it is so");
});

test("a bad row reads the same on the page and to the action, first, middle and last, and the lists link past it by the file's own index", async () => {
  const { readTriggers } = await import("../src/read-model.mjs");
  const { planTriggerEdit, planTriggerDelete } = await import("../src/write-plans.mjs");
  const good = (flow) => ({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow } });
  const drawn = (name, query, list) => {
    const fs = fileOnlyFs(JSON.stringify({ triggers: list }));
    const triggers = readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs });
    const snapshot = { readAt: NOW, triggers, runs: [], waiting: { rows: [] }, hostBudgets: [], schedulers: [], parked: { rows: [] } };
    const parsed = parsePageQuery(name, query);
    return { fs, draw: async (role = "operator") => {
      const data = await loadPageData(name, parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot, parkedCount: async () => 0 }, hostLoads: async () => null, triggerEditor: () => ({}), triggerFireCheck: async () => ({ refusal: "no" }) }, { role, readOnly: false });
      return String((await renderPage(name, { query: parsed.query, session: { name: role, role }, data })).html);
    } };
  };
  const BAD = "The file’s entry at this row is not a usable trigger, so this page has nothing to show or change. Return to Configuration.";
  for (const [what, list, index] of [["first", [null, good("next"), good("last")], 0], ["middle", [good("first"), null, good("last")], 1], ["last", [good("first"), good("next"), null], 2]]) {
    const { fs, draw } = drawn("trigger", `index=${index}`, list);
    for (const role of ["operator", "viewer", "agent"]) {
      const page = await draw(role);
      const text = textOf(page);
      assert.ok(text.includes(BAD), `${what}, ${role}: ${text.slice(0, 200)}`);
      assert.ok(text.includes("Trigger unavailable"), `${what}, ${role}: the title names no other row's flow`);
      for (const never of ["This row does not exist", `→ next`, `→ last`, `→ first`, "Delete row", "The triggers file loads.", "Edit here"]) assert.ok(!text.includes(never), `${what}, ${role}: ${never}`);
    }
    // The action says the same of the same row, for an edit and a delete.
    const edit = planTriggerEdit({ params: { index, flow: "x" }, paths: { triggersPath: TRIGGER_GETS_PATH }, env: {}, surface: "console", fs });
    assert.match(edit.refusal, /is not one this can change: the file's entry there is not a usable trigger/, what);
    assert.match(planTriggerDelete({ index, paths: { triggersPath: TRIGGER_GETS_PATH }, surface: "console", fs }).refusal, /is not one this can change/, what);
  }
  // A row past the end is another thing, and the page says that one.
  const past = textOf(await drawn("trigger", "index=7", [good("first")]).draw());
  assert.ok(past.includes("This row does not exist. Return to Configuration.") && !past.includes(BAD), past.slice(0, 200));
  // A good row beside a bad one is still itself, with its own Delete.
  const beside = textOf(await drawn("trigger", "index=1", [null, good("next")]).draw());
  assert.ok(beside.includes("→ next") && beside.includes("row 2") && beside.includes("Delete row 2"), beside.slice(0, 200));
  // The lists link by the file's index: nothing points at the bad row, and each good row at its own.
  for (const name of ["triggers", "config"]) {
    const page = await drawn(name, "", [null, good("next"), good("last")]).draw();
    const links = [...new Set([...page.matchAll(/\/config\/trigger\?index=(\d+)/g)].map((m) => Number(m[1])))].sort();
    assert.deepEqual(links, [1, 2], name);
  }
});
