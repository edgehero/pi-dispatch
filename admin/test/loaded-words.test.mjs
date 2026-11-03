import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { hostsAgree } from "@edgehero/pi-dispatch/host-loads";
import { recordedLoaded } from "../../worker/src/loaded-record.mjs";
import { LOADED_STATES, LOADED_WORDS, hostLoadsRow, hostPiFor, isOutcomeNote, loadedFold, loadedOf, loadedProblems, loadedRows, loadedVerdict, outcomeBanner, outcomeNote, projectLoadsOf, runningVerdict, sandboxFreshLine, sandboxRunLine, wordsText } from "../src/loaded-words.mjs";
import { outcomeKey } from "../src/words.mjs";
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

test("a failed MCP server stops the run: never a completed run's note, and no line says the run went on", () => {
  for (const record of [S.mcpFailed(), S.mcpTimeout()]) {
    assert.equal(outcomeNote(record), null);
    assert.deepEqual(loadedProblems(record), []);
    assert.ok(!lineOf(loadedVerdict(record)).includes("went on"));
    assert.equal(loadedVerdict(record).fixes[0].href, "/config/connections");
  }
  // "Its last attempt" only when the queue says so: an infrastructure failure writes a record per attempt.
  assert.deepEqual(loadedVerdict(S.mcpTimeout()).small, ["Retried, as any infrastructure failure."]);
  assert.deepEqual(loadedVerdict(S.mcpTimeout(), null, { jobEnded: true }).small, ["Retried, as any infrastructure failure; this was its last attempt."]);
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
  const atLoader = (over) => loadedRecord({ outcome: "failed", reason: "container-infra-exit", exitCode: 1, loaded: loadedField({ at: "loader", mcp: null, tools: null, ...over }) });
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
  // Ready, and the agent did start: whatever the outcome then, it ran without it.
  assert.equal(loadedVerdict(loadedRecord({ outcome: "failed", reason: "timeout", exitCode: 124, loaded: loadedField(noFlow) })).bold, LOADED_WORDS.ranWithoutFlow);
  assert.match(lineOf(loadedVerdict(loadedRecord({ outcome: "failed", reason: "timeout", exitCode: 124, loaded: loadedField({ ...failed, problems: { failed: 1, dropped: 0, mcp: 0 } }) }))), /The run went on without it\.$/);
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
  const connecting = loadedVerdict(loadedRecord({ outcome: "failed", exitCode: 1, reason: "container-infra-exit", loaded: loadedField({ at: "session", mcp: [{ name: "linear", state: "pending", tools: 0 }] }) }));
  assert.equal(connecting.state, "stopped");
  assert.equal(connecting.rest, LOADED_WORDS.stoppedServers);
  // A `-shadowed` refusal comes before the servers start, though their rows read pending: run-job.mjs throws first.
  assert.equal(loadedVerdict(S.stoppedBeforeServers()).state, "stopped");
  assert.equal(loadedVerdict(S.stoppedBeforeServers()).rest, "It stopped before its MCP servers started.");
  for (const reason of ["approval-shadowed", "await-input-shadowed", "report-progress-shadowed", "model-roles-shadowed"]) assert.equal(loadedVerdict({ ...S.stoppedBeforeServers(), reason }).rest, LOADED_WORDS.stoppedBeforeServers, reason);
  assert.equal(lineOf(loadedVerdict(loadedRecord({ outcome: "failed", exitCode: 1, loaded: loadedField({ at: "loader", mcp: null, tools: null }) }))), LOADED_WORDS.stoppedLoader);
  // Before anything loaded, "failed: 0" would be a claim, and "everything loaded" a false one.
  const early = (at) => loadedRecord({ outcome: "failed", exitCode: 1, loaded: loadedField({ at, flow: null, sources: [], mcp: null, tools: null, problems: null }) });
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

test("the overlay switch is this job's, so its words are true of a host's setting and of a canary's replay alike", () => {
  const off = { tools: [], packages: false, overlayExtensions: true, restricted: false };
  for (const over of [{}, { packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" } }]) {
    const record = loadedRecord({ ...over, host: "mini2", loaded: loadedField({ leftOut: off }) });
    const said = [lineOf(loadedVerdict(record)), wordsText(loadedRows(record).find((row) => row.label === "Extensions").more)].join(" ");
    assert.doesNotMatch(said, /host asks|mini2 leaves out/, "no line says the host asked: on a canary's replay it did not");
    assert.match(said, /Left out for this job: the overlay’s extensions\./);
    const from = wordsText(loadedFold(record).find((row) => row.kind === "Left out").from);
    assert.match(from, /PI_GLOBAL_ALLOW_EXTENSIONS=0/, "the fold names the host's setting");
    assert.match(from, /or for a canary’s replay/, "and never as the only cause");
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
  assert.deepEqual(loadedVerdict(full).small, ["Cut to fit: this record leaves out 2 packages, 1 server, 3 names and the exact value of 1 count."]);
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
    Extensions: ["pi-lint 1.4.2, pi-test-runner 0.9.0", "all 21 recorded runs, and git-guard in the 15 recorded on build3; 3 did not load or were not recorded"],
    Flows: ["fix in 15, review in 6", "fix from acme/billing’s .pi/skills; review from the overlay"],
    MCP: ["none", "no recorded run names a server"],
    Missing: ["nothing", "every recorded run found its flow and loaded every extension, and no MCP server stopped one"],
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
  assert.equal(wordsText(same.rows.find((row) => row.label === "Extensions").more), "every recorded run, but for trigger 2’s, which withhold them, and the canary gh-c0a7, which tried pi-lint 1.4.3");
  assert.deepEqual(same.rows.map((row) => row.label), ["pi", "Extensions"]);

  const none = projectLoadsOf([]);
  assert.equal(none.state, "none");
  assert.equal(none.top, "Nothing to read: no run of this project has a record in the last 7 days.");
  assert.deepEqual(none.small, ["Either none ran, or an older release wrote their records."]);
  assert.deepEqual(none.rows, []);
  assert.equal(projectLoadsOf([S.notRecorded()]).small[0], "Either none ran, or an older release wrote their records.");
  // A run that was refused is not an older release's, so that sentence would be false here.
  assert.equal(projectLoadsOf([S.notRecorded(), S.refused()]).small[0], "2 did not load or were not recorded: 1 from an older release, 1 refused.");

  const incomplete = projectLoadsOf(incompleteRecords());
  assert.equal(incomplete.state, "incomplete");
  assert.equal(incomplete.top, "Read from 9 of its 24 runs in the last 7 days, so runs may differ in ways this does not show.");
  assert.deepEqual(incomplete.small, ["15 did not load or were not recorded: 12 from an older release, 2 refused, 1 whose runner did not say."]);
  assert.equal(wordsText(incomplete.rows.find((row) => row.label === "Extensions").more), "the 9 recorded; unknown for the other 15");
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
  assert.equal(open.state, "incomplete", "agreeRow reads the record cut past its names as unknown");
  assert.deepEqual(open.small, ["The records of mini2 were cut to fit and keep no names to compare."]);
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

test("a canary or a restricted run has the overlay shut by its kind, so it says nothing of its host's overlay, and a host's own switch does", () => {
  const onHost = (names, host = "h1", i = 1) => loadedRecord({ jobId: `gh-${host}-${i}`, host, loaded: loadedField({ sources: [source("overlay", { names, extensions: names.length }), source("repository"), source("trigger"), source("other")] }) });
  const shut = (host, over, leftOut) => loadedRecord({ jobId: `gh-shut-${host}`, host, ...over, loaded: loadedField({ sources: [source("overlay"), source("repository"), source("trigger"), source("other")], leftOut: { tools: [], packages: false, overlayExtensions: false, restricted: false, ...leftOut } }) });
  const canary = shut("h2", { packageCanary: { name: "pi-a", version: "1.0.0", load: "loaded" } }, { overlayExtensions: true });
  const restricted = shut("h2", {}, { restricted: true });
  for (const record of [canary, restricted]) {
    const l = projectLoadsOf([onHost(["extra.ts"]), record]);
    assert.notEqual(l.state, "differs", record.jobId);
    assert.equal(l.state, "incomplete", "it cannot say the same either: h2 said nothing of its overlay");
    assert.deepEqual(l.small, ["The runs on h2 had the overlay shut, as canaries and restricted runs do, so they say nothing of its extensions."], record.jobId);
    // Once h2 has a run that can say, it says, whatever else it ran.
    assert.equal(projectLoadsOf([onHost(["extra.ts"]), record, onHost([], "h2", 2)]).state, "differs", record.jobId);
    assert.equal(projectLoadsOf([onHost(["extra.ts"]), record, onHost(["extra.ts"], "h2", 2)]).state, "same", record.jobId);
  }
  // Nothing differs here, and that is no answer either: h2's runs did not say.
  assert.equal(projectLoadsOf([onHost([]), canary]).state, "incomplete");
  // A host's own PI_GLOBAL_ALLOW_EXTENSIONS=0 is the host's, and it is a difference.
  const hostSwitch = shut("h2", {}, { overlayExtensions: true });
  assert.equal(projectLoadsOf([onHost(["extra.ts"]), hostSwitch]).state, "differs");
  // A project on one host has nothing to differ from, and a kind that shut the overlay leaves no question open there.
  assert.equal(projectLoadsOf([shut("h1", {}, { restricted: true })]).state, "same");
  // A record cut past its names does not leave the host's answer open if it was a canary's: it never spoke for the host.
  const compactCanary = loadedRecord({ jobId: "gh-cc", host: "h1", packageCanary: { name: "pi-a", version: "1.0.0", load: "loaded" }, loaded: S.cut().loaded });
  assert.equal(projectLoadsOf([onHost([]), compactCanary]).state, "same");
  // The row's own "every recorded run" holds: what every other run loaded is said as that, with the restricted one named.
  const names = ["git-guard"];
  const row = projectLoadsOf([onHost(names), onHost(names, "h1", 2), shut("h1", {}, { restricted: true })]).rows.find((entry) => entry.label === "Extensions");
  assert.equal(wordsText(row.value), "git-guard");
  assert.match(wordsText(row.more), /but for 1 run of a kind that leaves out the overlay’s extensions$/);
});

test("the project's counts agree with themselves in the singular, and every way it will not say the same gives a reason", () => {
  const { loaded: _gone, ...older } = loadedRecord({ jobId: "gh-o" });
  const cut = { ...loadedRecord({ jobId: "gh-c", host: "mini2" }), loaded: recordedLoaded({ v: 1, runner: "cut" }) };
  const one = projectLoadsOf([loadedRecord(), cut]);
  assert.equal(one.small[0], "1 did not load or was not recorded: 1 with no room for what it loaded.");
  assert.equal(wordsText(one.rows.find((row) => row.label === "Extensions").more), "the 1 recorded; unknown for the other 1");
  // Nothing is unknown when every run was read: only the reason it will not say the same.
  const history = projectLoadsOf([loadedRecord(), loadedRecord({ jobId: "gh-2", host: "mini2" })], { historyIncomplete: true });
  assert.equal(history.state, "incomplete");
  assert.deepEqual(history.small, ["The run history could not be read completely."]);
  assert.equal(wordsText(history.rows.find((row) => row.label === "Extensions").more), "the 2 recorded");
  const hostless = projectLoadsOf([loadedRecord(), { ...loadedRecord({ jobId: "gh-3" }), host: null }]);
  assert.deepEqual(hostless.small, ["1 run names no host, so it cannot be compared."]);
  const silent = projectLoadsOf([loadedRecord(), loadedRecord({ jobId: "gh-4", host: "mini2", loaded: loadedField({ at: "start", flow: null, sources: [], mcp: null, tools: null, problems: null }) })]);
  assert.deepEqual(silent.small, ["The runs on mini2 stopped before anything loaded."]);
  // Both at once: each is said.
  const two = projectLoadsOf([loadedRecord(), { ...S.cut(), jobId: "gh-5", host: "mini2" }, older], { historyIncomplete: true });
  assert.ok(two.small.some((line) => line.startsWith("1 did not load or was not recorded")));
  assert.ok(two.small.includes("The run history could not be read completely."));
  assert.ok(two.small.includes("The records of mini2 were cut to fit and keep no names to compare."));
  // Words of the plural stay plural, and "all" counts more than one.
  assert.match(wordsText(projectLoadsOf([...billingRecords()]).rows[0].more), /^all 21 recorded runs$/);
  const single = projectLoadsOf([onlyRecorded(), { ...older, jobId: "gh-6", host: "mini1" }]);
  assert.equal(wordsText(single.rows[0].more), "the 1 recorded run");
  const singleDiffers = projectLoadsOf([onlyRecorded(), loadedRecord({ jobId: "gh-7", host: "mini2", loaded: loadedField({ pi: "1.4.0", imagePi: "1.4.0" }) }), { ...older, jobId: "gh-8" }]);
  assert.equal(singleDiffers.state, "differs");
  const cutWords = projectLoadsOf([loadedRecord(), { ...older, jobId: "gh-9" }, { ...older, jobId: "gh-10" }, { ...cut, jobId: "gh-11" }, { ...cut, jobId: "gh-12" }]);
  assert.match(cutWords.small[0], /2 with no room for what they loaded/);
  assert.match(cutWords.small[0], /2 from an older release/);
});
