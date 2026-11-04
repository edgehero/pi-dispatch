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
import { wordsText } from "../src/loaded-words.mjs";
import { CARD_FIELDS, triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { TRIGGER_GETS_WORDS as W, readTriggerGetsEntry, triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { cardPreview, cardReadme, cardText } from "./helpers/card-structure.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { LOADED_SAMPLES as S } from "./helpers/loaded-samples.mjs";
import { Event, runConsoleScript } from "./helpers/script-dom.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { GETS_ENTRY, GETS_HOST_ENV, GETS_MCP_JSON, TRIGGER_GETS_PATH, fileOnlyFs, getsFile, getsHostLoads, triggerGetsPage } from "./helpers/trigger-gets-goldens.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const HOUR = 3_600_000;
const COMMENT = Object.freeze({ index: 2, type: "comment", flow: "fix", packages: true, forge: "github" });
const lineOf = (parts) => wordsText(parts);
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
  // Two hosts that define one server two ways do not get one sentence.
  const differ = await published({ a: { mcp: [linear] }, b: { mcp: [{ ...linear, where: "other.example" }] } });
  assert.equal(triggerGetsOf({ trigger: COMMENT, hostLoads: differ, liveHosts: ["a", "b"] }).mcp.items.find((item) => item.name === "linear").sub, "defined differently by host");
  const nothing = triggerGetsOf({ trigger: { ...COMMENT, forge: null }, hostLoads: await published({ a: {} }), liveHosts: ["a"] });
  assert.equal(nothing.mcp.none, true);
});

test("tools: pi's own and a named server's are chips, an extension's are shown, and an entry nothing offers still stays on the list", async () => {
  const page = panelOf(await triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, mcp: ["linear"], excludeTools: ["bash", "mcp__linear__*", "codemode"] } } }), "p-trigger-gets");
  for (const name of ["read", "bash", "edit", "write", "powershell", "grep", "find", "ls", "codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "mcp__linear__*"]) assert.ok(page.includes(`data-gets-list="excludeTools" data-gets-value="${name}" data-gets-inverse`), name);
  assert.match(page, /<input type="checkbox" data-gets-list="excludeTools" data-gets-value="bash"/, "removed reads unticked");
  assert.match(page, /<input type="checkbox" checked data-gets-list="excludeTools" data-gets-value="read"/);
  assert.ok(textOf(page).includes(W.lastWay), "the rule, and how far the preview holds it");
  assert.ok(textOf(page).includes("all of linear’s tools"));
  // No extension tool is a control: it is named from the record, and removing one comes later.
  assert.ok(textOf(page).includes("lint_file"));
  assert.ok(textOf(page).includes("From pi-lint, as gh-9575 loaded it on mini1"), "and it says whose it is");
  assert.ok(!page.includes('data-gets-value="lint_file"'));
  assert.ok(page.includes('<span class="te-chip te-chip--ro">lint_file</span>'));
  assert.ok(textOf(page).includes(W.extensionTools));
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

test("extensions: each is shown and not switched, says where it is, and what is read from a record says whose it is", async () => {
  const panel = panelOf(await triggerGetsPage(), "p-trigger-gets");
  assert.ok(!panel.includes('data-gets-value="pi-lint"') && !panel.includes('data-gets-list="excludeExtensions"'), "no switch per extension");
  assert.ok(textOf(panel).includes(W.oneExtension), "and it says so, with no date");
  assert.doesNotMatch(W.oneExtension, /soon|next|release|pull request/i);
  const text = textOf(panel);
  assert.ok(text.includes("pi-lint 1.4.2 staged on build3 and mini1, unknown on mini2 · 2 tools, 1 prompt template, as gh-9575 loaded it"), text.slice(0, 2000));
  assert.ok(text.includes("git-guard in the overlay on build3, not on mini1, unknown on mini2"));
  assert.ok(text.includes("The repository’s own"));
  // Off, the file's own words, and nothing of a record claims these jobs load them.
  const off = textOf(panelOf(await triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, packages: false } } }), "p-trigger-gets"));
  assert.ok(off.includes(W.packagesOff));
  assert.ok(!off.includes("as gh-9575 loaded it · ") && !off.includes("0.9.0 staged on build3 and mini1, unknown on mini2 · 3 tools"), off.slice(0, 1800));
  // A viewer has no switch, so no sentence about what off writes.
  const seen = textOf(panelOf(await triggerGetsPage({ role: "viewer" }), "p-trigger-gets"));
  assert.ok(seen.includes(W.packagesLoad) && !seen.includes(W.packagesOn));
});

test("the flow row says each host's answer, reads no answer from a doctor run about another flow, and a command is no flow", async () => {
  const flow = (tier, name = "fix", pkg = null) => ({ flows: [{ trigger: 2, flow: name, tier, package: pkg, repo: "unknown" }] });
  const view = (hosts, trigger = COMMENT) => published(hosts).then((loads) => triggerGetsOf({ trigger, hostLoads: loads, liveHosts: Object.keys(hosts) }).flow);
  assert.equal((await view({ a: flow("overlay"), b: flow("package", "fix", "pi-test-runner"), c: flow("none"), d: flow("repository"), e: flow("trigger"), f: flow("unknown") })).doctor, "a finds fix from the overlay; b finds fix from pi-test-runner; c finds fix in no tier; d finds fix from the repository; e finds fix from its skills folder; f finds fix in no tier a host can see.");
  assert.equal((await view({ a: flow("overlay", "other"), b: null })).doctor, "a has no answer for it yet; b has no answer to read.");
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

test("the cards say what the write side says: their words are the planner's, Built, and they name what waits", async () => {
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
  for (const sentence of [W.fileSays, W.repositoryPart, W.oneExtension, W.newExtension, W.packagesOn, W.serverRefused, W.toolsOn, W.extensionTools, W.serverToolsLater, W.jobTool, W.elsewhere, W.noTool]) assert.ok(page.includes(straight(sentence)), sentence);
  // What each card is not to say.
  for (const name of ["TriggerEnvironment", "TriggerEnvironmentChange"]) {
    const words = `${cardText(cardPreview(name))} ${cardReadme(name)}`;
    assert.doesNotMatch(words, /\braise|\braising/i, `${name}: a trigger cannot, and the sentence says who can move it`);
    assert.doesNotMatch(cardText(cardPreview(name)), /(?:MCP|Tools|Job cap|Flow|Model|Provider)[^.]*→/, `${name}: a Confirm says it in words`);
    assert.ok(!/\$2\.62(?:144)?\b(?! job cap)/.test(words) || words.includes("clears this $2.62144 job cap"), `${name}: the amount is the planner's`);
    assert.ok(!words.includes("No run yet"), `${name}: a run that aged out was a run`);
    assert.match(cardPreview(name), /aria-label="Design status: Built"/, name);
    assert.ok(cardPreview(name).includes("wait on a later pull request"), `${name}: the status names what waits`);
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
