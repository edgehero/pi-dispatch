// The admin's half of the shared version rule (issue #761, `DES-STORE-VERSION-WHEN-NEEDED`) for the files it writes
// besides the overlay: the pause windows (the writer and the console's whole-list action on one serializer, keys carried,
// a newer file refused), the triggers view (a newer file is invalid, one with a repeated key broken), the projects
// writer's version (computed, never a literal), the sandbox verdict for a manifest a newer release kept, and the re-run
// and parked answer of a job a newer release queued (refused, since the copy would drop what this build cannot read).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { parkedAnswerRefusalOf, planParkedAnswer, planProjectsWrite, planRerun, readTriggers, rerunRefusalOf, writePauseWindows, writeProjects } from "../src/read-model.mjs";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import * as RM from "../src/read-model.mjs";
import { ACTIONS } from "../src/console/actions.mjs";
import { sandboxRetentionOf } from "../src/sandbox-verdict.mjs";
import { PAUSE_WINDOW_FIELDS, parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
import { PROJECTS_FIELD_VERSIONS, PROJECTS_VERSION, projectsVersionFor } from "@edgehero/pi-dispatch/projects";
import { versionTableProblems } from "@edgehero/pi-dispatch/store-version";
import { parseTriggersDocument, triggersFileNewer } from "@edgehero/pi-dispatch/triggers";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const W1 = { scope: "acme/web", from: "22:00", to: "06:00" };
const W2 = { scope: "acme/api", from: "01:00", to: "02:00" };

function pauseFile(initial) {
  const dir = tempDir("pd-761-pw-");
  const path = join(dir, "pause-windows.json");
  if (initial !== undefined) writeFileSync(path, initial);
  return { dir, path };
}

test("writePauseWindows carries every other top-level key in its place, and a file of windows alone is written as it always was (#761)", () => {
  const { path } = pauseFile(text({ note: "quiet nights", windows: [W1], owner: { team: "ops" } }));
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: (list) => [...list, W2], fs: nodeFs }), { ok: true });
  assert.equal(readFileSync(path, "utf8"), text({ note: "quiet nights", windows: [W1, W2], owner: { team: "ops" } }));
  // `windows` keeps its place when it is not first, and a file holding only `windows` comes out byte for byte as the
  // writer's historical `JSON.stringify({ windows }, null, 2)` plus the newline.
  const only = pauseFile(text({ windows: [W1] }));
  writePauseWindows({ pauseWindowsPath: only.path, mutate: (list) => [...list, W2], fs: nodeFs });
  assert.equal(readFileSync(only.path, "utf8"), `${JSON.stringify({ windows: [W1, W2] }, null, 2)}\n`);
  // A key named __proto__ is data, carried as written.
  const proto = pauseFile(`{"__proto__":{"x":1},"windows":[]}`);
  writePauseWindows({ pauseWindowsPath: proto.path, mutate: () => [W1], fs: nodeFs });
  assert.equal(readFileSync(proto.path, "utf8"), `{\n  "__proto__": {\n    "x": 1\n  },\n  "windows": [\n${JSON.stringify(W1, null, 2).replace(/^/gm, "    ")}\n  ]\n}\n`);
});

test("writePauseWindows refuses a file a newer pi-dispatch wrote before mutate runs, and still repairs a broken one (#761)", () => {
  const newer = text({ version: 2, windows: [W1], future: true });
  const { dir, path } = pauseFile(newer);
  let mutated = 0;
  const res = writePauseWindows({ pauseWindowsPath: path, mutate: (list) => (mutated++, list), fs: nodeFs });
  assert.deepEqual(res, { invalid: `pause-windows file written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and nothing in it was lost; change it with that release: ${path}`, newer: true });
  assert.equal(mutated, 0);
  assert.equal(readFileSync(path, "utf8"), newer);
  assert.deepEqual(readdirSync(dir), ["pause-windows.json"], "no tmp file");
  // A broken `version` is not newer: the write repairs it (the writer owns the version and 1 is written as nothing),
  // and an unparseable file is still rebuilt from empty, the recorded posture.
  writeFileSync(path, text({ version: "2", windows: [W1] }));
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: (list) => list, fs: nodeFs }), { ok: true });
  assert.equal(readFileSync(path, "utf8"), text({ windows: [W1] }));
  writeFileSync(path, "not json");
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: (list) => [...list, W2], fs: nodeFs }), { ok: true });
  assert.equal(readFileSync(path, "utf8"), text({ windows: [W2] }));
});

/** The console's whole-list action, previewed and applied as its confirm applies it. */
function wholeList(path) {
  const action = ACTIONS.find((a) => a.name === "pause-windows");
  const ctx = { a: { rm: RM }, fs: nodeFs, config: { pauseWindowsPath: path }, session: { role: "operator" }, deps: { writePauseWindows: RM.writePauseWindows } };
  return { preview: (body) => action.preview(body, ctx), apply: (entry) => action.apply(entry, ctx) };
}

test("the console's whole-list pause action serializes as writePauseWindows does: its after digest is the written file's, other keys carried (#761)", async () => {
  const { path } = pauseFile(text({ note: "quiet nights", windows: [W1], owner: "ops" }));
  const act = wholeList(path);
  const preview = await act.preview({ windows: [W1, W2] });
  assert.equal(preview.refusal, undefined, preview.refusal);
  assert.deepEqual(await act.apply(preview), { ok: true });
  const written = readFileSync(path, "utf8");
  assert.equal(written, text({ note: "quiet nights", windows: [W1, W2], owner: "ops" }));
  assert.equal(preview.afterDigest, sha256(written), "the preview's after digest is the digest of what was written");
  // A window field is the parser's own list, named in the refusal.
  assert.deepEqual(PAUSE_WINDOW_FIELDS, ["scope", "from", "to", "tz", "days", "dateFrom", "dateTo"]);
  const odd = await act.preview({ windows: [{ ...W1, colour: "red" }] });
  assert.equal(odd.refusal, `pause window row 1 has a field this file does not take (${PAUSE_WINDOW_FIELDS.join(", ")} only); nothing was changed`);
  // Every field the list names is one the parser accepts on a window.
  parsePauseWindows(JSON.stringify({ windows: [{ scope: "*", from: "01:00", to: "02:00", tz: "UTC", days: ["mon"], dateFrom: "2026-01-01", dateTo: "2026-12-31" }] }), path);
});

test("the console's whole-list pause action refuses a file a newer pi-dispatch wrote at the preview, in the writer's words (#761)", async () => {
  const newer = text({ version: 2, windows: [W1] });
  const { path } = pauseFile(newer);
  const preview = await wholeList(path).preview({ windows: [] });
  assert.deepEqual(preview, { refusal: `pause-windows file written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and nothing in it was lost; change it with that release: ${path}`, status: 409 });
  assert.equal(readFileSync(path, "utf8"), newer);
});

test("readTriggers reads a triggers file a newer pi-dispatch wrote as invalid, naming the versions and never the path (#761)", () => {
  const dir = tempDir("pd-761-tr-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, text({ version: 2, triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }] }));
  assert.deepEqual(readTriggers({ triggersPath }), { invalid: "triggers file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true });
  // A version this build reads, written by hand, is read as before; the display stays lenient on a broken one.
  writeFileSync(triggersPath, text({ version: 1, triggers: [] }));
  assert.deepEqual(readTriggers({ triggersPath }), { triggers: [], count: 0 });
  writeFileSync(triggersPath, text({ version: "x", triggers: [] }));
  assert.deepEqual(readTriggers({ triggersPath }), { triggers: [], count: 0 });
});

test("readTriggers reads a file whose version is written twice as broken, never newer, as the loaders and triggersFileNewer do (#761)", () => {
  const dir = tempDir("pd-761-tr-dup-");
  const triggersPath = join(dir, "triggers.json");
  const broken = "triggers file has a duplicate key, so it is broken, not newer: JSON keeps the last value, so the file that was reviewed and the file that runs are not the same file";
  // `JSON.parse` keeps the last value, so each of these reads as version 2 once parsed; the text says the file is broken.
  for (const dup of ['{"triggers":[],"version":1,"version":2}', '{"version":2,"triggers":[],"version":2}', '{"version":2,"triggers":[],"triggers":[]}']) {
    writeFileSync(triggersPath, dup);
    const view = readTriggers({ triggersPath });
    assert.deepEqual(view, { invalid: broken }, dup);
    assert.match(view.invalid, /broken/);
    assert.equal(view.newer, undefined, `${dup}: not newer`);
    assert.equal(triggersFileNewer(dup), false, `${dup}: the worker's per-job reader agrees`);
    assert.throws(() => parseTriggersDocument(dup, triggersPath), (e) => /duplicate key/.test(e.message) && e.newer === undefined, `${dup}: the loader calls it broken`);
  }
  // The same file written once is newer, in all three readers' words.
  const once = '{"triggers":[],"version":2}';
  writeFileSync(triggersPath, once);
  assert.deepEqual(readTriggers({ triggersPath }), { invalid: "triggers file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true });
  assert.equal(triggersFileNewer(once), true);
  assert.throws(() => parseTriggersDocument(once, triggersPath), (e) => e.newer === true);
});

test("projectsVersionFor is the lowest version the rows need, never above PROJECTS_VERSION, and its table holds the rule (#761)", () => {
  assert.equal(projectsVersionFor([{ id: "web", members: ["github:acme/web"] }]), 1);
  assert.equal(projectsVersionFor([]), 1);
  // With an injected table, a row using a field that needs 2 stamps 2; one that does not, 1; never above `supported`.
  const table = Object.freeze({ budgetGroup: 2 });
  assert.equal(projectsVersionFor([{ id: "a", members: [] }, { id: "b", members: [], budgetGroup: "x" }], { table, supported: 2 }), 2);
  assert.equal(projectsVersionFor([{ id: "a", members: [] }], { table, supported: 2 }), 1);
  assert.equal(projectsVersionFor([{ id: "b", members: [], budgetGroup: "x" }], { table, supported: 1 }), 1);
  assert.equal(projectsVersionFor([{ id: "b", members: [], __proto__: { budgetGroup: "x" } }], { table, supported: 2 }), 1, "an inherited field is not the row's");
  assert.deepEqual(versionTableProblems(PROJECTS_FIELD_VERSIONS, { known: ["id", "name", "members"], version: PROJECTS_VERSION }), []);
});

test("planProjectsWrite writes the version projectsVersionFor computes, never a literal: both are 1 today, so only its source can tell (#761)", () => {
  const source = planProjectsWrite.toString();
  assert.match(source, /version: projectsVersionFor\(rows\)/);
  assert.match(source, /version: projectsVersionFor\(stored\)/);
  assert.doesNotMatch(source, /version:\s*1\b/);
  // And the file it writes is today's byte for byte.
  const dir = tempDir("pd-761-pj-");
  const projectsPath = join(dir, "projects.json");
  assert.deepEqual(writeProjects({ projectsPath, mutate: () => [{ id: "web", members: ["github:acme/web"] }], fs: nodeFs }), { ok: true });
  assert.equal(readFileSync(projectsPath, "utf8"), text({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
});

/** A retained run's directory under a fresh sandbox root, holding `manifest`. */
function retained(jobId, manifest) {
  const sandboxDir = tempDir("pd-761-sb-");
  mkdirSync(join(sandboxDir, jobId), { recursive: true });
  writeFileSync(join(sandboxDir, jobId, "manifest.json"), JSON.stringify({ jobId, kind: "github", image: "pi-job:latest", workspace: join(sandboxDir, jobId, "workspace"), createdAt: new Date(0).toISOString(), keepUntil: null, backend: "local", ...manifest }));
  return sandboxDir;
}

test("the sandbox verdict for a manifest a newer pi-dispatch kept is manifest-newer, before the venue, and a broken version is its own word (#761)", () => {
  const now = () => 3_600_000;
  // A newer manifest is refused whatever its venue says: that release may have redefined it.
  const newer = retained("gh-1", { version: 2, backend: "not-a-venue-here" });
  assert.deepEqual(sandboxRetentionOf({ sandboxDir: newer, sandboxRetentionHours: 24 }, "gh-1", { now, venuePolicy: "unknown" }), { retained: false, why: "manifest-newer", reason: "not reopenable here: kept by a newer pi-dispatch" });
  const broken = retained("gh-2", { version: "2" });
  assert.deepEqual(sandboxRetentionOf({ sandboxDir: broken, sandboxRetentionHours: 24 }, "gh-2", { now, venuePolicy: "unknown" }), { retained: false, why: "manifest-unreadable", reason: "not reopenable (its manifest's version is unreadable)" });
  // A manifest this build reads (no version, or 1) is judged as before.
  const known = retained("gh-3", { version: 1 });
  const ok = sandboxRetentionOf({ sandboxDir: known, sandboxRetentionHours: 24 }, "gh-3", { now, venuePolicy: "unknown" });
  assert.equal(ok.why, "workspace-gone", "past the version check, the next refusal is the run's own");
});

// ---- a job a newer pi-dispatch queued: neither re-run nor answered from here ----

/** The refusal a re-run of a job a newer pi-dispatch queued gives, the record refusal's shape and words. */
const rerunNewer = (jobId) => `${jobId} was queued by a newer pi-dispatch, whose job this console cannot rebuild, so it cannot be re-run from here; re-run it from a console of that release`;
const answerNewer = (jobId) => `${jobId} was queued by a newer pi-dispatch, whose job this console cannot rebuild, so the reply cannot be built here; answer it from a console of that release`;
const ENDED = "2026-10-14T12:00:00.000Z";
const AFTER = Date.parse(ENDED) + 60_000;
const LOCAL_DATA = Object.freeze({ kind: "local", folder: "/srv/site", flow: "fix", task: "tidy" });
const FORGE_DATA = Object.freeze({ kind: "github", repo: "acme/web", target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "fix", trigger: { event: "issues", action: "labeled", deliveryId: "d-1", matched: { index: 0, type: "label" } } });

/**
 * A deployment the planners read through fakes: one record per job on disk, and a queue that holds `data` under every
 * job id, so a planner reaches its data checks without a Valkey.
 */
function heldJobs(records, data) {
  const logsDir = tempDir("pd-761-newer-job-");
  for (const record of records) writeFileSync(join(logsDir, `${sanitizeJobId(record.jobId)}.json`), JSON.stringify(record));
  const triggersPath = join(logsDir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
  const redisFn = () => ({ on() {}, async get() { return null; }, smembers: async () => [], scan: async () => ["0", []], disconnect() {}, quit() {} });
  const queueFn = (_connection, { name }) => ({ name, getJob: async (id) => ({ id, data }), close: async () => {} });
  return { url: "redis://unused", logsDir, triggersPath, redisFn, queueFn, parseConnectionFn: () => ({}), timeoutMs: 200 };
}

test("a re-run of a local or a forge job a newer pi-dispatch queued is refused before anything is copied, in the newer record's words (#761)", async () => {
  for (const [jobId, kind, base] of [["local-9f8e7d", "local", LOCAL_DATA], ["gh-acme-web-7", "github", FORGE_DATA]]) {
    const record = { jobId, kind, outcome: "failed", startedAt: "2026-10-14T11:50:00.000Z", endedAt: ENDED };
    // Above this build's version, and a `dataVersion` no release writes (a string, 0): neither is read as this build's.
    for (const dataVersion of [2, "2", 0]) {
      const data = { ...base, dataVersion };
      assert.equal(rerunRefusalOf(record, AFTER, data), rerunNewer(jobId), `${kind} ${JSON.stringify(dataVersion)}`);
      assert.deepEqual(await planRerun({ ...heldJobs([record], data), jobId, now: () => AFTER }), { refusal: rerunNewer(jobId) }, `${kind} ${JSON.stringify(dataVersion)}: the planner asks the same check first`);
    }
    // The same job as this build queues it (no stamp, or version 1) passes this check: only the stamp refuses.
    for (const data of [base, { ...base, dataVersion: 1 }]) {
      assert.equal(rerunRefusalOf(record, AFTER, data), null, `${kind} ${JSON.stringify(data.dataVersion)}`);
      assert.notEqual((await planRerun({ ...heldJobs([record], data), jobId, now: () => AFTER })).refusal, rerunNewer(jobId), kind);
    }
  }
  // A cron run is rebuilt from its trigger and copies nothing of its data, so a stamp on that data refuses nothing here.
  const cron = { jobId: "repeat:nightly:1760443200000", kind: "local", outcome: "failed", startedAt: "2026-10-14T11:50:00.000Z", endedAt: ENDED };
  assert.equal(rerunRefusalOf(cron, AFTER, { ...LOCAL_DATA, dataVersion: 2 }), null);
});

test("a parked run whose job a newer pi-dispatch queued is not answered from the console, before the triggers file is read (#761)", async () => {
  const jobId = "gh-acme-web-park";
  const record = { jobId, kind: "github", target: "acme/web#7", outcome: "completed", reason: "awaiting-input", startedAt: "2026-10-14T11:50:00.000Z", endedAt: ENDED };
  for (const dataVersion of [2, "2"]) {
    const data = { ...FORGE_DATA, dataVersion };
    // Ahead of every check the triggers file decides: a path that names no file is never read.
    assert.deepEqual(parkedAnswerRefusalOf({ jobId, data, triggersPath: "/nonexistent/triggers.json" }), { refusal: answerNewer(jobId) });
    assert.deepEqual(parkedAnswerRefusalOf({ jobId, data, triggersPath: "/nonexistent/triggers.json", approval: true }), { refusal: answerNewer(jobId) }, "an approval's answer too");
    const deployment = heldJobs([record], data);
    assert.deepEqual(await planParkedAnswer({ ...deployment, jobId, text: "use the staging db", by: "alice", runsFn: async () => [], now: () => AFTER }), { refusal: answerNewer(jobId) }, JSON.stringify(dataVersion));
  }
  // The newer check comes before every check on the job's own fields, which only this build's meaning can judge: a kind
  // this console does not know (a newer release may add a forge, stamped for that reason) is refused as newer, not as
  // "is a <kind> run", and an approval's answer as newer, not for a missing gate declaration.
  for (const [data, approval] of [[{ ...FORGE_DATA, kind: "bitbucket", dataVersion: 2 }, false], [{ ...FORGE_DATA, kind: "bitbucket", dataVersion: 2 }, true], [{ ...FORGE_DATA, dataVersion: 2 }, true]]) {
    const said = parkedAnswerRefusalOf({ jobId, data, triggersPath: "/nonexistent/triggers.json", approval });
    assert.deepEqual(said, { refusal: answerNewer(jobId) }, `${data.kind}${approval ? ", an approval" : ""}`);
  }
  const unknown = { ...FORGE_DATA, kind: "bitbucket", dataVersion: 2 };
  assert.deepEqual(await planParkedAnswer({ ...heldJobs([{ ...record, kind: "bitbucket" }], unknown), jobId, text: "use the staging db", by: "alice", runsFn: async () => [], now: () => AFTER }), { refusal: answerNewer(jobId) }, "the planner asks the same check in the same order");
  // Unstamped, the same job is refused for what it is, so only the order tells the two apart.
  assert.deepEqual(parkedAnswerRefusalOf({ jobId, data: { ...FORGE_DATA, kind: "bitbucket" }, triggersPath: "/nonexistent/triggers.json" }), { refusal: `${jobId} is a bitbucket run; only a forge issue's parked run is answered this way` });
  // This build's job goes on to the triggers file's own refusal (it names no comment trigger), never the newer one.
  const deployment = heldJobs([record], FORGE_DATA);
  assert.deepEqual(parkedAnswerRefusalOf({ jobId, data: FORGE_DATA, triggersPath: deployment.triggersPath }), { refusal: "the triggers file has no github comment trigger, so the receiver would not route a reply either" });
  assert.deepEqual(await planParkedAnswer({ ...deployment, jobId, text: "use the staging db", by: "alice", runsFn: async () => [], now: () => AFTER }), { refusal: "the triggers file has no github comment trigger, so the receiver would not route a reply either" });
});
