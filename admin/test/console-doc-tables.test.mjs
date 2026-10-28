import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTIONS } from "../src/console/actions.mjs";
import { ERROR_KINDS, errorPage } from "../src/console/error-pages.mjs";
import { ENDED_REASONS, endedNotices } from "../src/console/session-ends.mjs";
import { RUN_FILTER_FIELDS, RUN_OUTCOME_VALUES } from "../src/run-filter.mjs";
import { planTriggerAdd, TRIGGER_ADD_FIELDS } from "../src/write-plans.mjs";

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
