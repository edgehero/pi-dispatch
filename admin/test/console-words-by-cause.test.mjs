import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPageData, renderPage, snapshotFailureOf } from "../src/console/pages.mjs";
import { DEPLOYMENT_UNREAD_WORDS, SNAPSHOT_MISSING, UNREAD_FAULT_TEXT, noChangeText, unreadCauseOf, unreadText } from "../src/console/panels/common.mjs";
import { OVERVIEW_UNREAD_HEADLINE, OVERVIEW_UNREAD_TEXT } from "../src/console/panels/overview.mjs";
import { FILES_ONLY_TEXT } from "../src/console/panels/config-ui.mjs";
import { SECRETS_FILES_ONLY_TEXT } from "../src/console/panels/secrets.mjs";
import { SKEW_UNKNOWN_TEXT, triggerChange } from "../src/console/panels/trigger.mjs";
import { RUNS_TRIGGER_ROW_ONLY, runsTableModel } from "../src/console/panels/runs.mjs";
import { parseRunFilter, runMatches, triggerFilterValueOf, triggerIdentityOf } from "../src/run-filter.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";
import { mirrorStateOf } from "../src/mirror-words.mjs";
import { queueErroredRefusal } from "../src/console/actions.mjs";
import { PageDeadlinePassed } from "../src/console/page-deadline.mjs";
import { noSnapshotFleet } from "./helpers/no-snapshot.mjs";
import { consoleOn, drawn, erroringKey, failing, healthy, HOST, REFUSED, RUN } from "./helpers/real-console.mjs";

/**
 * The words by cause (issue #1073): a page that could not read the deployment says why, in the words of the cause (a
 * Valkey that did not answer, one that answered with an error, by its code and its class, a read the page's deadline
 * cut, a fault of the console's own code), where five banners said "Valkey could not be read" of all four. And the
 * smaller sentences found beside them: a trigger's skew count, `?trigger=` by row and identity, an agent's copy of the
 * mirror's word and a host's slots, a queue's refusal by its code's class, and a refused run's host on a registry read
 * in part. Canned data and the real loader; nothing here dials a Valkey.
 */

const NOW = Date.UTC(2026, 9, 8, 15, 39, 0);
const wordsOf = (markup) => String(markup).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });

test("a failed snapshot read is kept by its cause: late, an error with its code, a fault of the console, and silence as no mark", () => {
  assert.deepEqual(snapshotFailureOf(new PageDeadlinePassed()), { kind: "late" });
  assert.deepEqual(snapshotFailureOf(reply("WRONGTYPE Operation against a key holding the wrong kind of value")), { kind: "error", code: "WRONGTYPE" });
  assert.deepEqual(snapshotFailureOf(new Error("NOPERM this user has no permissions to run the 'hgetall' command")), { kind: "error", code: "NOPERM" });
  assert.deepEqual(snapshotFailureOf(reply("something with no code")), { kind: "error", code: null });
  for (const fault of [new TypeError("Cannot read properties of null (reading 'name')"), new ReferenceError("x is not defined"), new RangeError("Invalid array length")]) assert.deepEqual(snapshotFailureOf(fault), { kind: "fault" }, fault.name);
  for (const silent of [new Error("Command timed out"), new Error("Connection is closed."), Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" }), null]) assert.equal(snapshotFailureOf(silent), null);
  // The pages read the mark, and the shape before it (a string) the same way.
  assert.deepEqual(unreadCauseOf({}), { kind: "silent", code: null });
  assert.deepEqual(unreadCauseOf({ snapshotFailure: "late" }), { kind: "late", code: null });
  assert.deepEqual(unreadCauseOf({ snapshotFailure: { kind: "error", code: "not a code!" } }), { kind: "error", code: null });
  assert.deepEqual(unreadCauseOf({ snapshotFailure: { kind: "elsewhere" } }), { kind: "silent", code: null });
});

test("a fault of the console's own code is kept as one, and its log names the error and where, never its message", async () => {
  const logs = [];
  const thrower = { snapshot: async () => { const row = null; return row.name; }, fileViews: () => null };
  const data = await loadPageData("overview", {}, { now: () => NOW, fleet: thrower, log: (line) => logs.push(line) }, { role: "operator" });
  assert.deepEqual([data.snapshot, data.readFailed, data.snapshotFailure], [null, true, { kind: "fault" }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^console: the overview page's read of the deployment failed in the console \(TypeError at [\w.$]+ \(console-words-by-cause\.test\.mjs:\d+\)\)$/);
  assert.ok(!logs[0].includes("Cannot read properties"), "never the error's message");
  // Once a minute for one line, by the load's clock: an open page reloads every two seconds.
  for (const at of [NOW + 2_000, NOW + 59_999]) await loadPageData("overview", {}, { now: () => at, fleet: thrower, log: (line) => logs.push(line) }, { role: "operator" });
  assert.equal(logs.length, 1);
  await loadPageData("overview", {}, { now: () => NOW + 60_000, fleet: thrower, log: (line) => logs.push(line) }, { role: "operator" });
  assert.equal(logs.length, 2);
  const words = wordsOf((await renderPage("overview", { query: {}, session: { name: "ops", role: "operator" }, data, theme: null })).html);
  assert.ok(words.includes(`${DEPLOYMENT_UNREAD_WORDS.fault}, so this panel has nothing to show. ${UNREAD_FAULT_TEXT} The next refresh tries again.`));
  assert.ok(!words.includes("Valkey could not be read"), "a console fault is not said of Valkey");
  // A Valkey that did not answer logs nothing and keeps the words it had.
  const quiet = [];
  const outage = await loadPageData("overview", {}, { now: () => NOW, fleet: noSnapshotFleet(), log: (line) => quiet.push(line) }, { role: "operator" });
  assert.deepEqual([outage.snapshotFailure, quiet], [undefined, []]);
});

test("the five banners say the cause: the silent words byte for byte, an error's code and class, a late read and a fault", async () => {
  const view = (snapshotFailure) => ({ data: { snapshot: null, readFailed: true, ...(snapshotFailure ? { snapshotFailure } : {}) } });
  const silent = view(null);
  // Silence: every site's own words, as they were.
  assert.equal(unreadText(silent, { lead: "The deployment's Valkey could not be read", then: "so this panel has nothing to show", retry: "The next refresh tries again." }), SNAPSHOT_MISSING);
  assert.equal(SNAPSHOT_MISSING, OVERVIEW_UNREAD_TEXT);
  assert.equal(unreadText(silent, { then: "so this shows what the file holds and offers no change", retry: "Reload to try again." }), FILES_ONLY_TEXT);
  assert.equal(unreadText(silent, { then: "so this shows what the settings overlay, the triggers file and the .env declare, and offers no change", retry: "Reload to try again." }), SECRETS_FILES_ONLY_TEXT);
  assert.equal(unreadText(silent, { prefix: "Not known: ", then: "so no next fire can be shown" }), "Not known: Valkey could not be read, so no next fire can be shown.");
  // An error of a lasting class: its code, its class and its remedy, and no "try again".
  const wrongtype = unreadText(view({ kind: "error", code: "WRONGTYPE" }), { then: "so this page offers no change", retry: "Reload to try again." });
  assert.equal(wrongtype, "Valkey answered this page's read with WRONGTYPE, so this page offers no change. WRONGTYPE is a key of another type: the key holds another kind of value. Waiting does not change that: an operator has to remove or repair that key first.");
  assert.match(unreadText(view({ kind: "error", code: "NOAUTH" }), { retry: "x" }), /NOAUTH is a permission or sign-in refusal: this connection has not signed in to Valkey\. Waiting does not change that: an operator has to fix the Valkey user and password first\.$/);
  // A passing class keeps its retry, and an unknown code claims nothing of how long it lasts.
  assert.equal(unreadText(view({ kind: "error", code: "BUSY" }), { retry: "Reload to try again." }), "Valkey answered this page's read with BUSY. BUSY is a state that passes: Valkey could not serve the command just then. A later read may succeed. Reload to try again.");
  assert.equal(unreadText(view({ kind: "error", code: "ERR" }), { retry: "Reload to try again." }), "Valkey answered this page's read with ERR. ERR is a reply of no class this console knows, so nothing is said here of how long it lasts. Reload to try again.");
  assert.equal(unreadText(view({ kind: "error", code: null }), { retry: "Reload to try again." }), "Valkey answered this page's read with an error. Reload to try again.");
  // Late, and a fault; a prefix takes the lead in lower case, Valkey's name kept.
  assert.equal(unreadText(view({ kind: "late" }), { prefix: "Next fire and stall count not known: " }), "Next fire and stall count not known: this page could not read the deployment in time.");
  assert.equal(unreadText(view({ kind: "fault" }), { prefix: "Not known: " }), `Not known: this console failed while it read the deployment. ${UNREAD_FAULT_TEXT}`);
  assert.equal(noChangeText(view({ kind: "late" }), "projects file"), "This page could not read the deployment in time, so it offers no change. The projects file can still be changed by hand. Reload to try again.");
  // Each page draws its banner in the cause's words: the overview, Fleet, Configuration, Secrets and Triggers.
  const failure = { kind: "error", code: "WRONGTYPE" };
  for (const [page, says] of [["overview", "so this panel has nothing to show"], ["fleet", ""], ["config", "so this shows what the file holds and offers no change"], ["secrets", "so this shows what the settings overlay"], ["triggers", "Not known: Valkey answered this page's read with WRONGTYPE, so no next fire can be shown"]]) {
    const data = await loadPageData(page, {}, { now: () => NOW, fleet: noSnapshotFleet({ snapshot: async () => { throw reply("WRONGTYPE Operation against a key holding the wrong kind of value"); } }), env: {} }, { role: "operator" });
    assert.deepEqual(data.snapshotFailure, failure, page);
    const words = wordsOf((await renderPage(page, { query: {}, session: { name: "ops", role: "operator" }, data, theme: null })).html);
    assert.ok(words.includes("Valkey answered this page's read with WRONGTYPE") && words.includes(says), `${page}: ${words.slice(0, 600)}`);
    assert.ok(!words.includes("Valkey could not be read"), `${page}: not said of a Valkey that answered`);
    assert.ok(!/WRONGTYPE[^.]*\. [^.]*\.[^.]*(?:The next refresh tries again|Reload to try again)/.test(words.replace(/Shown as last seen at[^]*?The next refresh tries again\./, "")), `${page}: no retry over a cause that waiting does not end`);
  }
  const headline = await loadPageData("overview", {}, { now: () => NOW, fleet: noSnapshotFleet() }, { role: "operator" });
  assert.ok(wordsOf((await renderPage("overview", { query: {}, session: { name: "ops", role: "operator" }, data: headline, theme: null })).html).includes(OVERVIEW_UNREAD_HEADLINE), "the overview's line, silent, as it was");
});

test("an agent's copy keeps the cause and the code, so its page says what an operator's says", () => {
  assert.deepEqual(agentReadProjection({ snapshotFailure: { kind: "error", code: "WRONGTYPE" } }).snapshotFailure, { kind: "error", code: "WRONGTYPE" });
  assert.deepEqual(agentReadProjection({ snapshotFailure: { kind: "fault", code: "<b>" } }).snapshotFailure, { kind: "fault", code: null });
  assert.equal(agentReadProjection({ snapshotFailure: { kind: "anything" } }).snapshotFailure, undefined);
});

test("a trigger's skew: not known over a check that saw none, a floor over one that saw some, and a count that agrees with its noun", () => {
  const change = (skewed, skewIncomplete) => wordsOf(triggerChange({ query: { index: 0 }, role: "viewer", data: { snapshot: { triggers: { triggers: [] } }, triggerDetail: { trigger: { type: "label", index: 0 }, skewed, skewIncomplete } } }));
  assert.ok(change([], true).includes(SKEW_UNKNOWN_TEXT) && !change([], true).includes("At least 0"));
  assert.ok(change([{ jobId: "gh-1" }], true).includes("At least 1 job in view would be refused now. The queue check was incomplete."));
  assert.ok(change([{ jobId: "gh-1" }, { jobId: "gh-2" }], false).includes("2 jobs in view would be refused now."));
  assert.ok(change([{ jobId: "gh-1" }], false).includes("1 job in view would be refused now."));
  assert.ok(change([], false).includes("0 jobs in view would be refused now."), "a check read whole that saw none: zero");
});

test("?trigger= finds a forge trigger's runs by its row and its identity, and a row alone still finds by row and says so", () => {
  const label = { jobId: "gh-1", kind: "github", triggerIndex: 3, triggerType: "label" };
  const other = { jobId: "gh-2", kind: "github", triggerIndex: 3, triggerType: "comment" };
  assert.equal(triggerFilterValueOf(label), "3:github:label");
  assert.deepEqual(triggerIdentityOf("3:github:label"), { index: 3, kind: "github", type: "label" });
  assert.equal(triggerIdentityOf("3:nowhere:label"), null, "a forge this build knows");
  assert.equal(parseRunFilter({ trigger: "3:github:label" }).filter.trigger, "3:github:label");
  assert.ok(parseRunFilter({ trigger: "3:nowhere:label" }).refusal, "refused by name");
  const byIdentity = parseRunFilter({ trigger: "3:github:label" }).filter;
  assert.deepEqual([runMatches(label, byIdentity), runMatches(other, byIdentity)], [true, false], "another trigger that held row 3 is not this one");
  const byRow = parseRunFilter({ trigger: "3" }).filter;
  assert.deepEqual([runMatches(label, byRow), runMatches(other, byRow)], [true, true], "an old link still finds by row");
  // A record without its type (from before it was recorded) is offered by row, as before.
  assert.equal(triggerFilterValueOf({ kind: "github", triggerIndex: 3 }), "3");
  assert.equal(triggerFilterValueOf({ kind: "local", jobId: "repeat:nightly:1" }), "nightly");
  const foot = (trigger) => runsTableModel({ query: { filter: { trigger } }, data: { runsPage: { runs: [label], mirror: "ok", next: null } } }).foot;
  assert.ok(foot("3").includes(RUNS_TRIGGER_ROW_ONLY));
  assert.ok(!foot("3:github:label").includes(RUNS_TRIGGER_ROW_ONLY) && !foot("nightly").includes(RUNS_TRIGGER_ROW_ONLY));
});

test("an agent's copy keeps a mirror cut at its bound apart from one read whole, and a host row's slot count", () => {
  assert.equal(agentReadProjection({ mirror: "truncated" }).mirror, "truncated");
  assert.equal(mirrorStateOf(agentReadProjection({ mirror: "truncated" }).mirror), "cut", "an agent's page says what an operator's says of it");
  assert.equal(agentReadProjection({ mirror: "ok" }).mirror, "bounded");
  assert.equal(mirrorStateOf("bounded"), "read");
  assert.equal(agentReadProjection({ mirror: "unreachable (Command timed out)" }).mirror, "unreachable");
  assert.deepEqual(agentReadProjection({ hostBudgets: [{ name: "build3", concurrency: "3" }, { name: "build4", concurrency: "<b>" }] }).hostBudgets, [{ name: "build3", concurrency: "3" }, { name: "build4", concurrency: null }]);
});

test("a queue's refusal says its code through the shared words: the key and its remedy, or that waiting may end it", () => {
  assert.equal(queueErroredRefusal("pi-jobs@hostb", "WRONGTYPE"), "pi-jobs@hostb could not be read: Valkey answers bull:pi-jobs@hostb:meta with WRONGTYPE, so whether it is paused is not known here. Remove or repair that key first; nothing was changed");
  assert.equal(queueErroredRefusal("pi-jobs@hostb", "NOPERM"), "pi-jobs@hostb could not be read: Valkey answers bull:pi-jobs@hostb:meta with NOPERM, so whether it is paused is not known here. Fix this Valkey user's ACL first; nothing was changed");
  assert.equal(queueErroredRefusal("pi-jobs@hostb", "BUSY", true), "the counts of pi-jobs@hostb could not be read: Valkey answers the read of its counts with BUSY. It is paused, and what the switch would change there is not known here. A later read may succeed; nothing was changed");
  assert.equal(queueErroredRefusal("pi-jobs@hostb", "ERR", false), "the counts of pi-jobs@hostb could not be read: Valkey answers the read of its counts with ERR. It is running, and what the switch would change there is not known here; nothing was changed");
});

test("a refused run's host with no row over a registry read in part: read in part only where that read may have missed it", async () => {
  const host = async (record) => {
    const got = await drawn("run", `id=${record.jobId}`, consoleOn({ redis: erroringKey(healthy(HOST), /^host:h:build3$/), records: [RUN, record] }), "operator");
    const at = got.words.indexOf("The host Host");
    return got.words.slice(at, got.words.indexOf("Open Fleet", at));
  };
  // build3's row is the one the read named as not read: read in part, as before.
  assert.match(await host(REFUSED), /Heartbeat not read this time: the host registry was read in part/);
  // A host the registry does not list, beside a read that named every host it missed: it has no row, as over a whole read.
  const gone = await host({ ...REFUSED, jobId: "gh-9", host: "gone" });
  assert.match(gone, /Heartbeat no live registry row for gone/);
  assert.ok(!gone.includes("read in part"), gone);
  // The control: with the registry not read at all, nothing is said to be absent.
  const unread = await drawn("run", "id=gh-9", consoleOn({ redis: failing(healthy(HOST), ["smembers"]), records: [RUN, { ...REFUSED, jobId: "gh-9", host: "gone" }] }), "operator");
  assert.ok(!unread.words.includes("no live registry row for gone"));
});
