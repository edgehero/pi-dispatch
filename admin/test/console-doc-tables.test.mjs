import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildHostLoads, hostLoadsKey } from "@edgehero/pi-dispatch/host-loads";
import { FIRST_CALL_MIN_CONTEXT_BYTES, FIRST_CALL_SHORT_TASK_BYTES, builtinModel, firstCallBoundMicros, firstCallFloorMicros } from "@edgehero/pi-dispatch/model-catalog";
import { formatMicros } from "@edgehero/pi-dispatch/money";
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
import { planTriggerAdd, TRIGGER_ADD_FIELDS } from "../src/write-plans.mjs";
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
function plannerWorld({ run = {}, doc = null, settings = "{}", env = {}, overlay = null, failing = null, projects = null, deps = {} } = {}) {
  const dir = tempDir("pd-800-docs-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: projects === null ? null : join(dir, "projects.json"), globalPiDir: join(dir, "overlay") };
  nodeFs.writeFileSync(paths.triggersPath, `${JSON.stringify(doc ?? { triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix", ...run } }] }, null, 2)}\n`);
  nodeFs.writeFileSync(paths.settingsFile, settings);
  if (projects !== null) nodeFs.writeFileSync(paths.projectsFile, projects);
  nodeFs.mkdirSync(paths.globalPiDir);
  nodeFs.writeFileSync(join(paths.globalPiDir, "mcp.json"), JSON.stringify(FILE_MCP));
  if (overlay !== null) nodeFs.writeFileSync(join(paths.globalPiDir, "models.json"), JSON.stringify(overlay));
  const fs = failing === null ? nodeFs : { ...nodeFs, readFileSync: (path, ...rest) => { if (String(path).endsWith(failing)) throw Object.assign(new Error("busy"), { code: "EIO" }); return nodeFs.readFileSync(path, ...rest); } };
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-haiku-4-5", PI_EGRESS: "0", PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "a value", ...env }, fs, now: () => PLANNER_NOW, deploymentDir: dir, ...deps });
  const digest = () => triggerEntryDigest(JSON.parse(nodeFs.readFileSync(paths.triggersPath, "utf8")).triggers[1]);
  const preview = (change, over = {}) => service.preview({ index: 1, pageDigest: over.pageDigest ?? digest(), ...change, ...over }, operator);
  return { paths, service, preview, digest };
}
const LOCAL_MODEL = Object.freeze({ providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "local", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 100, contextWindow: 1000 }] } } });
const MODEL_RUN = Object.freeze({ provider: "anthropic", model: "claude-haiku-4-5" });

/**
 * What the table of refusals quotes, by the words it quotes, each met through the real planner. A body only this page's form could send:
 * what a page cannot send (a list that is not a list, a blank where the form sends null) refuses too, and that is the planner's test.
 */
const REFUSALS = Object.freeze({
  "This trigger changed since the page drew it": () => plannerWorld().preview({ packages: false }, { pageDigest: "a".repeat(64) }),
  "There is no trigger at row": () => plannerWorld().preview({ packages: false }, { index: 9 }),
  "The triggers file could not be read": () => { const w = plannerWorld(); const pageDigest = w.digest(); nodeFs.writeFileSync(w.paths.triggersPath, "{ not json"); return w.preview({ packages: false }, { pageDigest }); },
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
  "The deployment's settings file is invalid": () => plannerWorld({ settings: "{ not json" }).preview({ maxCostUsd: "1" }),
  "PI_ALLOWED_MODELS is invalid": () => plannerWorld({ env: { PI_ALLOWED_MODELS: "not a list!" } }).preview({ maxCostUsd: "1" }),
  "The deployment's job cap could not be read": () => plannerWorld({ env: { PI_MAX_COST_USD: "lots" } }).preview({ maxCostUsd: "1" }),
  "The trigger's project or role policy could not be read": () => plannerWorld({ projects: "{ not json" }).preview({ maxCostUsd: "1" }),
});

/**
 * What the table of warnings quotes, each met through the real planner, which then still plans: a warning leaves the Confirm. A row can quote
 * several kinds of one sentence, so one meeting stands for the quote, and the scan below holds every warning the planner can say to a quote.
 */
const WARNINGS = Object.freeze({
  "is a model this deployment does not know": () => plannerWorld({ run: MODEL_RUN }).preview({ model: "claude-typo" }),
  "declares fallback models the allowed list does not name": () => plannerWorld({ run: { provider: "anthropic", model: "claude-fable-5" } }).preview({ models: ["anthropic/claude-fable-5"] }),
  "is not on the models they may call here": () => plannerWorld({ run: { provider: "anthropic", model: "claude-sonnet-5-5" }, env: { PI_ALLOWED_MODELS: SONNET } }).preview({ model: "claude-haiku-4-5" }),
  "every fallback must be on the allowed list": () => plannerWorld({ run: MODEL_RUN }).preview({ fallbackModels: [SONNET] }),
  "this trigger's model could not be resolved": () => { const projects = JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }, { id: "api", members: ["github:acme/api"] }] }); return plannerWorld({ projects, doc: { modelRoles: { web: { oai: "openai/gpt-4o" } }, triggers: [CRON, { on: COMMENT_ON, run: { kind: "github", flow: "fix", model: "role:oai" } }] } }).preview({ flow: "review", maxCostUsd: "5" }); },
  "would be refused as": () => plannerWorld({ env: { PI_FORWARD_ENV: "" } }).preview({ mcp: ["linear"] }),
  "On this host this trigger's jobs would be refused as mcp-excluded": () => plannerWorld().preview({ mcp: ["docs"], excludeTools: ["codemode"] }),
  "clears this": () => plannerWorld({ run: MODEL_RUN }).preview({ model: "claude-opus-5-5", maxCostUsd: "2.62144" }),
  "could not be bounded here": () => plannerWorld({ overlay: { providers: { free: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } } }, run: MODEL_RUN, env: { PI_MAX_COST_USD: "5" } }).preview({ provider: "free", model: "m" }),
  "could not be read just now": () => plannerWorld({ run: MODEL_RUN, overlay: LOCAL_MODEL, failing: "models.json" }).preview({ model: "claude-sonnet-5-5" }),
  "the worker's pickup check could not": () => plannerWorld({ deps: { readHostEnv: () => { throw new Error("no"); } } }).preview({ mcp: ["linear"] }),
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
  // A belt around the dry run, whose file system holds every write: a read that fails comes back as one of the table's two rows.
  "the change could not be checked": "unreachable",
  "The live hosts could not be read": "version",
  "This change needs": "version",
});

const REFUSAL_HEADER = "| It says | Why | What to do |";
const PICKUP_TAIL = "This reads this host's .env and overlay; what the worker's own service environment sets cannot be seen from here.";

test("docs/console.md's table of what the trigger's preview refuses: each quote is the start of what the real planner says, in the table's order", async () => {
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
});

test("every warning the planner can say is in that table: a new sentence has to choose", async () => {
  const source = read("admin/src/trigger-environment-plans.mjs");
  // A template inside a template ends the match early, so the one sentence that opens with a choice of words is held by its own words below.
  const literals = [...source.matchAll(/(?:\bwarnings\.(?:push|add)\((?:\[|failedRead \? )?|\bcould\(|\bnotRead = |\bonHost\("[^"]+", )(?:`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2]).filter((literal) => literal !== "" && !literal.includes("sentence") && !literal.startsWith("${unresolved.project"));
  assert.ok(source.includes("this trigger's model could not be resolved (${unresolved.reason})"));
  assert.ok(literals.length >= 14, `the scan finds the planner's sentences (${literals.length})`);
  const quotes = Object.keys(WARNINGS);
  for (const literal of literals) assert.ok(quotes.some((quote) => literal.includes(quote)), `no row for: ${literal}`);
});

test("every refusal the planner can say is in that table or named here with why: a new sentence has to choose", async () => {
  const source = read("admin/src/trigger-environment-plans.mjs");
  // Not the pickup check's own sentences. The docs do not quote them or list which refuse, and say only that a preview warns about what
  // would stop this trigger's jobs on this host and refuses what the file alone decides. The check's reasons are `docs/mcp.md`'s to list.
  // `stopped(` refuses of a job's main model, and warns of any other.
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
});

test("the sentences the docs quote of the preview are the real preview's, and no field on the card makes it read a host", async () => {
  let reads = 0;
  const w = plannerWorld({ deps: { readHosts: async () => { reads += 1; return { hosts: [] }; } } });
  const out = await w.preview({ flow: "review", provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "1", models: [HAIKU], fallbackModels: [HAIKU], mcp: ["docs"], packages: false, excludeTools: ["bash"] });
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
  assert.equal(reads, 0);
  const consoleDoc = flat(read("docs/console.md"));
  assert.ok(consoleDoc.includes("No field on this card needs that yet, so no host is read for it."));
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
  // A change that says the same to a job is none, in the two spellings the section names.
  const held = plannerWorld({ run: { maxCostUsd: 1.5 } });
  assert.match((await held.preview({ maxCostUsd: "1.50" })).unchanged, /already says this/);
  assert.match((await plannerWorld().preview({ packages: true })).unchanged, /already says this/);
  assert.match(consoleDoc, /`1\.5` and `"1\.50"` are one cap, and `true` is what no `packages` key already means/);
});

/** What the hosts published, written by the real builder and read back by the real reader beside what its host beats out. */
async function published(hosts) {
  const strings = new Map(Object.entries(hosts).filter(([, row]) => row !== null && typeof row === "object").map(([name, row]) => [hostLoadsKey(name), JSON.stringify(buildHostLoads({ at: PLANNER_NOW - 3_600_000, every: 24, by: { uid: 1000, worker: true }, overlay: { extensionsAllowed: true, extensions: [], skills: [] }, mcp: [], packages: [], flows: [], ...row }))]));
  const redis = { smembers: async () => Object.keys(hosts), mget: async (...keys) => keys.map((key) => strings.get(key) ?? null) };
  return readHostLoadsView(redis, { now: () => PLANNER_NOW, readHosts: async () => ({ hosts: Object.keys(hosts).map((name) => ({ name, image: "pi-job:4.3.1", piVersion: "1.5.0" })) }) });
}
const PILL_TRIGGER = Object.freeze({ index: 2, type: "comment", flow: "fix", packages: true, forge: "github" });
const pillWords = async (hosts) => Object.fromEntries(triggerGetsOf({ trigger: PILL_TRIGGER, hostLoads: await published(hosts), liveHosts: Object.keys(hosts) }).pills.map((pill) => [pill.name, pill.word]));

test("docs/console.md's table of the hosts' pills: a row for every word the pill can say, each said by the real card over a real publication", async () => {
  const rows = tableRows(read("docs/console.md"), "| The pill says | When |");
  const a = { packages: [{ name: "pi-lint", version: "1.4.2" }] };
  const b = { packages: [{ name: "pi-test", version: "0.9.0" }] };
  assert.deepEqual(rows.map(([word]) => word), ["`the same`", "`the only host`", "`the only one known`", "`also …; without …; … defined differently; its flow …; runs …`", "`no answer for its flow`, `its flow …`, `its image unknown`", `\`${W.pillOrder}\``, "`unknown`"]);
  const flows = (tier) => [{ trigger: 2, flow: "fix", tier, package: null, repo: "unknown" }];
  const same = { ...a, flows: flows("repository") };
  assert.deepEqual(await pillWords({ one: same, two: same }), { one: "the same", two: "the same" });
  assert.deepEqual(await pillWords({ one: a }), { one: "the only host" });
  assert.deepEqual(await pillWords({ one: a, silent: null }), { one: "the only one known", silent: "unknown" });
  const differ = await pillWords({ one: { ...a, flows: flows("repository") }, two: { ...b, flows: flows("overlay") } });
  assert.match(differ.one, /^also pi-lint 1\.4\.2; without pi-test 0\.9\.0; its flow from the repository$/);
  assert.deepEqual(await pillWords({ one: same, two: a }), { one: "its flow from the repository", two: "no answer for its flow" });
  const order = await pillWords({ one: { flows: flows("repository"), packages: [...a.packages, ...b.packages] }, two: { flows: flows("repository"), packages: [...b.packages, ...a.packages] } });
  assert.deepEqual(order, { one: W.pillOrder, two: W.pillOrder });
  // The card has no other word: a pill's word is one of these literals, or the differences joined.
  const source = read("admin/src/trigger-gets-view.mjs");
  const body = source.slice(source.indexOf("function hostPills("), source.indexOf("/** How old each host's answer is"));
  const words = [...body.matchAll(/word: (?:rows\.length === 1 \? )?"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => m.slice(1).filter(Boolean));
  assert.deepEqual([...words].sort(), ["the only host", "the only one known", "the same", "unknown"], "the literal words a pill takes are the table's");
  for (const word of words) assert.ok(rows.some(([cell]) => cell.includes(`\`${word}\``)), word);
  assert.match(body, /word: \[\.\.\.differs, \.\.\.unsaid\]\.join\("; "\)/, "and one where it says the differences");
  assert.match(body, /word: unsaid\.join\("; "\)/, "and one where it says what it cannot");
  for (const word of ['"no answer for its flow"', '"its image unknown"', "`its flow ${mine.flow}`"]) assert.ok(body.includes(word), word);
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
  const newer = await trigger({ fs: fileOnlyFs(JSON.stringify({ version: 999, triggers: JSON.parse(getsFile()).triggers })) });
  expectRow("A triggers file a newer release wrote, or one the page cannot read", newer, { form: false, card: false });
  assert.ok(textOf(panelOf(newer.whole, "p-trigger-on")).includes("The triggers file does not load; run pi-dispatch doctor for the reason."), "What starts it says why");
  // Valkey down: the snapshot read fails, and the file it does not need is read all the same.
  const fs = fileOnlyFs(getsFile());
  const downParsed = parsePageQuery("trigger", "index=2");
  const downData = await loadPageData("trigger", downParsed.query, { now: () => PLANNER_NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => { throw new Error("down"); } }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role: "operator" });
  const downWhole = String((await renderPage("trigger", { query: downParsed.query, session: { name: "someone", role: "operator" }, data: downData })).html);
  expectRow("A page whose Valkey read failed", { whole: downWhole, card: panelOf(downWhole, "p-trigger-gets"), how: panelOf(downWhole, "p-trigger-gets-how") }, { form: true, word: `${W.fileSays} ${W.historyUnread}` });
  assert.ok(textOf(panelOf(downWhole, "p-trigger-change")).includes(straight(W.othersUnread)), "Before you change it says what is unread");
  assert.equal(rows.size, 9, "and no state the table names goes untried");
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
  assert.match(said, /`dispatch_trigger_edit` keeps its nine fields/);
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
});
