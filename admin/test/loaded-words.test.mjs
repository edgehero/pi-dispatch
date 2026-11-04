import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { hostsAgree } from "@edgehero/pi-dispatch/host-loads";
import { manualCanaryJobId } from "../../worker/src/job-id.mjs";
import { recordedLoaded } from "../../worker/src/loaded-record.mjs";
import { buildRecord } from "../../worker/src/run-history.mjs";
import { HOSTS_OFFERED, LOADED_STATES, LOADED_WORDS, hostLoadsRow, hostPiFor, isOutcomeNote, loadedFold, loadedOf, loadedProblems, loadedRows, loadedVerdict, outcomeBanner, outcomeNote, projectLoadsOf, runningVerdict, sandboxFreshLine, sandboxRunLine, wordsText } from "../src/loaded-words.mjs";
import { outcomeKey } from "../src/words.mjs";
import { failedOverlayEntries, heldBackOverlay, recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { HOST_LOADS, HOSTILE_LOADED, LOADED_SAMPLES as S, SCRIPT, billingRecords, incompleteRecords, loadedField, loadedRecord, source, webRecords } from "./helpers/loaded-samples.mjs";

// Issue #800, the words every surface reads for what a run loaded. The cards draw these lines (RunLoaded, LoadedStates,
// ProjectLoads), so where a sentence here is the card's it is checked word for word, and where it is not the test says why.
// What the pages do with them is console-loaded.test.mjs's.

const lineOf = (v) => [v.lead, v.bold, v.rest, ...v.then.flatMap((part) => [part.bold, part.rest])].filter(Boolean).join(" ");
const fixLabels = (entry) => entry.fixes.map((fix) => fix.label);
const onlyRecorded = () => loadedRecord({ jobId: "gh-only" });
const BASE_BUTTON = "Open the base commit a41c0d2";

test("each state of the LoadedStates card, in its words, tone and way to where it is fixed", () => {
  const want = [
    [S.everything(), "everything", "ok", "Everything trigger 3 asks for loaded.", []],
    [S.leftOut(), "left-out", "ok", "Everything trigger 2 asks for loaded. Left out, as it asks: bash, and the staged packages.", []],
    [S.leftOutOverlay(), "left-out", "ok", "Everything trigger 4 asks for loaded. Left out for this job: the overlay’s extensions.", []],
    [S.mcpConnected(), "everything", "ok", "Everything trigger 7 asks for loaded.", []],
    [S.dropped(), "everything", "ok", "Everything trigger 3 asks for loaded.", []],
    [S.cut(), "everything", "ok", "Everything trigger 3 asks for loaded.", []],
    [S.noFlow(), "no-flow", "attention", "Ran without its flow. pi found no skill named fix: not in acme/api at its base commit, nor in a skills folder, the overlay or a staged package.", ["Open trigger 3", BASE_BUTTON]],
    [S.mcpFailed(), "mcp-failed", "refused", "linear could not be used. The run stopped before the agent started, after its extensions and skills had loaded.", ["Open Connections"]],
    [S.mcpTimeout(), "mcp-stopped", "failed", "linear did not answer in time. The run stopped before the agent started.", ["Open Connections"]],
    [S.notRecorded(), "not-recorded", "idle", "Not recorded: an older release wrote this run’s record.", []],
    [S.refused(), "refused", "idle", "Nothing loaded: it was refused before its container started.", []],
  ];
  for (const [record, state, tone, words, fixes] of want) {
    const v = loadedVerdict(record, HOST_LOADS);
    assert.equal(v.state, state, record.jobId);
    assert.ok(LOADED_STATES.includes(v.state));
    assert.equal(v.tone, tone, record.jobId);
    assert.equal(lineOf(v), words, record.jobId);
    assert.deepEqual(fixLabels(v), fixes, record.jobId);
  }
  assert.deepEqual(loadedVerdict(S.mcpConnected()).small, ["MCP: linear connected, with 12 tools."]);
  assert.deepEqual(loadedVerdict(S.cut()).small, ["Cut to fit: this record keeps the counts and leaves out package, overlay and tool names."]);
  assert.deepEqual(loadedVerdict(S.mcpFailed()).small, ["Not retried: the next attempt would find it the same."]);
});

test("a repository extension's fix names the commit a record names, and says the repository where it names none", () => {
  assert.deepEqual(fixLabels(loadedVerdict(S.extensionFailed())), [BASE_BUTTON]);
  const { baseSha: _sha, ...older } = S.extensionFailed().loaded;
  assert.deepEqual(fixLabels(loadedVerdict({ ...S.extensionFailed(), loaded: older })), ["Open the repository"]);
  // Another tier's problem is fixed elsewhere, whatever commit the run was at.
  const overlay = loadedRecord({ target: "acme/api#120", host: "mini2", loaded: loadedField({ sources: [source("overlay", { failed: 1, failedNames: ["git-guard"] }), source("repository"), source("trigger"), source("other")], problems: { failed: 1, dropped: 0, mcp: 0 } }) });
  assert.deepEqual(fixLabels(loadedVerdict(overlay)), ["Open mini2"]);
  // No field a record's rebuild refuses reaches the words as a commit.
  const bad = { ...S.extensionFailed(), loaded: { ...S.extensionFailed().loaded, baseSha: "<script>" } };
  assert.deepEqual(fixLabels(loadedVerdict(bad)), ["Open the repository"]);
});

test("the words read the record's module through the worker's exports, as every other worker module in admin/src is read", () => {
  const dir = new URL("../src/", import.meta.url);
  const byPath = readdirSync(dir, { recursive: true }).filter((file) => /\.(?:mjs|ts)$/.test(file)).filter((file) => /from\s+"[^"]*worker\/src\//.test(readFileSync(new URL(file, dir), "utf8")));
  assert.deepEqual(byPath, []);
});

test("the extension that failed: a total is said only where it is known, because a conflicted extension counts on both sides", () => {
  // pi 1.5.0 keeps a conflicted extension loaded and reports it too, so `extensions: 2, failed: 1` is either two extensions
  // with one conflicted, or three with one thrown. The record keeps no kind, so "1 of 3" and "1 of 2" are both guesses.
  const of = (repository) => loadedRecord({ target: "acme/api#120", loaded: loadedField({ sources: [source("overlay"), source("repository", repository), source("trigger"), source("other")], problems: { failed: repository.failed, dropped: 0, mcp: 0 } }) });
  assert.equal(lineOf(loadedVerdict(S.extensionFailed())), "1 of acme/api’s extensions failed to load. The run went on.");
  for (const extensions of [1, 2, 5]) {
    const v = loadedVerdict(of({ extensions, failed: 1 }));
    assert.equal(lineOf(v), "1 of acme/api’s extensions failed to load. The run went on.", "no total, and no 'without it'");
  }
  // Nothing loaded from that tier: nothing can be both, so the total is known, and the run went on without them.
  assert.equal(lineOf(loadedVerdict(S.extensionThrown())), "The extension from acme/api failed to load. The run went on without it.");
  assert.equal(lineOf(loadedVerdict(of({ extensions: 0, failed: 3 }))), "All 3 extensions from acme/api failed to load. The run went on without them.");
  assert.equal(loadedVerdict(S.extensionFailed()).fixes[0].kind, "repository");
  assert.equal(outcomeBanner(S.extensionFailed()).fixes[0].kind, "repository");
});

test("a failed overlay extension goes to its host, a package's to Updates, and several tiers are each named", () => {
  const record = (sources, failed) => loadedRecord({ host: "mini2", loaded: loadedField({ sources: [...sources, source("trigger"), source("other")], problems: { failed, dropped: 0, mcp: 0 } }) });
  const overlay = loadedVerdict(record([source("overlay", { names: ["ok.ts"], failedNames: ["broken.js"], extensions: 1, failed: 1 }), source("repository")], 1));
  assert.equal(lineOf(overlay), "1 of mini2’s overlay extensions failed to load. The run went on. broken.js.");
  assert.deepEqual(overlay.fixes, [{ kind: "host", label: "Open mini2", icon: "fleet", href: "/fleet/host?name=mini2" }]);
  const staged = loadedVerdict(record([source("package", { name: "pi-lint", version: "1.4.2", extensions: 1, failed: 1 }), source("overlay"), source("repository")], 1));
  assert.equal(staged.fixes[0].href, "/config/updates");
  const both = loadedVerdict(record([source("overlay", { failedNames: ["broken.js"], failed: 1 }), source("repository", { failed: 2 })], 3));
  assert.equal(lineOf(both), "3 of this run’s extensions failed to load. 1 from mini2’s overlay and 2 from acme/web. The run went on.");
  // Each tier is fixed in its own place, and two failures of one kind are one place.
  assert.deepEqual(fixLabels(both), ["Open mini2", BASE_BUTTON]);
  assert.deepEqual(fixLabels(outcomeBanner(record([source("overlay", { failedNames: ["broken.js"], failed: 1 }), source("repository", { failed: 2 })], 3))), ["Open mini2", BASE_BUTTON]);
  const twoPackages = loadedVerdict(record([source("package", { name: "pi-lint", version: "1.4.2", failed: 1 }), source("package", { name: "pi-docs", version: "1.0.0", failed: 1 }), source("overlay"), source("repository")], 2));
  assert.deepEqual(fixLabels(twoPackages), ["Open Updates"]);
  assert.deepEqual(fixLabels(loadedVerdict(S.twoTiers())), ["Open Updates", BASE_BUTTON]);
  // The minimal form keeps the total and not where.
  const minimal = loadedVerdict(loadedRecord({ loaded: loadedField({ cut: { form: "minimal", packages: 0, servers: 0, names: 0, counts: 0 }, sources: [], mcp: null, tools: null, problems: { failed: 2, dropped: 0, mcp: null } }) }));
  assert.equal(lineOf(minimal), "2 extensions failed to load. The run went on. This record was cut to fit, so it does not say which.");
  assert.deepEqual(minimal.fixes, []);
});

test("a retry is claimed only where the record or the queue shows one", () => {
  const first = { ...S.mcpTimeout(), attempt: 1 };
  const small = (record, jobState = null) => loadedVerdict(record, null, { jobState }).small;
  // The queue holds the job again, or is running it: it was retried.
  for (const jobState of ["waiting", "delayed", "prioritized", "paused", "active"]) assert.deepEqual(small(first, jobState), [LOADED_WORDS.retried], jobState);
  // A later attempt is itself a retry, whatever the queue no longer says.
  assert.deepEqual(small(S.mcpTimeout()), [LOADED_WORDS.retried]);
  // The queue says it failed, which shows it has stopped retrying and gives no total: attempt 1 and attempt 2 of 3 read alike, and neither is called the last.
  assert.deepEqual(small(first, "failed"), ["The queue has stopped retrying this job."]);
  assert.deepEqual(small(S.mcpTimeout(), "failed"), ["Retried, as any infrastructure failure; the queue has stopped retrying this job."]);
  assert.doesNotMatch(JSON.stringify(LOADED_WORDS), /last attempt/);
  // Neither shows one: the job is gone from the queue, or the read failed. It says what the queue does, and nothing of this run.
  for (const jobState of [null, "completed", "unknown"]) assert.deepEqual(small(first, jobState), ["The queue retries an infrastructure failure while it has attempts left."], String(jobState));
  assert.deepEqual(small({ ...first, attempt: undefined }), [LOADED_WORDS.retriedRule], "a record with no attempt");
});

test("a failed MCP server stops the run: never a completed run's note, and no line says the run went on", () => {
  for (const record of [S.mcpFailed(), S.mcpTimeout()]) {
    assert.equal(outcomeNote(record), null);
    assert.deepEqual(loadedProblems(record), []);
    assert.ok(!lineOf(loadedVerdict(record)).includes("went on"));
    assert.equal(loadedVerdict(record).fixes[0].href, "/config/connections");
  }
  // "Its last attempt" only when the queue says so: an infrastructure failure writes a record per attempt.
  assert.deepEqual(loadedVerdict(S.mcpTimeout()).small, ["Retried, as any infrastructure failure."]);
  assert.deepEqual(loadedVerdict(S.mcpTimeout(), null, { jobState: "failed" }).small, [LOADED_WORDS.retriedStopped]);
  // A record cut to its minimal form still says, by its outcome, which of the two it was.
  const minimal = (over) => loadedRecord({ ...over, loaded: loadedField({ at: "session", cut: { form: "minimal", packages: 0, servers: 0, names: 0, counts: 0 }, sources: [], mcp: null, tools: null, problems: { failed: 0, dropped: 0, mcp: 1 } }) });
  assert.equal(loadedVerdict(minimal({ outcome: "failed", reason: "container-infra-exit", exitCode: 1 })).state, "mcp-stopped");
  assert.equal(loadedVerdict(minimal({ outcome: "policy", reason: "mcp-unavailable", exitCode: 2 })).state, "mcp-failed");
});

test("a run that stopped did not run: its line says what was found and what failed, and never that it went on", () => {
  const noFlow = { flow: { tier: "none", package: null } };
  const failed = { sources: [source("overlay"), source("repository", { failed: 1 }), source("trigger"), source("other")], problems: { failed: 1, dropped: 0, mcp: 1 } };
  const stoppedByServer = (over) => loadedRecord({ outcome: "policy", reason: "mcp-unavailable", exitCode: 2, loaded: loadedField({ at: "session", mcp: [{ name: "linear", state: "failed", tools: 0 }], problems: { failed: 0, dropped: 0, mcp: 1 }, ...over }) });
  const flowLine = loadedVerdict(stoppedByServer(noFlow));
  assert.equal(flowLine.state, "mcp-failed");
  assert.equal(flowLine.also[0].bold, "Its flow was found nowhere.");
  assert.equal(flowLine.also[0].rest, "pi found no skill named fix: not in acme/web at its base commit, nor in a skills folder, the overlay or a staged package.");
  const extensionLine = loadedVerdict(stoppedByServer(failed));
  assert.equal(extensionLine.also[0].bold, "The extension from acme/web failed to load.");
  assert.equal(extensionLine.also[0].rest, "");
  // Stopped at the loader, with nothing about a server to say so.
  const atLoader = (over) => loadedRecord({ outcome: "failed", reason: "container-infra-exit", exitCode: 1, tokens: null, loaded: loadedField({ at: "loader", mcp: null, tools: null, ...over }) });
  const loaderFlow = loadedVerdict(atLoader(noFlow));
  assert.equal(lineOf(loaderFlow), "Its flow was found nowhere. pi found no skill named fix: not in acme/web at its base commit, nor in a skills folder, the overlay or a staged package.");
  assert.deepEqual(fixLabels(loaderFlow), ["Open trigger 3", BASE_BUTTON]);
  assert.equal(lineOf(loadedVerdict(atLoader({ sources: [source("overlay"), source("repository", { extensions: 2, failed: 1 }), source("trigger"), source("other")], problems: { failed: 1, dropped: 0, mcp: null } }))), "1 of acme/web’s extensions failed to load.");
  const manyAtLoader = loadedVerdict(atLoader({ sources: [source("overlay", { failed: 1, failedNames: ["b.js"] }), source("repository", { failed: 2 }), source("trigger"), source("other")], problems: { failed: 3, dropped: 0, mcp: null } }));
  assert.equal(lineOf(manyAtLoader), "3 of this run’s extensions failed to load. 1 from mini1’s overlay and 2 from acme/web.");
  const minimalAtLoader = loadedVerdict(atLoader({ cut: { form: "minimal", packages: 0, servers: 0, names: 0, counts: 0 }, sources: [], problems: { failed: 2, dropped: 0, mcp: null } }));
  assert.equal(lineOf(minimalAtLoader), "2 extensions failed to load. This record was cut to fit, so it does not say which.");
  for (const v of [flowLine, extensionLine, loaderFlow, manyAtLoader, minimalAtLoader]) {
    const words = [lineOf(v), ...v.also.flatMap((entry) => [entry.bold, entry.rest])].join(" ");
    assert.doesNotMatch(words, /went on|Ran without/, words);
  }
  // Failing it at the tier a real line can carry it, with no turn on the record.
  assert.equal(loadedVerdict(loadedRecord({ outcome: "failed", reason: "timeout", exitCode: 124, turns: 0, loaded: loadedField({ ...failed, problems: { failed: 1, dropped: 0, mcp: 0 } }) })).bold, "The extension from acme/web failed to load.");
});

// Each exit-2 path after the `ready` note in `run-job.mjs`, by what its line carries. The runner's reason is often not the record's: the worker keeps
// only `RUNNER_POLICY_REASONS`, so `command-unregistered` and `turn_budget` both read `runner-policy`, told apart only by the turns on the line.
/** The `tokens` of an exit line, as the real meter's snapshot holds them. */
const meterSnapshot = (calls, total) => ({ input: total, output: 0, total, cost: 0, metered: true, rootTotal: total, otherTotal: 0, looseTotal: 0, sessions: 1, calls, unresolved: 0, unpriced: 0, costUnreported: 0 });

const AFTER_READY_EXIT_2 = Object.freeze([
  // Its catch path writes no turns, so the record holds null.
  { name: "a command no extension registers", exit: { code: 2, reason: "command-unregistered", message: "no such command" }, record: { reason: "runner-policy", turns: null }, wentOn: false },
  // The same, after a call an extension made while it loaded, which that line carries so the spend is not hidden (`meteredExitFields`).
  { name: "a command no extension registers, after a call at load", exit: { code: 2, reason: "command-unregistered", message: "no such command", tokens: meterSnapshot(1, 300) }, record: { reason: "runner-policy", turns: null }, wentOn: false },
  // A stop made by a call an extension made while it loaded: the prompt is never sent (`decideExit`'s meterStop, with no turn taken).
  { name: "a cost cap at load", exit: { code: 2, reason: "cost-cap", message: "over", tokens: meterSnapshot(1, 300) }, turnsOnLine: 0, record: { reason: "cost-cap", turns: 0 }, wentOn: false },
  { name: "a model refused at load", exit: { code: 2, reason: "model-not-allowed", message: "no", tokens: meterSnapshot(1, 0) }, turnsOnLine: 0, record: { reason: "model-not-allowed", turns: 0 }, wentOn: false },
  // A provider that refuses the credential on the first prompt, as pi's own loop at the pin, the real `attachTurnBudget` and the real
  // meter write it: the turn started and the call went out, so both count, and no token came back.
  { name: "a credential refused on the first prompt", exit: { code: 2, reason: "provider-auth-refused", message: "401", tokens: meterSnapshot(1, 0) }, turnsOnLine: 1, record: { reason: "provider-auth-refused", turns: 1 }, wentOn: false },
  // These took turns and got answers, so they went on.
  { name: "the turn budget", exit: { code: 2, reason: "turn_budget", message: "over", tokens: meterSnapshot(20, 90_000) }, turnsOnLine: 20, record: { reason: "runner-policy", turns: 20 }, wentOn: true },
  { name: "a cost cap mid-run", exit: { code: 2, reason: "cost-cap", message: "over", tokens: meterSnapshot(9, 40_000) }, turnsOnLine: 9, record: { reason: "cost-cap", turns: 9 }, wentOn: true },
]);

test("every exit-2 path after ready, as a real record: only a run that took a turn a provider answered reads as having loaded everything, and none reads as stopped by its reason", async () => {
  const runner = readFileSync(new URL("../../image/runner/run-job.mjs", import.meta.url), "utf8");
  const readyAt = runner.indexOf('loaded.record("ready", liveTools);');
  const promptAt = runner.indexOf("await session.prompt(prompt);");
  assert.ok(readyAt > 0 && readyAt < promptAt, "the runner's notes are where this test reads them");
  // A new refusal after `ready` fails here, until it is added to the paths above and read through the pipeline.
  assert.deepEqual([...runner.slice(readyAt, promptAt).matchAll(/configError\(\s*(?:`[^`]*`|"[^"]*"),\s*"([a-z-]+)",?\s*\)/g)].map((match) => match[1]), ["command-unregistered"]);
  for (const path of AFTER_READY_EXIT_2) {
    const record = await recordThroughPipeline({ exit: path.exit, turnsOnLine: path.turnsOnLine });
    assert.equal(record.outcome, "policy", path.name);
    assert.equal(record.exitCode, 2, path.name);
    assert.equal(record.reason, path.record.reason, path.name);
    assert.equal(record.turns, path.record.turns, path.name);
    assert.equal(record.loaded.at, "ready", path.name);
    const v = loadedVerdict(record);
    if (path.wentOn) {
      assert.equal(v.state, "everything", path.name);
      assert.equal(v.rest, "Everything trigger 3 asks for loaded.", path.name);
    } else {
      assert.equal(v.state, "stopped", path.name);
      assert.equal(v.tone, "idle", path.name);
      assert.equal(v.rest, "It stopped after loading. The outcome above says what can stop a run this way.", path.name);
    }
  }
  // What a problem says of the same paths: said as found and failed, with nothing of going on, until a turn shows it.
  const noFlow = await recordThroughPipeline({ exit: { code: 2, reason: "cost-cap", message: "over" }, turnsOnLine: 0, flowFound: false });
  assert.equal(noFlow.loaded.flow.tier, "none");
  assert.equal(loadedVerdict(noFlow).bold, LOADED_WORDS.flowNowhere);
  const failure = [{ root: "/opt/pi-global/packages/pi-lint", kind: "load" }];
  const lost = await recordThroughPipeline({ exit: { code: 2, reason: "command-unregistered", message: "no such command" }, failures: failure });
  assert.equal(lost.loaded.problems.failed, 1);
  assert.doesNotMatch([loadedVerdict(lost).bold, loadedVerdict(lost).rest].join(" "), /went on|Ran without/);
  const ranThenStopped = await recordThroughPipeline({ exit: { code: 2, reason: "cost-cap", message: "over", tokens: meterSnapshot(3, 12_000) }, turnsOnLine: 3, flowFound: false });
  assert.equal(loadedVerdict(ranThenStopped).bold, LOADED_WORDS.ranWithoutFlow);
});

test("a run stopped before ready never reads as everything, whatever brought it there", async () => {
  const runner = readFileSync(new URL("../../image/runner/run-job.mjs", import.meta.url), "utf8");
  const sessionAt = runner.indexOf('loaded.record("session", liveTools);');
  const readyAt = runner.indexOf('loaded.record("ready", liveTools);');
  const reasons = [...runner.slice(sessionAt, readyAt).matchAll(/configError\(\s*(?:`[^`]*`|"[^"]*"),\s*"([a-z-]+)",?\s*\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(reasons)].sort(), ["approval-shadowed", "await-input-shadowed", "mcp-shadowed", "model-roles-shadowed", "report-progress-shadowed"]);
  for (const reason of reasons) {
    const record = await recordThroughPipeline({ stages: ["start", "loader", "session"], exit: { code: 2, reason, message: "another extension" } });
    assert.equal(record.loaded.at, "session", reason);
    assert.equal(record.turns, null, reason);
    const v = loadedVerdict(record);
    assert.equal(v.state, "stopped", reason);
    assert.equal(v.rest, "It stopped after its extensions and skills loaded, before the agent started.", reason);
  }
  const atLoader = await recordThroughPipeline({ stages: ["start", "loader"], exit: { code: 1, reason: "crash", message: "x" } });
  assert.equal(loadedVerdict(atLoader).rest, LOADED_WORDS.stoppedLoader);
  assert.equal(Object.hasOwn(loadedVerdict(S.stoppedBeforeServers()), "short"), false, "nothing printed it, so a word about a run has one less place to be wrong");
});

test("a run that went on with its list stuck at an earlier stage says it went on: a broken report is no stop", async () => {
  // `createLoadedRecorder` catches a throw from its facts and keeps the last note, so a repository extension can leave `session` or `loader` on a run that carries on.
  const clean = { code: 0, reason: "stop" };
  for (const [brokenAt, at] of [[["ready"], "session"], [["session", "ready"], "loader"], [["loader", "session", "ready"], "start"]]) {
    const record = await recordThroughPipeline({ brokenAt, exit: clean, turnsOnLine: 14 });
    assert.equal(record.outcome, "completed");
    assert.equal(record.turns, 14);
    assert.equal(record.loaded.at, at);
    const v = loadedVerdict(record);
    assert.notEqual(v.state, "stopped", at);
    assert.doesNotMatch(lineOf(v), /stopped|before the agent/i, at);
  }
  const session = await recordThroughPipeline({ brokenAt: ["ready"], exit: clean, turnsOnLine: 14 });
  assert.equal(loadedVerdict(session).state, "everything");
  assert.deepEqual(loadedVerdict(session).small, [LOADED_WORDS.notedEarly]);
  // At `start` there is no list at all, so it says that.
  const start = await recordThroughPipeline({ brokenAt: ["loader", "session", "ready"], exit: clean, turnsOnLine: 14 });
  assert.equal(loadedVerdict(start).state, "absent");
  // A flow pi did not find, under a banner that says completed, reads the same as the banner.
  const noFlow = await recordThroughPipeline({ brokenAt: ["ready"], flowFound: false, exit: clean, turnsOnLine: 14 });
  assert.equal(loadedVerdict(noFlow).bold, LOADED_WORDS.ranWithoutFlow);
  assert.equal(outcomeNote(noFlow), "Completed, without its flow");
  assert.deepEqual(loadedVerdict(noFlow).small, [LOADED_WORDS.notedEarly]);
  // The rows do not say a run that went on stopped.
  const atLoader = await recordThroughPipeline({ brokenAt: ["session", "ready"], exit: clean, turnsOnLine: 14 });
  const rows = Object.fromEntries(loadedRows(atLoader).map((row) => [row.label, wordsText(row.more)]));
  assert.equal(rows.MCP, LOADED_WORDS.notedEarlyRow);
  assert.equal(rows.Tools, LOADED_WORDS.notedEarlyRow);
  assert.equal(wordsText(loadedRows(S.stopped()).find((row) => row.label === "MCP").more), "the run stopped before its servers started", "a run that did stop still says so");
  // A server still pending on a run that went on was an early note: it would have stopped otherwise. The fold reads the same.
  const pending = loadedRecord({ turns: 14, loaded: loadedField({ at: "session", mcp: [{ name: "linear", state: "pending", tools: 0 }] }) });
  assert.equal(loadedVerdict(pending).state, "everything");
  assert.equal(wordsText(loadedRows(pending).find((row) => row.label === "MCP").value), "linear had not connected when this was noted");
  assert.equal(wordsText(loadedFold(pending).find((row) => row.kind === "MCP server").from), "had not connected when this was noted");
  assert.equal(wordsText(loadedRows({ ...pending, turns: null, tokens: null, outcome: "failed" }).find((row) => row.label === "MCP").value), "linear had not connected");
});

test("a name leads no sentence, so none takes a capital that is not its spelling: the commonest failure, on each tier", () => {
  const thrown = (tier, over = {}) => {
    const sources = ["overlay", "repository", "trigger", "other"].map((name) => (name === tier ? source(name, { failed: 1, ...over }) : source(name)));
    return loadedRecord({ host: "mini1", loaded: loadedField({ sources: tier === "package" ? [source("package", { name: "pi-lint", version: "1.4.2", failed: 1 }), ...sources] : sources, problems: { failed: 1, dropped: 0, mcp: 0 } }) });
  };
  assert.equal(lineOf(loadedVerdict(thrown("repository"))), "The extension from acme/web failed to load. The run went on without it.");
  assert.equal(lineOf(loadedVerdict(thrown("package"))), "The extension from pi-lint failed to load. The run went on without it.");
  assert.equal(lineOf(loadedVerdict(thrown("overlay", { failedNames: ["b.ts"] }))), "The extension from mini1’s overlay failed to load. The run went on without it. b.ts.");
  assert.equal(lineOf(loadedVerdict(thrown("trigger"))), "The extension from the skills folder failed to load. The run went on without it.");
  assert.deepEqual(outcomeBanner(thrown("repository")).sentences, ["The extension from acme/web failed to load. The extension failed while it loaded and the run went on without it. Read what it did before you trust it."]);
});

test("a flow not found says what pi found, not what the repository holds, and offers the commit it could read to see why", () => {
  const record = S.noFlow();
  assert.equal(outcomeBanner(record).sentences[0], "pi found no skill named fix: not in acme/api at its base commit, nor in a skills folder, the overlay or a staged package. Read what it did before you trust it.");
  assert.deepEqual(fixLabels(outcomeBanner(record)), ["Open trigger 3", BASE_BUTTON]);
  assert.deepEqual(outcomeBanner(record).fixes.map((fix) => fix.kind), ["trigger", "repository"]);
  // A trigger that withholds the staged packages did not look in them, and a folder has no commit to offer.
  const withheld = loadedRecord({ loaded: loadedField({ flow: { tier: "none", package: null }, leftOut: { tools: [], packages: true, overlayExtensions: false, restricted: false } }) });
  assert.equal(loadedVerdict(withheld).rest, "pi found no skill named fix: not in acme/web at its base commit, nor in a skills folder or the overlay. The trigger withholds the staged packages.");
  const local = { ...S.noFlow(), kind: "local", target: "local:site" };
  assert.equal(loadedVerdict(local).rest, "pi found no skill named fix: not in this folder, nor in a skills folder, the overlay or a staged package.");
  assert.deepEqual(fixLabels(loadedVerdict(local)), ["Open trigger 3"]);
  // A flow's name the worker's rule refuses is never printed.
  assert.match(loadedVerdict({ ...S.noFlow(), flow: SCRIPT }).rest, /^pi found no such skill: not in acme\/api/);
});

test("what no card names keeps saying the truth: off, pending, a stage that loaded nothing, and each way a record is not read", () => {
  // No worker can write a server turned off: its pickup check refuses one and writes the document from that same read. So a
  // line that says so is forged, and reads as one, rather than say "the run went on without it" of a run that cannot have.
  const off = loadedRecord({ loaded: loadedField({ mcp: [{ name: "linear", state: "disabled", tools: 0 }] }) });
  assert.equal(loadedOf(off).runner, "invalid");
  assert.equal(loadedVerdict(off).state, "invalid");
  assert.deepEqual(loadedRows(off), []);
  assert.equal(outcomeNote(off), null);
  const connecting = loadedVerdict(loadedRecord({ outcome: "failed", exitCode: 1, reason: "container-infra-exit", tokens: null, loaded: loadedField({ at: "session", mcp: [{ name: "linear", state: "pending", tools: 0 }] }) }));
  assert.equal(connecting.state, "stopped");
  assert.equal(connecting.rest, LOADED_WORDS.stoppedServers);
  // A `-shadowed` refusal comes before the servers start, though their rows read pending: run-job.mjs throws first.
  assert.equal(loadedVerdict(S.stoppedBeforeServers()).state, "stopped");
  assert.equal(loadedVerdict(S.stoppedBeforeServers()).rest, "It stopped before its MCP servers started.");
  for (const reason of ["approval-shadowed", "await-input-shadowed", "report-progress-shadowed", "model-roles-shadowed"]) assert.equal(loadedVerdict({ ...S.stoppedBeforeServers(), reason }).rest, LOADED_WORDS.stoppedBeforeServers, reason);
  assert.equal(lineOf(loadedVerdict(loadedRecord({ outcome: "failed", exitCode: 1, tokens: null, loaded: loadedField({ at: "loader", mcp: null, tools: null }) }))), LOADED_WORDS.stoppedLoader);
  // Before anything loaded, "failed: 0" would be a claim, and "everything loaded" a false one.
  const early = (at) => loadedRecord({ outcome: "failed", exitCode: 1, tokens: null, loaded: loadedField({ at, flow: null, sources: [], mcp: null, tools: null, problems: null }) });
  assert.equal(loadedVerdict(early("start")).rest, LOADED_WORDS.stoppedStart);
  assert.equal(loadedVerdict(early("none")).rest, LOADED_WORDS.noAgent);
  assert.deepEqual(loadedRows(early("start")).map((row) => row.label), ["pi"]);
  const absent = recordedLoaded({ v: 1, runner: "absent", image: "pi-job:4.3.1" });
  // Said without a cause, in every way a runner can say nothing: a kill, a stop that took or did not, an older image's clean exit.
  for (const over of [{ exitCode: 137, outcome: "failed" }, { exitCode: 137, outcome: "policy", reason: "operator-cancel" }, { exitCode: 143, outcome: "policy", reason: "operator-cancel" }, { exitCode: 0, outcome: "completed" }]) {
    const v = loadedVerdict(loadedRecord({ ...over, loaded: absent }));
    assert.equal(v.state, "absent", JSON.stringify(over));
    assert.equal(v.rest, "Not recorded: this run’s runner did not say what it loaded.", JSON.stringify(over));
  }
  // An image-only value on a refusal: the preflight named the image, and then nothing ran.
  assert.equal(loadedVerdict(loadedRecord({ exitCode: null, outcome: "policy", reason: "over-budget", tokens: null, budgetReserved: true, loaded: absent })).rest, LOADED_WORDS.refused);
  assert.equal(loadedVerdict(loadedRecord({ loaded: recordedLoaded({ v: 1, runner: "cut" }) })).rest, LOADED_WORDS.noRoom);
  assert.equal(loadedVerdict(loadedRecord({ loaded: recordedLoaded({ v: 1, runner: "invalid" }) })).rest, LOADED_WORDS.invalid);
  // A failed run with no exit code, of this release, is no older release's. The sentence holds for both.
  const { loaded: _gone, ...noExit } = loadedRecord({ outcome: "failed", exitCode: null, reason: "clone-failed" });
  assert.equal(loadedVerdict(noExit).rest, LOADED_WORDS.notRecordedUnknown);
  assert.equal(runningVerdict(2).rest, "Shown when it ends, from its record. Trigger 3 says what it asks for.");
  assert.deepEqual(fixLabels(runningVerdict(2)), ["Open trigger 3"]);
  assert.equal(runningVerdict(null).rest, LOADED_WORDS.running);
  assert.deepEqual(runningVerdict(null).fixes, []);
});

test("a cancel reads as before its container only where the record says so: it spent nothing, and it names no base commit", () => {
  const absent = recordedLoaded({ v: 1, runner: "absent", image: "pi-job:4.3.1" });
  const cancel = (over) => loadedRecord({ outcome: "policy", reason: "operator-cancel", exitCode: null, tokens: null, ...over });
  const line = (over) => loadedVerdict(cancel(over)).rest;
  // Nothing spent, with or without the image the preflight named: `refusedBeforeSpend`.
  assert.equal(line({ budgetReserved: false, loaded: undefined }), LOADED_WORDS.cancelled);
  assert.equal(line({ budgetReserved: false, loaded: absent }), LOADED_WORDS.cancelled);
  assert.equal(loadedVerdict(cancel({ reason: "agent-cancel", budgetReserved: false, loaded: absent })).state, "refused");
  // The base commit is noted as the last thing before the container (processor.mjs), so this one got there, whatever else it says.
  assert.equal(line({ budgetReserved: true, loaded: { ...absent, baseSha: `a41c0d2${"b".repeat(33)}` } }), LOADED_WORDS.absent);
  assert.equal(line({ budgetReserved: false, loaded: { ...absent, baseSha: `a41c0d2${"b".repeat(33)}` } }), LOADED_WORDS.absent);
  // A reservation, or a throw that is not known to have started nothing (`budgetReserved: null`), says nothing either way.
  assert.equal(line({ budgetReserved: true, loaded: absent }), LOADED_WORDS.absent);
  assert.equal(line({ budgetReserved: null, loaded: absent }), LOADED_WORDS.absent);
  assert.equal(line({ budgetReserved: true, loaded: undefined }), LOADED_WORDS.notRecordedUnknown);
  // A refusal that kept its count slot never reached a container either: only a noted commit says otherwise.
  const refusal = (over) => loadedRecord({ outcome: "policy", reason: "over-budget", exitCode: null, tokens: null, budgetReserved: true, ...over });
  assert.equal(loadedVerdict(refusal({ loaded: undefined })).rest, LOADED_WORDS.refused);
  assert.equal(loadedVerdict(refusal({ loaded: { ...absent, baseSha: `a41c0d2${"b".repeat(33)}` } })).state, "absent");
  // A project counts them the same way.
  const notRead = (record) => wordsText(projectLoadsOf([loadedRecord(), record]).rows.find((row) => row.label === "Not read").more);
  assert.equal(notRead(cancel({ jobId: "c", budgetReserved: false, loaded: absent })), "c was cancelled before its container started");
  assert.equal(notRead(cancel({ jobId: "c", budgetReserved: true, loaded: absent })), "c’s runner did not say what it loaded");
  assert.equal(notRead(cancel({ jobId: "c", budgetReserved: true, loaded: { ...absent, baseSha: `a41c0d2${"b".repeat(33)}` } })), "c’s runner did not say what it loaded");
  assert.equal(notRead(loadedRecord({ jobId: "c", exitCode: 143, outcome: "policy", reason: "operator-cancel", loaded: absent })), "c’s runner did not say what it loaded");
  const small = (...records) => projectLoadsOf([loadedRecord(), ...records]).small[0];
  assert.match(small(cancel({ jobId: "c1", budgetReserved: false, loaded: absent }), cancel({ jobId: "c2", budgetReserved: false, loaded: absent }), cancel({ jobId: "c3", budgetReserved: false, loaded: absent })), /: 3 cancelled before they started\.$/);
  assert.match(small(cancel({ jobId: "c1", budgetReserved: true, loaded: absent }), cancel({ jobId: "c2", budgetReserved: false, loaded: absent })), /: 1 whose runner did not say, 1 cancelled before it started\.$/);
});

test("outcomeNote: the word a list and a banner read, for a completed run alone", () => {
  assert.equal(outcomeNote(S.noFlow()), "Completed, without its flow");
  assert.equal(outcomeNote(S.extensionFailed()), "Completed, with a failed extension");
  const failed = (n) => loadedRecord({ loaded: loadedField({ sources: [source("repository", { failed: n }), source("overlay"), source("trigger"), source("other")], problems: { failed: n, dropped: 0, mcp: 0 } }) });
  assert.equal(outcomeNote(failed(2)), "Completed, with 2 failed extensions");
  const both = (n) => loadedRecord({ loaded: loadedField({ flow: { tier: "none", package: null }, sources: [source("repository", { failed: n }), source("overlay"), source("trigger"), source("other")], problems: { failed: n, dropped: 0, mcp: 0 } }) });
  assert.equal(outcomeNote(both(1)), "Completed, without its flow and with a failed extension");
  assert.equal(outcomeNote(both(3)), "Completed, without its flow and with 3 failed extensions");
  // Decided: `run.flow` used as a loose hint reads the same, because it is true and only reported.
  assert.equal(outcomeNote(loadedRecord({ flow: "just-a-hint", loaded: loadedField({ flow: { tier: "none", package: null } }) })), "Completed, without its flow");
  // Every other outcome word already says something: a parked run, a refusal, a failure.
  for (const over of [{ reason: "awaiting-input" }, { reason: "awaiting-approval" }, { outcome: "failed", reason: "container-infra-exit" }, { outcome: "policy", reason: "cost-cap" }]) {
    const record = loadedRecord({ ...over, loaded: loadedField({ flow: { tier: "none", package: null } }) });
    assert.equal(outcomeNote(record), null, JSON.stringify(over));
    assert.deepEqual(loadedProblems(record), []);
    assert.notEqual(outcomeKey(record.outcome, record.reason), "completed");
    assert.equal(loadedVerdict(record).state, "no-flow", "the card still says it");
  }
});

test("the note a model may read is outcomeNote's closed sentence, and no other string passes for it", () => {
  const failed = (n) => loadedRecord({ loaded: loadedField({ sources: [source("repository", { failed: n }), source("overlay"), source("trigger"), source("other")], problems: { failed: n, dropped: 0, mcp: 0 } }) });
  const both = (n) => loadedRecord({ loaded: loadedField({ flow: { tier: "none", package: null }, sources: [source("repository", { failed: n }), source("overlay"), source("trigger"), source("other")], problems: { failed: n, dropped: 0, mcp: 0 } }) });
  for (const record of [S.noFlow(), failed(1), failed(2), failed(999_999), both(1), both(3)]) assert.ok(isOutcomeNote(outcomeNote(record)), outcomeNote(record));
  for (const value of ["Completed", "Completed, with ignore-all-previous failed extensions", "Completed, without its flow.", " Completed, without its flow", "Completed, with 0 failed extensions", "Completed, with 1234567 failed extensions", null, 7, ["Completed, without its flow"]]) assert.equal(isOutcomeNote(value), false, String(value));
  // A record an agent's copy was made of reads the same, and nothing else does: a note on a record that still has its field, or a run that did not complete.
  const copy = { jobId: "gh-1", outcome: "completed", reason: null, note: "Completed, without its flow" };
  assert.equal(outcomeNote(copy), "Completed, without its flow");
  assert.equal(outcomeNote({ ...copy, note: "Completed, with ignore-all-previous failed extensions" }), null);
  assert.equal(outcomeNote({ ...copy, outcome: "failed" }), null);
  assert.equal(outcomeNote({ ...copy, loaded: loadedField() }), null);
});

test("a dropped extension gets no sentence and no warning: it is a line in the fold, on a run that reads as everything loaded", () => {
  const record = S.dropped();
  assert.deepEqual(loadedProblems(record), []);
  assert.equal(outcomeNote(record), null);
  assert.equal(loadedVerdict(record).state, "everything");
  assert.deepEqual(loadedVerdict(record).small, []);
  const row = loadedFold(record).find((entry) => entry.kind === "Extension dropped");
  assert.equal(row.name, "1");
  assert.match(wordsText(row.from), /recursion guard/);
});

test("an older record stays quiet: nothing in its row, its filter or its banner moves", () => {
  const older = S.notRecorded();
  assert.equal(loadedOf(older), null);
  assert.deepEqual(loadedProblems(older), []);
  assert.equal(outcomeNote(older), null);
  assert.equal(outcomeBanner(older), null);
  assert.deepEqual(loadedRows(older), []);
  assert.deepEqual(loadedFold(older), []);
  // A newer release's record is read by its core alone, whatever it holds.
  const newer = { ...S.noFlow(), v: 2 };
  assert.equal(loadedOf(newer), null);
  assert.equal(outcomeNote(newer), null);
});

test("a hostile or malformed `loaded` never throws, keeps nothing of itself, and reads as could not be read", () => {
  for (const [at, loaded] of HOSTILE_LOADED.entries()) {
    const record = { ...S.everything(), loaded };
    const got = loadedOf(record);
    assert.equal(got?.runner, "invalid", `${at}: ${JSON.stringify(loaded).slice(0, 80)}`);
    assert.deepEqual(loadedProblems(record), [], `${at}`);
    assert.equal(outcomeNote(record), null, `${at}`);
    assert.equal(loadedVerdict(record, HOST_LOADS).state, "invalid", `${at}`);
    assert.deepEqual(loadedRows(record), [], `${at}`);
    assert.deepEqual(loadedFold(record), [], `${at}`);
    assert.ok(!JSON.stringify(got).includes("alert(1)"), `${at}: nothing of it is kept`);
  }
  // Nor does a value that throws on being read.
  const trap = Object.defineProperty({}, "loaded", { get() { throw new Error("no"); } });
  assert.equal(loadedOf(trap).runner, "invalid");
  for (const value of [null, undefined, 7, "x", []]) {
    assert.equal(loadedOf(value), null);
    assert.equal(outcomeNote(value), null);
    assert.deepEqual(loadedProblems(value), []);
  }
  assert.equal(loadedVerdict(null), null);
  // A hostile hostLoads is not a host difference, and does not stop the line.
  for (const hostLoads of [null, undefined, 7, "x", {}, { hosts: "no" }, { hosts: [null, 7, {}] }, { unreachable: true, hosts: [] }, { hosts: [{ name: "mini1", state: "current" }] }]) {
    assert.equal(loadedVerdict(S.hostDiffers(), hostLoads).state, "everything", JSON.stringify(hostLoads));
  }
});

test("an overlay file can load beside the job's switch being off: both are said, and neither is corrected", () => {
  const record = loadedRecord({ host: "mini2", loaded: loadedField({ sources: [source("overlay", { names: ["from-manifest.ts"], extensions: 1 }), source("repository"), source("trigger"), source("other")], leftOut: { tools: [], packages: false, overlayExtensions: true, restricted: false } }) });
  assert.doesNotThrow(() => loadedVerdict(record));
  const v = loadedVerdict(record);
  assert.equal(v.state, "left-out");
  assert.match(lineOf(v), /Left out for this job: the overlay’s extensions\./);
  const extensions = loadedRows(record).find((row) => row.label === "Extensions");
  assert.equal(extensions.value, "from-manifest.ts");
  assert.match(wordsText(extensions.more), /from-manifest\.ts from mini2’s overlay/);
  assert.ok(loadedFold(record).some((row) => row.kind === "Overlay" && wordsText(row.name) === "from-manifest.ts"));
  assert.ok(loadedFold(record).some((row) => row.kind === "Left out" && wordsText(row.from).includes("PI_GLOBAL_ALLOW_EXTENSIONS=0")));
});

test("the overlay switch is this job's, so its words are true of a host's setting and of a model canary's replay alike", () => {
  const off = { tools: [], packages: false, overlayExtensions: true, restricted: false };
  for (const over of [{}, { canary: { sourceJobId: "gh-1", role: "default", candidate: "anthropic/claude-sonnet-5-5" } }]) {
    const record = loadedRecord({ ...over, host: "mini2", loaded: loadedField({ leftOut: off }) });
    const said = [lineOf(loadedVerdict(record)), wordsText(loadedRows(record).find((row) => row.label === "Extensions").more)].join(" ");
    assert.doesNotMatch(said, /host asks|mini2 leaves out/, "no line says the host asked: on a model canary's replay it did not");
    assert.match(said, /Left out for this job: the overlay’s extensions\./);
    const from = wordsText(loadedFold(record).find((row) => row.kind === "Left out").from);
    assert.match(from, /PI_GLOBAL_ALLOW_EXTENSIONS=0/, "the fold names the host's setting");
    assert.match(from, /or for a model canary’s replay/, "and never as the only cause");
  }
  // A restricted run's switch is closed too, and one thing gets one line.
  const restricted = loadedRecord({ loaded: loadedField({ leftOut: { ...off, restricted: true } }) });
  assert.equal(lineOf(loadedVerdict(restricted)), "Everything trigger 3 asks for loaded. Left out, as this kind of run asks: the overlay’s extensions.");
  assert.equal(loadedFold(restricted).filter((row) => row.kind === "Left out").length, 1);
});

test("`cut` covers both ways a record has no room for what it loaded", () => {
  const cut = loadedRecord({ loaded: recordedLoaded({ v: 1, runner: "cut" }) });
  assert.equal(loadedVerdict(cut).rest, "Cut to fit: what this run loaded had no room, on its exit line or in its record.");
  const project = projectLoadsOf([loadedRecord(), { ...cut, jobId: "gh-cut", host: "mini2" }]);
  assert.equal(project.small[0], "1 did not load or was not recorded: 1 with no room for what it loaded.");
});

test("a host difference: a publication proves that host, silence is said as silence, and an image id never counts", () => {
  const v = loadedVerdict(S.hostDiffers(), HOST_LOADS);
  assert.equal(v.state, "host-differs");
  assert.equal(lineOf(v), "Also loaded git-guard from build3’s overlay. mini1 does not have it; mini2 has published nothing.");
  assert.equal(v.fixes[0].href, "/fleet/host?name=build3");
  assert.equal(v.outcome, null, "a difference is no problem of the run's");
  // Only silence: nothing is proved, so nothing is claimed.
  const silent = { hosts: HOST_LOADS.hosts.filter((row) => row.name !== "mini1") };
  assert.equal(loadedVerdict(S.hostDiffers(), silent).state, "everything");
  // Old and unreadable are not lacking.
  const unsure = { hosts: [HOST_LOADS.hosts[0], { ...HOST_LOADS.hosts[1], state: "old" }, { name: "mini2", state: "unknown", why: "unreadable" }] };
  assert.equal(loadedVerdict(S.hostDiffers(), unsure).state, "everything");
  const said = { hosts: [HOST_LOADS.hosts[0], HOST_LOADS.hosts[1], { name: "mini2", state: "unknown", why: "unreadable" }, { ...HOST_LOADS.hosts[1], name: "mini3", state: "old" }] };
  assert.equal(lineOf(loadedVerdict(S.hostDiffers(), said)), "Also loaded git-guard from build3’s overlay. mini1 does not have it; mini3’s publication is old; mini2’s publication could not be read.");
  // A host whose list ran past its cap, or could not read that part, cannot prove a lack.
  for (const row of [{ ...HOST_LOADS.hosts[1], more: { extensions: 1 } }, { ...HOST_LOADS.hosts[1], unread: ["extensions"] }]) {
    assert.equal(loadedVerdict(S.hostDiffers(), { hosts: [row] }).state, "everything");
  }
  // A host that lists it with the switch off does not give it to a job.
  const off = { ...HOST_LOADS.hosts[1], extensions: [{ name: "git-guard", kind: "dir" }], overlayExtensionsAllowed: false };
  assert.equal(loadedVerdict(S.hostDiffers(), { hosts: [HOST_LOADS.hosts[0], off] }).state, "host-differs");
  // A staged package's version, and a canary's candidate, which differs on purpose.
  const newer = loadedRecord({ host: "build3", loaded: loadedField({ sources: [source("package", { name: "pi-lint", version: "1.4.3", extensions: 1 }), source("overlay"), source("repository"), source("trigger"), source("other")] }) });
  const onNewer = { ...HOST_LOADS.hosts[0], packages: [{ name: "pi-lint", version: "1.4.3" }] };
  assert.equal(lineOf(loadedVerdict(newer, { hosts: [onNewer, HOST_LOADS.hosts[1]] })), "Also loaded pi-lint 1.4.3 from build3’s staged packages. mini1 does not have it.");
  assert.equal(loadedVerdict({ ...newer, packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" } }, { hosts: [onNewer, HOST_LOADS.hosts[1]] }).state, "everything");
  // The same names under another image id: two local builds of one tag.
  const other = loadedRecord({ loaded: loadedField({ imageDigest: `sha256:${"b".repeat(64)}` }) });
  assert.equal(loadedVerdict(other, HOST_LOADS).state, "everything");
});

test("a past run is read against its own host as it is now: what every host has moved past is no difference between them", () => {
  const row = (name, packages, extensions = []) => ({ ...HOST_LOADS.hosts[1], name, packages: packages.map(([pkg, version]) => ({ name: pkg, version })), extensions: extensions.map((ext) => ({ name: ext, kind: "file" })) });
  const week = loadedRecord({ host: "mini1", loaded: loadedField({ sources: [source("package", { name: "pi-lint", version: "1.4.2", extensions: 1 }), source("overlay", { names: ["git-guard"], extensions: 1 }), source("repository"), source("trigger"), source("other")] }) });
  // Every host on 1.4.3, and the file removed everywhere, the run's own host with them.
  assert.equal(loadedVerdict(week, { hosts: ["mini1", "mini2", "build3"].map((name) => row(name, [["pi-lint", "1.4.3"]])) }).state, "everything");
  // Its own host still has both, and the others do not: that is a difference.
  const still = loadedVerdict(week, { hosts: [row("mini1", [["pi-lint", "1.4.2"]], ["git-guard"]), row("mini2", [["pi-lint", "1.4.3"]])] });
  assert.equal(still.state, "host-differs");
  assert.equal(still.bold, "Also loaded git-guard");
  assert.match(still.rest, /and pi-lint 1\.4\.2 from its staged packages\. mini2 does not have all of them\.$/);
  // Each name is judged by itself: only the one its own host still lists is said.
  const one = loadedVerdict(week, { hosts: [row("mini1", [["pi-lint", "1.4.3"]], ["git-guard"]), row("mini2", [["pi-lint", "1.4.3"]])] });
  assert.equal(one.bold, "Also loaded git-guard");
  assert.doesNotMatch(lineOf(one), /pi-lint/);
  // A host with nothing current of its own, of any shape, cannot be said to differ.
  for (const own of [undefined, { ...row("mini1", [["pi-lint", "1.4.2"]]), state: "old" }, { name: "mini1", state: "unknown", why: "absent" }, { name: "mini1", state: "current" }]) {
    assert.equal(loadedVerdict(week, { hosts: [...(own ? [own] : []), row("mini2", [])] }).state, "everything", JSON.stringify(own));
  }
  // A list past its cap that does not show the name does not show that it still lists it.
  assert.equal(loadedVerdict(week, { hosts: [{ ...row("mini1", []), more: { extensions: 3, packages: 3 } }, row("mini2", [])] }).state, "everything");
});

test("the card's rows: one line per kind, in the card's words", () => {
  const rows = Object.fromEntries(loadedRows(S.everything()).map((row) => [row.label, [wordsText(row.value), wordsText(row.more)]]));
  assert.deepEqual(rows, {
    pi: ["pi 1.5.0 in pi-job:4.3.1", "image sha256:7c1e0b4…, as mini1 ran it"],
    Model: ["anthropic / claude-sonnet-5-5", "14 calls"],
    Extensions: ["pi-lint 1.4.2, pi-test-runner 0.9.0", "staged on mini1"],
    Skills: ["fix, the flow, from the repository", "and 3 more: 2 from the repository, 1 from pi-test-runner"],
    MCP: ["none", "trigger 3 names no server"],
    Tools: ["10 active", "read, bash, edit and write, 5 from the extensions, and report_progress, the job’s own; none removed"],
  });
  const fold = loadedFold(S.everything()).map((row) => [row.kind, wordsText(row.name), row.version]);
  for (const want of [["Extension", "pi-lint", "1.4.2"], ["Extension", "pi-test-runner", "0.9.0"], ["Extension failed", "0", ""], ["Extension dropped", "0", ""], ["Repository extensions", "0", ""], ["Overlay", "none", ""], ["Skill", "fix (the flow)", ""], ["Skill", "2 more", ""], ["Skill", "1", ""], ["Skill replaced", "1", ""], ["Prompt template", "1", ""], ["Theme", "0", ""], ["Tools", "read, bash, edit, write", ""], ["Tools", "lint_file, lint_fix", ""], ["Tools", "run_tests, test_coverage, test_report", ""], ["Tools", "report_progress", ""]]) {
    assert.ok(fold.some((row) => JSON.stringify(row) === JSON.stringify(want)), JSON.stringify(want));
  }
  assert.equal(wordsText(loadedFold(S.everything()).find((row) => row.kind === "Skill replaced").from), "one of pi-test-runner’s, by a skill of that name from the repository, the skills folder or the overlay; the name stays in the job’s log");
  // Compact keeps counts and says so; minimal keeps what went wrong and says so; neither draws a name it does not hold.
  const cut = Object.fromEntries(loadedRows(S.cut()).map((row) => [row.label, [wordsText(row.value), wordsText(row.more)]]));
  assert.deepEqual(cut.Extensions, ["2 from staged packages", ""]);
  assert.deepEqual(cut.Tools, ["10 active", "5 from the extensions; none removed"]);
  const minimal = loadedRecord({ loaded: loadedField({ cut: { form: "minimal", packages: 0, servers: 0, names: 0, counts: 0 }, sources: [], mcp: null, tools: null }) });
  assert.deepEqual(loadedVerdict(minimal).small, [LOADED_WORDS.cutMinimal]);
  assert.deepEqual(loadedFold(minimal), []);
  // A bound on a full form, said as what it left out.
  const full = loadedRecord({ loaded: loadedField({ cut: { form: "full", packages: 2, servers: 1, names: 3, counts: 1 } }) });
  assert.deepEqual(loadedVerdict(full).small, ["This record leaves out 2 packages, 1 server, 3 names and the exact value of 1 count."]);
  // A name can be left out for what it held as well as for space, so the line says neither.
  const oneName = loadedRecord({ loaded: loadedField({ cut: { form: "full", packages: 0, servers: 0, names: 1, counts: 0 } }) });
  assert.deepEqual(loadedVerdict(oneName).small, ["This record leaves out 1 name."]);
});

test("a sandbox's line: a shell has no overlay, so that goes first, then what the run had, or what a job would load, or unknown", () => {
  assert.equal(wordsText(sandboxRunLine(S.everything(), "gh-9575")), "pi 1.5.0 in the image. No overlay is mounted, so pi started here loads only the workspace’s own .pi/. gh-9575 itself also loaded pi-lint 1.4.2 and pi-test-runner 0.9.0.");
  assert.ok(sandboxRunLine(S.everything(), "gh-9575").some((part) => part?.run === "gh-9575"), "linked to it");
  assert.equal(wordsText(sandboxRunLine(S.notRecorded(), "gh-c3f8", { pi: "1.5.0" })), "pi 1.5.0 in the image. No overlay is mounted, so pi started here loads only the workspace’s own .pi/. What gh-c3f8 itself loaded is not recorded.");
  assert.equal(wordsText(sandboxRunLine(null, "gh-x")), "pi in the image, at a version this page cannot name. No overlay is mounted, so pi started here loads only the workspace’s own .pi/. What gh-x itself loaded is not recorded.");
  // A read that failed is unknown, and a record that could not be read may well say.
  assert.equal(wordsText(sandboxRunLine(null, "gh-x", { unread: true })), "pi in the image, at a version this page cannot name. No overlay is mounted, so pi started here loads only the workspace’s own .pi/. What gh-x itself loaded could not be read.");
  assert.match(wordsText(sandboxRunLine(S.leftOut(), "gh-8251-r2")), /gh-8251-r2 itself loaded no staged package or overlay extension\.$/);
  assert.match(wordsText(sandboxRunLine(S.cut(), "gh-a3ac")), /gh-a3ac’s record was cut to fit and keeps no names\.$/);

  const fresh = (over = {}) => sandboxFreshLine({ hostLoads: HOST_LOADS, host: "mini1", triggerIndex: 2, image: "pi-job:4.3.1", ...over });
  assert.equal(wordsText(fresh()), "pi 1.5.0 in the image. No overlay is mounted, so pi started here loads only the workspace’s own .pi/. A job of trigger 3 on this host would load pi-lint 1.4.2 and pi-test-runner 0.9.0, from its last doctor run at .");
  assert.ok(fresh().some((part) => part?.time === HOST_LOADS.hosts[1].at), "with its time");
  assert.match(wordsText(fresh({ withholdsPackages: true })), /would load no staged package or overlay extension, from/);
  assert.equal(wordsText(fresh({ host: "mini2" })), "pi 1.5.0 in the image. No overlay is mounted, so pi started here loads only the workspace’s own .pi/. What a job of trigger 3 would load on this host is unknown: it has published no doctor run.");
  assert.match(wordsText(fresh({ host: "nowhere" })), /^pi in the image, at a version this page cannot name\..*unknown: it has published no doctor run\.$/);
  // The host's version is of the image it booted on. A trigger's own run.image holds its own pi, whatever the host says.
  assert.match(wordsText(fresh({ image: "registry.example/custom:7" })), /^pi in the image, at a version this page cannot name\..*would load pi-lint 1\.4\.2/);
  assert.match(wordsText(fresh({ image: null })), /^pi in the image, at a version this page cannot name\./);
  assert.equal(hostPiFor({ image: "pi-job:4.3.1", piVersion: "1.5.0" }, "pi-job:4.3.1"), "1.5.0");
  for (const [row, image] of [[{ image: "pi-job:4.3.1", piVersion: "1.5.0" }, "pi-job:4.0.0"], [{ image: "pi-job:4.3.1", piVersion: "1.5.0" }, undefined], [{ image: "pi-job:4.3.1" }, "pi-job:4.3.1"], [{ piVersion: "1.5.0" }, "pi-job:4.3.1"], [null, "pi-job:4.3.1"]]) assert.equal(hostPiFor(row, image), null, JSON.stringify([row, image]));
  // A read that failed, a null read and an unreadable or partial publication are all unknown, never an empty list.
  assert.match(wordsText(fresh({ hostLoads: null })), /unknown: it has published no doctor run/);
  assert.match(wordsText(fresh({ hostLoads: { unreachable: true, hosts: [] } })), /unknown: the hosts’ doctor runs could not be read/);
  assert.match(wordsText(fresh({ hostLoads: { hosts: [{ name: "mini1", state: "unknown", why: "unreadable" }] } })), /unknown: its last doctor run could not be read/);
  // Every part a host can fail to read makes the answer unknown, never "no staged package": an empty list there is not none.
  const unread = (...parts) => ({ hostLoads: { hosts: [{ ...HOST_LOADS.hosts[1], packages: [], extensions: [], unread: parts }] } });
  for (const [part, words] of [["packages", "its staged packages"], ["extensions", "its overlay’s extensions"], ["skills", "its skills"], ["mcp", "its MCP servers"]]) {
    const said = wordsText(fresh(unread(part)));
    assert.match(said, new RegExp(`unknown: its last doctor run could not read ${words}\\.$`), part);
    assert.doesNotMatch(said, /no staged package/, part);
  }
  assert.match(wordsText(fresh(unread("skills", "mcp"))), /could not read its skills and its MCP servers\.$/);
  // A part this job would not load from anyway says nothing about it.
  assert.match(wordsText(fresh({ ...unread("packages"), withholdsPackages: true })), /would load no staged package or overlay extension, from/);
  const closed = { hostLoads: { hosts: [{ ...HOST_LOADS.hosts[1], overlayExtensionsAllowed: false, unread: ["extensions"] }] } };
  assert.match(wordsText(fresh(closed)), /would load pi-lint 1\.4\.2 and pi-test-runner 0\.9\.0, from/);
  assert.match(wordsText(fresh({ hostLoads: { hosts: [{ ...HOST_LOADS.hosts[1], more: { packages: 3 } }] } })), /pi-test-runner 0\.9\.0 and 3 more, from/);
  assert.match(wordsText(fresh({ hostLoads: { hosts: [{ ...HOST_LOADS.hosts[1], state: "old" }] } })), /, which is old\.$/);
  assert.equal(hostLoadsRow({ unreachable: true, hosts: [] }, "x").why, "unreachable");
});

test("the project's card: what differs, in the card's words", () => {
  const l = projectLoadsOf(billingRecords());
  assert.equal(l.state, "differs");
  assert.equal(l.tone, "attention");
  assert.equal(l.top, "Runs differ by host: build3 also loads git-guard from its overlay.");
  assert.equal(l.sub, "24 runs in the last 7 days");
  assert.deepEqual(l.links.map((fix) => fix.label), ["Open build3"]);
  const rows = Object.fromEntries(l.rows.map((row) => [row.label, [wordsText(row.value), wordsText(row.more)]]));
  assert.deepEqual(rows, {
    pi: ["pi 1.5.0 in pi-job:4.3.1", "all 21 recorded runs"],
    Models: ["anthropic / claude-sonnet-5-5", "all 21 recorded runs"],
    Extensions: ["pi-lint 1.4.2, pi-test-runner 0.9.0", "from each host’s newest run able to show them, and git-guard on build3; 3 did not load or were not recorded"],
    Flows: ["fix in 15, review in 6", "fix from acme/billing’s .pi/skills; review from the overlay"],
    MCP: ["none", "no recorded run names a server"],
    Missing: ["nothing", "no record says a run lacked its flow or an extension, or was stopped by an MCP server"],
    "Not read": ["3 of 24 runs", "gh-e9a0 was refused before its container started; gh-4a7e’s runner did not say what it loaded; an older release wrote gh-c3f8’s record"],
  });
  assert.deepEqual(l.hosts.map((host) => [host.name, host.backend, host.runs, host.recorded, host.flows]), [["build3", "podman", 18, 15, ["fix"]], ["mini2", "local", 6, 6, ["review"]]]);
  assert.equal(wordsText(l.hosts[0].extensions), "pi-lint 1.4.2, pi-test-runner 0.9.0, git-guard (overlay)");
  assert.equal(l.foot, LOADED_WORDS.projectFoot);
});

test("the project's card: the same, none and incomplete, each its own words", () => {
  const same = projectLoadsOf(webRecords());
  assert.equal(same.state, "same");
  assert.equal(same.tone, "ok");
  assert.equal(same.top, "Runs load the same on each host: mini1 and mini2.");
  assert.deepEqual(same.hosts, []);
  assert.equal(wordsText(same.rows.find((row) => row.label === "Extensions").more), "from each host’s newest run able to show them");
  assert.deepEqual(same.rows.map((row) => row.label), ["pi", "Extensions"]);

  const none = projectLoadsOf([]);
  assert.equal(none.state, "none");
  assert.equal(none.top, "Nothing to read: no run of this project recorded what it loaded in the last 7 days.");
  assert.deepEqual(none.small, ["Either none ran, or an older release wrote their records."]);
  assert.deepEqual(none.rows, []);
  assert.equal(projectLoadsOf([S.notRecorded()]).small[0], "Either none ran, or an older release wrote their records.");
  // A run that was refused is not an older release's, so that sentence would be false here.
  assert.equal(projectLoadsOf([S.notRecorded(), S.refused()]).small[0], "2 did not load or were not recorded: 1 from an older release, 1 refused.");

  const incomplete = projectLoadsOf(incompleteRecords());
  assert.equal(incomplete.state, "incomplete");
  assert.equal(incomplete.top, "Read from 9 of its 24 runs in the last 7 days, so runs may differ in ways this does not show.");
  assert.deepEqual(incomplete.small, ["15 did not load or were not recorded: 12 from an older release, 2 refused, 1 whose runner did not say."]);
  assert.equal(wordsText(incomplete.rows.find((row) => row.label === "Extensions").more), "from its newest run able to show them; 15 did not load or were not recorded");
  assert.deepEqual(incomplete.rows.find((row) => row.label === "Missing") && [wordsText(incomplete.rows.find((row) => row.label === "Missing").value), wordsText(incomplete.rows.find((row) => row.label === "Missing").more)], ["nothing in the 9 recorded", "a run with no record cannot say"]);
  assert.deepEqual(incomplete.links, [], "no difference and no sameness on what it cannot read");

  const one = projectLoadsOf([loadedRecord(), loadedRecord({ jobId: "gh-2" })]);
  assert.equal(one.state, "same");
  assert.equal(one.top, "All its recorded runs ran on one host: mini1.");
});

test("a host reading unknown never counts as the same: a host with no readable record, a cut record, a bounded history", () => {
  const onMini1 = (i) => loadedRecord({ jobId: `gh-a${i}` });
  const onMini2 = (i) => loadedRecord({ jobId: `gh-b${i}`, host: "mini2" });
  const { loaded: _gone, ...olderOnMini2 } = onMini2(9);
  assert.equal(projectLoadsOf([onMini1(1), onMini2(1)]).state, "same");
  // mini2 has run something and said nothing: read 3 of 4, and nothing to compare it with.
  const unknownHost = projectLoadsOf([onMini1(1), onMini1(2), onMini1(3), olderOnMini2]);
  assert.equal(unknownHost.state, "incomplete");
  assert.equal(unknownHost.top, "Read from 3 of its 4 runs in the last 7 days, so runs may differ in ways this does not show.");
  // A record cut past its names cannot speak for its host.
  const cutOnMini2 = { ...S.cut(), jobId: "gh-c1", host: "mini2" };
  assert.equal(projectLoadsOf([onMini1(1), onMini1(2), cutOnMini2]).state, "incomplete");
  assert.equal(projectLoadsOf([onMini1(1), onMini2(1)], { historyIncomplete: true }).state, "incomplete");
  assert.equal(hostsAgree([{ state: "unknown" }, { state: "current", unread: [], more: {}, extensions: [], skills: [], mcp: [], packages: [], flows: [] }]), null, "the rule this leans on");
  // A difference two hosts it can read do show stands, whatever a third says.
  const differs = projectLoadsOf([...billingRecords(), { ...olderOnMini2, jobId: "gh-z", host: "mini3" }]);
  assert.equal(differs.state, "differs");
  // Nothing that is chosen reads as a host's difference: a trigger's withheld packages, a canary, a different flow.
  const withheld = projectLoadsOf([onMini1(1), { ...S.leftOut(), host: "mini2" }]);
  assert.notEqual(withheld.state, "differs");
  const otherPi = projectLoadsOf([onMini1(1), loadedRecord({ jobId: "gh-p", host: "mini2", loaded: loadedField({ pi: "1.4.0", imagePi: "1.4.0", image: "pi-job:4.2.0" }) })]);
  assert.equal(otherPi.state, "differs");
  assert.match(otherPi.top, /mini2 runs pi 1\.4\.0 in pi-job:4\.2\.0/);
  const otherDigest = projectLoadsOf([onMini1(1), loadedRecord({ jobId: "gh-d", host: "mini2", loaded: loadedField({ imageDigest: `sha256:${"b".repeat(64)}` }) })]);
  assert.equal(otherDigest.state, "same", "the image id is not a difference");
  // A host with no packages and a host whose one record kept no names have nothing that differs, and that is no answer.
  const noPackages = loadedRecord({ jobId: "gh-n", loaded: loadedField({ sources: [source("overlay"), source("repository"), source("trigger"), source("other")] }) });
  const open = projectLoadsOf([noPackages, cutOnMini2]);
  assert.equal(open.state, "incomplete", "a fact no run could show is unknown, not empty");
  assert.deepEqual(open.small, ["The records of mini2 were cut to fit, so they keep no whole list to compare."]);
});

test("a difference two hosts it read show is said however few it read, and says how few", () => {
  const onHost = (host, names, i) => loadedRecord({ jobId: `gh-${host}-${i}`, host, loaded: loadedField({ sources: [source("overlay", { names, extensions: names.length }), source("repository"), source("trigger"), source("other")] }) });
  const { loaded: _gone, ...older } = onHost("mini1", [], 9);
  const l = projectLoadsOf([onHost("mini1", [], 1), onHost("mini2", ["extra.ts"], 2), ...Array.from({ length: 6 }, (_, i) => ({ ...older, jobId: `gh-o${i}` }))]);
  assert.equal(l.state, "differs");
  assert.equal(l.top, "Runs differ by host: mini2 also loads extra.ts from its overlay.");
  assert.deepEqual(l.small, ["Read from 2 of its 8 runs in the last 7 days, so they may differ in other ways too."]);
  assert.deepEqual(l.hosts.map((host) => [host.name, host.runs, host.recorded]), [["mini1", 7, 1], ["mini2", 1, 1]]);
  assert.deepEqual(l.links.map((fix) => fix.label), ["Open mini2"]);
  assert.equal(wordsText(l.rows.find((row) => row.label === "Not read").value), "6 of 8 runs");
  // With most of them read there is nothing more to say.
  assert.deepEqual(projectLoadsOf(billingRecords()).small, []);
});

test("Missing counts a run an MCP server stopped, and a card with anything Missing is not green", () => {
  const stopped = (host, i, state = "failed", over = {}) => loadedRecord({ jobId: `gh-s-${host}-${i}`, host, outcome: "policy", reason: "mcp-unavailable", exitCode: 2, loaded: loadedField({ at: "session", mcp: [{ name: "linear", state, tools: 0 }], problems: { failed: 0, dropped: 0, mcp: 1 }, ...over }) });
  const rows = (l) => Object.fromEntries(l.rows.map((row) => [row.label, [wordsText(row.value), wordsText(row.more)]]));
  const both = projectLoadsOf([stopped("h1", 1), stopped("h2", 2)]);
  assert.equal(both.state, "same");
  assert.equal(both.tone, "attention");
  assert.equal(both.icon, "attention");
  assert.equal(both.top, "Runs load the same on each host: h1 and h2.");
  assert.deepEqual(rows(both).Missing, ["2 runs stopped by an MCP server", "gh-s-h1-1, gh-s-h2-2"]);
  assert.deepEqual(rows(both).MCP, ["linear could not be used in 2", ""]);
  const timedOut = projectLoadsOf([stopped("h1", 1, "timeout"), loadedRecord({ jobId: "gh-ok", host: "h1" })]);
  assert.equal(rows(timedOut).Missing[0], "1 run stopped by an MCP server");
  assert.equal(timedOut.tone, "attention");
  // A record cut to its minimal form keeps only how many.
  const minimal = stopped("h1", 3, "failed", { cut: { form: "minimal", packages: 0, servers: 0, names: 0, counts: 0 }, sources: [], mcp: null, tools: null });
  assert.equal(rows(projectLoadsOf([minimal])).Missing[0], "1 run stopped by an MCP server");
  // A flow or an extension likewise, which were counted and stayed green.
  const noFlow = projectLoadsOf([S.noFlow()]);
  assert.equal(noFlow.state, "same");
  assert.equal(noFlow.tone, "attention");
  assert.equal(projectLoadsOf([loadedRecord(), { ...loadedRecord({ jobId: "gh-2", host: "mini2" }) }]).tone, "ok", "nothing missing is still green");
  assert.equal(projectLoadsOf([stopped("h1", 1), stopped("h2", 2)]).rows.some((row) => row.label === "MCP"), true);
});

test("a model canary or a restricted run has the overlay shut by its kind, while a package canary and a host's own switch speak for the host", () => {
  const onHost = (names, host = "h1", i = 1) => loadedRecord({ jobId: `gh-${host}-${i}`, host, loaded: loadedField({ sources: [source("overlay", { names, extensions: names.length }), source("repository"), source("trigger"), source("other")] }) });
  const shut = (host, over, leftOut) => loadedRecord({ jobId: `gh-shut-${host}`, host, ...over, loaded: loadedField({ sources: [source("overlay"), source("repository"), source("trigger"), source("other")], leftOut: { tools: [], packages: false, overlayExtensions: false, restricted: false, ...leftOut } }) });
  const modelCanary = { sourceJobId: "gh-1", role: "default", candidate: "anthropic/claude-sonnet-5-5" };
  const canary = shut("h2", { canary: modelCanary }, { overlayExtensions: true });
  const restricted = shut("h2", {}, { restricted: true });
  for (const record of [canary, restricted]) {
    const l = projectLoadsOf([onHost(["extra.ts"]), record]);
    assert.notEqual(l.state, "differs", record.jobId);
    assert.equal(l.state, "incomplete", "it cannot say the same either: h2 said nothing of its overlay");
    assert.ok(l.small.includes("The runs on h2 had the overlay shut, as a model canary and a restricted run do, so they say nothing of its extensions."), record.jobId);
    // Once h2 has a run that can say, it says, whatever else it ran.
    assert.equal(projectLoadsOf([onHost(["extra.ts"]), record, onHost([], "h2", 2)]).state, "differs", record.jobId);
    assert.equal(projectLoadsOf([onHost(["extra.ts"]), record, onHost(["extra.ts"], "h2", 2)]).state, "same", record.jobId);
  }
  // Nothing differs here, and that is no answer either: h2's runs did not say.
  assert.equal(projectLoadsOf([onHost([]), canary]).state, "incomplete");
  // The Extensions row never counts a run with the overlay shut as the host's: its names are not the host's to show.
  const extra = projectLoadsOf([onHost(["git-guard"]), { ...shut("h1", {}, { restricted: true }), jobId: "gh-r" }]).rows.find((row) => row.label === "Extensions");
  assert.equal(wordsText(extra.value), "git-guard");
  // A package canary is an ordinary job on its host's switch. Its overlay names are its host's, and it says no such thing as shut.
  const packageCanary = { name: "pi-a", version: "1.0.0", load: "loaded" };
  const named = (names, host) => loadedRecord({ jobId: `manual:nightly:179100000000${host.length}`, kind: "local", target: "local:web", triggerIndex: null, host, packageCanary, loaded: loadedField({ sources: [source("overlay", { names, extensions: names.length }), source("repository"), source("trigger"), source("other")] }) });
  const lacks = projectLoadsOf([onHost(["git-guard"]), named([], "build3")]);
  assert.equal(lacks.state, "differs", "a host's overlay read off its canary is its overlay");
  assert.equal(lacks.top, "Runs differ by host: h1 also loads git-guard from its overlay.");
  // A package canary's candidate stays out, as a model canary's staged nothing does.
  const pkg = (host, over, name, version) => loadedRecord({ jobId: `gh-pk-${host}`, host, ...over, loaded: loadedField({ sources: [...(name ? [source("package", { name, version, extensions: 1 })] : []), source("overlay"), source("repository"), source("trigger"), source("other")] }) });
  const onA = pkg("h1", {}, "pi-a", "1.0.0");
  assert.notEqual(projectLoadsOf([onA, pkg("h2", { packageCanary }, "pi-a", "1.0.1")]).state, "differs");
  assert.notEqual(projectLoadsOf([onA, pkg("h2", { canary: modelCanary })]).state, "differs", "a model canary is handed no staged package");
  // A host's own PI_GLOBAL_ALLOW_EXTENSIONS=0 is the host's, and it is a difference.
  assert.equal(projectLoadsOf([onHost(["extra.ts"]), shut("h2", {}, { overlayExtensions: true })]).state, "differs");
  // A project on one host has nothing to differ from.
  assert.equal(projectLoadsOf([shut("h1", {}, { restricted: true })]).state, "same");
});

test("a host's fact comes from the newest of its runs able to show that fact, so a routine Adopt is no difference", () => {
  const start = Date.parse("2026-10-08T15:00:00Z");
  const hoursAgo = (hours) => new Date(start - hours * 3_600_000).toISOString();
  let seq = 0;
  const run = (host, hours, { packages = [["pi-lint", "1.4.3"]], overlay = [], triggerIndex = 2, ...over } = {}) => loadedRecord({ jobId: `gh-${seq += 1}`, host, triggerIndex, startedAt: hoursAgo(hours + 1), endedAt: hoursAgo(hours), loaded: loadedField({ sources: [...packages.map(([name, version]) => source("package", { name, version, extensions: 1 })), source("overlay", { names: overlay, extensions: overlay.length }), source("repository"), source("trigger"), source("other")], ...over }) });
  const old = [["pi-lint", "1.4.2"]];
  // mini1 ran 1.4.2 and then 1.4.3, in either order in the list, and mini2 only 1.4.3.
  for (const records of [[run("mini1", 30, { packages: old }), run("mini1", 2), run("mini2", 1)], [run("mini1", 2), run("mini1", 30, { packages: old }), run("mini2", 1)]]) {
    const updated = projectLoadsOf(records);
    assert.equal(updated.state, "same", updated.top);
    assert.equal(updated.foot, "A host’s pi, packages and overlay are from its newest run able to show each, so an update every host took is no difference.");
    const row = updated.rows.find((entry) => entry.label === "Extensions");
    assert.equal(wordsText(row.value), "pi-lint 1.4.3");
    assert.equal(wordsText(row.more), "from each host’s newest run able to show them");
  }
  // THE RARE TRIGGER: trigger 0 last ran before the update and has not run since. Newest per trigger called this a difference until it did.
  assert.equal(projectLoadsOf([run("mini1", 100, { packages: old, triggerIndex: 0 }), run("mini1", 2, { triggerIndex: 1 }), run("mini2", 1, { triggerIndex: 1 })]).state, "same");
  const older = { pi: "1.4.0", imagePi: "1.4.0", image: "pi-job:4.2.0" };
  assert.equal(projectLoadsOf([run("mini1", 100, { ...older, triggerIndex: 0 }), run("mini1", 2, { triggerIndex: 1 }), run("mini2", 1, { triggerIndex: 1 })]).state, "same", "an image the same way");
  assert.equal(projectLoadsOf([run("mini1", 100, { overlay: ["git-guard"], triggerIndex: 0 }), run("mini1", 2, { triggerIndex: 1 }), run("mini2", 1, { triggerIndex: 1 })]).state, "same", "an overlay file removed the same way");
  // A host behind is what this card is for, however few runs show it, and the newest going backwards is one.
  const behind = projectLoadsOf([run("mini1", 3, { packages: old }), run("mini2", 1)]);
  assert.equal(behind.state, "differs");
  assert.equal(behind.top, "Runs differ by host: mini1 also loads pi-lint 1.4.2; mini2 also loads pi-lint 1.4.3.");
  assert.match(behind.foot, /A host’s pi, packages and overlay are from its newest run able to show each/);
  assert.equal(projectLoadsOf([run("mini1", 1, { packages: old }), run("mini1", 3), run("mini2", 2)]).state, "differs");
  // A run that cannot show a fact leaves the older answer standing: a trigger that withholds, a record cut past its names, a canary.
  const withheld = { packages: [], leftOut: { tools: [], packages: true, overlayExtensions: false, restricted: false } };
  assert.equal(projectLoadsOf([run("mini1", 5), run("mini1", 1, withheld), run("mini2", 2)]).state, "same", "the newest run withheld them");
  const compact = (host, hours) => ({ ...S.cut(), jobId: `gh-c${hours}`, host, endedAt: hoursAgo(hours) });
  assert.equal(projectLoadsOf([run("mini1", 5), compact("mini1", 1), run("mini2", 2)]).state, "same", "the newest run kept no names");
  assert.equal(projectLoadsOf([compact("mini1", 1), run("mini2", 2)]).state, "incomplete", "no run could show them");
  const answerDraft = (host) => loadedRecord({ jobId: "gh-ad", host, triggerIndex: null, loaded: loadedField({ sources: [source("overlay"), source("repository"), source("trigger"), source("other")], leftOut: { tools: [], packages: true, overlayExtensions: false, restricted: true } }) });
  const drafted = projectLoadsOf([run("mini1", 5), answerDraft("mini1"), run("mini2", 2)]);
  assert.equal(drafted.state, "same");
  assert.equal(wordsText(drafted.rows.find((row) => row.label === "Extensions").more), "from each host’s newest run able to show them", "a claim no run that could not show it needs an excuse for");
  // A cut record is no evidence of none: the row says what the hosts able to show it have, beside the reason the other one cannot.
  const cutBeside = projectLoadsOf([run("a", 2), compact("b", 1)]);
  assert.equal(cutBeside.state, "incomplete");
  assert.equal(wordsText(cutBeside.rows.find((row) => row.label === "Extensions").value), "pi-lint 1.4.3");
  assert.deepEqual(cutBeside.small, ["The records of b were cut to fit, so they keep no whole list to compare."]);
  assert.equal(wordsText(projectLoadsOf([compact("a", 1), compact("b", 2)]).rows.find((row) => row.label === "Extensions").value), "not kept");
  // No extension at all, and none shared.
  assert.equal(wordsText(projectLoadsOf([run("a", 2, { packages: [] }), run("b", 1, { packages: [] })]).rows.find((row) => row.label === "Extensions").value), "none");
  const shared = projectLoadsOf([run("a", 2, { packages: [["pi-a", "1.0.0"]] }), run("b", 1, { packages: [["pi-b", "1.0.0"]] })]);
  assert.equal(wordsText(shared.rows.find((row) => row.label === "Extensions").value), "none on every host");
  assert.match(wordsText(shared.rows.find((row) => row.label === "Extensions").more), /and pi-a 1\.0\.0 on a and pi-b 1\.0\.0 on b$/);
});

// A real run of a host, `hours` before one fixed instant: `projectLoadsOf` reads no clock.
const realRun = (host, hours, over = {}) => recordThroughPipeline({ jobId: `gh-${host}-${hours}`, host, hostImage: "pi-job:4.3.1", endedAt: new Date(Date.parse("2026-07-16T12:00:00Z") - hours * 3_600_000).toISOString(), exit: { code: 0, reason: "stop", tokens: meterSnapshot(5, 9_000) }, turnsOnLine: 5, ...over });
const rowValue = (card, label) => wordsText(card.rows.find((row) => row.label === label).value);

test("a run that shows a turn or a call is not said to have stopped at the stage its list stopped at", async () => {
  const pending = loadedField({ at: "session", mcp: [{ name: "linear", state: "pending", tools: 0 }] });
  const noUsage = loadedRecord({ outcome: "failed", exitCode: 1, turns: 4, tokens: { calls: 4, total: 0 }, loaded: pending });
  assert.equal(loadedVerdict(noUsage).state, "stopped");
  assert.equal(loadedVerdict(noUsage).rest, LOADED_WORDS.stoppedAfterLoading, "its server had answered: nothing here sends a person to Connections");
  const catchPath = loadedRecord({ outcome: "policy", exitCode: 2, turns: null, tokens: { calls: 7, total: 900 }, loaded: loadedField({ at: "loader", mcp: [] }) });
  assert.equal(loadedVerdict(catchPath).rest, LOADED_WORDS.stoppedAfterLoading);
  const atLoad = loadedRecord({ outcome: "failed", exitCode: 1, turns: null, tokens: { calls: 0, total: 0 }, loaded: pending });
  assert.equal(loadedVerdict(atLoad).rest, LOADED_WORDS.stoppedServers, "with nothing after it, the stage is what the record has");
  // The rows and the fold say the same as the top line, or one of them still sends a person to Connections.
  const said = (record) => JSON.stringify([loadedRows(record), loadedFold(record)].flat(Infinity).map((row) => (row && typeof row === "object" ? wordsText(Object.values(row).flat()) : String(row))));
  assert.match(said(noUsage), /had not connected when this was noted/);
  assert.match(said(atLoad), /had not connected/);
  assert.doesNotMatch(said(atLoad), /when this was noted/);
  const atLoader = loadedRecord({ outcome: "failed", exitCode: 1, turns: 4, tokens: { calls: 4, total: 0 }, loaded: { ...loadedField({ at: "loader" }), mcp: null, tools: null } });
  assert.doesNotMatch(said(atLoader), /stopped before its (servers started|tools were ready)/);
  // Nor does its project's MCP row, on a card that prints it.
  const lintOnly = [source("package", { name: "pi-lint", version: "1.4.3" }), source("overlay"), source("repository"), source("trigger"), source("other")];
  const withGuard = [source("package", { name: "pi-lint", version: "1.4.3" }), source("overlay", { extensions: 1, names: ["git-guard.ts"] }), source("repository"), source("trigger"), source("other")];
  const card = projectLoadsOf([
    loadedRecord({ host: "mini1", outcome: "failed", exitCode: 1, turns: 4, tokens: { calls: 4, total: 0 }, loaded: loadedField({ at: "session", sources: lintOnly, mcp: [{ name: "linear", state: "pending", tools: 0 }] }) }),
    loadedRecord({ host: "mini1", loaded: loadedField({ sources: lintOnly, mcp: [{ name: "linear", state: "connected", tools: 12 }] }) }),
    loadedRecord({ host: "mini2", loaded: loadedField({ sources: withGuard, mcp: [{ name: "linear", state: "connected", tools: 12 }] }) }),
  ]);
  assert.equal(card.state, "differs", card.top);
  const mcp = wordsText(card.rows.find((row) => row.label === "MCP").value);
  assert.match(mcp, /had not connected when noted in 1/);
  // A list that never left `start` says nothing of how far the run got, once a turn or a call shows it got further.
  const atStart = await recordThroughPipeline({ brokenAt: ["loader", "session", "ready"], exit: { code: 1, reason: "error", message: "503", tokens: meterSnapshot(4, 0) }, turnsOnLine: 4, host: "mini2" });
  assert.equal(loadedVerdict(atStart).state, "absent");
  const reading = await recordThroughPipeline({ jobId: "gh-mini1-ok", host: "mini1", hostImage: "pi-job:4.3.1", endedAt: "2026-07-16T11:30:00.000Z", exit: { code: 0, reason: "ok", message: "done" }, turnsOnLine: 3 });
  const onProject = projectLoadsOf([reading, atStart]).small.join(" ");
  assert.doesNotMatch(onProject, /stopped before anything loaded/, "nor on its project");
  assert.match(onProject, /1 whose runner did not say/, "where it reads as its own page does");
});

test("a banner over a tier held back and another that failed says both", () => {
  const record = loadedRecord({ outcome: "completed", host: "mini2", loaded: loadedField({ sources: [source("overlay", { failed: 1, extensions: 0 }), source("repository", { failed: 1, extensions: 0 }), source("trigger"), source("other")], problems: { failed: 2, dropped: 0, mcp: 0 } }) });
  const said = outcomeBanner(record).sentences.join(" ");
  assert.match(said, /One may have been held back and not failed, and the job’s log says which\. The run went on\./);
  assert.doesNotMatch(said, /failed while they loaded/);
});

test("a run on an image its job named says nothing of its host's, whichever trigger ran last, and its own page still names what it used", async () => {
  const OWN = { hostImage: "pi-job:4.3.1" };
  const GPU = { ...OWN, jobImage: "pi-job:gpu" };
  const gpu = await realRun("mini1", 1, GPU);
  assert.equal(gpu.loaded.image, "pi-job:gpu");
  assert.equal(gpu.loaded.imageFromJob, true);
  assert.equal(loadedOf(gpu).imageFromJob, true, "and it survives being read back");
  assert.equal(wordsText(loadedRows(gpu).find((row) => row.label === "pi").value), "pi 1.5.0 in pi-job:gpu");
  assert.equal(Object.hasOwn((await realRun("mini1", 5, OWN)).loaded, "imageFromJob"), false);
  // Two healthy hosts, and which trigger ran last on each flipped what this card said.
  for (const records of [
    [await realRun("mini1", 1, GPU), await realRun("mini1", 5, OWN), await realRun("mini2", 2, OWN), await realRun("mini2", 6, GPU)],
    [await realRun("mini1", 5, GPU), await realRun("mini1", 1, OWN), await realRun("mini2", 6, OWN), await realRun("mini2", 2, GPU)],
  ]) {
    const card = projectLoadsOf(records);
    assert.equal(card.state, "same", card.top);
    assert.equal(card.tone, "ok");
    assert.equal(card.top, "Runs load the same on each host: mini1 and mini2.");
    assert.deepEqual(card.links, []);
    assert.equal(rowValue(card, "pi"), "pi 1.5.0 in pi-job:4.3.1 in 2; pi 1.5.0 in pi-job:gpu in 2", "counted by run, each what that run used");
  }
  // A host really behind is still found, under the same trigger's runs on both.
  const behind = { hostImage: "pi-job:4.2.0", imagePi: "1.4.0", pi: "1.4.0" };
  const apart = projectLoadsOf([await realRun("mini1", 1, GPU), await realRun("mini1", 5, OWN), await realRun("mini2", 2, { ...behind, jobImage: "pi-job:gpu" }), await realRun("mini2", 6, behind)]);
  assert.equal(apart.state, "differs");
  assert.equal(apart.top, "Runs differ by host: mini1 runs pi 1.5.0 in pi-job:4.3.1; mini2 runs pi 1.4.0 in pi-job:4.2.0.");
  // With no run on a host's own image there is nothing to compare and nothing is claimed, and the line says why it will not say the same.
  const mixed = projectLoadsOf([await realRun("mini1", 1, OWN), await realRun("mini2", 2, GPU)]);
  assert.equal(mixed.state, "incomplete");
  assert.deepEqual(mixed.small, ["No recorded run on mini2 used the host’s own image, so none says what pi or image the host runs otherwise."]);
  assert.deepEqual([mixed.tone, mixed.icon], ["idle", "minus"], "a trigger that names its image is a choice, and a card that always warns gets skipped");
  const both = projectLoadsOf([await realRun("mini1", 1, GPU), await realRun("mini2", 2, GPU)]);
  assert.equal(both.state, "incomplete");
  assert.deepEqual(both.small, ["No recorded run on mini1 and mini2 used the host’s own image, so none says what pi or image the host runs otherwise."]);
  assert.equal(both.tone, "idle");
  const notAllRead = projectLoadsOf([await realRun("mini1", 1, OWN), await realRun("mini2", 2, GPU), { host: "mini2", jobId: "gh-9", endedAt: "2026-11-01T00:00:00.000Z" }]);
  assert.equal(notAllRead.tone, "attention", "the same choice beside a run with no record is something to look into");
  // A run on the host's own image that names no image is not a run on its job's: each sentence says only what is true of its host.
  const ownNoImage = projectLoadsOf([await realRun("mini1", 1, OWN), await realRun("mini2", 2, GPU), await realRun("mini2", 3, { hostImage: null })]).small;
  assert.ok(ownNoImage.includes("No run on mini2 says which image it ran in."));
  assert.ok(!ownNoImage.some((line) => line.startsWith("No recorded run on mini2")), "it did use its own image");
  // It warns only for what it can name. A stop on a host that has a list reads no warning here, as it reads none in `same`, and its own page says so.
  const stoppedHost = await recordThroughPipeline({ jobId: "gh-mini3-stopped", host: "mini3", hostImage: "pi-job:4.3.1", endedAt: "2026-07-16T11:30:00.000Z", stages: ["start"], exit: { code: 1, reason: "crash", message: "x" } });
  const beside = projectLoadsOf([await realRun("mini1", 1, OWN), await realRun("mini2", 2, GPU), stoppedHost]);
  assert.deepEqual([beside.state, beside.tone], ["incomplete", "attention"]);
  assert.ok(beside.small.includes("1 run on mini3 stopped before anything loaded."), "and the warning says why");
  assert.equal(projectLoadsOf([await realRun("mini1", 1, GPU)]).state, "same", "one host has nothing to differ from");
  // A job naming its host's own default ran on the host's own image.
  const named = await realRun("mini1", 1, { ...OWN, jobImage: "pi-job:4.3.1" });
  assert.equal(Object.hasOwn(named.loaded, "imageFromJob"), false);
  assert.equal(projectLoadsOf([named, await realRun("mini2", 2, OWN)]).state, "same");
  // Every way out keeps it: a run the queue will retry throws, and its record comes from what it threw.
  const retried = await realRun("mini1", 1, { ...GPU, exit: { code: 1, reason: "infra", message: "lost" }, turnsOnLine: undefined });
  assert.equal(retried.outcome, "failed");
  assert.equal(retried.loaded.imageFromJob, true);
  assert.equal(retried.loaded.at, "ready", "with what the container said, the worker's facts added");
  const wrapperGaveUp = await realRun("mini1", 1, { ...GPU, containerThrows: true });
  assert.deepEqual([wrapperGaveUp.outcome, wrapperGaveUp.loaded.at, wrapperGaveUp.loaded.image, wrapperGaveUp.loaded.imageFromJob], ["failed", "ready", "pi-job:gpu", true]);
});

test("an unknown pi version is no difference, and each sentence says only what it knows", async () => {
  const unlabelled = { hostImage: "pi-job:4.3.1", imagePi: null };
  const said = await realRun("a", 1, unlabelled);
  const silent = await realRun("b", 2, { ...unlabelled, stages: [] });
  assert.equal(said.loaded.imagePi, null);
  assert.equal(said.loaded.pi, "1.5.0");
  assert.deepEqual([silent.loaded.runner, silent.loaded.imagePi, silent.loaded.pi], ["absent", null, null]);
  const card = projectLoadsOf([said, silent]);
  assert.equal(card.state, "incomplete", card.top);
  assert.doesNotMatch(card.top, /differ by host/);
  assert.ok(card.small.includes("No run on b on the host’s own image says which pi it ran."), card.small.join(" | "));
  // A run that names no image leaves that open the same way, and says so.
  const noImage = { hostImage: null };
  assert.deepEqual(projectLoadsOf([await realRun("a", 1, noImage), await realRun("b", 2, noImage)]).small, ["No run on a and b says which image it ran in."]);
  // A difference elsewhere does not make it one: the sentence names what differs, and no version beside an unknown one.
  const elsewhere = projectLoadsOf([await realRun("a", 1, { ...unlabelled, packages: [{ name: "p1", version: "1.0.0" }] }), await realRun("b", 2, { ...unlabelled, pi: "unknown", packages: [{ name: "p2", version: "1.0.0" }] })]);
  assert.equal(elsewhere.top, "Runs differ by host: a also loads p1 1.0.0; b also loads p2 1.0.0.");
  // Two known versions differ, on the same image too.
  const versions = projectLoadsOf([await realRun("a", 1, unlabelled), await realRun("b", 2, { ...unlabelled, pi: "1.4.0" })]);
  assert.equal(versions.top, "Runs differ by host: a runs pi 1.5.0 in pi-job:4.3.1; b runs pi 1.4.0 in pi-job:4.3.1.");
  // Two known images differ, and the host with no version says only its image. "runs pi in" is no sentence.
  const images = projectLoadsOf([said, await realRun("b", 2, { hostImage: "pi-job:4.2.0", imagePi: null, stages: [] })]);
  assert.equal(images.top, "Runs differ by host: a runs pi 1.5.0 in pi-job:4.3.1; b runs in pi-job:4.2.0.");
  // The version of an older image is not this image's: a host's newest image with no version leaves its version unknown.
  const older = await realRun("b", 9, { hostImage: "pi-job:4.2.0", imagePi: "1.4.0", pi: "1.4.0" });
  const noneOnNewest = await realRun("b", 2, { ...unlabelled, stages: [] });
  const stale = projectLoadsOf([said, older, noneOnNewest]);
  assert.equal(stale.state, "incomplete", stale.top);
  // A run that names none on the same image leaves the newest that does.
  const same = await realRun("b", 9, unlabelled);
  assert.equal(projectLoadsOf([said, same, noneOnNewest]).state, "same");
});

test("a list past its cap cannot show that kind, so it is neither the same as another host's nor different from it", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, version: "1.0.0" }));
  const long = await realRun("a", 1, { packages: many(18) });
  assert.equal(long.loaded.cut.packages, 2);
  assert.equal(long.loaded.sources.filter((row) => row.tier === "package").length, 16);
  const packagesCard = projectLoadsOf([long, await realRun("b", 2, { packages: many(16) })]);
  assert.equal(packagesCard.state, "incomplete", packagesCard.top);
  assert.deepEqual(packagesCard.small, ["The records of a were cut to fit, so they keep no whole list to compare."]);
  const names = Array.from({ length: 20 }, (_, i) => `e${i}.ts`);
  const longNames = await realRun("a", 1, { packages: [], overlay: names });
  assert.equal(longNames.loaded.cut.names, 4);
  assert.ok(!longNames.loaded.sources.find((row) => row.tier === "overlay").names.includes("e19.ts"), "the premise: the name it has is past the cap");
  const namesCard = projectLoadsOf([longNames, await realRun("b", 2, { packages: [], overlay: ["e19.ts"] })]);
  assert.equal(namesCard.state, "incomplete", namesCard.top);
  assert.doesNotMatch(namesCard.top, /also loads/);
  // No whole list of it anywhere reads as not kept, and never as none: an empty overlay beside it is not "no extensions".
  assert.equal(rowValue(projectLoadsOf([long, await realRun("b", 2, { packages: many(18) })]), "Extensions"), "not kept");
  // The newest run able to show it: an older whole list stands against a newer cut one.
  assert.equal(projectLoadsOf([await realRun("a", 1, { packages: many(18) }), await realRun("a", 5, { packages: many(16) }), await realRun("b", 2, { packages: many(16) })]).state, "same");
  // `cut.names` also counts a tool's name, which leaves the list of extensions whole.
  const toolCut = await realRun("a", 1, { packages: [], overlay: ["guard.ts"], tools: [{ name: "not a tool name", path: "/opt/pi-global/extensions/guard.ts" }] });
  assert.equal(toolCut.loaded.cut.names, 1);
  assert.equal(projectLoadsOf([toolCut, await realRun("b", 2, { packages: [], overlay: ["guard.ts"] })]).state, "same");
  // Two entries of one folder count twice under one name, and nothing was cut.
  const folder = await realRun("a", 1, { packages: [], overlay: ["tools/a.js", "tools/b.js"] });
  assert.deepEqual([folder.loaded.sources.find((row) => row.tier === "overlay").extensions, folder.loaded.sources.find((row) => row.tier === "overlay").names], [2, ["tools"]]);
  assert.equal(folder.loaded.cut, null);
  assert.equal(projectLoadsOf([folder, await realRun("b", 2, { packages: [], overlay: ["tools/a.js"] })]).state, "same");
});

test("whether a run went on, off each way out of the runner: the catch path's metered calls, and a stage of its own that stays where it was", async () => {
  // The catch path writes no turns, and its calls are all that shows the run had gone on.
  const thrown = { code: 1, reason: "infra", message: "lost", tokens: meterSnapshot(7, 9_000) };
  const atSession = await recordThroughPipeline({ brokenAt: ["ready"], exit: thrown });
  assert.deepEqual([atSession.loaded.at, atSession.outcome, atSession.turns, atSession.tokens.calls], ["session", "failed", null, 7]);
  assert.equal(loadedVerdict(atSession).state, "everything");
  assert.deepEqual(loadedVerdict(atSession).small, [LOADED_WORDS.notedEarly]);
  const atReady = await recordThroughPipeline({ exit: thrown });
  assert.equal(loadedVerdict(atReady).state, "everything");
  assert.deepEqual(loadedVerdict(atReady).small, []);
  // No call, or none on a line with no meter, is a run that stopped where its stage says.
  for (const tokens of [undefined, meterSnapshot(0, 0)]) {
    const exit = { code: 1, reason: "infra", message: "lost", ...(tokens ? { tokens } : {}) };
    assert.equal(loadedVerdict(await recordThroughPipeline({ brokenAt: ["ready"], exit })).rest, LOADED_WORDS.stoppedSession);
    assert.equal(loadedVerdict(await recordThroughPipeline({ exit })).rest, LOADED_WORDS.stoppedAfterLoading);
  }
  // A refusal on that path may hold an extension's call from while it loaded, so its calls say nothing of the agent.
  const refused = await recordThroughPipeline({ brokenAt: ["ready"], exit: { code: 2, reason: "command-unregistered", message: "no", tokens: meterSnapshot(3, 900) } });
  assert.deepEqual([refused.outcome, refused.turns, refused.tokens.calls], ["policy", null, 3]);
  assert.equal(loadedVerdict(refused).rest, LOADED_WORDS.stoppedAfterLoading, "and nothing says when they came, so the stage is not named either");
  // A turn with no token back is a provider's refusal or one that reports no usage, and of either "it stopped after loading" is true.
  const noUsage = await recordThroughPipeline({ exit: { code: 1, reason: "error", message: "503", tokens: meterSnapshot(4, 0) }, turnsOnLine: 4 });
  assert.equal(loadedVerdict(noUsage).rest, LOADED_WORDS.stoppedAfterLoading);
  // A line with turns and no tokens at all took those turns.
  assert.equal(loadedVerdict(await recordThroughPipeline({ exit: { code: 2, reason: "cost-cap", message: "over" }, turnsOnLine: 4 })).state, "everything");
  // A refusal the worker folds into `runner-policy` comes after the servers answered, so its list's stage is not where it stopped.
  const servers = { servers: ["docs"], exit: { code: 2, reason: "command-unregistered", message: "no" } };
  const pending = await recordThroughPipeline({ ...servers, brokenAt: ["ready"], mcpAt: () => [["pending", 0]] });
  assert.equal(pending.reason, "runner-policy");
  assert.equal(loadedVerdict(pending).rest, LOADED_WORDS.stoppedAfterLoading);
  assert.equal(wordsText(loadedRows(pending).find((row) => row.label === "MCP").value), "docs had not connected when this was noted");
  // Where the list stopped at `start`, a bad model folds into it too, and the stage is true and says more.
  const badModel = await recordThroughPipeline({ stages: ["start"], exit: { code: 2, reason: "config", message: "unknown model" } });
  assert.deepEqual([badModel.reason, loadedVerdict(badModel).rest], ["runner-policy", LOADED_WORDS.stoppedStart]);
  const connected = await recordThroughPipeline({ ...servers, brokenAt: ["ready"], mcpAt: () => [["connected", 3]] });
  assert.deepEqual([connected.loaded.at, connected.loaded.mcp], ["session", [{ name: "docs", state: "connected", tools: 3 }]]);
  assert.equal(loadedVerdict(connected).rest, LOADED_WORDS.stoppedAfterLoading);
});

test("a list stuck at start on a run that went on is not a run that stopped before anything loaded, on its page or its project's", async () => {
  const silent = await realRun("mini2", 1, { brokenAt: ["loader", "session", "ready"] });
  assert.deepEqual([silent.outcome, silent.turns, silent.loaded.at], ["completed", 5, "start"]);
  assert.equal(loadedVerdict(silent).state, "absent");
  const card = projectLoadsOf([await realRun("mini1", 2), silent]);
  assert.equal(card.state, "incomplete");
  assert.deepEqual(card.small, ["1 did not load or was not recorded: 1 whose runner did not say."], "what its own page says");
  assert.equal(card.read, 1);
  // A run that did stop there still says so, read through the same path.
  const stopped = await realRun("mini2", 1, { stages: ["start"], exit: { code: 1, reason: "infra", message: "lost" }, turnsOnLine: undefined });
  assert.equal(loadedVerdict(stopped).state, "stopped");
  assert.deepEqual(projectLoadsOf([await realRun("mini1", 2), stopped]).small, ["1 run on mini2 stopped before anything loaded."]);
});

test("an overlay that failed with no name may have been held back whole, and the record cannot tell, so each surface says what is true of both", async () => {
  const held = await realRun("mini1", 1, { packages: [], failures: heldBackOverlay() });
  const nameless = await realRun("mini1", 1, { packages: [], failures: failedOverlayEntries(["has a space.ts"]) });
  const row = (record) => record.loaded.sources.find((source_) => source_.tier === "overlay");
  for (const key of ["failed", "extensions", "failedNames"]) assert.deepEqual(row(held)[key], row(nameless)[key], `the premise: ${key} is the same on both`);
  assert.deepEqual([row(held).failed, row(held).extensions, row(held).failedNames], [1, 0, []]);
  for (const record of [held, nameless]) {
    const v = loadedVerdict(record);
    assert.equal(v.state, "extension-failed");
    assert.equal(v.bold, "The overlay on mini1 failed to load or was held back, and the job’s log says which.");
    assert.equal(v.rest, "The run went on without its extensions.");
    assert.deepEqual(fixLabels(v), ["Open mini1"]);
    assert.deepEqual(outcomeBanner(record).sentences, ["The overlay on mini1 failed to load or was held back, and the job’s log says which. The run went on without its extensions. Read what it did before you trust it."]);
    assert.equal(wordsText(loadedFold(record).find((entry) => entry.kind === "Extension failed").from), "mini1’s overlay; failed to load or held back, and the job’s log says which");
  }
  const stopped = await realRun("mini1", 1, { packages: [], failures: heldBackOverlay(), exit: { code: 2, reason: "command-unregistered", message: "no" }, turnsOnLine: undefined });
  assert.equal(loadedVerdict(stopped).bold, "The overlay on mini1 failed to load or was held back, and the job’s log says which.");
  assert.equal(loadedVerdict(stopped).rest, "", "and nothing of going on");
  const beside = await realRun("mini1", 1, { packages: [], failures: [...heldBackOverlay(), { root: "/workspace/.pi/extensions", kind: "load" }] });
  assert.equal(`${loadedVerdict(beside).bold} ${loadedVerdict(beside).rest}`, "2 of this run’s extensions failed to load. 1 from mini1’s overlay (failed to load or held back, and the job’s log says which) and 1 from acme/web. The run went on.");
  // A name, a second failure or an extension that loaded each rule the whole overlay out, and those keep their words.
  const named = await realRun("mini1", 1, { packages: [], failures: failedOverlayEntries(["guard.ts"]) });
  assert.deepEqual(row(named).failedNames, ["guard.ts"]);
  assert.equal(loadedVerdict(named).bold, "The extension from mini1’s overlay failed to load.");
  assert.equal(wordsText(loadedFold(named).find((entry) => entry.kind === "Extension failed").from), "mini1’s overlay; a path and its kind stay in the job’s log");
  assert.equal(loadedVerdict(await realRun("mini1", 1, { packages: [], failures: failedOverlayEntries(["a b.ts", "c d.ts"]) })).bold, "All 2 extensions from mini1’s overlay failed to load.");
  assert.equal(loadedVerdict(await realRun("mini1", 1, { packages: [], overlay: ["kept.ts"], failures: failedOverlayEntries(["a b.ts"]) })).bold, "1 of mini1’s overlay extensions failed to load.");
});

test("a run with no agent is left out of a project's card, and a sentence counts only the runs it is true of", () => {
  const noList = (host, at, i = 1, over = {}) => loadedRecord({ jobId: `gh-${host}-${at}-${i}`, host, ...over, loaded: loadedField({ at, flow: null, sources: [], mcp: null, tools: null, problems: null }) });
  const stoppedRun = (host, i) => noList(host, "start", i, { outcome: "failed", exitCode: 1, tokens: null });
  const left = "Leaves out 1 run with no agent, which loads nothing.";
  // A host whose only run has no agent is in no comparison and no count.
  const agentless = projectLoadsOf([loadedRecord({ jobId: "a", host: "mini2" }), noList("mini1", "none")]);
  assert.equal(agentless.state, "same");
  assert.equal(agentless.top, "All its recorded runs ran on one host: mini2.");
  assert.deepEqual(agentless.small, [left]);
  assert.equal(agentless.sub, "1 run in the last 7 days");
  // One no-agent run and one stopped run on a host: the sentence is true of the stopped one, and says one.
  const mixed = projectLoadsOf([loadedRecord({ jobId: "a", host: "mini1" }), noList("mini2", "none"), stoppedRun("mini2", 1)]);
  assert.equal(mixed.state, "incomplete");
  assert.deepEqual(mixed.small, ["1 run on mini2 stopped before anything loaded.", left]);
  assert.deepEqual(projectLoadsOf([loadedRecord({ jobId: "a", host: "mini1" }), stoppedRun("mini2", 1), stoppedRun("mini2", 2), stoppedRun("build3", 3)]).small, ["1 run on build3 and 2 on mini2 stopped before anything loaded."]);
  // A host with a list beside a stopped run has its list: the stopped run leaves nothing open.
  assert.equal(projectLoadsOf([loadedRecord({ jobId: "a", host: "mini1" }), stoppedRun("mini1", 1), loadedRecord({ jobId: "b", host: "mini2" })]).state, "same");
  assert.deepEqual(projectLoadsOf([loadedRecord({ jobId: "a", host: "mini1" }), stoppedRun("mini1", 1), loadedRecord({ jobId: "b", host: "mini2" })], { historyIncomplete: true }).small, ["The run history could not be read completely."], "and no sentence blames it when something else does");
  // A project of nothing but: it says what it left out, not that nothing ran.
  const only = projectLoadsOf([noList("mini1", "none"), noList("mini1", "none", 2)]);
  assert.equal(only.state, "none");
  assert.deepEqual(only.small, ["Leaves out 2 runs with no agent, which load nothing."]);
  assert.equal(projectLoadsOf([stoppedRun("mini1", 1)]).rows.find((row) => row.label === "Extensions").value, "not kept");
});

test("the sample package canary is the shape a real one is: fired by hand from a cron trigger, on a folder", () => {
  const sample = webRecords().find((record) => record.packageCanary);
  const real = buildRecord({
    job: { id: manualCanaryJobId({ triggerId: "nightly", now: new Date(Date.parse(sample.startedAt)) }), name: "local", attemptsMade: 0, data: { kind: "local", folder: "/srv/web", flow: "fix", trigger: { id: "nightly", pattern: "0 1 * * *" }, packageCanary: { name: "pi-lint", version: "1.4.3" } } },
    result: { outcome: "completed", exitCode: 0, canaryLoad: "loaded" }, startedAt: sample.startedAt, endedAt: sample.endedAt, host: "mini1",
  });
  assert.match(real.jobId, /^manual:nightly:\d+1$/);
  assert.match(sample.jobId, /^manual:nightly:\d+1$/, "one millisecond past the minute, as `manualCanaryJobId` mints it");
  for (const key of ["kind", "target", "triggerIndex", "triggerType", "packageCanary"]) assert.deepEqual(sample[key], real[key], key);
});

test("a scheduled run names its trigger by its id, and offers the list that trigger is on", () => {
  const cron = (over = {}) => loadedRecord({ jobId: "repeat:nightly-report:1791000000000", kind: "local", target: "local:site", triggerIndex: null, triggerType: null, loaded: loadedField({ flow: { tier: "none", package: null } }), ...over });
  const v = loadedVerdict(cron());
  assert.deepEqual(v.fixes, [{ kind: "trigger", label: "Find nightly-report in Triggers", icon: "config", href: "/triggers?kind=schedule" }]);
  assert.deepEqual(outcomeBanner(cron()).fixes, v.fixes);
  assert.equal(lineOf(loadedVerdict(cron({ loaded: loadedField() }))), "Everything cron trigger nightly-report asks for loaded.");
  assert.equal(wordsText(loadedRows(cron()).find((row) => row.label === "MCP").more), "cron trigger nightly-report names no server");
  // A run fired by hand is that trigger's too. A skills folder's failure on one goes to the same place.
  assert.deepEqual(fixLabels(loadedVerdict(cron({ jobId: "manual:nightly-report:1791000000000" }))), ["Find nightly-report in Triggers"]);
  const folder = cron({ loaded: loadedField({ sources: [source("overlay"), source("repository"), source("trigger", { failed: 1 }), source("other")], problems: { failed: 1, dropped: 0, mcp: 0 } }) });
  assert.deepEqual(fixLabels(loadedVerdict(folder)), ["Find nightly-report in Triggers"]);
  // A row beats an id, and a job id that names nothing offers nothing.
  assert.deepEqual(fixLabels(loadedVerdict(cron({ triggerIndex: 4 }))), ["Open trigger 5"]);
  assert.deepEqual(loadedVerdict(cron({ jobId: "gh-1" })).fixes, []);
  assert.deepEqual(loadedVerdict(cron({ jobId: `repeat:${"x".repeat(201)}:1` })).fixes, [], "an id no scheduler holds is no name");
});

test("a host that differs offers the host that has it and the host behind it, a button each and named, and the sentence names the rest", () => {
  const v = loadedVerdict(S.hostDiffers(), HOST_LOADS);
  assert.deepEqual(v.fixes.map((fix) => [fix.label, fix.href]), [["Open build3", "/fleet/host?name=build3"], ["Open mini1", "/fleet/host?name=mini1"]]);
  // A host that published nothing is not known to be behind, so it gets words and no button. Past a few, the words name the rest.
  assert.ok(!fixLabels(v).includes("Open mini2"));
  const many = { hosts: [HOST_LOADS.hosts[0], ...["a", "b", "c", "d", "e"].map((name) => ({ ...HOST_LOADS.hosts[1], name }))] };
  const crowded = loadedVerdict(S.hostDiffers(), many);
  assert.deepEqual(fixLabels(crowded), ["Open build3", "Open a", "Open b", "Open c"]);
  assert.equal(HOSTS_OFFERED, crowded.fixes.length - 1);
  assert.match(crowded.rest, /a, b, c, d and e do not have it/);
});

test("a pattern in run.excludeTools reads as a person says it: one server's tools", () => {
  const record = loadedRecord({ loaded: loadedField({ leftOut: { tools: ["mcp__linear__*", "bash"], packages: false, overlayExtensions: false, restricted: false } }) });
  assert.equal(lineOf(loadedVerdict(record)), "Everything trigger 3 asks for loaded. Left out, as it asks: linear’s tools and bash.");
  assert.match(wordsText(loadedRows(record).find((row) => row.label === "Tools").more), /linear’s tools and bash removed$/);
});

test("loadedOf answers once per record, frozen, and reads again a record whose field was replaced", () => {
  const record = S.everything();
  const first = loadedOf(record);
  assert.equal(loadedOf(record), first, "the same answer, not a second rebuild");
  assert.notEqual(loadedOf({ ...record }), first, "another record is another reading");
  assert.deepEqual(loadedOf({ ...record }), first);
  // Shared, so nobody may write to it: at any depth.
  for (const part of [first, first.sources, first.sources[0], first.tools, first.tools.own, first.leftOut]) assert.ok(Object.isFrozen(part), JSON.stringify(part).slice(0, 40));
  assert.throws(() => first.sources.push({}), TypeError);
  assert.throws(() => { first.at = "start"; }, TypeError);
  // A field replaced after the first read is what the next read reads, hostile included.
  record.loaded = loadedField({ pi: "1.4.0" });
  assert.equal(loadedOf(record).pi, "1.4.0");
  record.loaded = HOSTILE_LOADED[0];
  assert.equal(loadedOf(record).runner, "invalid");
  // Every surface reads a frozen answer without writing: each of these walks the whole of it.
  for (const sample of Object.values(S)) {
    const r = sample();
    assert.doesNotThrow(() => { loadedVerdict(r, HOST_LOADS); loadedRows(r); loadedFold(r); outcomeBanner(r); outcomeNote(r); sandboxRunLine(r, "gh-x"); projectLoadsOf([r, r]); });
  }
});

test("the project's counts agree with themselves in the singular, and every way it will not say the same gives a reason", () => {
  const { loaded: _gone, ...older } = loadedRecord({ jobId: "gh-o" });
  const cut = { ...loadedRecord({ jobId: "gh-c", host: "mini2" }), loaded: recordedLoaded({ v: 1, runner: "cut" }) };
  const one = projectLoadsOf([loadedRecord(), cut]);
  assert.equal(one.small[0], "1 did not load or was not recorded: 1 with no room for what it loaded.");
  assert.equal(wordsText(one.rows.find((row) => row.label === "Extensions").more), "from each host’s newest run able to show them; 1 did not load or was not recorded");
  // Nothing is unread when every run was read: only the reason it will not say the same.
  const history = projectLoadsOf([loadedRecord(), loadedRecord({ jobId: "gh-2", host: "mini2" })], { historyIncomplete: true });
  assert.equal(history.state, "incomplete");
  assert.deepEqual(history.small, ["The run history could not be read completely."]);
  assert.equal(wordsText(history.rows.find((row) => row.label === "Extensions").more), "from each host’s newest run able to show them");
  const hostless = projectLoadsOf([loadedRecord(), { ...loadedRecord({ jobId: "gh-3" }), host: null }]);
  assert.deepEqual(hostless.small, ["1 run names no host, so it cannot be compared."]);
  const silent = projectLoadsOf([loadedRecord(), loadedRecord({ jobId: "gh-4", host: "mini2", outcome: "failed", exitCode: 1, tokens: null, loaded: loadedField({ at: "start", flow: null, sources: [], mcp: null, tools: null, problems: null }) })]);
  assert.deepEqual(silent.small, ["1 run on mini2 stopped before anything loaded."]);
  // A host whose runs only withheld its packages leaves them open, and says so.
  const withheld = projectLoadsOf([loadedRecord(), { ...S.leftOut(), host: "mini2" }]);
  assert.equal(withheld.state, "incomplete");
  assert.deepEqual(withheld.small, ["The runs on mini2 withheld the staged packages or were canaries, so they say nothing of them."]);
  // Both at once: each is said.
  const two = projectLoadsOf([loadedRecord(), { ...S.cut(), jobId: "gh-5", host: "mini2" }, older], { historyIncomplete: true });
  assert.ok(two.small.some((line) => line.startsWith("1 did not load or was not recorded")));
  assert.ok(two.small.includes("The run history could not be read completely."));
  assert.ok(two.small.includes("The records of mini2 were cut to fit, so they keep no whole list to compare."));
  // Words of the plural stay plural, and "all" counts more than one.
  assert.match(wordsText(projectLoadsOf([...billingRecords()]).rows[0].more), /^all 21 recorded runs$/);
  const single = projectLoadsOf([onlyRecorded(), { ...older, jobId: "gh-6", host: "mini1" }]);
  assert.equal(wordsText(single.rows[0].more), "the 1 recorded run");
  const cutWords = projectLoadsOf([loadedRecord(), { ...older, jobId: "gh-9" }, { ...older, jobId: "gh-10" }, { ...cut, jobId: "gh-11" }, { ...cut, jobId: "gh-12" }]);
  assert.match(cutWords.small[0], /2 with no room for what they loaded/);
  assert.match(cutWords.small[0], /2 from an older release/);
});
