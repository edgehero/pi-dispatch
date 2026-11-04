import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildHostLoads, hostLoadsKey } from "@edgehero/pi-dispatch/host-loads";
import { FIRST_CALL_MIN_CONTEXT_BYTES, FIRST_CALL_SHORT_TASK_BYTES, builtinModel, firstCallBoundMicros, firstCallFloorMicros } from "@edgehero/pi-dispatch/model-catalog";
import { effectiveCostCapMicros, formatMicros } from "@edgehero/pi-dispatch/money";
import { ACTIONS } from "../src/console/actions.mjs";
import { AUDIT_ACTOR_ROLES } from "../src/console/audit-view.mjs";
import { auditFilter } from "../src/console/panels/audit.mjs";
import { EDIT_FIELDS } from "../src/console/panels/trigger.mjs";
import { PAGES, loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { readTriggers } from "../src/read-model.mjs";
import { CARD_FIELDS, triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { TRIGGER_GETS_WORDS as W, triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { ERROR_KINDS, errorPage } from "../src/console/error-pages.mjs";
import { ENDED_REASONS, endedNotices } from "../src/console/session-ends.mjs";
import { LOADED_MAX_OVERLAY_NAMES, LOADED_MAX_PACKAGES } from "../../worker/src/loaded-record.mjs";
import { HOSTS_OFFERED, LOADED_STATES, loadedVerdict, outcomeNote, runningVerdict } from "../src/loaded-words.mjs";
import { RUN_FILTER_FIELDS, RUN_OUTCOME_VALUES } from "../src/run-filter.mjs";
import { planTriggerAdd, planTriggerEdit, TRIGGER_ADD_FIELDS } from "../src/write-plans.mjs";
import { HOST_LOADS, LOADED_SAMPLES as S, loadedField, loadedRecord, source } from "./helpers/loaded-samples.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { TRIGGER_GETS_PATH, fileOnlyFs, getsFile, triggerGetsPage } from "./helpers/trigger-gets-goldens.mjs";

/**
 * The console's hand-written lists in the docs and the specs, each held to the code it restates (AGENTS.md: a table
 * that restates a derivable source is derived or pinned, never trusted). Each is read as the file has it, so a row
 * added, dropped or reworded on one side fails here until the other says the same.
 */

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** The text with every run of whitespace one space: a sentence the file wraps over lines reads as one. */
const flat = (text) => text.replace(/\s+/g, " ");

/** The rows of the Markdown table whose header line is `header`: each row's cells, trimmed, until the table ends. */
function tableRows(text, header) {
  const lines = text.split("\n");
  const at = lines.indexOf(header);
  assert.ok(at >= 0, `the file has the table ${header}`);
  assert.match(lines[at + 1], /^\|(?:---\|)+$/, `${header} is followed by its rule line`);
  const rows = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows;
}

test("docs/console.md's table of why a session ended: every ENDED_REASONS member once, in order, with the sign-in page's own title", () => {
  const rows = tableRows(read("docs/console.md"), "| `ended` | What ended it | The sign-in page says |");
  assert.deepEqual(rows.map(([code]) => code), ENDED_REASONS.map((r) => `\`${r}\``));
  // The page's words for the console's own limits as a console started with no settings has them (60 minutes, 12 hours),
  // which is what the table quotes; it may add the notice's sentence after the title, in brackets.
  const notices = endedNotices();
  for (const [code, , says] of rows) {
    const reason = code.slice(1, -1);
    assert.ok(says === notices[reason].title || says.startsWith(`${notices[reason].title} (`), `${reason}: the table says ${JSON.stringify(says)}, the page ${JSON.stringify(notices[reason].title)}`);
  }
});

test("docs/console.md's table of error pages: one row per ERROR_KINDS member, by the status the server answers it with", () => {
  const rows = tableRows(read("docs/console.md"), "| Status | When | What it offers |");
  const statuses = (list) => [...list].sort((a, b) => a - b);
  assert.deepEqual(statuses(rows.map(([status]) => Number(status))), statuses(ERROR_KINDS.map((kind) => errorPage({ kind }).status)));
});

test("docs/console.md's table of runs filters: one row per RUN_FILTER_FIELDS member, in order, the outcome row naming RUN_OUTCOME_VALUES", () => {
  const rows = tableRows(read("docs/console.md"), "| Filter | Matches the run's |");
  assert.deepEqual(rows.map(([field]) => field), RUN_FILTER_FIELDS.map((f) => `\`${f}\``));
  // The outcome row names every value the filter takes, in the code's order, and no other: its code spans are the list.
  const [, outcome] = rows.find(([field]) => field === "`outcome`");
  assert.deepEqual([...outcome.matchAll(/`([^`]+)`/g)].map((m) => m[1]), [...RUN_OUTCOME_VALUES]);
});

test("docs/console.md's audit role list is AUDIT_ACTOR_ROLES, in order, none shown in the filter's own words (issue #808)", () => {
  // Read between the sentence's own fixed words, so a role named elsewhere in the paragraph is not taken for a member.
  const text = flat(read("docs/console.md"));
  const start = "The role list holds the roles a row is written with, ";
  const a = text.indexOf(start);
  assert.ok(a >= 0, `docs/console.md says ${JSON.stringify(start)}`);
  const list = text.slice(a + start.length, text.indexOf(":", a + start.length));
  assert.deepEqual([...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]), [...AUDIT_ACTOR_ROLES]);
  const filter = String(auditFilter({ role: "operator", query: {}, data: {} }));
  assert.ok(filter.includes('<option value="none">Role: none (no session)</option>') && text.includes('`none`, shown as "Role: none (no session)"'), "the docs quote the option the filter draws");
});

test("the requirements' list of destructive actions is exactly the actions whose write rules set danger", () => {
  const said = /`danger` is true for the destructive actions \(([^)]*)\)/.exec(flat(read("specs/requirements.md")));
  assert.ok(said, "the requirement names the destructive actions");
  const named = [...said[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
  assert.equal(new Set(named).size, named.length, "each named once");
  assert.deepEqual([...named].sort(), ACTIONS.filter((a) => a.danger).map((a) => a.name).sort());
});

test("docs/triggers.md's example refusal for a pull_request trigger is the trigger add's own sentence, its field list TRIGGER_ADD_FIELDS.pull_request", () => {
  const said = /for example: "(dispatch_trigger_add does not take repository for a pull_request trigger; it takes ([^"]*)\. Nothing was changed)"/.exec(flat(read("docs/triggers.md")));
  assert.ok(said, "the doc quotes the refusal");
  assert.deepEqual(said[2].split(", "), [...TRIGGER_ADD_FIELDS.pull_request]);
  const planned = planTriggerAdd({ params: { kind: "pull_request", repository: "acme/web", flow: "review" }, paths: { triggersPath: "/deploy/triggers.json" }, env: {} });
  assert.equal(planned.refusal, said[1]);
});

test("docs/console.md's table of the screens: a row for every page's route, and no row for a route that is not one", () => {
  const rows = tableRows(read("docs/console.md"), "| Page | What it shows |");
  const routed = new Map(rows.map(([route, says]) => [/^`([^`?]+)/.exec(route)?.[1], says]));
  const paths = Object.values(PAGES).map((page) => page.path);
  // Spend's four other views share its row, which names each, since they are tabs of one page.
  const insights = routed.get("/insights");
  for (const path of paths) {
    assert.ok(routed.has(path) || (path.startsWith("/insights/") && insights.includes(path)), `${path} has a row`);
  }
  for (const route of routed.keys()) assert.ok(paths.includes(route), `${route} is a page`);
});

test("docs/console.md's table of the Loaded card's top lines: one row per LOADED_STATES member, in order, each saying what to do", () => {
  const rows = tableRows(read("docs/console.md"), "| State | The top line says | What to do |");
  assert.deepEqual(rows.map(([state]) => state), LOADED_STATES.map((state) => `\`${state}\``));
  for (const [state, says, todo] of rows) {
    assert.ok(says.length > 0 && todo.length > 0, `${state} says what it means and what to do`);
  }
});

test("each row of that table says what to do on the page its line's own buttons open, and none says the log keeps pi's error", () => {
  const rows = new Map(tableRows(read("docs/console.md"), "| State | The top line says | What to do |").map(([state, says, todo]) => [state.replaceAll("`", ""), { says, todo }]));
  // A kind of way to a fix, as a row must name it: the code's word, because a row that sends a person elsewhere is the defect this holds.
  const WORD = { trigger: /[Tt]rigger/, repository: /base commit/, connections: /Connections/, updates: /Updates/, host: /host/ };
  const overlay = loadedRecord({ host: "mini2", loaded: loadedField({ sources: [source("overlay", { failed: 1, failedNames: ["b.js"] }), source("repository"), source("trigger"), source("other")], problems: { failed: 1, dropped: 0, mcp: 0 } }) });
  const skillsFolder = loadedRecord({ loaded: loadedField({ sources: [source("overlay"), source("repository"), source("trigger", { failed: 1 }), source("other")], problems: { failed: 1, dropped: 0, mcp: 0 } }) });
  const samples = { "host-differs": [S.hostDiffers()], "no-flow": [S.noFlow()], "extension-failed": [S.extensionFailed(), S.twoTiers(), overlay, skillsFolder], "mcp-stopped": [S.mcpTimeout()], "mcp-failed": [S.mcpFailed()] };
  for (const [state, records] of Object.entries(samples)) {
    for (const record of records) {
      const verdict = loadedVerdict(record, HOST_LOADS);
      assert.equal(verdict.state, state, record.jobId);
      assert.ok(verdict.fixes.length > 0, `${state}: this sample offers a way to a fix`);
      for (const fix of verdict.fixes) assert.match(rows.get(state).todo, WORD[fix.kind], `${state}: its line opens ${fix.label}, and its row does not say so`);
    }
  }
  // A running job's line opens its trigger, and has no record to sample.
  assert.match(rows.get("running").todo, WORD[runningVerdict(2).fixes[0].kind]);
  // A state with nothing to fix tells nobody to open a page.
  for (const state of ["everything", "no-agent", "cut"]) assert.equal(loadedVerdict(S[{ everything: "everything", "no-agent": "noAgent", cut: "noRoom" }[state]]()).fixes.length, 0, state);
  // The runner logs a path and a kind and never pi's error text (`reportExtensionLoadErrors`), so the row may mention that text only to say it is not there.
  const failed = rows.get("extension-failed");
  assert.doesNotMatch(`${failed.says} ${failed.todo}`.replace("pi's error text is not", ""), /error/i);
  assert.match(failed.says, /`load`, `conflict` or `manifest-dir`/);
  assert.match(failed.says, /`overlay_extensions_withheld` with the reason `ignore-matcher-unavailable` and a `root`/, "the failure that logs neither a path nor a kind");
  // A difference's fix is on the host behind, so the row says the line offers it, and how many, wherever a person reads that.
  const offered = `up to ${HOSTS_OFFERED} of the hosts that lack it`;
  assert.ok(rows.get("host-differs").todo.includes(offered), offered);
  assert.ok(read("specs/requirements.md").includes(offered), "the requirement");
  assert.ok(read("design/system/components/LoadedStates/README.md").includes(offered), "the card");
  assert.deepEqual(loadedVerdict(S.hostDiffers(), HOST_LOADS).fixes.map((fix) => fix.label), ["Open build3", "Open mini1"]);
  // A scheduled run's way to its fix, which is not the trigger's page.
  assert.match(rows.get("no-flow").todo, /a scheduled run keeps no row, so its button opens the Triggers list, under its id/);
  assert.match(loadedVerdict({ ...S.noFlow(), jobId: "repeat:nightly:1", kind: "local", target: "local:site", triggerIndex: null }).fixes[0].href, /^\/triggers\?/);
  // Words a state's sentences lean on that the code holds.
  assert.match(rows.get("mcp-stopped").says, /only where the queue holds the job again or the record is a later attempt/);
  assert.match(rows.get("stopped").says, /after loading with no answered turn/);
  assert.match(rows.get("stopped").says, /A run that completed, counts a turn a provider answered, or holds metered calls on a failure whose line has no count of turns never reads as this/);
  assert.match(rows.get("stopped").says, /A stopped run that shows a turn or a call, or reads `runner-policy` with its list at `session`, says only that it stopped after loading/);
  assert.match(rows.get("stopped").todo, /`runner-policy`, what can stop a run this way/);
  assert.match(rows.get("extension-failed").says, /failed to load or was held back, and the job's log says which/);
  assert.ok(read("docs/console.md").includes(`A list past its cap (${LOADED_MAX_PACKAGES} packages, ${LOADED_MAX_OVERLAY_NAMES} overlay names)`), "the caps the card's comparison leans on");
  assert.equal(loadedVerdict({ ...S.stoppedAfterLoading() }).state, "stopped", "what it says of a real refusal's record");
  assert.equal(loadedVerdict({ ...S.stoppedAfterLoading(), turns: 3 }).state, "everything");
});

// The console's other sentences are left to the card (the docs point there, and a test here would only freeze them). These
// two words are the ones a person searches for after reading a row, so each file that quotes one quotes what the code says.
test("the docs and the requirements quote a run that lacked something in outcomeNote's own words", () => {
  const noFlow = outcomeNote(S.noFlow());
  const failed = outcomeNote(S.extensionFailed());
  assert.ok(noFlow && failed, "the samples are runs that lacked something, or this proves nothing");
  for (const path of ["docs/console.md", "docs/reasons.md", "specs/requirements.md"]) {
    const text = flat(read(path)).replaceAll("**", "");
    assert.ok(text.includes(noFlow), `${path} says ${noFlow}`);
    assert.ok(text.includes(failed), `${path} says ${failed}`);
  }
});

// ---- what a trigger's jobs get ------------------------------------------------------------------------------------------

/** A code span's text, each in the order the cell has them. */
const spans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/** A page's words as a person reads them. The docs quote with a plain apostrophe, and the card's own words use a curly one. */
const textOf = (html) => String(html).replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("’", "'").replace(/\s+/g, " ");
const straight = (text) => text.replaceAll("’", "'");
const panelOf = (page, id) => {
  const at = page.indexOf(`<section id="${id}"`);
  return at < 0 ? "" : page.slice(at, page.indexOf("</section>", at));
};

const PLANNER_NOW = Date.parse("2026-11-04T12:00:00Z");
const operator = Object.freeze({ surface: "console", role: "operator", name: "ops" });
const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const FILE_MCP = Object.freeze({ mcpServers: { linear: { url: "https://mcp.example.com/mcp", description: "Linear", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } }, docs: { url: "https://docs.example.com/mcp", description: "Docs" } } });
const CRON = Object.freeze({ on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder: "/nowhere", flow: "tidy", task: "T" } });
const COMMENT_ON = Object.freeze({ type: "comment", phrase: "@pi" });

/** The real planner over a real triggers file and overlay, with the entry at row 2. `failing` makes a read of one file name fail as a disk would. */
function plannerWorld({ run = {}, doc = null, text = null, settings = "{}", env = {}, overlay = null, failing = null, failingCode = "EIO", projects = null, deps = {} } = {}) {
  const dir = tempDir("pd-800-docs-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: projects === null ? null : join(dir, "projects.json"), globalPiDir: join(dir, "overlay") };
  nodeFs.writeFileSync(paths.triggersPath, text ?? `${JSON.stringify(doc ?? { triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix", ...run } }] }, null, 2)}\n`);
  nodeFs.writeFileSync(paths.settingsFile, settings);
  if (projects !== null) nodeFs.writeFileSync(paths.projectsFile, projects);
  nodeFs.mkdirSync(paths.globalPiDir);
  nodeFs.writeFileSync(join(paths.globalPiDir, "mcp.json"), JSON.stringify(FILE_MCP));
  if (overlay !== null) nodeFs.writeFileSync(join(paths.globalPiDir, "models.json"), JSON.stringify(overlay));
  const fs = failing === null ? nodeFs : { ...nodeFs, readFileSync: (path, ...rest) => { if (String(path).endsWith(failing)) throw Object.assign(new Error("busy"), { code: failingCode }); return nodeFs.readFileSync(path, ...rest); } };
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-haiku-4-5", PI_EGRESS: "0", PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "a value", ...env }, fs, now: () => PLANNER_NOW, deploymentDir: dir, ...deps });
  const digest = () => triggerEntryDigest(JSON.parse(nodeFs.readFileSync(paths.triggersPath, "utf8")).triggers[1]);
  const preview = (change, over = {}) => service.preview({ index: 1, pageDigest: over.pageDigest ?? digest(), ...change, ...over }, operator);
  return { paths, service, preview, digest };
}
/** A file that reads for the planner's first look and stops reading at the trigger edit's own: the file moving during one preview. */
function readsThenFails(later) {
  const w = plannerWorld();
  const pageDigest = w.digest();
  let reads = 0;
  const fs = { ...nodeFs, readFileSync: (path, ...rest) => (String(path).endsWith("triggers.json") && ++reads > 3 ? later() : nodeFs.readFileSync(path, ...rest)) };
  return createTriggerEnvironmentActions({ paths: w.paths, env: {}, fs, now: () => PLANNER_NOW }).preview({ index: 1, pageDigest, flow: "review" }, operator);
}
const LOCAL_MODEL = Object.freeze({ providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "local", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 100, contextWindow: 1000 }] } } });
const MODEL_RUN = Object.freeze({ provider: "anthropic", model: "claude-haiku-4-5" });

/**
 * What the table of refusals quotes, by the words it quotes, each met through the real planner. A body only this page's form could send:
 * what a page cannot send (a list that is not a list, a blank where the form sends null) refuses too, and that is the planner's test.
 */
const REFUSALS = Object.freeze({
  "This trigger changed since the page drew it": () => plannerWorld().preview({ packages: false }, { pageDigest: "a".repeat(64) }),
  "There is no usable trigger at row": () => plannerWorld().preview({ packages: false }, { index: 9 }),
  "The triggers file could not be read": () => { const w = plannerWorld(); const pageDigest = w.digest(); nodeFs.writeFileSync(w.paths.triggersPath, "{ not json"); return w.preview({ packages: false }, { pageDigest }); },
  "the triggers file could not be read (": () => readsThenFails(() => { throw Object.assign(new Error("busy"), { code: "EIO" }); }),
  "the triggers file does not load (": () => readsThenFails(() => "{ not json"),
  "nothing was written and nothing in it was lost; change it with that release": () => { const w = plannerWorld({ doc: { version: 999, triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix" } }] } }); return w.preview({ packages: false }); },
  "A trigger's flow cannot be removed": () => plannerWorld().preview({ flow: null }),
  "trigger row": () => plannerWorld().preview({ provider: "No Spaces Allowed" }),
  "rejected:": () => plannerWorld().preview({ models: ["nope"] }),
  "A trigger's job cap can only lower the deployment's": () => plannerWorld({ settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ maxCostUsd: "7" }),
  "needs at least": () => plannerWorld({ run: MODEL_RUN, settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ model: "claude-opus-5-5", maxCostUsd: "2" }),
  "could not be resolved": () => plannerWorld({ doc: { modelRoles: { default: { cheap: HAIKU } }, triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix", model: "role:cheap" } }] } }).preview({ model: "role:nobody" }),
  "has no verified local cost bound": () => plannerWorld({ settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ provider: "radius", model: "balanced" }),
  "travels as max_completion_tokens": () => plannerWorld({ overlay: LOCAL_MODEL, settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ provider: "ollama", model: "local" }),
  "On every host this trigger's jobs would be refused as mcp-excluded": () => plannerWorld().preview({ mcp: ["linear"], excludeTools: ["codemode", "tool_search", "mcp__linear__*", "read_mcp_resource"] }),
  "No live host holds": () => plannerWorld({ deps: { readHosts: async () => ({ hosts: [{ name: "mini1", triggersVersion: "2", jobDataVersion: "3" }] }), readHostLoads: async () => ({ hosts: [{ name: "mini1", state: "current", overlayExtensionsAllowed: true, packages: [], extensions: [], skills: [], flows: [], mcp: [], unread: [], more: {} }] }) } }).preview({ excludeExtensions: ["pi-linter"] }),
  "The deployment's settings file could not be read, or is invalid": () => plannerWorld({ settings: "{ not json" }).preview({ maxCostUsd: "1" }),
  "PI_ALLOWED_MODELS is invalid": () => plannerWorld({ env: { PI_ALLOWED_MODELS: "not a list!" } }).preview({ maxCostUsd: "1" }),
  "The deployment's job cap could not be read": () => plannerWorld({ env: { PI_MAX_COST_USD: "lots" } }).preview({ maxCostUsd: "1" }),
  "The trigger's project or role policy could not be read": () => plannerWorld({ projects: "{ not json" }).preview({ maxCostUsd: "1" }),
  // The Add form's own, in the planner it shares with a tool, and held to the page it sends a person to.
  "this form cannot set": () => planTriggerAdd({ params: { kind: "label", flow: "triage", labels: ["pi"], maxCostUsd: "1" }, paths: { triggersPath: "triggers.json" }, env: { PI_BACKENDS: "local" }, tool: "this form", surface: "console" }),
});

/**
 * What the table of warnings quotes, each met through the real planner, which then still plans: a warning leaves the Confirm. A row can quote
 * several kinds of one sentence, so one meeting stands for the quote, and the scan below holds every warning the planner can say to a quote.
 */
/** A live host that reads what the two fields need and publishes pi-lint, for what a preview says of a name the file would leave out. */
const exclusionHost = (over = {}) => ({ name: "mini1", state: "current", overlayExtensionsAllowed: true, packages: [{ name: "pi-lint", version: "1.4.2" }], extensions: [], skills: [], flows: [], mcp: [], unread: [], more: {}, ...over });
const exclusionWorld = ({ live = ["mini1"], loads = [exclusionHost()], run = {}, doc = null } = {}) => plannerWorld({ run, doc, deps: { readHosts: async () => ({ hosts: live.map((name) => ({ name, triggersVersion: "2", jobDataVersion: "3" })) }), readHostLoads: async () => ({ hosts: loads }) } });

const WARNINGS = Object.freeze({
  "is a model this deployment does not know": () => plannerWorld({ run: MODEL_RUN }).preview({ model: "claude-typo" }),
  "could not be read or used for": () => plannerWorld({ run: MODEL_RUN, overlay: LOCAL_MODEL, failing: "models.json", failingCode: "EACCES" }).preview({ model: "claude-sonnet-5-5" }),
  "declares fallback models the allowed list does not name": () => plannerWorld({ run: { provider: "anthropic", model: "claude-fable-5" } }).preview({ models: ["anthropic/claude-fable-5"] }),
  "is not on the models they may call here": () => plannerWorld({ run: { provider: "anthropic", model: "claude-sonnet-5-5" }, env: { PI_ALLOWED_MODELS: SONNET } }).preview({ model: "claude-haiku-4-5" }),
  "every fallback must be on the allowed list": () => plannerWorld({ run: MODEL_RUN }).preview({ fallbackModels: [SONNET] }),
  "On this host a job cannot use": () => plannerWorld({ run: { provider: "anthropic", model: "claude-opus-5-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${SONNET}` } }).preview({ fallbackModels: [SONNET], model: "claude-typo" }),
  "and has no model left": () => plannerWorld({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: "anthropic/claude-typo,anthropic/claude-nope" } }).preview({ model: "claude-typo", fallbackModels: ["anthropic/claude-nope"] }),
  "this trigger's model could not be resolved": () => { const projects = JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }, { id: "api", members: ["github:acme/api"] }] }); return plannerWorld({ projects, doc: { modelRoles: { web: { oai: "openai/gpt-4o" } }, triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix", model: "role:oai" } }] } }).preview({ flow: "review", maxCostUsd: "5" }); },
  "would be refused as": () => plannerWorld({ env: { PI_FORWARD_ENV: "" } }).preview({ mcp: ["linear"] }),
  "On this host this trigger's jobs would be refused as mcp-excluded": () => plannerWorld().preview({ mcp: ["docs"], excludeTools: ["codemode"] }),
  "so a job cannot use it under this cap": () => plannerWorld({ run: MODEL_RUN }).preview({ models: [HAIKU, "anthropic/claude-opus-5-5"], maxCostUsd: "2" }),
  "A job on a host without": () => plannerWorld().preview({ mcp: ["docs"] }),
  "no skill named": () => plannerWorld({ deps: { readHostLoads: () => published({ mini1: {} }) } }).preview({ flow: "review" }),
  "What the hosts published could not be read": () => plannerWorld({ deps: { readHostLoads: async () => { throw new Error("down"); } } }).preview({ flow: "review" }),
  "No host that can say holds": () => exclusionWorld({ loads: [{ name: "mini1", state: "unknown", why: "absent" }] }).preview({ excludeExtensions: ["pi-linter"] }),
  "is refused as job-image-load-exclusions-unsupported": () => exclusionWorld().preview({ excludeExtensions: ["pi-lint"] }),
  "No host is live right now, so no running host says": () => exclusionWorld({ live: [], loads: [] }).preview({ excludeExtensions: ["pi-linter"] }),
  "which this change leaves out": () => exclusionWorld({ loads: [exclusionHost({ flows: [{ trigger: 1, flow: "fix", tier: "package", package: "pi-lint", repo: "unknown" }] })] }).preview({ excludeExtensions: ["pi-lint"] }),
  "is a subscription connection's adapter": () => exclusionWorld({ loads: [exclusionHost({ packages: [{ name: "pi-anthropic-oauth", version: "0.3.6" }] })] }).preview({ excludeExtensions: ["pi-anthropic-oauth"] }),
  "is refused as package-canary-excluded": () => exclusionWorld({ doc: { triggers: [{ on: COMMENT_ON, run: { kind: "github", flow: "fix" } }, CRON] } }).preview({ excludeExtensions: ["pi-lint"] }),
  "so it cannot confirm": () => exclusionWorld().preview({ excludeExtensionTools: ["lint_typo"] }),
  "stops before its prompt as exclude-tool-not-loaded": () => exclusionWorld().preview({ excludeExtensionTools: ["lint_file"] }),
  "stops no job of this trigger while it holds extensions back": () => exclusionWorld({ run: { packages: false } }).preview({ excludeExtensionTools: ["lint_typo"] }),
  "clears this": () => plannerWorld({ run: MODEL_RUN }).preview({ model: "claude-opus-5-5", maxCostUsd: "2.62144" }),
  "could not be bounded here": () => plannerWorld({ overlay: { providers: { free: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } } }, run: MODEL_RUN, env: { PI_MAX_COST_USD: "5" } }).preview({ provider: "free", model: "m" }),
  "of this host's .env could not be read as the worker reads it, so the deployment's job cap": () => plannerWorld({ deps: { readHostEnv: () => ({ env: {}, unread: [], hazardLine: 3 }) } }).preview({ maxCostUsd: "5" }),
  "in a line that could not be read as the worker reads it, so the deployment's job cap": () => plannerWorld({ deps: { readHostEnv: () => ({ env: {}, unread: ["PI_MAX_COST_USD"] }) } }).preview({ maxCostUsd: "5" }),
  "This host's .env could not be read as the worker reads it, so the deployment's job cap": () => plannerWorld({ deps: { readHostEnv: () => { throw new Error("no"); } } }).preview({ maxCostUsd: "5" }),
  "could not be read just now": () => plannerWorld({ run: MODEL_RUN, overlay: LOCAL_MODEL, failing: "models.json" }).preview({ model: "claude-sonnet-5-5" }),
  "pickup check could not": () => plannerWorld({ deps: { readHostEnv: () => { throw new Error("no"); } } }).preview({ mcp: ["linear"] }),
  "still reach a server could not be judged here": () => plannerWorld({ run: { mcp: ["linear"] }, failing: "mcp.json" }).preview({ excludeTools: ["write"] }),
  "its line in the .env could not be read": () => plannerWorld({ deps: { readHostEnv: (keys) => ({ env: { PI_EGRESS: "0", PI_FORWARD_ENV: "LINEAR_API_KEY" }, unread: keys.includes("LINEAR_API_KEY") ? ["LINEAR_API_KEY"] : [] }) } }).preview({ mcp: ["linear"] }),
  "The model catalog could not judge": () => plannerWorld({ run: MODEL_RUN, deps: { checkModelsKnown: () => ({}) } }).preview({ model: "claude-sonnet-5-5" }),
});

/**
 * Refusals the table leaves out, each with why, so a new one has to choose. The first group no page can meet. The second is the
 * paragraph under the table's, and it is held below by the planner reading no host.
 */
const NOT_IN_THE_TABLE = Object.freeze({
  // No triggers file means no digest, and no digest means the page draws no form.
  "This console does not name its triggers file": "unreachable",
  // A real Undo's digest is the entry it left, and the digest is compared first, so the order alone cannot be stale.
  "This trigger's keys changed since the edit being undone": "unreachable",
  // `readOverlay` turns a failed read into `invalid`, which has its own row.
  "The deployment's settings could not be read": "unreachable",
  // A belt around the dry run, whose file system holds every write: a read that fails comes back as one of the table's rows.
  "the change could not be checked": "unreachable",
  "The live hosts could not be read": "version",
  "This change needs": "version",
});

/**
 * The trigger edit's own refusals that no page meets, each with why. The body is shared with `dispatch_trigger_edit`, and its other refusals
 * read the same file the planner has already read, so what a person meets of it is in the table.
 */
const CORE_NOT_IN_THE_TABLE = Object.freeze({
  // The form trims a box and sends null for a blank (`getsBody`), which the planner's shape check answers first: "A trigger's flow cannot be removed".
  "flow must be non-empty": "unreachable",
  // Not this card's: it draws its form only from a row the file gives back, and compares the digest first, which answers for a row gone or changed. A page's
  // Edit and Delete forms do meet them, on a page drawn before the row went or went bad, in their own bar: held below, and a page drawn after draws neither form.
  "no trigger at row": "the Edit and Delete forms', on a page drawn before",
  "${rowName(\"trigger\", index, surface)} is not one this can change": "the Edit and Delete forms', on a page drawn before",
  // A tool's words, for its zero-based index and its call that sends no field. The form's own empty change is "already says this".
  "no trigger at index": "a tool's",
  "send at least one trigger field to edit": "a tool's",
});

const REFUSAL_HEADER = "| It says | Why | What to do |";

/**
 * What each row's What to do must say, by the row's first quote. `shared`: the page's own sentence says it too, so a row and a page cannot give
 * a person two ways out. Otherwise the sentence only says what is wrong, and the row alone says what to do, so it is held here to that much.
 */
const REFUSAL_TODO = Object.freeze({
  "This trigger changed since the page drew it": { says: /Reload the page/, shared: true },
  "There is no usable trigger at row": { says: /Reload the page.*correct that row in the file/i, shared: true },
  "The triggers file could not be read": { says: /Correct the file\. `pi-dispatch doctor` names what is wrong with it/ },
  "the triggers file could not be read (": { says: /Correct the file\. `pi-dispatch doctor` names what is wrong with it/ },
  "nothing was written and nothing in it was lost; change it with that release": { says: /with that release/, shared: true },
  "A trigger's flow cannot be removed": { says: /Choose another flow/i, shared: true },
  "trigger row": { says: /Correct the value it names, or look again and retry/ },
  "A trigger's job cap can only lower the deployment's": { says: /or less[^|]*remove this trigger's cap[^|]*belongs to its settings/, shared: true },
  "needs at least": { says: /Choose another model/, shared: true },
  "could not be resolved": { says: /Correct its model or its role/, shared: true },
  "has no verified local cost bound": { says: /Choose another model/ },
  "On every host this trigger's jobs would be refused as mcp-excluded": { says: /Remove the server from `run\.mcp`, or keep a tool that reaches it out of `run\.excludeTools`/, shared: true },
  "No live host holds": { says: /Check the name, or run `?pi-dispatch doctor`? on the host that has it/, shared: true },
  "The deployment's settings file could not be read, or is invalid": { says: /Correct what it names/ },
  "this form cannot set": { says: /on that trigger's page or by hand in the triggers file/, shared: true },
});
const WARNING_TODO = Object.freeze({
  "is a model this deployment does not know": { says: /Choose one from the catalog, or declare it in the overlay's `?models\.json`?/, shared: true },
  "could not be read or used for": { says: /Fix that file/, shared: true },
  "declares fallback models the allowed list does not name": { says: /Add (?:it|them) to the list/, shared: true },
  "every fallback must be on the allowed list": { says: /`?run\.models`?[^|]*`?PI_ALLOWED_MODELS`? when the trigger has (?:no list|none)/, shared: true },
  "On this host a job cannot use": { says: /Correct the model it names/ },
  "this trigger's model could not be resolved": { says: /Correct its model or its role/, shared: true },
  "would be refused as": { says: /`?run\.secrets`? is set in the (?:triggers )?file, not on this page/, shared: true },
  "On this host this trigger's jobs would be refused as mcp-excluded": { says: /Remove the server from `run\.mcp`, or keep a tool that reaches it out of `run\.excludeTools`/, shared: true },
  "so a job cannot use it under this cap": { says: /Choose another model/i },
  "A job on a host without": { says: /overlay `mcp\.json`/ },
  "no skill named": { says: /Check the flow's name/ },
  "What the hosts published could not be read": { says: /Doctor's run on each host/ },
  "No host that can say holds": { says: /Check the name, or run `pi-dispatch doctor`/ },
  "is refused as job-image-load-exclusions-unsupported": { says: /Rebuild the job image/ },
  "No host is live right now, so no running host says": { says: /Check the name/ },
  "which this change leaves out": { says: /Keep the package, or choose a flow/ },
  "is a subscription connection's adapter": { says: /Keep it, on a trigger whose jobs use that connection/ },
  "is refused as package-canary-excluded": { says: /Run the canary as a trigger that loads it/ },
  "so it cannot confirm": { says: /Check the name against what a run listed/ },
  "stops before its prompt as exclude-tool-not-loaded": { says: /or leave that extension out instead/ },
  "stops no job of this trigger while it holds extensions back": { says: /Read a run's record/ },
  "clears this": { says: /Choose another model/i, shared: true },
  "could not be bounded here": { says: /Read it, and decide/ },
  "of this host's .env could not be read as the worker reads it, so the deployment's job cap": { says: /Correct the line it names/ },
  "could not be read just now": { says: /Correct what it names, or try again/ },
});
/** Each row names its way out, by its first quote, and the page says the same where it says one at all. */
async function holdTodo(rows, table, meetings, of) {
  assert.deepEqual(rows.map(([says]) => spans(says)[0]), Object.keys(table), "a way out named for every row");
  for (const [says, , todo] of rows) {
    const first = spans(says)[0];
    assert.match(todo, table[first].says, `${first}: its What to do`);
    if (table[first].shared) assert.match(of(await meetings[first]()), table[first].says, `${first}: the page's own words`);
  }
}
const PICKUP_TAIL = "This reads this host's .env and overlay; what the worker's own service environment sets cannot be seen from here.";

test("docs/console.md's table of what the trigger's preview refuses: each quote is in what the real planner says, in the table's order", async () => {
  const rows = tableRows(read("docs/console.md"), REFUSAL_HEADER);
  const quoted = rows.flatMap(([says]) => spans(says));
  assert.deepEqual(quoted, Object.keys(REFUSALS), "the table's quotes, and the scenarios that meet them");
  for (const [says, why, todo] of rows) assert.ok(says && why && todo, `${says} says why and what to do`);
  // The row's other example of the loader's words, and the file moving, which reaches it the same way.
  assert.match((await plannerWorld().preview({ maxCostUsd: "lots" })).refusal, /^rejected: /);
  for (const [quote, meet] of Object.entries(REFUSALS)) {
    const out = await meet();
    assert.ok(typeof out?.refusal === "string", `${quote}: ${JSON.stringify(out?.summary ?? out)}`);
    assert.ok(out.refusal.includes(quote), `${quote}: the planner says ${JSON.stringify(out.refusal)}`);
  }
  // The two sentences that open on a model's name are why the section says "part of", and not "the start of".
  assert.ok(flat(read("docs/console.md")).includes("Each quote is part of what the page says"));
  await holdTodo(rows.slice(0, Object.keys(REFUSAL_TODO).length), REFUSAL_TODO, REFUSALS, (out) => out.refusal);
  // Of the model a job starts on, and no other: a listed one under the same cap plans, and both rows say so.
  for (const [row] of [["needs at least"], ["has no verified local cost bound"]]) assert.match(rows.find(([says]) => says.includes(row))[1], /the model a job starts on[^|]*A listed or fallback model[^|]*warns/, row);
  assert.ok((await WARNINGS["so a job cannot use it under this cap"]()).plan, "a listed model under the cap plans");
  const radiusListed = await plannerWorld({ run: MODEL_RUN, settings: JSON.stringify({ maxCostUsd: "5" }), deps: { checkModelsKnown: () => ({ ok: true }) } }).preview({ models: [HAIKU, "radius/balanced"] });
  assert.ok(radiusListed.plan, JSON.stringify(radiusListed));
  assert.ok(radiusListed.summary.some((line) => line.includes("has no verified local cost bound") && line.includes("so a job cannot use it under this cap")), radiusListed.summary.join("\n"));
});

test("docs/console.md's table of what the preview warns of: each quote is in what the real planner says, and a warning leaves the Confirm", async () => {
  const rows = tableRows(read("docs/console.md"), REFUSAL_HEADER);
  const [, warned] = (() => { const doc = read("docs/console.md"); const parts = doc.split("**What it warns of.**"); return [parts[0], tableRows(parts[1], REFUSAL_HEADER)]; })();
  assert.deepEqual(warned.flatMap(([says]) => spans(says)), Object.keys(WARNINGS), "the table's quotes, and the scenarios that meet them");
  assert.ok(rows.length > 0);
  for (const [says, why, todo] of warned) assert.ok(says && why && todo, `${says} says why and what to do`);
  for (const [quote, meet] of Object.entries(WARNINGS)) {
    const out = await meet();
    assert.ok(out?.plan, `${quote}: a warning still plans: ${JSON.stringify(out)}`);
    assert.ok(out.summary.some((line) => line.includes(quote)), `${quote}: the preview says ${JSON.stringify(out.summary)}`);
  }
  assert.ok(flat(read("docs/console.md")).includes(`"${PICKUP_TAIL}"`), "the line a pickup warning stands beside");
  const tailed = await WARNINGS["would be refused as"]();
  assert.equal(tailed.plan.warnings.at(-1), PICKUP_TAIL);
  await holdTodo(warned, WARNING_TODO, WARNINGS, (out) => out.plan.warnings.join(" ") + out.summary.join(" "));
  // What the section says of a server a preview adds, beside anything it warns of.
  const doc = flat(read("docs/console.md"));
  const widening = tailed.plan.changes.find((change) => change.key === "mcp").widening;
  assert.ok(widening.includes("a job that reaches its container connects to"), widening);
  assert.ok(doc.includes('"a job that reaches its container connects to" it.'));
  // Host names are what the row says of them: only a host that answered is named.
  const silent = await plannerWorld({ deps: { readHostLoads: () => published({ mini1: {}, quiet: null }) } }).preview({ flow: "review" });
  assert.ok(silent.plan.warnings.some((line) => line.startsWith("mini1 has no skill named review")), silent.plan.warnings.join("\n"));
  assert.ok(!silent.plan.warnings.some((line) => line.includes("quiet")), "a host that did not answer is not named");
});

test("every warning the planner can say is in that table: a new sentence has to choose", async () => {
  const source = read("admin/src/trigger-environment-plans.mjs");
  // A template inside a template ends the match early, so the one sentence that opens with a choice of words is held by its own words below.
  // Not read here, on purpose: `denied`, the answer to a tool or a viewer, which no person at an operator's form meets; and the summary's lines of a host's
  // release and of the file's stamp, which are not warnings: the paragraph after the table quotes each, and the test of what the docs quote holds it to the real preview.
  const cannot = /const cannot = "([^"]+)"/.exec(source)[1];
  const literals = [...source.matchAll(/(?:\b(?:warnings|toolWords|exclusionWords)\.(?:push|add)\((?:\[|failedRead \? )?|\bservers\.map\(\(name\) => |\bthin\.add\(|\bcould\(|\bnotRead = |\bonHost\("[^"]+", |\bnote: |\blacking\.length > 0 \? \[|\bunjudged\.length > 0 \? \[)(?:`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2]).filter((literal) => literal !== "" && !literal.startsWith("${unresolved.project")).map((literal) => literal.replace("${cannot}", cannot));
  // The other branch of the one sentence that chooses between two.
  literals.push(...[...source.matchAll(/failedRead \? `[^`]*` : `((?:[^`\\]|\\.)*)`/g)].map((m) => m[1]));
  assert.ok(source.includes("this trigger's model could not be resolved (${unresolved.reason})"));
  // Each of these went unforced when the scan skipped a literal it could not read: held by name, so a scan that loses one says so.
  for (const said of ["No host that can say holds", "which this change leaves out", "is refused as package-canary-excluded", "so it cannot confirm", "stops before its prompt as exclude-tool-not-loaded", "stops no job of this trigger", "On this host a job cannot use", "A job on a host without", "could not be read or used for", "no skill named", "so the deployment's job cap", "only for the smallest first call", "could not be bounded here", "The worker's pickup check could not judge"]) assert.ok(literals.some((literal) => literal.includes(said)), `the scan sees ${said}`);
  assert.ok(literals.length >= 20, `the scan finds the planner's sentences (${literals.length})`);
  const quotes = Object.keys(WARNINGS);
  for (const literal of literals) assert.ok(quotes.some((quote) => literal.includes(quote)), `no row for: ${literal}`);
});

test("every refusal the planner can say is in that table or named here with why: a new sentence has to choose", async () => {
  const source = read("admin/src/trigger-environment-plans.mjs");
  // Not the pickup check's own sentences. The docs do not quote them or list which refuse, and say only that a preview warns about what
  // would stop this trigger's jobs on this host and refuses what the file alone decides. The check's reasons are `docs/mcp.md`'s to list.
  // `stopped(` refuses of the model a job starts on, and where the amount is known of the trigger's main model, and warns of any other.
  const literals = [...source.matchAll(/\b(?:refuse|stopped)\((?:`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2]).filter((literal) => !/answer\.|pickup check/.test(literal));
  assert.ok(literals.length >= 20, `the scan finds the planner's sentences (${literals.length})`);
  const said = await Promise.all(Object.values(REFUSALS).map(async (meet) => (await meet()).refusal));
  for (const literal of literals) {
    const shape = new RegExp(literal.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*"));
    const left = Object.keys(NOT_IN_THE_TABLE).some((start) => literal.startsWith(start));
    assert.ok(left || said.some((text) => shape.test(text)), `no row and no reason for: ${literal}`);
  }
  // And nothing here excuses a sentence the planner no longer says.
  for (const start of Object.keys(NOT_IN_THE_TABLE)) assert.ok(literals.some((literal) => literal.startsWith(start)), start);

  // The trigger edit's own, which the planner hands on as they are.
  const core = read("admin/src/trigger-edit-core.mjs");
  const coreLiterals = [...core.matchAll(/\brefusal: (?:surface === "console" \? (?:`((?:[^`\\]|\\.)*)`) : )?(?:`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)")/g)].flatMap((m) => [m[1], m[2] ?? m[3]]).filter((literal) => literal !== undefined);
  assert.ok(coreLiterals.length >= 6, `the scan finds the trigger edit's sentences (${coreLiterals.length})`);
  const quotes = Object.keys(REFUSALS);
  for (const literal of coreLiterals) {
    const left = Object.keys(CORE_NOT_IN_THE_TABLE).some((start) => literal.startsWith(start));
    assert.ok(left || quotes.some((quote) => literal.includes(quote)), `no row and no reason for: ${literal}`);
  }
  for (const start of Object.keys(CORE_NOT_IN_THE_TABLE)) assert.ok(coreLiterals.some((literal) => literal.startsWith(start)), start);
  // Who meets the two the card does not: the same row through the Edit form's planner, and through the card's, which says its own.
  const stale = plannerWorld({ doc: { triggers: [null, { on: COMMENT_ON, run: { kind: "github", flow: "fix" } }] } });
  const edit = (index) => planTriggerEdit({ params: { index, flow: "x" }, paths: stale.paths, env: {}, surface: "console" }).refusal;
  assert.match(edit(0), /is not one this can change/);
  assert.match(edit(9), /^no trigger at row 10 \(have 2\)$/);
  assert.match((await stale.preview({ packages: false }, { index: 0 })).refusal, /^There is no usable trigger at row 1\./);
  // Why a page never meets "flow must be non-empty": a blank box goes as null, and null is refused in the row the table has.
  assert.match(read("admin/src/console/script.mjs"), /out\[boxes\[i\]\.name\] = next === "" \? null : next/);
  assert.match((await plannerWorld().preview({ flow: null })).refusal, /^A trigger's flow cannot be removed/);
});

test("the sentences the docs quote of the preview are the real preview's, and a file that needs no more than version 1 reads no host", async () => {
  let reads = 0;
  const w = plannerWorld({ deps: { readHosts: async () => { reads += 1; return { hosts: [] }; } } });
  const out = await w.preview({ flow: "review", provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "1", models: [HAIKU], fallbackModels: [HAIKU], mcp: ["docs"], packages: false, excludeTools: ["bash"] });
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
  assert.equal(reads, 0);
  const consoleDoc = flat(read("docs/console.md"));
  assert.ok(consoleDoc.includes("A file that needs no more than version 1 asks no host, and any change to it keeps every other key's bytes."));
  // And the four things the section says a write does to the stamp, each off the real preview of a real file.
  const needing = (run, doc = null) => plannerWorld({ run, doc, deps: { readHosts: async () => ({ hosts: [{ name: "mini1", triggersVersion: "2", jobDataVersion: "3" }] }), readHostLoads: async () => ({ hosts: [exclusionHost()] }) } });
  const stamps = await needing({}).preview({ excludeExtensions: ["pi-lint"] });
  const stays = await needing({}, { version: 2, triggers: [{ ...CRON, run: { ...CRON.run, excludeExtensions: ["pi-lint"] } }, { on: COMMENT_ON, run: { kind: "github", flow: "fix" } }] }).preview({ flow: "review" });
  const leaves = await needing({}, { version: 2, triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix", excludeExtensions: ["pi-lint"] } }] }).preview({ excludeExtensions: null });
  // A `"version": 1` needs nothing of a host, so it reads none: this one's world says so if it does.
  const literal = await plannerWorld({ doc: { version: 1, triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix" } }] }, deps: { readHosts: async () => assert.fail("a file at version 1 reads no host") } }).preview({ flow: "review" });
  for (const [said, start] of [[stamps, "Stamps the file version 2"], [stays, "The file stays at version 2"], [leaves, "The file no longer needs version 2"], [literal, "This write also takes the file's"]]) {
    const line = said.summary.find((one) => one.startsWith(start));
    assert.ok(line && consoleDoc.includes(`"${line}`), `${start}: ${JSON.stringify(said.summary ?? said)}`);
  }
  // And the two it says of a host's release, each off a preview that reads one, with the name it reads.
  const release = stamps.summary.find((one) => one.endsWith("reads what this change needs."));
  assert.equal(release, "mini1 reads what this change needs.");
  const twoHosts = await plannerWorld({ deps: { readHosts: async () => ({ hosts: [{ name: "mini1", triggersVersion: "2", jobDataVersion: "2" }, { name: "mini2", triggersVersion: "2", jobDataVersion: "2" }] }), readHostLoads: async () => ({ hosts: [exclusionHost()] }) } }).preview({ excludeExtensions: ["pi-lint"] });
  const each = twoHosts.summary.find((one) => one.endsWith("each read what this change needs."));
  assert.ok(each && consoleDoc.includes(`"${each}"`), `${JSON.stringify(twoHosts.summary ?? twoHosts)}`);
  const noHosts = await plannerWorld({ deps: { readHosts: async () => ({ hosts: [] }), readHostLoads: async () => ({ hosts: [] }) } }).preview({ excludeExtensions: ["pi-lint"] });
  const none = noHosts.summary.find((one) => one.startsWith("No host is live right now, so no host's release"));
  assert.ok(none && consoleDoc.includes(`"${none}"`), `${JSON.stringify(noHosts.summary ?? noHosts)}`);
  // What an Undo says of the bytes, each from the real preview that says it.
  const handFile = await plannerWorld({ text: `${JSON.stringify({ triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix" } }] })}\n` }).preview({ flow: "review" });
  assert.equal(handFile.plan.undo, "Put trigger row 2's values back; the file stays in the form the writer gives it");
  assert.ok(consoleDoc.includes(`"${handFile.plan.undo}"`));
  assert.equal(out.plan.undo, "Put trigger row 2 back as it was");
  assert.ok(consoleDoc.includes('reads "back as it was" only where it writes the very bytes it found'));
  const effect = out.summary.filter((one) => /^(The services reading|A host with its own copy)/.test(one));
  assert.equal(effect.length, 2, "the two lines the section quotes");
  for (const line of effect) assert.ok(consoleDoc.includes(`"${line}"`), line);
  // The one line docs/triggers.md carries for a fleet of per-host files.
  const own = out.summary.find((one) => one.startsWith("A host with its own copy"));
  assert.ok(flat(read("docs/triggers.md")).includes(`"${own}"`), own);
  // A schedule's own line, as the section paraphrases it.
  const cron = await w.service.preview({ index: 0, pageDigest: triggerEntryDigest(CRON), packages: false }, operator);
  assert.ok(cron.summary.includes("While hosts' copies differ on a schedule, no host installs a change to one, so this one moves when they agree."));
  assert.match(consoleDoc, /while hosts' copies differ, no host installs a change to one/);
  assert.match(flat(read("docs/triggers.md")), /while the copies differ on a schedule, no host installs a change to one/);
  // How many jobs a preview names.
  const planner = read("admin/src/trigger-environment-plans.mjs");
  assert.match(planner, /const SKEW_NAMED_MAX = 5;/);
  assert.match(consoleDoc, /named up to five/);
  // A server it adds, where the hosts' publication could not be read: said, and never read as no host having it.
  const unreadHosts = await plannerWorld({ deps: { readHostLoads: async () => { throw new Error("down"); } } }).preview({ mcp: ["linear"] });
  assert.ok(unreadHosts.summary.some((line) => line.endsWith("What the hosts published could not be read, so which of them have it is unknown.")), unreadHosts.summary.join("\n"));
  assert.match(consoleDoc, /or that what the hosts published could not be read/);
  // A change that says the same to a job is none, in the spelling the section names.
  const held = plannerWorld({ run: { maxCostUsd: 1.5 } });
  assert.match((await held.preview({ maxCostUsd: "1.50" })).unchanged, /already says this/);
  assert.match(consoleDoc, /`1\.5` and `"1\.50"` are one cap/);
  // What the switch does: off writes `false`, on removes it, and it is drawn on over `true`. A job loads the same under `true` and no key; doctor does not.
  assert.match(read("admin/src/console/script.mjs"), /flags\[f\]\.checked \? null : false/);
  assert.equal((await plannerWorld().preview({ packages: false })).plan.changes[0].line, "Staged packages: off.");
  const on = plannerWorld({ run: { packages: false } });
  const back = await on.preview({ packages: null });
  assert.equal(back.plan.changes[0].line, "Staged packages: on.");
  assert.doesNotMatch(back.afterText, /"packages"/, "on removes the key");
  const overTrue = panelOf(await triggerGetsPage({ entry: { on: COMMENT_ON, run: { kind: "github", flow: "fix", packages: true } } }), "p-trigger-gets");
  assert.match(overTrue, /<input type="checkbox" checked data-gets-flag="packages"/, "drawn on over true");
  assert.match(consoleDoc, /switch writes `"packages": false` when it goes off, and removes that when it goes on\. It is drawn on over a file that says `true`/);
  assert.match(consoleDoc, /`true` and no key are not one value: a job loads the staged packages under either, and doctor fails a host with none staged while any trigger says `true`/);
  assert.match(read("worker/src/doctor.mjs"), /\$\{requiring\} trigger\(s\) require staged packages \(run\.packages: true\) but nothing is staged/);
  assert.doesNotMatch(consoleDoc, /Staged packages: stay on/, "a form cannot reach that line");
});

/** What the hosts published, written by the real builder and read back by the real reader beside what its host beats out. */
async function published(hosts, images = {}) {
  const strings = new Map(Object.entries(hosts).filter(([, row]) => row !== null && typeof row === "object").map(([name, row]) => [hostLoadsKey(name), JSON.stringify(buildHostLoads({ at: PLANNER_NOW - 3_600_000, every: 24, by: { uid: 1000, worker: true }, overlay: { extensionsAllowed: true, extensions: [], skills: [] }, mcp: [], packages: [], flows: [], ...row }))]));
  const redis = { smembers: async () => Object.keys(hosts), mget: async (...keys) => keys.map((key) => strings.get(key) ?? null) };
  return readHostLoadsView(redis, { now: () => PLANNER_NOW, readHosts: async () => ({ hosts: Object.keys(hosts).map((name) => ({ name, image: images[name] ?? "pi-job:4.3.1", piVersion: "1.5.0" })) }) });
}
const PILL_TRIGGER = Object.freeze({ index: 2, type: "comment", flow: "fix", packages: true, forge: "github" });
const pillWords = async (hosts, { trigger = PILL_TRIGGER, images = {} } = {}) => Object.fromEntries(triggerGetsOf({ trigger, hostLoads: await published(hosts, images), liveHosts: Object.keys(hosts) }).pills.map((pill) => [pill.name, pill.word]));

test("docs/console.md's table of the hosts' pills: a row for every word the pill can say, each said by the real card over a real publication", async () => {
  const rows = tableRows(read("docs/console.md"), "| The pill says | When |");
  const a = { packages: [{ name: "pi-lint", version: "1.4.2" }] };
  const b = { packages: [{ name: "pi-test", version: "0.9.0" }] };
  assert.deepEqual(rows.map(([word]) => word), ["`the same`", "`the only host`", "`the only one known`", "`also …; without …; … defined differently; its flow …; runs …`", "`its flow in no tier`", "`no answer for its flow`, `its flow …`, `its image unknown`", `\`${W.pillOrder}\``, "`unknown`"]);
  const flows = (tier) => [{ trigger: 2, flow: "fix", tier, package: null, repo: "unknown" }];
  const same = { ...a, flows: flows("repository") };
  assert.deepEqual(await pillWords({ one: same, two: same }), { one: "the same", two: "the same" });
  assert.deepEqual(await pillWords({ one: a }), { one: "the only host" });
  assert.deepEqual(await pillWords({ one: a, silent: null }), { one: "the only one known", silent: "unknown" });
  assert.deepEqual(triggerGetsOf({ trigger: PILL_TRIGGER, hostLoads: await published({ one: a }), liveHosts: null }).pills.map((pill) => pill.word), ["the only one known"], "no live host listed: what the table's row says");
  const differ = await pillWords({ one: { ...a, flows: flows("repository") }, two: { ...b, flows: flows("overlay") } });
  assert.match(differ.one, /^also pi-lint 1\.4\.2; without pi-test 0\.9\.0; its flow from the repository$/);
  assert.deepEqual(await pillWords({ one: same, two: a }), { one: "its flow from the repository", two: "no answer for its flow" });
  const order = await pillWords({ one: { flows: flows("repository"), packages: [...a.packages, ...b.packages] }, two: { flows: flows("repository"), packages: [...b.packages, ...a.packages] } });
  assert.deepEqual(order, { one: W.pillOrder, two: W.pillOrder });
  // The card has no other word: a pill's word is one of these literals, or the differences joined.
  const source = read("admin/src/trigger-gets-view.mjs");
  const body = source.slice(source.indexOf("function hostPills("), source.indexOf("/** How old each host's answer is"));
  const words = [...body.matchAll(/word: (?:rows\.length === 1 && liveList \? )?"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => m.slice(1).filter(Boolean));
  assert.deepEqual([...words].sort(), ["the only host", "the only one known", "the same", "unknown"], "the literal words a pill takes are the table's");
  for (const word of words) assert.ok(rows.some(([cell]) => cell.includes(`\`${word}\``)), word);
  assert.match(body, /word: \[\.\.\.differs, \.\.\.unsaid\]\.join\("; "\)/, "and one where it says the differences");
  assert.match(body, /word: unsaid\.join\("; "\)/, "and one where it says what it cannot");
  for (const word of ['"no answer for its flow"', '"its image unknown"', "`its flow ${mine.flow}`"]) assert.ok(body.includes(word), word);

  // Each row's When, held to what the card does: every thing "the same" compares denies it when that alone differs, and is named.
  const when = new Map(rows.map(([word, says]) => [word, says]));
  const sameWhen = when.get("`the same`");
  const answered = { flows: flows("repository") };
  const server = (where) => ({ name: "linear", transport: "http", where, exposure: "codemode", enabled: true, keys: [] });
  const named = { ...PILL_TRIGGER, mcp: ["linear"] };
  const denies = {
    "its staged packages": [{ ...answered, packages: a.packages }, { ...answered, packages: b.packages }],
    "the overlay's extensions": [{ ...answered, extensions: [{ name: "guard", kind: "dir" }] }, answered],
    "the overlay's skills": [{ ...answered, skills: ["review"] }, answered],
    "the servers it names": [{ ...answered, mcp: [server("a.example")] }, answered, { trigger: named }],
    "how each is defined": [{ ...answered, mcp: [server("a.example")] }, { ...answered, mcp: [server("b.example")] }, { trigger: named }],
    "where doctor found its flow": [answered, { flows: flows("overlay") }],
  };
  for (const [words, [one, two, options]] of Object.entries(denies)) {
    assert.ok(sameWhen.includes(words), `the row names ${words}`);
    assert.notEqual((await pillWords({ one, two }, options)).one, "the same", `${words} alone denies it`);
  }
  assert.match(sameWhen, /the image and its pi, unless the trigger names its own image/);
  assert.notEqual((await pillWords({ one: answered, two: answered }, { images: { one: "pi-job:1", two: "pi-job:2" } })).one, "the same", "the image alone denies it");
  assert.equal((await pillWords({ one: answered, two: answered }, { trigger: { ...PILL_TRIGGER, image: "mine:1" }, images: { one: "pi-job:1", two: "pi-job:2" } })).one, "the same", "and not where the trigger names its own");
  assert.match(sameWhen, /its staged packages unless it withholds them/);
  assert.equal((await pillWords({ one: { ...answered, packages: a.packages }, two: { ...answered, packages: b.packages } }, { trigger: { ...PILL_TRIGGER, packages: false } })).one, "the same", "withheld packages deny nothing");
  assert.match(sameWhen, /the overlay's extensions where the host allows them/);
  assert.equal((await pillWords({ one: { ...answered, overlayExtensionsAllowed: false, extensions: [{ name: "guard", kind: "dir" }] }, two: answered })).one, "the same", "extensions a host does not allow deny nothing");
  assert.match(when.get("`the only host`"), /There is one host/);
  assert.match(when.get("`the only one known`"), /The other hosts read `unknown`/);
  assert.match(when.get("`the only one known`"), /no live host is listed/);
  assert.match(when.get("`the only host`"), /on the list of live hosts/);
  assert.match(when.get("`also …; without …; … defined differently; its flow …; runs …`"), /what it has over another, what it goes without[^|]*a server it names defined differently[^|]*where it finds the flow[^|]*the image it runs/);
  const lacking = { flows: [{ trigger: 2, flow: "fix", tier: "none", package: null, repo: "absent" }] };
  const local = { index: 2, type: "cron", flow: "fix", packages: true, folder: "/srv/web" };
  assert.deepEqual(await pillWords({ one: lacking, two: lacking }, { trigger: local }), { one: "its flow in no tier", two: "its flow in no tier" }, "whoever agrees with it");
  assert.deepEqual(await pillWords({ one: lacking }, { trigger: local }), { one: "its flow in no tier" }, "or alone");
  assert.match(when.get("`its flow in no tier`"), /whoever agrees with it, beside other hosts or alone/);
  // A forge's repository is not on a host: tier `none` with its answer `unknown` is not this.
  assert.notEqual((await pillWords({ one: { flows: [{ trigger: 2, flow: "fix", tier: "none", package: null, repo: "unknown" }] } })).one, "its flow in no tier");
  assert.match(when.get("`its flow in no tier`"), /A forge's repository is not on a host/);
  const unknownWhen = when.get("`unknown`");
  const silence = { "published nothing": null, "could not be read": "{", "a newer release wrote": JSON.stringify({ v: 99, at: PLANNER_NOW }), "left out part": { unread: ["packages"] }, "record is old": { at: PLANNER_NOW - 100 * 3_600_000 } };
  for (const [words, row] of Object.entries(silence)) {
    assert.ok(unknownWhen.includes(words), `the row names ${words}`);
    assert.equal((await pillWords({ one: a, other: row })).other, "unknown", words);
  }
});

test("docs/console.md's table of the card's rows: its rows are the page's, in order, and each names exactly the controls that row draws", async () => {
  const rows = tableRows(read("docs/console.md"), "| Row | What a person changes | What it shows and leaves |");
  const panel = panelOf(await triggerGetsPage(), "p-trigger-gets");
  const sections = panel.split('<div class="te-sec">').slice(1);
  const titleOf = (section) => /class="te-sec__k">[\s\S]*?<span>([^<]+)<small>/.exec(section)[1].replaceAll("’", "'");
  assert.deepEqual(rows.map(([row]) => row), sections.map(titleOf));
  for (const section of sections) {
    const drawn = new Set([...section.matchAll(/\bname="([A-Za-z]+)"|data-gets-(?:list|add|flag)="([A-Za-z]+)"/g)].map((m) => m[1] ?? m[2]));
    const row = rows.find(([label]) => label === titleOf(section));
    assert.deepEqual(spans(row[1]).sort(), [...drawn].sort(), row[0]);
  }
  assert.deepEqual(rows.flatMap(([, changes]) => spans(changes)).sort(), [...CARD_FIELDS].sort(), "every field the card writes has its row");
  assert.equal(rows.at(-1)[1], "Nothing here");
  // The words the paragraphs around the table quote of the card.
  const doc = flat(read("docs/console.md"));
  assert.ok(doc.includes(`"${W.noRun.replace(/\.$/, "")}"`), W.noRun);
  assert.ok(doc.includes(`*2 changes, not written yet*`) && W.barMany === "{n} changes, not written yet:");
  for (const label of ["Preview the change", "Discard"]) assert.ok(panel.includes(label) && doc.includes(`**${label}**`), label);
  // A cell's own quotes of what the rows draw.
  const row = (label) => flat(rows.find(([name]) => name === label)[2]);
  assert.ok(row("Flow and skills").includes(`"${straight(W.flowPicker)}"`), "the picker's list is not whole");
  assert.ok(textOf(panelOf(await triggerGetsPage(), "p-trigger-gets-how")).includes(straight(W.flowPicker)), "and the page says so");
  const servers = (where) => ({ name: "linear", transport: "http", where, exposure: "codemode", enabled: true, keys: [] });
  const defined = await published({ one: { mcp: [servers("a.example")] }, two: { mcp: [servers("b.example")] } });
  const subOf = (trigger) => triggerGetsOf({ trigger, hostLoads: defined, liveHosts: ["one", "two"] }).mcp.items.find((item) => item.name === "linear").sub;
  assert.ok(row("MCP servers").includes(`one it does not reads "${subOf(PILL_TRIGGER)}"`), subOf(PILL_TRIGGER));
  assert.ok(row("MCP servers").includes(`one it names reads "${subOf({ ...PILL_TRIGGER, mcp: ["linear"] })}"`));
  const noCap = triggerGetsOf({ trigger: PILL_TRIGGER, defaults: { maxCostUsd: "no per-job dollar cap" } }).model.capHint;
  assert.equal(noCap, "Blank means no cap of its own.");
  assert.ok(row("Model").includes("a blank cap means no cap of its own"));
  // Hosts doctor found no flow on: the row warns, in the card's own words.
  const lacking = await published({ one: { flows: [{ trigger: 2, flow: "fix", tier: "none", package: null, repo: "absent" }] } });
  assert.match(triggerGetsOf({ trigger: { index: 2, type: "cron", flow: "fix", packages: true, folder: "/srv/web" }, hostLoads: lacking, liveHosts: ["one"] }).flow.lacking, /^As doctor last read it, a job on one would not find fix/);
  assert.ok(row("Flow and skills").includes("with a warning where it found the flow nowhere"));
});

test("docs/console.md's actions table has the card's action, by the button a person presses, with a plain name for each field it changes", () => {
  const rows = tableRows(read("docs/console.md"), "| Where | Action | What it does |");
  const row = rows.find(([where]) => where === "A trigger's page");
  assert.ok(row, "the row");
  assert.equal(row[1], "Preview the change");
  const plain = { flow: "its flow", provider: "its provider", model: "and model", maxCostUsd: "its job cap", models: "its allowed models", fallbackModels: "and fallbacks", mcp: "its servers", packages: "the staged packages", excludeTools: "its tools", excludeExtensions: "each extension it leaves out", excludeExtensionTools: "each extension's tool it removes" };
  assert.deepEqual(Object.keys(plain), [...CARD_FIELDS], "one plain name per field");
  for (const [field, name] of Object.entries(plain)) assert.ok(row[2].includes(name), `${field} is said as ${name}`);
  assert.match(row[2], /A person's action, which no tool reaches/);
  assert.match(read("admin/src/action-policy.mjs"), /"trigger-environment-edit": rule\("person",/);
});

test("design/system/README.md lists what a trigger's jobs get among the screens that are built, as its card's status says", () => {
  const readme = read("design/system/README.md");
  const row = (name) => readme.split("\n").find((line) => line.startsWith(`| ${name} |`));
  assert.match(row("Triggers"), /what a trigger's jobs get on each host, changed in place, and its preview \(#800/);
  assert.doesNotMatch(row("Triggers"), /\bproposed\b|\bplanned\b/i, "the row holds what is built");
  assert.doesNotMatch(row("Planned and proposed"), /what a trigger's jobs get/);
  const markers = read("design/tools/fix_markers.py");
  assert.match(markers, /\*\*\{n: \(BUILT, "Built by #800, parts 2 and 3: what a trigger's jobs get/);
});

test("docs/console.md's table of who reads what: each row is what the real page draws in that state, in the card's own words", async () => {
  const rows = new Map(tableRows(read("docs/console.md"), "| Who, or which row | What they get | What it says |").map(([who, gets, says]) => [who, { gets, says }]));
  const page = async (options) => {
    const whole = await triggerGetsPage(options);
    return { card: panelOf(whole, "p-trigger-gets"), how: panelOf(whole, "p-trigger-gets-how") };
  };
  const expectRow = (who, drawn, { form, word = null, card = true }) => {
    const row = rows.get(who);
    assert.ok(row, who);
    assert.equal(/<form\b/.test(drawn.card), form, `${who}: a form`);
    assert.equal(drawn.card.includes("pageDigest"), form, `${who}: the digest`);
    assert.equal(drawn.card.replace(/<section[^>]*>/, "") !== "", card, `${who}: a card`);
    assert.equal(row.says, word === null ? "" : straight(word), `${who}: the table's words`);
    if (word !== null) assert.ok(textOf(`${drawn.card} ${drawn.how}`).includes(straight(word)), `${who}: the page says ${word}`);
  };
  expectRow("An operator, on a console that takes changes", await page(), { form: true });
  expectRow("An operator, on a read-only console", await page({ readOnly: true }), { form: false, word: W.readOnly });
  expectRow("A viewer", await page({ role: "viewer" }), { form: false, word: W.viewer });
  expectRow("A watch rule", await page({ entry: { on: { type: "watch", id: "w", source: "s" }, run: { kind: "local", folder: "/x", flow: "fix", task: "T", mode: "investigate" } } }), { form: false, word: W.watch });
  expectRow("A row the file did not give back", await page({ deps: { fs: { readFileSync: () => { throw new Error("gone"); } } } }), { form: false, word: W.unreadRow });

  const trigger = async ({ role = "operator", query = "index=2", fs = fileOnlyFs(getsFile()), snapshot: over = {} }) => {
    const triggers = readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs });
    const parsed = parsePageQuery("trigger", query);
    const data = await loadPageData("trigger", parsed.query, { now: () => PLANNER_NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => ({ readAt: PLANNER_NOW, triggers, runs: [], waiting: { rows: [] }, ...over }) }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role });
    const whole = String((await renderPage("trigger", { query: parsed.query, session: { name: "someone", role }, data })).html);
    return { whole, card: panelOf(whole, "p-trigger-gets"), how: panelOf(whole, "p-trigger-gets-how") };
  };
  expectRow("A page reached from a refused run", await trigger({ query: "index=2&becauseRun=gh-1" }), { form: true, word: W.notLinked });
  const agent = await trigger({ role: "agent" });
  expectRow("An agent", agent, { form: false, card: false });
  const agentRun = textOf(panelOf(agent.whole, "p-trigger-run"));
  assert.ok(rows.get("An agent").gets.includes(`"${straight("not in an agent’s read")}"`));
  assert.ok(agentRun.includes(straight("not in an agent’s read")), "a field its read lacks");
  for (const key of CARD_FIELDS) assert.ok(agentRun.includes(`run.${key}`), `What it runs lists run.${key}`);
  const newer = await trigger({ fs: fileOnlyFs(JSON.stringify({ version: 999, triggers: JSON.parse(getsFile()).triggers })) });
  expectRow("A triggers file a newer release wrote, or one the page cannot read", newer, { form: false, card: false });
  assert.ok(textOf(panelOf(newer.whole, "p-trigger-on")).includes("The triggers file does not load; run pi-dispatch doctor for the reason."), "What starts it says why");
  const denied = await trigger({ fs: { readFileSync: () => { throw Object.assign(new Error("no"), { code: "EACCES" }); }, existsSync: () => true } });
  assert.equal(denied.card.replace(/<section[^>]*>/, ""), "", "a file it cannot read draws no card either");
  assert.ok(textOf(panelOf(denied.whole, "p-trigger-on")).includes("The triggers file cannot be read (EACCES)."), "and says so, by the error's code");
  assert.match(rows.get("A triggers file a newer release wrote, or one the page cannot read").gets, /does not load, or that it cannot be read and the error's code/);
  // Valkey down: the snapshot read fails, and the file it does not need is read all the same.
  const fs = fileOnlyFs(getsFile());
  const downParsed = parsePageQuery("trigger", "index=2");
  const downData = await loadPageData("trigger", downParsed.query, { now: () => PLANNER_NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => { throw new Error("down"); } }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const downWhole = String((await renderPage("trigger", { query: downParsed.query, session: { name: "someone", role: "operator" }, data: downData })).html);
  expectRow("A page whose Valkey read failed", { whole: downWhole, card: panelOf(downWhole, "p-trigger-gets"), how: panelOf(downWhole, "p-trigger-gets-how") }, { form: true, word: `${W.fileSays} ${W.historyUnread}` });
  assert.ok(textOf(panelOf(downWhole, "p-trigger-change")).includes(straight(W.othersUnread)), "Before you change it says what is unread");
  // A file the worker refuses, and the page can still read: the card stays, so the row can be fixed, and the pills are unknown.
  const refused = await trigger({ fs: fileOnlyFs(getsFile({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", maxTurns: "many" } })) });
  expectRow("A triggers file the worker refuses that the page can still read: a key with no stamp, a row that is no trigger, a value the loader refuses", refused, { form: true, word: W.fileRefused });
  assert.ok(textOf(panelOf(refused.whole, "p-trigger-change")).includes("The triggers file does not load; run pi-dispatch doctor for the reason."), "Before you change it says so");
  const refusedAgent = await trigger({ role: "agent", fs: fileOnlyFs(getsFile({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", maxTurns: "many" } })) });
  assert.ok(textOf(panelOf(refusedAgent.whole, "p-trigger-change")).includes("The triggers file does not load; run pi-dispatch doctor for the reason."), "and to an agent, whose copy holds that yes or no");
  assert.equal(rows.size, 10, "and no state the table names goes untried");
});

test("docs/console.md says what a tool cannot reach, and names the fields a tool may not set and how many it keeps", () => {
  const doc = flat(read("docs/console.md"));
  const said = doc.slice(doc.indexOf("**What a tool cannot reach.**"), doc.indexOf("### The rules page"));
  assert.ok(said.length > 0, "the paragraph");
  assert.equal(ACTIONS.find((action) => action.name === "trigger-environment-edit").kind, "trigger-edit");
  assert.match(read("admin/src/action-policy.mjs"), /"trigger-environment-edit": rule\("person",/);
  const proof = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(read("admin/src/write-plans.mjs"))[1];
  const carrying = /A tool call carrying (.*?), or a near miss of one/.exec(said)[1];
  assert.deepEqual(spans(carrying).sort(), [...proof.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort());
  const editable = ACTIONS.find((action) => action.name === "trigger-edit").fields.filter((key) => !["index", "becauseRun"].includes(key));
  assert.equal(editable.length, 9);
  assert.match(said, /`dispatch_trigger_edit` keeps its nine fields, flow, provider and model among them/);
  for (const key of ["flow", "provider", "model"]) assert.ok(editable.includes(key), key);
  // The deployment's caps are a setting, which a tool can raise behind a confirm: "those six" is as far as this holds, and the section says so.
  assert.match(read("admin/src/action-policy.mjs"), /"setting-set": rule\("confirm",[^\n]*"dispatch_set"\)/);
  assert.match(said, /`dispatch_set` still sets the deployment's own caps, behind a confirm wherever a cap could rise/);
  assert.match(said, /Those eight are the operator's to write/);
  assert.match(said, /pi's own `bash` is outside this, as it is outside every action/);
  // The bar on the Confirm says what is true of this action, and claims nothing of what moves a job's spend elsewhere.
  const reason = /"trigger-environment-edit": rule\("person", "([^"]+)"\)/.exec(read("admin/src/action-policy.mjs"))[1];
  assert.equal(reason, "A person writes these fields here; no tool reaches this action.");
});

test("docs/triggers.md's two editors are the card's fields and the Edit form's, and its tool sentence takes what the tool does", () => {
  const doc = flat(read("docs/triggers.md"));
  const card = /\*\*What its jobs get\*\* changes ((?:`[A-Za-z]+`(?:, | and )?)+),/.exec(doc);
  assert.deepEqual(spans(card[1]), [...CARD_FIELDS]);
  const edit = /\*\*Edit\*\* changes the venue \(`backend`\), ((?:`[A-Za-z]+`(?:, | and )?)+)\./.exec(doc);
  assert.deepEqual(["backend", ...spans(edit[1])], [...EDIT_FIELDS]);
  // No key has both: the spec's claim, which these two sentences repeat.
  assert.deepEqual(CARD_FIELDS.filter((key) => EDIT_FIELDS.includes(key)), []);
  const tool = ACTIONS.find((action) => action.name === "trigger-edit").fields;
  for (const key of ["flow", "backend", "provider", "model", "maxTurns", ...EDIT_FIELDS.slice(2)]) assert.ok(tool.includes(key), key);
  // Which of the card's fields a tool can still set: "the first three", and that it cannot set the rest, read from what the tool takes.
  assert.deepEqual(CARD_FIELDS.filter((key) => tool.includes(key)), CARD_FIELDS.slice(0, 3));
  assert.match(doc, /Of those fields, `dispatch_trigger_edit` can still set the first three, and no `dispatch_\*` tool can set the other eight/);
  // The opening of the optional fields: most are the file's alone, and which are not is read from what the Edit form and the tool take.
  const flags = /\. ((?:`[A-Za-z]+`(?:, | and )?)+) change how a run is followed or picked up, and that page's Edit form and `dispatch_trigger_edit` take them too/.exec(doc);
  assert.deepEqual(spans(flags[1]), EDIT_FIELDS.slice(2));
  for (const key of EDIT_FIELDS.slice(2)) assert.ok(tool.includes(key), key);
  const proof = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(read("admin/src/write-plans.mjs"))[1];
  assert.deepEqual([...proof.matchAll(/"run\.([^"]+)"/g)].map((m) => m[1]).sort(), CARD_FIELDS.slice(3).sort());
  // Behind a confirm, but for the one thing the policy lets a headless call do alone.
  assert.match(read("admin/src/action-policy.mjs"), /"trigger-edit": rule\("confirm", "Only turning existing execution flags off is unattended\."/);
  assert.match(doc, /behind a confirm, except that a headless call with the process's write grant can turn an existing flag off unattended/);
});

test("docs/costs.md's amounts are the real bound's, at the pin, and each row of what the preview does is what the real planner does", async () => {
  const doc = read("docs/costs.md");
  const text = flat(doc);
  assert.ok(text.includes(`**The floor**, for a ${FIRST_CALL_MIN_CONTEXT_BYTES.toLocaleString("en-US")} byte request`));
  assert.ok(text.includes(`**A short task's first call**, for ${FIRST_CALL_SHORT_TASK_BYTES.toLocaleString("en-US")} bytes`));
  const rows = tableRows(doc, "| Model | The floor | A short task's first call |");
  assert.ok(rows.length > 0);
  for (const [cell, floor, short] of rows) {
    const [provider, id] = spans(cell)[0].split("/");
    const model = builtinModel(provider, id);
    assert.equal(floor, `$${formatMicros(firstCallFloorMicros(model))}`, cell);
    assert.equal(short, `$${formatMicros(firstCallBoundMicros(model, FIRST_CALL_SHORT_TASK_BYTES))}`, cell);
  }
  const quotes = (cell) => [...cell.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const [below, between, above] = tableRows(doc, "| The cap is | The preview |");
  const opus = { provider: "anthropic", model: "claude-opus-5-5" };
  const refused = await plannerWorld({ run: opus }).preview({ maxCostUsd: "2" });
  assert.ok(refused.refusal, JSON.stringify(refused.summary));
  assert.ok(refused.refusal.startsWith(quotes(below[1])[0]), refused.refusal);
  const deployment = await plannerWorld({ run: MODEL_RUN, settings: JSON.stringify({ maxCostUsd: "2" }) }).preview({ model: "claude-opus-5-5" });
  assert.match(deployment.refusal, /A trigger can only lower the deployment's job cap: choose another model/);
  assert.match(below[1], /it says choose another model, since a trigger can only lower it/);
  const warned = await plannerWorld({ run: opus }).preview({ maxCostUsd: "2.62144" });
  assert.ok(warned.plan, JSON.stringify(warned));
  assert.ok(warned.summary.some((line) => line.startsWith(quotes(between[1])[0])), warned.summary.join("\n"));
  const clean = await plannerWorld({ run: opus }).preview({ maxCostUsd: "2.654295" });
  assert.ok(clean.plan, JSON.stringify(clean));
  assert.ok(!clean.summary.some((line) => line.includes("only for the smallest first call")), above[1]);
  // The refusal above the deployment's cap, and a model the runner could not bound, in the words the section quotes.
  const raise = await plannerWorld({ settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ maxCostUsd: "7" });
  assert.ok(text.includes(`"${raise.refusal.slice(0, raise.refusal.indexOf(". ") + 1)}"`), raise.refusal);
  const free = { providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "free", compat: { maxTokensField: "max_tokens" }, maxTokens: 100, contextWindow: 1000 }] } } };
  const open = await plannerWorld({ overlay: free, settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ provider: "ollama", model: "free" });
  assert.ok(open.plan, JSON.stringify(open));
  const openLine = open.summary.find((line) => line.startsWith("The first call on"));
  assert.ok(text.includes(`"${openLine}"`), openLine);
  // The changes that reach this judgement.
  const judged = /const MODEL_OR_CAP = Object\.freeze\(\[([^\]]*)\]\)/.exec(read("admin/src/trigger-environment-plans.mjs"))[1];
  assert.deepEqual([...judged.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["provider", "model", "models", "fallbackModels", "maxCostUsd"]);
  assert.match(text, /only when the change sends the model, the provider, a list or the cap/);
  // A listed or fallback model under the same cap, in the words the row quotes.
  const listed = await plannerWorld({ run: MODEL_RUN }).preview({ models: [HAIKU, "anthropic/claude-opus-5-5"], maxCostUsd: "2" });
  assert.ok(listed.plan, JSON.stringify(listed));
  const [, listedQuote] = quotes(below[1]);
  assert.ok(listed.plan.warnings.some((line) => line.endsWith(listedQuote)), listedQuote);
  assert.match(below[1], /^Of the trigger's main model and the model a job starts on, refuses/);
  assert.match(below[1], /Of a listed or fallback model, previews/);
  assert.match(text, /is refused under any cap as the main model of a trigger with no fallbacks, and warned of as any other model, a main with fallbacks included/);
  // What a change of the model or a list asks: the entry as it will be, as the cap does.
  const held = plannerWorld({ run: { ...MODEL_RUN, models: [HAIKU, "anthropic/claude-opus-5-5"], maxCostUsd: "2" } });
  assert.ok(!(await held.preview({ flow: "review" })).summary.some((line) => line.includes("claude-opus-5-5")), "an edit that names no model asks of none");
  assert.ok((await held.preview({ maxCostUsd: "2.1" })).summary.some((line) => line.includes("claude-opus-5-5 needs at least")), "a change of the cap asks of each");
  assert.ok((await held.preview({ model: "claude-sonnet-5-5", models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"] })).summary.some((line) => line.includes("claude-opus-5-5 needs at least")), "a change of the model asks of each too");
  assert.match(text, /so nobody is refused over a change that moves none of them, and then it asks of each of those models/);
  // It can only lower the deployment's cap: the worker's own rule, and what the bold line says of it.
  assert.ok(text.includes("**It can only lower the deployment's cap.** A job runs under the smaller of the two"));
  assert.equal(effectiveCostCapMicros("7", "5"), 5_000_000);
  assert.equal(effectiveCostCapMicros("3", "5"), 3_000_000);
  assert.equal(effectiveCostCapMicros("3", null), 3_000_000, "the trigger's applies on its own");
  assert.ok(text.includes("When the deployment sets no cap, the trigger's applies on its own"));
  assert.ok((await plannerWorld().preview({ maxCostUsd: "900" })).plan, "with none set, any amount is taken");
  assert.ok(raise.refusal.includes("remove this trigger's cap") && raise.refusal.includes("belongs to its settings, not to this page"));
  assert.ok(text.includes("It offers this trigger's cap or none as the way out, and no way to move the deployment's cap, which belongs to its settings"));
  assert.match((await plannerWorld({ run: { maxCostUsd: "1" }, settings: JSON.stringify({ maxCostUsd: "5" }) }).preview({ maxCostUsd: null })).plan.changes[0].widening, /widens what each job may spend/);
  assert.ok(text.includes("Removing a trigger's cap, or raising it, is said as a widening when it lets a job spend more"));
  // `first-call-bytes.pinned.test.mjs` computes the size of pi's default prompt and tools, and holds what this says of it. No older figure stays.
  assert.ok(text.includes("alone come to about 5 KB at the pinned pi"));
  assert.doesNotMatch(text, /4,465|5,340|5,440/);
});
