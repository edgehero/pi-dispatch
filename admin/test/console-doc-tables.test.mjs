import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTIONS } from "../src/console/actions.mjs";
import { PAGES } from "../src/console/pages.mjs";
import { ERROR_KINDS, errorPage } from "../src/console/error-pages.mjs";
import { ENDED_REASONS, endedNotices } from "../src/console/session-ends.mjs";
import { LOADED_MAX_OVERLAY_NAMES, LOADED_MAX_PACKAGES } from "../../worker/src/loaded-record.mjs";
import { HOSTS_OFFERED, LOADED_STATES, loadedVerdict, outcomeNote, runningVerdict } from "../src/loaded-words.mjs";
import { RUN_FILTER_FIELDS, RUN_OUTCOME_VALUES } from "../src/run-filter.mjs";
import { planTriggerAdd, TRIGGER_ADD_FIELDS } from "../src/write-plans.mjs";
import { HOST_LOADS, LOADED_SAMPLES as S, loadedField, loadedRecord, source } from "./helpers/loaded-samples.mjs";

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
  assert.match(rows.get("stopped").says, /A run that completed, took a turn a provider answered, or holds metered calls on a failure that counts no turns never reads as this/);
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
