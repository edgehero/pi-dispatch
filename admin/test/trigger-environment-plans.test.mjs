// The person's change to what a trigger's jobs get (issue #800): the real planner against a real triggers file, its bytes read
// back after each write. Nothing here hand-writes a plan or a file the writer did not write, because a shape written by hand
// can hide the defect it stands in for.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeMcpCheck } from "@edgehero/pi-dispatch/mcp-preflight";
import { checkFailoverCandidate, markModelCooldown, selectFailoverJob } from "@edgehero/pi-dispatch/model-failover";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { readEnvAssignments } from "@edgehero/pi-dispatch/env-file";
import { loadSchedules } from "@edgehero/pi-dispatch/schedules";
import { resolveModelRoles } from "@edgehero/pi-dispatch/model-roles";
import { makeCheckWaitSkew } from "@edgehero/pi-dispatch/triggers-file";
import { FIRST_CALL_SHORT_TASK_BYTES, builtinModel, firstCallFloorMicros } from "@edgehero/pi-dispatch/model-catalog";
import { parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { createCostGuard } from "../../image/runner/src/usage-meter.mjs";
import { DEFAULT_ON_TOOL_NAMES, EXCLUDABLE_TOOL_NAMES, parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { createFleetReader, readTriggerSkew } from "../src/read-model.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { TRIGGER_GETS_WORDS } from "../src/trigger-gets-view.mjs";
import { CARD_FIELDS, triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { doneBannerHtml } from "../src/console/confirm-view.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const operator = { surface: "console", role: "operator", name: "ops" };
const HAIKU = "anthropic/claude-haiku-4-5"; // a short task's first call: $0.343574 at the pin
const SONNET = "anthropic/claude-sonnet-5-5"; // $1.327148
const OPUS = "anthropic/claude-opus-5-5"; // $2.654295, and its floor $2.62144
/** pi's default prompt and tools at the pin, about: `worker/test/first-call-bytes.pinned.test.mjs` measures them. */
const DEFAULT_CONTEXT_BYTES = 5100;

const comment = (run = {}) => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", ...run } });
const cron = { on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder: "/nowhere", flow: "tidy", task: "PRIVATE TASK" } };
const text = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/** A real overlay's servers, and what lets each be judged clean: egress off, and the one key linear reads forwarded with a value. */
const MCP_JSON = { mcpServers: { linear: { url: "https://mcp.example.com/mcp", description: "Linear", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } }, docs: { url: "https://docs.example.com/mcp", description: "Docs" }, x: { url: "https://x.example.com/mcp", description: "X" } } };
const HOST_ENV = { PI_EGRESS: "0", PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "a value" };

function fixture({ run = {}, doc = null, settings = {}, env = {}, overlay = null, mcpJson = MCP_JSON, deps = {} } = {}) {
  const dir = tempDir("pd-800-env-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: null, globalPiDir: join(dir, "overlay") };
  const original = doc ?? { retained: { kept: true }, triggers: [cron, comment(run)] };
  nodeFs.writeFileSync(paths.triggersPath, text(original));
  nodeFs.writeFileSync(paths.settingsFile, JSON.stringify(settings));
  nodeFs.mkdirSync(paths.globalPiDir);
  if (overlay) nodeFs.writeFileSync(join(paths.globalPiDir, "models.json"), JSON.stringify(overlay));
  if (mcpJson !== null) nodeFs.writeFileSync(join(paths.globalPiDir, "mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson));
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-haiku-4-5", ...HOST_ENV, ...env }, now: () => NOW, deploymentDir: dir, ...deps });
  const read = () => nodeFs.readFileSync(paths.triggersPath, "utf8");
  const entry = (index = 1) => JSON.parse(read()).triggers[index];
  const digest = (index = 1) => triggerEntryDigest(entry(index));
  return { dir, paths, service, read, entry, digest, original };
}
const ask = (f, change, index = 1) => ({ index, pageDigest: f.digest(index), ...change });
/** Preview, then the Confirm's half, as the ticket would hold it: what `previewAction` stores is what `apply` gets. */
async function write(f, change, index = 1) {
  const out = await f.service.preview(ask(f, change, index), operator);
  assert.ok(out.plan, JSON.stringify(out));
  const res = await f.service.apply(out, operator);
  assert.deepEqual(res, { ok: true });
  return out;
}
const refusal = async (f, change, index = 1) => {
  const out = await f.service.preview(ask(f, change, index), operator);
  assert.ok(out.refusal, JSON.stringify(out?.summary ?? out));
  return out;
};
/** A preview that stands and warns: the person can still Confirm, and the warnings as one text. */
const warned = async (f, change, index = 1) => {
  const out = await f.service.preview(ask(f, change, index), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.ok(out.plan.warnings.length > 0, JSON.stringify(out.summary));
  for (const line of out.plan.warnings) assert.ok(out.summary.includes(line), line);
  return out.plan.warnings.join(" ");
};
/** A preview that stands and has nothing to warn of. */
const quiet = async (f, change, index = 1) => {
  const out = await f.service.preview(ask(f, change, index), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.warnings, []);
  return out;
};
/** The Undo button's own round trip: the form the banner draws, read back the way `script.mjs` `bodyOf` reads each input. */
function undoBody(inverse) {
  const form = String(doneBannerHtml({ summary: "Changed", by: "ops", auditSeq: 1, count: 1, undo: "Put it back", inverse }));
  const unescape = (s) => s.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const body = {};
  for (const [, attrs] of form.matchAll(/<input type="hidden"([^>]*)>/g)) {
    const name = /name="([^"]*)"/.exec(attrs)[1];
    const value = unescape(/value="([^"]*)"/.exec(attrs)[1]);
    const type = /data-type="([^"]*)"/.exec(attrs)?.[1];
    body[name] = type === "int" ? Number(value) : type === "json" ? JSON.parse(value) : value;
  }
  return body;
}

// ---- the file ---------------------------------------------------------------------------------------------------------

test("CARD_FIELDS are the nine the card edits, named once; image, secrets and skillsDir are not among them", () => {
  assert.deepEqual([...CARD_FIELDS], ["flow", "provider", "model", "maxCostUsd", "models", "fallbackModels", "mcp", "packages", "excludeTools"]);
  assert.ok(Object.isFrozen(CARD_FIELDS));
  for (const key of ["image", "secrets", "secretsProfile", "skillsDir", "backend", "maxTurns"]) assert.ok(!CARD_FIELDS.includes(key), key);
});

test("a preview writes nothing, and leaves no lock or temporary file beside the triggers file", async () => {
  const f = fixture();
  const before = f.read();
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.ok(out.plan);
  assert.equal(f.read(), before);
  assert.deepEqual(nodeFs.readdirSync(f.dir).sort(), ["overlay", "settings.json", "triggers.json"]);
  assert.equal(out.beforeText, before);
  assert.notEqual(out.afterText, before);
});

// ---- a read that fails ------------------------------------------------------------------------------------------------

/** A real fs whose `target`-th read, of any file, fails once: every read before and after it succeeds. Stats and listings count. */
function failingOnce(target) {
  let n = 0;
  const failAt = (name) => (...args) => {
    n += 1;
    if (n === target) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return nodeFs[name](...args);
  };
  return { ...nodeFs, readFileSync: failAt("readFileSync"), statSync: failAt("statSync"), lstatSync: failAt("lstatSync"), readdirSync: failAt("readdirSync"), existsSync: nodeFs.existsSync, get count() { return n; } };
}
/** One planner over one real file, its `fs` swapped per call: what the service holds is what the worker's writer gets. */
function failingFixture() {
  let current = nodeFs;
  const fs = new Proxy({}, { get: (_, key) => current[key] });
  const f = fixture({ deps: { fs } });
  return { ...f, use: (next) => { current = next; } };
}

test("the Confirm: every read failing once leaves the file whole or exactly as previewed, and never empties it", async () => {
  const f = failingFixture();
  const before = f.read();
  const planned = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.ok(planned.plan);
  const counting = failingOnce(0);
  f.use(counting);
  assert.deepEqual(await f.service.apply(planned, operator), { ok: true });
  const reads = counting.count;
  const landed = f.read();
  assert.notEqual(landed, before);
  assert.ok(reads >= 3, `the judgement, the dry run and the write each read the file (${reads} reads)`);
  let refused = 0;
  for (let target = 1; target <= reads; target += 1) {
    nodeFs.writeFileSync(f.paths.triggersPath, before);
    f.use(failingOnce(target));
    const res = await f.service.apply(planned, operator);
    const now = f.read();
    if (res.ok === true) assert.equal(now, landed, `read ${target} failed, and the write that landed is the one previewed`);
    else {
      refused += 1;
      assert.equal(typeof res.invalid, "string", `read ${target}: ${JSON.stringify(res)}`);
      assert.equal(now, before, `read ${target} failed: refused, with every trigger still in the file`);
    }
    assert.deepEqual(nodeFs.readdirSync(f.dir).sort(), ["overlay", "settings.json", "triggers.json"], `read ${target}: no lock and no tmp file`);
  }
  assert.ok(refused >= 3, `the file's own reads each refuse (${refused})`);
});

test("the Confirm, its own write's read failing: the writer's words, nothing written", async () => {
  const f = failingFixture();
  const before = f.read();
  const planned = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  // The apply's reads of the triggers file, the last but one of which is the writer's (the last is its re-check).
  const seen = [];
  f.use({ ...nodeFs, readFileSync: (p, ...rest) => { if (p === f.paths.triggersPath) seen.push(p); return nodeFs.readFileSync(p, ...rest); } });
  assert.deepEqual(await f.service.apply(planned, operator), { ok: true });
  nodeFs.writeFileSync(f.paths.triggersPath, before);
  let n = 0;
  f.use({ ...nodeFs, readFileSync: (p, ...rest) => {
    if (p === f.paths.triggersPath && ++n === seen.length - 1) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return nodeFs.readFileSync(p, ...rest);
  } });
  const res = await f.service.apply(planned, operator);
  assert.equal(res.invalid, `the triggers file ${f.paths.triggersPath} could not be read (EIO), so its triggers cannot be kept; nothing was written`);
  assert.equal(f.read(), before);
});

test("the preview: every read failing once answers, and writes nothing; the file's own say this page could not read it", async () => {
  const f = failingFixture();
  const before = f.read();
  const body = ask(f, { mcp: ["docs"] });
  const counting = failingOnce(0);
  f.use(counting);
  assert.ok((await f.service.preview(body, operator)).plan);
  const reads = counting.count;
  const words = new Set();
  for (let target = 1; target <= reads; target += 1) {
    f.use(failingOnce(target));
    // No throw: a throw here is a page saying its log has the reason, for a failed read that has one sentence.
    const out = await f.service.preview(body, operator);
    assert.ok(out.plan || out.refusal, `read ${target}: ${JSON.stringify(out)}`);
    if (out.refusal) words.add(out.refusal);
    assert.equal(f.read(), before, `read ${target}`);
    assert.deepEqual(nodeFs.readdirSync(f.dir).sort(), ["overlay", "settings.json", "triggers.json"], `read ${target}`);
  }
  assert.ok(words.has("The triggers file could not be read, so this change could not be judged. Nothing is written over a file this page cannot read."), [...words].join(" | "));
});

for (const change of [{ model: "claude-sonnet-5-5", maxCostUsd: "5" }, { models: [HAIKU, "local/own"] }, { fallbackModels: [SONNET] }, { excludeTools: ["write"] }, { flow: "review" }]) {
  test(`the preview of ${JSON.stringify(change)}: a read failing anywhere, with an overlay to read, answers and writes nothing`, async () => {
    let current = nodeFs;
    const fs = new Proxy({}, { get: (_, key) => current[key] });
    const f = fixture({ run: { mcp: ["docs"] }, overlay: { providers: { local: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "none", models: [{ id: "own" }] } } }, deps: { fs } });
    const before = f.read();
    const body = ask(f, change);
    const counting = failingOnce(0);
    current = counting;
    const clean = await f.service.preview(body, operator);
    assert.ok(clean.plan, JSON.stringify(clean));
    for (let target = 1, reads = counting.count; target <= reads; target += 1) {
      current = failingOnce(target);
      const out = await f.service.preview(body, operator);
      assert.ok(out.plan || out.refusal, `read ${target}: ${JSON.stringify(out)}`);
      assert.equal(f.read(), before, `read ${target}`);
    }
  });
}

test("the preview, the dry run's own read failing: the same sentence, by the same state, not a broken page", async () => {
  const f = failingFixture();
  const body = ask(f, { mcp: ["docs"] });
  // Reads of the triggers file in a preview: the snapshot, the judgement's, then the funnel's and its re-check.
  let n = 0;
  f.use({ ...nodeFs, readFileSync: (p, ...rest) => {
    if (p === f.paths.triggersPath && ++n === 3) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return nodeFs.readFileSync(p, ...rest);
  } });
  const out = await f.service.preview(body, operator);
  assert.equal(n >= 3, true);
  assert.deepEqual([out.refusal, out.status, out.state], ["The triggers file could not be read, so this change could not be judged. Nothing is written over a file this page cannot read.", 409, "changed"]);
});

for (const [what, method, code] of [["the tmp file's write", "writeFileSync", "ENOSPC"], ["the rename", "renameSync", "EIO"]]) {
  test(`the Confirm, ${what} failing: it throws for the pipeline's own sentence, and the old file is whole`, async () => {
    const f = failingFixture();
    const before = f.read();
    const planned = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
    f.use({ ...nodeFs, [method]: () => { throw Object.assign(new Error(code), { code }); } });
    await assert.rejects(f.service.apply(planned, operator), (e) => e.code === code);
    assert.equal(f.read(), before);
    assert.deepEqual(nodeFs.readdirSync(f.dir).sort(), ["overlay", "settings.json", "triggers.json"]);
  });
}

// One row per field the card writes: what is sent, and the entry's `run` it must leave, every other byte of the file the same.
const EVERY_FIELD = {
  kind: "github", flow: "fix", provider: "anthropic", model: "claude-haiku-4-5", steer: true, models: [HAIKU, SONNET], instructions: "Use pnpm", fallbackModels: [SONNET], mcp: ["docs", "forge"], packages: false, secrets: { T: "op://v/r" }, excludeTools: ["bash", "write"], maxCostUsd: "2.50", progress: true,
};
const edits = [
  ["flow", { flow: "review" }, { ...EVERY_FIELD, flow: "review" }],
  ["provider", { provider: "anthropic" }, null],
  ["model", { model: "claude-sonnet-5-5" }, { ...EVERY_FIELD, model: "claude-sonnet-5-5" }],
  ["maxCostUsd", { maxCostUsd: "1.75" }, { ...EVERY_FIELD, maxCostUsd: "1.75" }],
  ["models", { models: [SONNET, HAIKU] }, { ...EVERY_FIELD, models: [SONNET, HAIKU] }],
  ["fallbackModels", { fallbackModels: [HAIKU] }, { ...EVERY_FIELD, fallbackModels: [HAIKU] }],
  ["mcp", { mcp: ["forge"] }, { ...EVERY_FIELD, mcp: ["forge"] }],
  ["packages", { packages: true }, { ...EVERY_FIELD, packages: true }],
  ["excludeTools", { excludeTools: ["write", "read"] }, { ...EVERY_FIELD, excludeTools: ["write", "read"] }],
];
for (const [what, change, wantRun] of edits) {
  test(`${what}: only that key's bytes move, in place, in the whole file`, async () => {
    const f = fixture({ run: EVERY_FIELD, env: { PI_MAX_COST_USD: "5" } });
    const before = f.read();
    const out = await f.service.preview(ask(f, change), operator);
    if (wantRun === null) {
      assert.match(out.unchanged, /trigger row 2 already says this/);
      assert.equal(f.read(), before);
      return;
    }
    assert.ok(out.plan, JSON.stringify(out));
    assert.deepEqual(await f.service.apply(out, operator), { ok: true });
    assert.equal(f.read(), text({ retained: { kept: true }, triggers: [cron, { on: comment().on, run: wantRun }] }));
  });
}

test("null deletes a key, a sent key is added at the end, and every key not sent keeps its bytes and its place", async () => {
  const f = fixture({ run: EVERY_FIELD, env: { PI_MAX_COST_USD: "5" } });
  await write(f, { excludeTools: null, fallbackModels: null, provider: null, model: null, models: null, mcp: null, packages: null, maxCostUsd: null });
  assert.equal(f.read(), text({ retained: { kept: true }, triggers: [cron, { on: comment().on, run: { kind: "github", flow: "fix", steer: true, instructions: "Use pnpm", secrets: { T: "op://v/r" }, progress: true } }] }));
  const g = fixture({ run: { resume: true } });
  await write(g, { packages: false, mcp: ["docs"] });
  assert.deepEqual(Object.keys(g.entry().run), ["kind", "flow", "resume", "mcp", "packages"], "added in CARD_FIELDS' order, after the keys it had");
});

test("the other triggers, and every top-level key, are the same bytes after a write", async () => {
  const f = fixture({ run: { resume: true } });
  const before = JSON.parse(f.read());
  await write(f, { packages: false });
  const after = JSON.parse(f.read());
  assert.deepEqual(after.retained, before.retained);
  assert.deepEqual(after.triggers[0], before.triggers[0]);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.equal(after.version, undefined, "file version 1 is written as nothing, the file stays what it was");
});

test("the funnel's parser has the last word, in its own sentence", async () => {
  const f = fixture();
  assert.match((await refusal(f, { excludeTools: ["bsh"] })).refusal, /^rejected: .*run\.excludeTools\[0\] "bsh" is not a tool the pinned pi knows/);
  assert.match((await refusal(f, { excludeTools: [] })).refusal, /run\.excludeTools must be a non-empty array/);
  assert.match((await refusal(f, { mcp: ["Not A Name"] })).refusal, /run\.mcp\[0\] must name a server/);
  assert.match((await refusal(f, { mcp: [] })).refusal, /run\.mcp must be a non-empty array/);
  assert.match((await refusal(f, { maxCostUsd: "lots" })).refusal, /run\.maxCostUsd/);
  assert.match((await refusal(f, { models: ["nope"] })).refusal, /run\.models/);
  // A cron job holds no forge token of its own: refused by the kind the entry is, which only the loader knows.
  assert.match((await refusal(f, { mcp: ["forge"] }, 0)).refusal, /run\.mcp names "forge"/);
});

test("a body the form could not have sent refuses before anything is read, by name and never by value", async () => {
  const f = fixture();
  const digest = f.digest();
  const cases = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ index: 1, pageDigest: digest, image: "evil:latest" }, /takes .* only; image is not one of them/],
    [{ index: 1, pageDigest: digest, skillsDir: "/x" }, /skillsDir is not one of them/],
    [{ index: 1, pageDigest: digest, secrets: {} }, /secrets is not one of them/],
    [{ index: -1, pageDigest: digest, flow: "x" }, /index must be a whole number/],
    [{ index: 1.5, pageDigest: digest, flow: "x" }, /index must be a whole number/],
    [{ index: 1, flow: "x" }, /did not say what it saw/],
    [{ index: 1, pageDigest: "abc", flow: "x" }, /did not say what it saw/],
    [{ index: 1, pageDigest: digest, flow: null }, /flow cannot be removed/],
    [{ index: 1, pageDigest: digest, flow: 7 }, /flow must be a string/],
    [{ index: 1, pageDigest: digest, provider: "" }, /provider must be a non-empty string, or null/],
    [{ index: 1, pageDigest: digest, model: "   " }, /model must be a non-empty string, or null/],
    [{ index: 1, pageDigest: digest, model: 7 }, /model must be a non-empty string, or null/],
    [{ index: 1, pageDigest: digest, maxCostUsd: true }, /^rejected: .*run\.maxCostUsd/],
    [{ index: 1, pageDigest: digest, mcp: "linear" }, /mcp must be a list of names/],
    [{ index: 1, pageDigest: digest, models: [1] }, /models must be a list of names/],
    [{ index: 1, pageDigest: digest, fallbackModels: {} }, /fallbackModels must be a list of names/],
    [{ index: 1, pageDigest: digest, excludeTools: "bash" }, /excludeTools must be a list of names/],
    [{ index: 1, pageDigest: digest, packages: "false" }, /^rejected: .*run\.packages must be true or false/],
    [{ index: 1, pageDigest: digest, packages: false, keyOrder: "kind" }, /keyOrder must be a list/],
    [{ index: 1, pageDigest: digest, packages: false, keyOrder: [1] }, /keyOrder must be a list/],
  ];
  const before = f.read();
  for (const [body, want] of cases) {
    const out = await f.service.preview(body, operator);
    assert.match(out.refusal, want, JSON.stringify(body));
    assert.equal(out.status, 400, JSON.stringify(body));
  }
  assert.equal(f.read(), before);
});

test("a digit string reads as the row a hidden control sent", async () => {
  const f = fixture();
  const out = await f.service.preview({ index: "1", pageDigest: f.digest(), packages: false }, operator);
  assert.equal(out.plan.index, 1);
  assert.equal(out.payload.body.index, 1);
});

test("a file it cannot read, a file from a newer release and a row that is gone each refuse, and write nothing", async () => {
  const f = fixture();
  const digest = f.digest();
  nodeFs.writeFileSync(f.paths.triggersPath, "{ not json");
  assert.deepEqual(await f.service.preview({ index: 1, pageDigest: digest, packages: false }, operator), { refusal: "The triggers file could not be read, so this change could not be judged. Nothing is written over a file this page cannot read.", status: 409, state: "changed" });
  assert.equal(nodeFs.readFileSync(f.paths.triggersPath, "utf8"), "{ not json");

  const newer = fixture({ doc: { version: 999, triggers: [cron, comment()] } });
  const said = await newer.service.preview({ index: 1, pageDigest: newer.digest(), packages: false }, operator);
  assert.equal(said.status, 409);
  assert.match(said.refusal, /nothing was written and nothing in it was lost; change it with that release/);
  // The same words for the trigger edit's own fields, whose body reads a file like this as holding no triggers at all.
  assert.deepEqual(await newer.service.preview({ index: 1, pageDigest: newer.digest(), flow: "review" }, operator), said);

  const gone = fixture();
  const past = await gone.service.preview({ index: 9, pageDigest: gone.digest(), packages: false }, operator);
  assert.deepEqual(past, { refusal: "There is no trigger at row 10 any more. Reload the page.", status: 409, state: "changed" });
});

test("what the trigger edit's own body refuses is said in its words, and judged against the rest of the same edit", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] } });
  assert.deepEqual(await f.service.preview(ask(f, { flow: "   " }), operator), { refusal: "flow must be non-empty", status: 400 });
  assert.match((await refusal(f, { provider: "No Spaces Allowed" })).refusal, /^trigger row 2: run\.provider /);
  assert.match((await refusal(f, { model: "claude-sonnet-5-5" })).refusal, /run\.models does not list this trigger's own run\.provider\/run\.model/, "off the list the file still holds");
  // The new model is on the list this same edit writes: judged against that list, it passes.
  const moved = await f.service.preview(ask(f, { model: "claude-sonnet-5-5", models: [SONNET] }), operator);
  assert.ok(moved.plan, JSON.stringify(moved));
  assert.deepEqual(await f.service.apply(moved, operator), { ok: true });
  assert.deepEqual(f.entry().run, { kind: "github", flow: "fix", provider: "anthropic", model: "claude-sonnet-5-5", models: [SONNET] });
  // And a removed list leaves nothing the new model must be on.
  const off = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] } });
  assert.ok((await off.service.preview(ask(off, { model: "claude-sonnet-5-5", models: null }), operator)).plan);
});

test("a file with a duplicate key is the funnel's refusal, never a silent rewrite", async () => {
  const f = fixture();
  const digest = f.digest();
  const doubled = `{"triggers": [${JSON.stringify(cron)}, ${JSON.stringify(comment())}], "triggers": [${JSON.stringify(cron)}, ${JSON.stringify(comment())}]}\n`;
  nodeFs.writeFileSync(f.paths.triggersPath, doubled);
  const out = await f.service.preview({ index: 1, pageDigest: digest, packages: false }, operator);
  assert.match(out.refusal, /duplicate key/);
  assert.equal(nodeFs.readFileSync(f.paths.triggersPath, "utf8"), doubled);
});

test("a console that names no triggers file says so", async () => {
  const service = createTriggerEnvironmentActions({ paths: {}, now: () => NOW });
  assert.deepEqual(await service.preview({ index: 0, pageDigest: "a".repeat(64), packages: false }, operator), { refusal: "This console does not name its triggers file.", status: 409 });
});

// ---- the digest -------------------------------------------------------------------------------------------------------

test("the page's digest: a stale entry refuses with 409 at the preview, and nothing else's edit does", async () => {
  const f = fixture();
  const seen = f.digest();

  // Another trigger moves under the page: this one's entry is the same, so the person is not sent back.
  const other = JSON.parse(f.read());
  other.triggers[0].run.flow = "elsewhere";
  nodeFs.writeFileSync(f.paths.triggersPath, text(other));
  assert.ok((await f.service.preview({ index: 1, pageDigest: seen, packages: false }, operator)).plan);

  // This one moves: refused, with the bar that reloads, and the file as it was.
  const moved = JSON.parse(f.read());
  moved.triggers[1].run.flow = "review";
  nodeFs.writeFileSync(f.paths.triggersPath, text(moved));
  const before = f.read();
  assert.deepEqual(await f.service.preview({ index: 1, pageDigest: seen, packages: false }, operator), { refusal: "This trigger changed since the page drew it, so nothing was changed. Reload the page and make the change again.", status: 409, state: "changed" });
  assert.equal(f.read(), before);
  // Rows swapped by hand: the digest belongs to the entry, so an index alone proves nothing.
  const swapped = fixture();
  const first = swapped.digest(1);
  nodeFs.writeFileSync(swapped.paths.triggersPath, text({ retained: { kept: true }, triggers: [comment(), cron] }));
  assert.equal((await swapped.service.preview({ index: 1, pageDigest: first, packages: false }, operator)).status, 409);
});

test("the digest moves with any key of the entry, a disarm or a key order included", () => {
  const entry = comment({ model: "m" });
  const base = triggerEntryDigest(entry);
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.notEqual(triggerEntryDigest({ ...entry, on: { ...entry.on, disarmed: { at: "t" } } }), base);
  assert.notEqual(triggerEntryDigest({ on: entry.on, run: { model: "m", kind: "github", flow: "fix" } }), base);
  assert.equal(triggerEntryDigest(JSON.parse(JSON.stringify(entry))), base, "a parse and a stringify are not a change");
});

test("expect still covers preview to confirm, whichever trigger moved in between", async () => {
  const f = fixture();
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  const other = JSON.parse(f.read());
  other.triggers[0].run.flow = "elsewhere";
  nodeFs.writeFileSync(f.paths.triggersPath, text(other));
  const after = f.read();
  const res = await f.service.apply(out, operator);
  assert.ok(res.invalid, JSON.stringify(res));
  assert.equal(res.ok, undefined);
  assert.equal(f.read(), after);
});

test("a change that changed the same trigger after the preview is refused at the confirm by its digest", async () => {
  const f = fixture();
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  const moved = JSON.parse(f.read());
  moved.triggers[1].run.flow = "review";
  nodeFs.writeFileSync(f.paths.triggersPath, text(moved));
  const after = f.read();
  assert.deepEqual(await f.service.apply(out, operator), { invalid: "This trigger changed since the page drew it, so nothing was changed. Reload the page and make the change again." });
  assert.equal(f.read(), after);
});

test("the Confirm re-judges a cap the deployment moved after the preview", async () => {
  const f = fixture({ settings: { maxCostUsd: "5" } });
  const out = await f.service.preview(ask(f, { provider: "anthropic", model: "claude-opus-5-5" }), operator);
  assert.ok(out.plan);
  nodeFs.writeFileSync(f.paths.settingsFile, JSON.stringify({ maxCostUsd: "2" }));
  const before = f.read();
  const res = await f.service.apply(out, operator);
  assert.match(res.invalid, /claude-opus-5-5 needs at least \$2\.654295/);
  assert.equal(f.read(), before);
});

test("an apply with nothing to apply refuses, and one that has become no change says so", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.apply({}, operator), { invalid: "This confirmation holds no change; preview it again." });
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  await f.service.apply(out, operator);
  // The same ticket's body against the file it wrote: its digest is stale first, and no second write happens.
  const before = f.read();
  assert.match((await f.service.apply(out, operator)).invalid, /changed since the page drew it/);
  assert.equal(f.read(), before);
});

// ---- the undo ---------------------------------------------------------------------------------------------------------

for (const [what, start, change] of [
  ["an added key", { resume: true }, { mcp: ["docs"] }],
  ["two added keys and a list", { resume: true }, { packages: false, excludeTools: ["bash", "write"], mcp: ["docs"] }],
  ["a changed list", { resume: true, mcp: ["docs", "linear"], progress: true }, { mcp: ["linear"] }],
  ["a list in a new order", { resume: true, mcp: ["docs", "linear"], progress: true }, { mcp: ["linear", "docs"] }],
  ["a deleted key from the middle", { resume: true, packages: false, progress: true }, { packages: null }],
  ["a deleted list from the middle", { resume: true, excludeTools: ["bash", "write"], progress: true }, { excludeTools: null }],
  ["a delete and an add together", { excludeTools: ["bash"], resume: true }, { excludeTools: null, mcp: ["docs"] }],
  ["a cap written as a string with its zeros", { maxCostUsd: "2.50", resume: true }, { maxCostUsd: "1.5" }],
  ["a cap written as a number", { maxCostUsd: 2.5, resume: true }, { maxCostUsd: "1.5" }],
  ["a whole-number cap", { maxCostUsd: 2, resume: true }, { maxCostUsd: "1.5" }],
  ["packages true", { packages: true, resume: true }, { packages: false }],
  ["a flow", { resume: true }, { flow: "review" }],
  ["a model and its provider", { provider: "anthropic", model: "claude-haiku-4-5", resume: true }, { provider: null, model: "claude-sonnet-5-5" }],
  ["a list and the model on it", { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU], fallbackModels: [HAIKU], resume: true }, { model: "claude-sonnet-5-5", models: [SONNET], fallbackModels: null }],
]) {
  test(`an Undo puts the file's bytes back for ${what}, through the banner's own form`, async () => {
    const f = fixture({ run: start, settings: { maxCostUsd: "5" } });
    const before = f.read();
    const out = await write(f, change);
    assert.notEqual(f.read(), before);
    assert.equal(out.plan.undo, "Put trigger row 2 back as it was");
    assert.equal(out.plan.inverse.action, "trigger-environment-edit");
    const body = undoBody(out.plan.inverse);
    assert.deepEqual(body, out.plan.inverse.body, "the form reads back what the inverse names, null and lists included");
    assert.equal(body.pageDigest, f.digest(), "it names the entry the write left");
    const back = await f.service.preview(body, operator);
    assert.ok(back.plan, JSON.stringify(back));
    assert.deepEqual(await f.service.apply(back, operator), { ok: true });
    assert.equal(f.read(), before);
    // And the Undo has a way back of its own.
    const again = await f.service.preview(back.plan.inverse.body, operator);
    assert.ok(again.plan, JSON.stringify(again));
  });
}

test("an Undo of an edit that stamped the file's version takes the stamp back with it, byte for byte", async () => {
  const f = fixture({ run: { steer: true }, deps: { versionTables: { triggers: { supported: 2, runTable: { packages: 2 } }, jobData: { table: {} } }, readHosts: async () => ({ hosts: [{ name: "a", triggersVersion: "2" }] }) } });
  const before = f.read();
  const out = await write(f, { packages: false });
  assert.equal(JSON.parse(f.read()).version, 2);
  const back = await f.service.preview(out.plan.inverse.body, operator);
  assert.deepEqual(await f.service.apply(back, operator), { ok: true });
  assert.equal(f.read(), before);
});

test("a file the writer did not write comes out in its form, as every writer of this file leaves it, and no Undo restores that", async () => {
  const f = fixture();
  // A layout of its own, a `version` of 1, and a number written with its zeros: each legal, and none of them what the writer writes.
  const hand = `{"version": 1, "triggers": [{"on": {"type": "comment", "phrase": "@pi"}, "run": {"kind": "github", "flow": "fix", "steer": true, "maxCostUsd": 2.50}}]}`;
  nodeFs.writeFileSync(f.paths.triggersPath, hand);
  const seen = comment({ steer: true, maxCostUsd: 2.5 });
  const out = await f.service.preview({ index: 0, pageDigest: triggerEntryDigest(JSON.parse(hand).triggers[0]), packages: false }, operator);
  assert.equal(out.beforeText, hand);
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  const written = text({ triggers: [{ on: seen.on, run: { ...seen.run, packages: false } }] });
  assert.equal(f.read(), written, "no version key, 2.5, and the writer's layout");
  assert.ok(!f.read().includes("version") && f.read().includes("2.5") && !f.read().includes("2.50"));
  // The Undo puts back what it touched, and only that: the file does not become what it was.
  const back = await f.service.preview(out.plan.inverse.body, operator);
  assert.deepEqual(await f.service.apply(back, operator), { ok: true });
  assert.equal(f.read(), text({ triggers: [seen] }));
  assert.notEqual(f.read(), hand);
  const again = await f.service.preview({ index: 0, pageDigest: f.digest(0), excludeTools: null }, operator);
  assert.deepEqual(again, { unchanged: "trigger row 1 already says this." }, "formatting alone is not a change, so it asks no Confirm");
});

test("the undo's shape: null for an added key, a list as itself, keyOrder only where it is needed", async () => {
  const added = fixture({ run: { resume: true } });
  const planned = await write(added, { mcp: ["docs"], packages: false });
  assert.deepEqual(planned.plan.inverse.body, { index: 1, pageDigest: added.digest(), mcp: null, packages: null });

  const listed = fixture({ run: { mcp: ["docs", "linear"], resume: true } });
  const list = await write(listed, { mcp: ["linear"] });
  assert.deepEqual(list.plan.inverse.body, { index: 1, pageDigest: listed.digest(), mcp: ["docs", "linear"] });

  const middle = fixture({ run: { packages: false, resume: true } });
  const removed = await write(middle, { packages: null });
  assert.deepEqual(removed.plan.inverse.body, { index: 1, pageDigest: middle.digest(), packages: false, keyOrder: ["kind", "flow", "packages", "resume"] });

  // A key at the end comes back at the end on its own, so no order is sent.
  const last = fixture({ run: { resume: true, packages: false } });
  const ended = await write(last, { packages: null });
  assert.deepEqual(ended.plan.inverse.body, { index: 1, pageDigest: last.digest(), packages: false });
});

test("the undo touches only what the edit changed: a key sent with the value it had is not put back", async () => {
  const f = fixture({ run: { mcp: ["docs"], resume: true } });
  const out = await write(f, { mcp: ["docs"], packages: false });
  assert.deepEqual(out.plan.inverse.body, { index: 1, pageDigest: f.digest(), packages: null });
  assert.deepEqual(out.plan.changes.map((change) => change.key), ["packages"]);
});

test("an Undo over a later change refuses by its digest, and writes nothing", async () => {
  const f = fixture();
  const out = await write(f, { packages: false });
  const moved = JSON.parse(f.read());
  moved.triggers[1].run.flow = "review";
  nodeFs.writeFileSync(f.paths.triggersPath, text(moved));
  const before = f.read();
  const back = await f.service.preview(out.plan.inverse.body, operator);
  assert.equal(back.status, 409);
  assert.equal(f.read(), before);
});

test("a key order that is not the entry's keys refuses: it reorders, and can never add or drop one", async () => {
  const f = fixture({ run: { resume: true } });
  const before = f.read();
  for (const keyOrder of [["kind", "flow"], ["kind", "flow", "resume", "packages", "extra"], ["kind", "kind", "flow", "resume"]]) {
    assert.deepEqual(await f.service.preview(ask(f, { packages: false, keyOrder }), operator), { refusal: "This trigger's keys changed since the edit being undone. Reload the page and make the change again.", status: 409, state: "changed" }, JSON.stringify(keyOrder));
  }
  assert.equal(f.read(), before);
  const fine = await f.service.preview(ask(f, { packages: false, keyOrder: ["packages", "flow", "kind", "resume"] }), operator);
  assert.ok(fine.plan);
  assert.deepEqual(await f.service.apply(fine, operator), { ok: true });
  assert.deepEqual(Object.keys(f.entry().run), ["packages", "flow", "kind", "resume"]);
});

test("a key the file held as null has no button back: null means delete, so its Undo says by hand", async () => {
  const f = fixture({ run: { model: null, provider: null, resume: true } });
  const out = await write(f, { model: "claude-sonnet-5-5", provider: "anthropic" });
  assert.equal(out.plan.inverse, null);
  assert.equal(out.plan.undo, "Edit trigger row 2 back by hand: the file held run.provider as null, which this page cannot write");
});

test("a trigger this page would refuse today has no button back: its Undo says why, by hand", async () => {
  // The file holds a cap below the model's first call, written by hand. The person fixes it by choosing a cheaper model.
  const f = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5", maxCostUsd: "2" } });
  const out = await write(f, { model: "claude-haiku-4-5" });
  assert.equal(out.plan.inverse, null);
  assert.match(out.plan.undo, /^Edit trigger row 2 back by hand: this page would refuse what it said before\. anthropic\/claude-opus-5-5 needs at least \$2\.654295/);
});

test("an edit no change would not judge the state it leaves behind: an Undo of the flow keeps its button", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5", maxCostUsd: "2" } });
  const out = await write(f, { flow: "review" });
  assert.deepEqual(out.plan.inverse.body, { index: 1, pageDigest: f.digest(), flow: "fix" });
});

test("the widest undo a person can make still fits the session's flash, so its button is not silently dropped", async () => {
  const models = Array.from({ length: 16 }, (_, i) => `anthropic/model-${"x".repeat(180)}-${i}`);
  const f = fixture({ run: { models, fallbackModels: models, mcp: Array.from({ length: 8 }, (_, i) => `server-${"y".repeat(20)}-${i}`), excludeTools: ["bash", "read", "write", "edit", "grep", "find", "ls", "powershell"], packages: false, resume: true }, deps: { checkModelsKnown: () => ({ ok: true }) } });
  const out = await write(f, { models: null, fallbackModels: null, mcp: null, excludeTools: null, packages: null });
  assert.ok(Buffer.byteLength(JSON.stringify(out.plan.inverse)) < 16384);
});

// ---- the first call ---------------------------------------------------------------------------------------------------

test("a cap below what any call needs refuses with a short task's amount, naming the trigger's own cap", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, settings: { maxCostUsd: "5" } });
  const before = f.read();
  const out = await refusal(f, { model: "claude-opus-5-5", maxCostUsd: "2" });
  assert.equal(out.refusal, "anthropic/claude-opus-5-5 needs at least $2.654295 for a short task's first call, above this trigger's $2.00 job cap, so the runner would refuse every call to it before it is sent. Choose another model, or a job cap of at least $2.654295; a repository's context files and a longer task need more.");
  assert.equal(out.status, 400);
  assert.equal(f.read(), before);
});

test("under the deployment's cap the way out is another model or its settings, never this page, and never raising it here", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, settings: { maxCostUsd: "2" } });
  const out = await refusal(f, { model: "claude-opus-5-5" });
  assert.equal(out.refusal, "anthropic/claude-opus-5-5 needs at least $2.654295 for a short task's first call, above the deployment's $2.00 job cap, so the runner would refuse every call to it before it is sent. A trigger can only lower the deployment's job cap: choose another model. The deployment's own cap belongs to its settings, not to this page.");
  assert.doesNotMatch(out.refusal, /raise/i);
  // A trigger cap below that deployment cap reads the same, since no cap this trigger could set would let the call through.
  const lower = await refusal(f, { model: "claude-opus-5-5", maxCostUsd: "1" });
  assert.match(lower.refusal, /above the deployment's \$2\.00 job cap/);
});

const contextOf = (bytes) => ({ systemPrompt: "x".repeat(bytes - JSON.stringify({ systemPrompt: "" }).length) });
const admits = (capMicros, model, bytes) => createCostGuard({ capMicros, env: {}, log: () => {} }).admit({ method: "streamSimple", model, args: [contextOf(bytes), {}] }) === null;

for (const [provider, id] of [["anthropic", "claude-opus-5-5"], ["anthropic", "claude-sonnet-5-5"], ["anthropic", "claude-haiku-4-5"], ["openai", "gpt-5.5"]]) {
  test(`the amount offered for ${provider}/${id} admits a short task's first call on the real guard, and a cap at it reads clean`, async () => {
    const f = fixture();
    const out = await refusal(f, { provider, model: id, maxCostUsd: "0.01" });
    const printed = /a job cap of at least \$([0-9.]+);/.exec(out.refusal)[1];
    const model = builtinModel(provider, id);
    const cap = parseUsdMicros(printed, "printed");
    assert.equal(admits(cap, model, FIRST_CALL_SHORT_TASK_BYTES), true, "the amount a person is told admits the request");
    assert.equal(admits(cap, model, DEFAULT_CONTEXT_BYTES), true);
    assert.equal(admits(cap - 1, model, FIRST_CALL_SHORT_TASK_BYTES), false, "and it is the least that does");
    const clean = await f.service.preview(ask(f, { provider, model: id, maxCostUsd: printed }), operator);
    assert.ok(clean.plan, JSON.stringify(clean));
    assert.ok(!clean.summary.some((line) => line.includes("only for the smallest first call")), clean.summary.join("\n"));
    // Why the floor is no answer: it admits a request smaller than any job sends, and neither of the two a job does.
    const floor = firstCallFloorMicros(model);
    assert.equal(admits(floor, model, 4096), true);
    assert.equal(admits(floor, model, DEFAULT_CONTEXT_BYTES), false, "a job's smallest first call");
    assert.equal(admits(floor, model, FIRST_CALL_SHORT_TASK_BYTES), false, "a short task's");
  });
}

test("a cap that clears the floor and not a short task previews, with a warning that most jobs would be refused before they spend", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5" } });
  const out = await f.service.preview(ask(f, { maxCostUsd: "2.62144" }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.ok(out.summary.includes("anthropic/claude-opus-5-5 clears this $2.62144 job cap only for the smallest first call: a short task's needs $2.654295, so most jobs that call it would be refused before they spend. Choose another model, or a job cap of at least $2.654295; a repository's context files and a longer task need more."), out.summary.join("\n"));
  assert.deepEqual(await f.service.apply(out, operator), { ok: true }, "a warning, not a refusal: the person has read it");
  // Under a deployment's cap no value here clears it, and the warning says so instead of offering one.
  const held = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, settings: { maxCostUsd: "2.63" } });
  const said = await held.service.preview(ask(held, { model: "claude-opus-5-5" }), operator);
  assert.ok(said.summary.includes("anthropic/claude-opus-5-5 clears this $2.63 job cap only for the smallest first call: a short task's needs $2.654295, so most jobs that call it would be refused before they spend. A trigger can only lower the deployment's job cap: choose another model. The deployment's own cap belongs to its settings, not to this page."), said.summary.join("\n"));
  // A listed model that only just fits is said too, and one that fits is not.
  const listed = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } });
  const both = await listed.service.preview(ask(listed, { models: [HAIKU, OPUS], maxCostUsd: "2.63" }), operator);
  assert.deepEqual(both.summary.filter((line) => line.includes("only for the smallest first call")).map((line) => line.split(" ")[0]), [OPUS]);
});

test("a raise above the deployment's cap refuses in words that say a trigger can only lower it", async () => {
  const f = fixture({ settings: { maxCostUsd: "5" } });
  const out = await refusal(f, { maxCostUsd: "7" });
  assert.equal(out.refusal, "A trigger's job cap can only lower the deployment's: $7.00 is above its $5.00. Set $5.00 or less here, or remove this trigger's cap to run under the deployment's. The deployment's own cap belongs to its settings, not to this page.");
  assert.doesNotMatch(out.refusal, /raise/i);
  assert.ok((await f.service.preview(ask(f, { maxCostUsd: "5" }), operator)).plan, "exactly the deployment's is not above it");
  // What the specs promise: it may offer this trigger's own cap, below the deployment's, and never to move the deployment's.
  const below = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5", maxCostUsd: "1" }, settings: { maxCostUsd: "5" } });
  assert.match((await refusal(below, { maxCostUsd: "0.5" })).refusal, /a job cap of at least \$2\.654295/);

});

test("the env's cap counts too: a file above it stops at the worker's load, whatever the overlay says", async () => {
  const f = fixture({ settings: { maxCostUsd: "10" }, env: { PI_MAX_COST_USD: "5" } });
  assert.match((await refusal(f, { maxCostUsd: "7" })).refusal, /\$7\.00 is above its \$5\.00/);
  const lowerOverlay = fixture({ settings: { maxCostUsd: "3" }, env: { PI_MAX_COST_USD: "5" } });
  assert.match((await refusal(lowerOverlay, { maxCostUsd: "4" })).refusal, /\$4\.00 is above its \$3\.00/);
  const envOnly = fixture({ env: { PI_MAX_COST_USD: "5" } });
  assert.match((await refusal(envOnly, { maxCostUsd: "6" })).refusal, /\$6\.00 is above its \$5\.00/);
});

test("a cap set only in the env is the deployment's cap for a job's first call and for its words", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "1" }, env: { PI_MAX_COST_USD: "2" } });
  assert.match((await refusal(f, { model: "claude-opus-5-5", maxCostUsd: null })).refusal, /above the deployment's \$2\.00 job cap/);
  const removed = await f.service.preview(ask(f, { maxCostUsd: null }), operator);
  assert.equal(removed.plan.changes[0].line, "Job cap: $1.00 removed; its jobs run under the deployment's $2.00.");
});

test("with no deployment cap a trigger's is a narrowing of nothing: any amount is taken, and the first call is judged against it", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5" } });
  assert.ok((await f.service.preview(ask(f, { maxCostUsd: "900" }), operator)).plan);
  assert.ok((await f.service.preview(ask(f, { maxCostUsd: "2.62144" }), operator)).plan, "exactly the floor is not refused");
  assert.match((await refusal(f, { maxCostUsd: "2.62143" })).refusal, /needs at least \$2\.654295/, "a micro-dollar under it is");
});

test("the bound is judged only when the edit sends a model field or the cap", async () => {
  // A hand-written pairing the runner refuses. An edit of something else is no reason to refuse the person.
  const run = { provider: "anthropic", model: "claude-opus-5-5", maxCostUsd: "2" };
  for (const change of [{ flow: "review" }, { mcp: ["docs"] }, { packages: false }, { excludeTools: ["bash"] }]) {
    const f = fixture({ run });
    assert.ok((await f.service.preview(ask(f, change), operator)).plan, JSON.stringify(change));
  }
  for (const change of [{ model: "claude-opus-5-5", maxCostUsd: "1" }, { maxCostUsd: "1" }, { models: [OPUS] }, { fallbackModels: [OPUS], models: [OPUS, HAIKU] }, { provider: "anthropic", model: "claude-opus-5-5" }]) {
    const f = fixture({ run: { ...run, maxCostUsd: "1" } });
    const out = await f.service.preview(ask(f, change), operator);
    assert.match(out.refusal ?? out.unchanged ?? "", /needs at least \$2\.654295|already says this/, JSON.stringify(change));
  }
  const bad = fixture({ run: { model: "claude-opus-5-5", maxCostUsd: "2" } });
  assert.match((await refusal(bad, { provider: "anthropic" })).refusal, /needs at least/, "the provider alone is a model field");
});

test("a model a job does not start on warns by name above the cap: a call to it stops the job, and one failover moved there paid for a container", async () => {
  const stops = "A call to this one stops the job as cost-cap, and a job moved to it starts a paid container first.";
  const listed = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, settings: { maxCostUsd: "2" } });
  const words = await warned(listed, { models: [HAIKU, OPUS] });
  assert.match(words, /^anthropic\/claude-opus-5-5 needs at least \$2\.654295 for a short task's first call, above the deployment's \$2\.00 job cap, so the runner would refuse every call to it before it is sent\./);
  assert.ok(words.endsWith(stops), words);
  const listedSummary = (await listed.service.preview(ask(listed, { models: [HAIKU, OPUS] }), operator)).summary.join(" ");
  assert.ok(!listedSummary.includes("clears this"), "said once: a model that cannot clear the cap is not also one that barely does");
  const fallback = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, OPUS] }, settings: { maxCostUsd: "5" } });
  assert.ok((await warned(fallback, { fallbackModels: [OPUS], maxCostUsd: "2" })).includes(stops));
  // A fallback this trigger names off the deployment's list counts as named, though no list of its own holds it.
  const envFallback = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${OPUS}` } });
  assert.ok((await warned(envFallback, { fallbackModels: [OPUS], maxCostUsd: "2" })).includes(stops));
  // What the runtime does with such a cap, on the real guard: the job's main model gets its first call, and the listed one is refused it.
  const cap = parseUsdMicros("2", "cap");
  assert.equal(admits(cap, builtinModel("anthropic", "claude-haiku-4-5"), FIRST_CALL_SHORT_TASK_BYTES), true);
  assert.equal(admits(cap, builtinModel("anthropic", "claude-opus-5-5"), FIRST_CALL_SHORT_TASK_BYTES), false);
  // And it can be confirmed: nothing about a model a job may never call stops a person.
  const planned = await listed.service.preview(ask(listed, { models: [HAIKU, OPUS] }), operator);
  assert.deepEqual(await listed.service.apply(planned, operator), { ok: true });
  assert.deepEqual(listed.entry().run.models, [HAIKU, OPUS]);
  // The main model above it is a job that cannot start, and that still refuses.
  assert.match((await refusal(fixture({ run: { provider: "anthropic", model: "claude-opus-5-5", models: [HAIKU, OPUS] } }), { maxCostUsd: "1" })).refusal, /^anthropic\/claude-opus-5-5 needs at least/);
  // The deployment allows a dear model this trigger never named: lowering this trigger's cap is no fault of that model's.
  const envList = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${OPUS}` } });
  await quiet(envList, { maxCostUsd: "1" });
  const roles = fixture({ doc: { modelRoles: { default: { architect: OPUS } }, triggers: [cron, comment({ provider: "anthropic", model: "claude-haiku-4-5" })] } });
  await quiet(roles, { maxCostUsd: "1" });
});

test("a listed model no cap can bound warns too, where one a job starts on refuses", async () => {
  const overlay = { providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "local", cost: { input: 100000, output: 100000, cacheRead: 0, cacheWrite: 0 }, maxTokens: 100, contextWindow: 1000 }] } } };
  const run = { provider: "anthropic", model: "claude-haiku-4-5" };
  const unbound = await warned(fixture({ overlay, run, settings: { maxCostUsd: "5" } }), { models: [HAIKU, "ollama/local"] });
  assert.match(unbound, /^ollama\/local's output cap travels as max_completion_tokens/);
  assert.ok(unbound.endsWith("A call to this one stops the job as cost-cap, and a job moved to it starts a paid container first."), unbound);
  assert.equal(unbound.split("stops the job as cost-cap").length, 2, "said once");
  const radiusFixture = fixture({ run, settings: { maxCostUsd: "5" } });
  const radius = await warned(radiusFixture, { models: [HAIKU, "radius/not-in-its-catalog"] });
  assert.match(radius, /radius\/not-in-its-catalog: Radius \(pi-messages\) has no verified local cost bound.* A call to this one stops the job as cost-cap, and a job moved to it starts a paid container first\./);
  const said = (await radiusFixture.service.preview(ask(radiusFixture, { models: [HAIKU, "radius/not-in-its-catalog"] }), operator)).summary.join(" ");
  assert.ok(!said.includes("could not be bounded"), "and not also as one this page could not judge");
});

test("an overlay models.json that cannot be read stays unread for every model the edit names: none is priced or judged without it", async () => {
  const overlay = { providers: { anthropic: { models: [{ id: "claude-opus-5-5", cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }, maxTokens: 100, contextWindow: 1000 }] } } };
  let armed = false;
  const fs = { ...nodeFs, readFileSync: (path, ...rest) => {
    if (armed && String(path).endsWith("models.json")) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return nodeFs.readFileSync(path, ...rest);
  } };
  const run = { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] };
  const f = fixture({ run, overlay, deps: { fs } });
  armed = true;
  const out = await f.service.preview(ask(f, { maxCostUsd: "1", models: [HAIKU, SONNET, OPUS] }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  for (const name of [SONNET, OPUS]) assert.ok(out.plan.warnings.includes(`The overlay's models.json could not be read just now, so whether this deployment knows ${name} could not be judged here; a pickup asks again.`), out.plan.warnings.join(" | "));
  // Under a $1 cap the builtin table would say opus cannot clear it: with the file unread no amount is claimed, in either direction.
  assert.ok(out.summary.includes(`The first call on ${HAIKU}, ${SONNET} and ${OPUS} could not be bounded here, so the runner judges it when a job runs.`), out.summary.join("\n"));
  assert.ok(!out.summary.join(" ").includes("$2.654295"), out.summary.join("\n"));
  // One failed read, and the next would have answered: the judgement holds to what it read, for the second model as for the first.
  let failures = 1;
  const once = { ...nodeFs, readFileSync: (path, ...rest) => {
    if (String(path).endsWith("models.json") && failures > 0) {
      failures -= 1;
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return nodeFs.readFileSync(path, ...rest);
  } };
  const g = fixture({ run, overlay, deps: { fs: once } });
  const onceOut = await g.service.preview(ask(g, { models: [HAIKU, SONNET, OPUS] }), operator);
  for (const name of [SONNET, OPUS]) assert.ok(onceOut.plan.warnings.includes(`The overlay's models.json could not be read just now, so whether this deployment knows ${name} could not be judged here; a pickup asks again.`), onceOut.plan.warnings.join(" | "));
});

// The real reader over a real file, as the console's own wiring reads it (`cli.mjs`): the shell never reaches this.
const envFile = (f, text, platform = "darwin") => {
  nodeFs.writeFileSync(join(f.dir, ".env"), text, { mode: 0o600 });
  return (keys) => {
    // One loader's reading, whichever machine runs this: a line can be a hazard to one service's loader and plain to another's.
    const read = deploymentServiceEnv({ env: {}, dir: f.dir, keys, fs: nodeFs, platform });
    if (read.unreadable || read.untrusted) throw new Error("no");
    return { env: read.env, unread: [...read.unread.map((row) => row.key), ...read.hazardSkipped], hazardLine: read.hazardSkipped.length > 0 ? read.hazard?.line ?? null : null };
  };
};
const withEnvFile = (run, text, env = {}, platform = "darwin") => {
  const base = fixture({ run, env });
  const readHostEnv = envFile(base, text, platform);
  return { ...base, service: createTriggerEnvironmentActions({ paths: base.paths, env: { PI_MAX_COST_USD: "9", PI_PROVIDER: "anthropic", PI_MODEL: "claude-opus-5-5", ...env }, now: () => NOW, deploymentDir: base.dir, readHostEnv }) };
};

test("a deployment's cap and model come from its file: a console started from a shell that says otherwise changes nothing", async () => {
  // The shell (the console's own environment) says $9 and the file $2, so a worker's loader refuses a $5 trigger cap, and the whole file with it.
  const f = withEnvFile({ provider: "anthropic", model: "claude-haiku-4-5" }, "PI_MAX_COST_USD=2\nPI_PROVIDER=anthropic\nPI_MODEL=claude-haiku-4-5\n");
  assert.match((await refusal(f, { maxCostUsd: "5" })).refusal, /^A trigger's job cap can only lower the deployment's: \$5\.00 is above its \$2\.00\./);
  await quiet(f, { maxCostUsd: "1.50" });
  // The other way round: the file says nothing of a cap, so the shell's lower one does not refuse anything.
  const open = withEnvFile({ provider: "anthropic", model: "claude-haiku-4-5" }, "PI_PROVIDER=anthropic\n", { PI_MAX_COST_USD: "1" });
  await quiet(open, { maxCostUsd: "4" });
  // The list is the file's too.
  const listed = withEnvFile({ provider: "anthropic", model: "claude-sonnet-5-5" }, `PI_ALLOWED_MODELS=${SONNET}\n`);
  assert.match(await warned(listed, { model: "claude-haiku-4-5" }), /refused as model-not-allowed/);
  // And the job's main model: the shell's opus could not clear a $1 cap, and the file's haiku does.
  await quiet(withEnvFile({}, "PI_PROVIDER=anthropic\nPI_MODEL=claude-haiku-4-5\n"), { maxCostUsd: "1" });
});

test("a cap the loader would refuse, beside a line it cannot vouch for: under a sourcing shell it warns of the whole file, and where the reader can take the key it refuses", async () => {
  const run = { provider: "anthropic", model: "claude-haiku-4-5" };
  const text = "PI_MAX_COST_USD=2\nOTHER=ab cd\n";
  const shell = withEnvFile(run, text);
  const words = await warned(shell, { maxCostUsd: "5" });
  assert.equal(words, "Line 2 of this host's .env could not be read as the worker reads it, so the deployment's job cap and its list of models could not be judged here. A trigger's cap above what the worker reads makes it refuse the whole file.");
  // It stays a warning: the file alone does not decide this, and the worker's own line may read otherwise on the host that runs it.
  const planned = await shell.service.preview(ask(shell, { maxCostUsd: "5" }), operator);
  assert.deepEqual(await shell.service.apply(planned, operator), { ok: true });
  // What that write meets, in the worker's own loader, at the value this shape really sources to.
  assert.throws(() => loadSchedules({ triggersFile: shell.paths.triggersPath, maxCostUsd: "2" }), /run\.maxCostUsd is above this deployment's PI_MAX_COST_USD/);
  // To systemd `OTHER=ab cd` is one key's value it cannot vouch for, and no hazard: the cap's own line is read, and judged.
  assert.match((await refusal(withEnvFile(run, text, {}, "linux"), { maxCostUsd: "5" })).refusal, /^A trigger's job cap can only lower the deployment's: \$5\.00 is above its \$2\.00\./);
});

test("why a plain line is not believed beside one a sourcing shell runs: each of these reads $2 by its own line and sources otherwise", (t) => {
  if (!nodeFs.existsSync("/bin/sh")) return t.skip("no /bin/sh here");
  const dir = tempDir("pd-800-env-source-");
  const sourced = (text) => {
    nodeFs.writeFileSync(join(dir, ".env"), text);
    return execFileSync("/bin/sh", ["-c", 'set -a; . ./.env; set +a; printf %s "${PI_MAX_COST_USD-unset}"'], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  };
  assert.equal(sourced("PI_MAX_COST_USD=2\nOTHER=ab cd\n"), "2", "the shape met: this one happens to leave it");
  assert.equal(sourced("PI_MAX_COST_USD=2\nOTHER=ab export PI_MAX_COST_USD=9\n"), "9");
  assert.equal(sourced("PI_MAX_COST_USD=2\nunset PI_MAX_COST_USD\n"), "unset");
  assert.equal(sourced("exit 0\nPI_MAX_COST_USD=2\n"), "", "the shell ended on that line, so nothing after the sourcing ran");
  const read = (text) => readEnvAssignments(text, ["PI_MAX_COST_USD"], { loader: "shell" }).PI_MAX_COST_USD;
  for (const text of ["PI_MAX_COST_USD=2\nOTHER=ab export PI_MAX_COST_USD=9\n", "PI_MAX_COST_USD=2\nunset PI_MAX_COST_USD\n", "exit 0\nPI_MAX_COST_USD=2\n"]) {
    const line = read(text);
    assert.deepEqual([line.plain, line.value, line.vouched], [true, "2", false], "its own line reads plain, and the reader does not vouch for it");
  }
  // An open quote above takes the key into its own value. The reader sees that one itself, so there is no plain line to believe.
  const quoted = "OTHER='ab\nPI_MAX_COST_USD=2\nMORE=cd'\n";
  assert.equal(sourced(quoted), "unset");
  assert.deepEqual([read(quoted).plain, read(quoted).value, read(quoted).vouched], [false, null, false]);
});

test("a deployment's file it cannot vouch for leaves the cap unjudged, says so, and stops nobody", async () => {
  const note = (head) => `${head} so the deployment's job cap and its list of models could not be judged here. A trigger's cap above what the worker reads makes it refuse the whole file.`;
  const unread = withEnvFile({ provider: "anthropic", model: "claude-haiku-4-5" }, "PI_MAX_COST_USD=ab$cd\n");
  assert.equal(await warned(unread, { maxCostUsd: "5" }), note("This host's .env holds PI_MAX_COST_USD in a line that could not be read as the worker reads it,"));
  const untrusted = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, deps: { readHostEnv: () => { throw new Error("untrusted"); } } });
  assert.equal(await warned(untrusted, { maxCostUsd: "5" }), note("This host's .env could not be read as the worker reads it,"));
  const planned = await untrusted.service.preview(ask(untrusted, { maxCostUsd: "5" }), operator);
  assert.deepEqual(await untrusted.service.apply(planned, operator), { ok: true });
  // A value the file holds that the worker refuses is the file saying something, and that still refuses.
  assert.match((await refusal(withEnvFile({ provider: "anthropic", model: "claude-haiku-4-5" }, "PI_MAX_COST_USD=lots\n"), { maxCostUsd: "1" })).refusal, /The deployment's job cap could not be read/);
});

// ---- what the worker's own selection does with a trigger's fallbacks --------------------------------------------------------

/** The worker's real selection, on the job as a pickup hands it over, with a cooldown only where a test sets one. */
const realSelection = (job, { overlay = null, cooldowns = new Map() } = {}) => selectFailoverJob(job, {
  redis: { get: async (key) => cooldowns.get(key) ?? null },
  id: "gh-1",
  models: overlay,
  checkCandidate: (candidate) => checkFailoverCandidate(candidate, { models: overlay }),
});

for (const [what, run, env, change, overlay, job, ref, skips] of [
  ["a main this host does not know", { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, SONNET], fallbackModels: [SONNET] }, {}, { model: "claude-typo", models: ["anthropic/claude-typo", SONNET] }, null,
    { provider: "anthropic", model: "claude-typo", models: ["anthropic/claude-typo", SONNET], fallbackModels: [SONNET] }, SONNET, "anthropic/claude-typo (model-unknown)"],
  ["a main off this host's list", { provider: "anthropic", model: "claude-haiku-4-5", fallbackModels: [SONNET] }, { PI_ALLOWED_MODELS: SONNET }, { model: "claude-opus-5-5" }, null,
    { provider: "anthropic", model: "claude-opus-5-5", models: [SONNET], fallbackModels: [SONNET] }, SONNET, "anthropic/claude-opus-5-5 (model-not-allowed)"],
  ["a fallback the worker will not price", { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] }, {}, { models: [HAIKU, "radius/balanced"], fallbackModels: ["radius/balanced"] }, null,
    { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, "radius/balanced"], fallbackModels: ["radius/balanced"] }, HAIKU, "radius/balanced (model-unpriced)"],
  ["a fallback this host does not know", { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] }, {}, { models: [HAIKU, "anthropic/claude-typo"], fallbackModels: ["anthropic/claude-typo"] }, null,
    { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, "anthropic/claude-typo"], fallbackModels: ["anthropic/claude-typo"] }, HAIKU, "anthropic/claude-typo (model-unknown)"],
]) {
  test(`${what}, on a trigger with fallbacks: the preview says what the worker's selection does, and refuses nothing`, async () => {
    const f = fixture({ run, env, overlay });
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan, JSON.stringify(out));
    assert.deepEqual(out.plan.warnings.filter((line) => line.includes("skips")), [`On this host a job of this trigger skips ${skips} and starts on ${ref}.`]);
    assert.ok(!out.plan.warnings.some((line) => /would be refused as model-(?:unknown|not-allowed)/.test(line)), out.plan.warnings.join(" | "));
    const real = await realSelection(job, { overlay });
    assert.equal(real.ref, ref, "the model the sentence names is the one the worker's own selection starts the job on");
    assert.deepEqual(real.job.models, [ref]);
    assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  });
}

test("no model of a trigger with fallbacks qualifying says that, by each one's reason, as the worker's selection refuses it", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: "anthropic/claude-typo,anthropic/claude-nope" } });
  const words = await warned(f, { model: "claude-typo", fallbackModels: ["anthropic/claude-nope"] });
  assert.equal(words, "On this host this trigger's jobs would be refused as model-failover-no-candidate, before they spend: a job skips anthropic/claude-typo (model-unknown) and anthropic/claude-nope (model-unknown) and has no model left.");
  assert.deepEqual(await realSelection({ provider: "anthropic", model: "claude-typo", models: ["anthropic/claude-typo", "anthropic/claude-nope"], fallbackModels: ["anthropic/claude-nope"] }), { refused: "model-failover-no-candidate" });
  // A fallback off the list ends the selection before it looks at a model at all, and the sentence for that stands.
  const off = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: HAIKU } });
  const offWords = await warned(off, { fallbackModels: [SONNET] });
  assert.match(offWords, /refused as model-failover-no-candidate, before they spend: every fallback must be on the allowed list/);
  assert.ok(!offWords.includes("has no model left"), offWords);
  assert.deepEqual(await realSelection({ provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU], fallbackModels: [SONNET] }), { refused: "model-failover-no-candidate" });
});

test("what a selection skipped before this edit, the edit does not speak of: it judges what it touched", async () => {
  // The main is off this host's list already. Adding a fallback that qualifies says nothing of the main, and raises nothing new.
  await quiet(fixture({ run: { provider: "anthropic", model: "claude-opus-5-5", fallbackModels: [SONNET] }, env: { PI_ALLOWED_MODELS: `${SONNET},${HAIKU}` } }), { fallbackModels: [SONNET, HAIKU] });
  await quiet(fixture({ run: { provider: "anthropic", model: "claude-typo", models: ["anthropic/claude-typo", SONNET], fallbackModels: [SONNET] } }), { flow: "review" });
  // A cap edit moves no model, though none of this trigger's qualifies.
  await quiet(fixture({ run: { provider: "anthropic", model: "claude-typo", models: ["anthropic/claude-typo", "anthropic/claude-nope"], fallbackModels: ["anthropic/claude-nope"] } }), { maxCostUsd: "1" });
});

test("the model the cap is judged by is the one selection starts a job on, whichever that is", async () => {
  const env = { PI_ALLOWED_MODELS: `${HAIKU},${OPUS}` };
  // A main passed over that could not clear the cap stops nothing at its start: the job starts on the fallback, which can.
  const passed = fixture({ run: { provider: "anthropic", model: "claude-sonnet-5-5", fallbackModels: [HAIKU] }, env: { PI_ALLOWED_MODELS: HAIKU } });
  const words = await warned(passed, { maxCostUsd: "1" });
  assert.match(words, /anthropic\/claude-sonnet-5-5 needs at least \$1\.327148.*A call to this one stops the job as cost-cap/);
  assert.equal((await realSelection({ provider: "anthropic", model: "claude-sonnet-5-5", models: [HAIKU], fallbackModels: [HAIKU] })).ref, HAIKU);
  // A fallback the job does start on, that cannot clear it: nothing it can do is left, so that refuses, as a main does.
  const starts = fixture({ run: { provider: "anthropic", model: "claude-sonnet-5-5", fallbackModels: [OPUS] }, env });
  assert.match((await refusal(starts, { maxCostUsd: "1" })).refusal, /^anthropic\/claude-opus-5-5 needs at least \$2\.654295/);
  assert.equal((await realSelection({ provider: "anthropic", model: "claude-sonnet-5-5", models: [HAIKU, OPUS], fallbackModels: [OPUS] })).ref, OPUS);
});

test("a job failover moves to a fallback starts a paid container first: selection asks nothing of the cap, and the guard refuses the first call there", async () => {
  // The main on cooldown, as `markModelCooldown` writes it, and a $1 cap that a job on the fallback cannot make one call under.
  const cooldowns = new Map();
  await markModelCooldown({ eval: async (_script, _keys, key, _until, value) => { cooldowns.set(key, value); } }, HAIKU, { kind: "rate-limited" }, { now: () => Date.now() });
  const moved = await realSelection({ provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, OPUS], fallbackModels: [OPUS], maxCostMicros: 1_000_000 }, { cooldowns });
  assert.deepEqual([moved.ref, moved.job.models, moved.job.modelWhy], [OPUS, [OPUS], "fallback-cooldown"]);
  assert.equal(admits(1_000_000, builtinModel("anthropic", "claude-opus-5-5"), FIRST_CALL_SHORT_TASK_BYTES), false, "its first call never leaves the container");
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, OPUS] } });
  const words = await warned(f, { fallbackModels: [OPUS], maxCostUsd: "1" });
  assert.ok(words.endsWith("A call to this one stops the job as cost-cap, and a job moved to it starts a paid container first."), words);
  assert.ok(!words.includes("still starts"), words);
});

test("a models.json this host cannot read is said as that, and another model is no way out", async () => {
  const unreadable = { ...nodeFs, readFileSync: (path, ...rest) => {
    if (String(path).endsWith("models.json")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return nodeFs.readFileSync(path, ...rest);
  } };
  const overlay = { providers: {} };
  const sentence = (name, why) => `The overlay's models.json could not be read or used for ${name} (${why}), so this host cannot run it. Fix that file, since another model may be refused the same way.`;
  for (const model of ["claude-typo", "claude-sonnet-5-5"]) {
    const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, overlay, deps: { fs: unreadable } });
    assert.equal(await warned(f, { model }), sentence(`anthropic/${model}`, "overlay-unreadable"));
  }
  // The file that does not parse, and the entry pi would drop: the same way out, and neither says to choose from the catalog.
  const broken = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } });
  nodeFs.writeFileSync(join(broken.paths.globalPiDir, "models.json"), "{ not json");
  const brokenWords = await warned(broken, { model: "claude-sonnet-5-5" });
  assert.ok(brokenWords.includes("could not be read or used for anthropic/claude-sonnet-5-5"), brokenWords);
  assert.ok(!brokenWords.includes("Choose one from the catalog"), brokenWords);
  // The same on a trigger with fallbacks: no selection is claimed without the file.
  const withFallback = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, SONNET], fallbackModels: [SONNET] }, overlay, deps: { fs: unreadable } });
  const failover = await withFallback.service.preview(ask(withFallback, { model: "claude-sonnet-5-5" }), operator);
  assert.deepEqual(failover.plan.warnings, [sentence("anthropic/claude-sonnet-5-5", "overlay-unreadable")]);
  // A model simply not in the catalog keeps its own way out.
  assert.match(await warned(fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } }), { model: "claude-typo" }), /Choose one from the catalog/);
});

test("a role resolves first: the bound and the catalog judge the model it names", async () => {
  const doc = { modelRoles: { default: { editor: OPUS, cheap: HAIKU } }, triggers: [cron, comment({ model: "role:cheap" })] };
  const f = fixture({ doc });
  assert.ok((await f.service.preview(ask(f, { maxCostUsd: "1" }), operator)).plan);
  assert.match((await refusal(f, { model: "role:editor", maxCostUsd: "1" })).refusal, /^anthropic\/claude-opus-5-5 needs at least/);
  assert.match((await refusal(f, { model: "role:nobody" })).refusal, /could not be resolved \(model-role-unknown\): every job would be refused before it spends/);
});

test("a model this host does not know, or that its own list leaves off, is a warning in the reason a job would get, and can still be confirmed", async () => {
  const run = { provider: "anthropic", model: "claude-haiku-4-5" };
  const f = fixture({ run });
  assert.match(await warned(f, { model: "claude-typo" }), /^On this host this trigger's jobs would be refused as model-unknown, before they spend: anthropic\/claude-typo is a model this deployment does not know \(not-in-catalog\)\. Choose one from the catalog, or declare it in the overlay's models\.json\./);
  assert.match(await warned(f, { models: [HAIKU, "anthropic/claude-typo"] }), /claude-typo is a model this deployment does not know/);
  // Another host's overlay may declare it, and that host's pickup is free: the page does not stand in the way.
  const planned = await f.service.preview(ask(f, { model: "claude-typo" }), operator);
  assert.deepEqual(await f.service.apply(planned, operator), { ok: true });
  assert.equal(f.entry().run.model, "claude-typo");

  // A list from this host's PI_ALLOWED_MODELS, where another host's may hold the model.
  const offEnvList = fixture({ run: { provider: "anthropic", model: "claude-sonnet-5-5" }, env: { PI_ALLOWED_MODELS: SONNET } });
  assert.match(await warned(offEnvList, { model: "claude-haiku-4-5" }), /refused as model-not-allowed, before they spend: anthropic\/claude-haiku-4-5 is not on the models they may call here/);
  const noList = fixture({ run });
  assert.match(await warned(noList, { fallbackModels: [SONNET] }), /refused as model-failover-no-candidate, before they spend: every fallback must be on the allowed list .* and anthropic\/claude-sonnet-5-5 is not/);
  assert.match(await warned(fixture({ run, env: { PI_ALLOWED_MODELS: HAIKU } }), { fallbackModels: [SONNET] }), /anthropic\/claude-sonnet-5-5 is not/);
  await quiet(fixture({ run, env: { PI_ALLOWED_MODELS: `${HAIKU},${SONNET}` } }), { fallbackModels: [SONNET] });
  assert.match(await warned(fixture({ run: { provider: "anthropic", model: "claude-fable-5" } }), { models: ["anthropic/claude-fable-5"] }), /refused as model-not-allowed.*claude-fable-5 declares fallback models the allowed list does not name/);
});

test("a list the file itself contradicts is the loader's to refuse, since that holds on every host", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } });
  assert.match((await refusal(f, { models: [SONNET] })).refusal, /^rejected: trigger at index 1: run\.models does not list this trigger's own run\.provider\/run\.model, so every job it starts would be refused/, "the loader's own words, from the funnel");
  const listed = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] } });
  assert.match((await refusal(listed, { fallbackModels: [SONNET] })).refusal, /^rejected: trigger at index 1: run\.models does not list a run\.fallbackModels entry/);
  await quiet(fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, SONNET] } }), { fallbackModels: [SONNET] });
});

test("a model edit judges what it touches: an unknown model it did not touch says nothing, and its first call is not asked of", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-typo" } });
  assert.deepEqual((await f.service.preview(ask(f, { flow: "review" }), operator)).plan.warnings, []);
  const capped = await f.service.preview(ask(f, { maxCostUsd: "1" }), operator);
  assert.ok(!capped.summary.join(" ").includes("model-unknown"), capped.summary.join(" | "));
  // An opus that a $1 cap cannot pay for is this edit's business only when the edit touches the cap or the model.
  const opus = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5", maxCostUsd: "1", models: [OPUS, HAIKU, SONNET] } });
  await quiet(opus, { models: [OPUS, HAIKU] });
  assert.match((await refusal(opus, { maxCostUsd: "0.99" })).refusal, /needs at least \$2\.654295 for a short task's first call/);
  // A cap this edit did not touch stays out of it, though the deployment's is lower: a person changing the model is not told to fix it.
  const above = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "9" }, env: { PI_MAX_COST_USD: "5" } });
  await quiet(above, { model: "claude-sonnet-5-5" });
  assert.match((await refusal(above, { maxCostUsd: "8" })).refusal, /can only lower the deployment's/);
});

test("a role only one project declares warns of those jobs by their project, and a role no job resolves refuses", async () => {
  const doc = { modelRoles: { web: { oai: "openai/gpt-4o" } }, triggers: [cron, comment({ model: "role:oai" })] };
  const nobody = fixture({ doc });
  assert.match((await refusal(nobody, { flow: "review", maxCostUsd: "1" })).refusal, /This trigger's model could not be resolved \(model-role-unknown\): every job would be refused before it spends/);
  const some = fixture({ doc });
  some.paths.projectsFile = join(some.dir, "projects.json");
  nodeFs.writeFileSync(some.paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }, { id: "api", members: ["github:acme/api"] }] }));
  const words = await warned(some, { flow: "review", maxCostUsd: "5" });
  assert.ok(words.includes("In project api this trigger's model could not be resolved (model-role-unknown), so those jobs would be refused before they spend."), words);
  assert.ok(words.includes("In no project this trigger's model could not be resolved (model-role-unknown)"), words);
});

test("a model no cap can bound refuses under any cap, and a cap-free job is not asked", async () => {
  const overlay = { providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "local", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 100, contextWindow: 1000 }] } } };
  const unbound = fixture({ overlay, run: { resume: true }, settings: { maxCostUsd: "5" } });
  assert.match((await refusal(unbound, { provider: "ollama", model: "local" })).refusal, /^ollama\/local's output cap travels as max_completion_tokens to a server that may ignore it, so the runner counts every call to it unboundable/);
  const free = fixture({ overlay, run: { resume: true } });
  assert.ok((await free.service.preview(ask(free, { provider: "ollama", model: "local" }), operator)).plan);
  const radius = fixture({ run: { resume: true }, settings: { maxCostUsd: "5" } });
  const said = await refusal(radius, { provider: "radius", model: "balanced" });
  assert.match(said.refusal, /^radius\/balanced: Radius \(pi-messages\) has no verified local cost bound/);
});

test("a first call this page cannot bound fails open and says which, on a line of the preview", async () => {
  const overlay = { providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "free", compat: { maxTokensField: "max_tokens" }, maxTokens: 100, contextWindow: 1000 }] } } };
  // A model pi composes from the overlay with no table this reads as a price: judged by nothing, and the sentence says so.
  const f = fixture({ overlay, run: { resume: true }, settings: { maxCostUsd: "5" } });
  const out = await f.service.preview(ask(f, { provider: "ollama", model: "free" }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.ok(out.summary.includes("The first call on ollama/free could not be bounded here, so the runner judges it when a job runs."), out.summary.join("\n"));
});

test("settings or a list it cannot read refuse a model or cap edit, and leave every other edit alone", async () => {
  const bad = fixture({ env: { PI_ALLOWED_MODELS: "not a list!" } });
  assert.match((await refusal(bad, { maxCostUsd: "1" })).refusal, /PI_ALLOWED_MODELS is invalid/);
  assert.ok((await bad.service.preview(ask(bad, { packages: false }), operator)).plan);

  const badCap = fixture({ env: { PI_MAX_COST_USD: "lots" } });
  assert.match((await refusal(badCap, { maxCostUsd: "1" })).refusal, /The deployment's job cap could not be read/);

  const invalid = fixture();
  nodeFs.writeFileSync(invalid.paths.settingsFile, "{ not json");
  assert.match((await refusal(invalid, { maxCostUsd: "1" })).refusal, /settings file is invalid/);
  assert.ok((await invalid.service.preview(ask(invalid, { flow: "review" }), operator)).plan);

  const unknownProjects = fixture();
  unknownProjects.paths.projectsFile = join(unknownProjects.dir, "projects.json");
  nodeFs.writeFileSync(unknownProjects.paths.projectsFile, "{ not json");
  assert.match((await refusal(unknownProjects, { maxCostUsd: "1" })).refusal, /project or role policy could not be read/);

  // A read that may pass on a second try, and a catalog that answers nothing, are no reason to stop a person: a pickup asks again.
  const down = fixture({ deps: { checkModelsKnown: () => ({ unavailable: "EIO" }) } });
  assert.match(await warned(down, { model: "claude-sonnet-5-5" }), /^The overlay's models\.json could not be read just now, so whether this deployment knows anthropic\/claude-sonnet-5-5 could not be judged here; a pickup asks again\.$/);
  const silent = fixture({ deps: { checkModelsKnown: () => ({}) } });
  assert.match(await warned(silent, { model: "claude-sonnet-5-5" }), /^The model catalog could not judge anthropic\/claude-sonnet-5-5 here; a pickup asks again\.$/);
});

// ---- the worker's own pickup check --------------------------------------------------------------------------------------

const HELD = { secrets: { LINEAR_API_KEY: "op://vault/linear" } };
/** The real check, as the worker's wiring builds it, for a job with this `run`: what the next job of the trigger would meet. */
const pickup = (f, job, { egress = false, forwardEnv = [], hostEnv = {} } = {}) => makeMcpCheck({ globalPiDir: f.paths.globalPiDir, forwardEnv, hostEnv, egress })({ kind: "github", provider: "anthropic", ...job });

const TAIL = "This reads this host's .env and overlay; what the worker's own service environment sets cannot be seen from here.";

test("a server whose key this host does not hold warns, in the worker's own reason, says what to do, and can still be confirmed", async () => {
  const f = fixture({ env: { PI_FORWARD_ENV: "" } });
  assert.equal(pickup(f, { mcp: ["linear"] }).refused, "mcp-secret-unmapped", "what the real check says of the next job");
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.deepEqual(out.plan.warnings, [
    "On this host this trigger's jobs would be refused as mcp-secret-unmapped, before they spend. linear: it references LINEAR_API_KEY, which the trigger does not pass (run.secrets, or a PI_FORWARD_ENV name the worker holds a value for). Pass the credential the server needs in the trigger's `run.secrets`. `run.secrets` is set in the triggers file, not on this page.",
    TAIL,
  ]);
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to linear.", "true beside a warning: this one stops at pickup, and so does not reach one");
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  assert.deepEqual(f.entry().run.mcp, ["linear"]);
});

test("a server this host does not offer warns, and the host that has it is named beside it", async () => {
  const f = fixture({ mcpJson: { mcpServers: {} }, deps: { readHostLoads: async () => ({ hosts: [{ name: "mini2", state: "current", mcp: [{ name: "docs", enabled: true, where: "docs.example.com", keys: [] }], unread: [], more: {} }] }) } });
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.match(out.plan.warnings[0], /^On this host this trigger's jobs would be refused as mcp-server-unknown, before they spend\. docs: the overlay's mcp\.json does not offer it\./);
  assert.ok(out.summary.some((line) => line.endsWith("mini2 has it.")), out.summary.join(" | "));
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
});

test("what passes the real check is quiet: a key the trigger passes, or one forwarded with a value on this host", async () => {
  await quiet(fixture({ run: HELD, env: { PI_FORWARD_ENV: "" } }), { mcp: ["linear"] });
  await quiet(fixture({ env: { PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "a value" } }), { mcp: ["linear"] });
  // Named in PI_FORWARD_ENV with no value here: the worker's rule, since `buildContainerEnv` forwards only what it holds.
  assert.match(await warned(fixture({ env: { PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "" } }), { mcp: ["linear"] }), /refused as mcp-secret-unmapped/);
});

test("the file alone cuts a server off: refused, on every host, whichever of the two the edit sent", async () => {
  const excluded = ["mcp__linear__*", "read_mcp_resource"];
  const f = fixture({ run: { ...HELD, mcp: ["linear"] } });
  assert.equal(pickup(f, { ...HELD, mcp: ["linear"], excludeTools: excluded }).refused, "mcp-excluded");
  const out = await refusal(f, { excludeTools: excluded });
  assert.equal(out.refusal, "On every host this trigger's jobs would be refused as mcp-excluded, before they spend. linear: run.excludeTools removes every tool that reaches it (its own, the discovery tools that reach them, and read_mcp_resource). Remove the server from `run.mcp`, or keep a tool that reaches it out of `run.excludeTools`.");
  // The server added to a trigger whose exclusions already leave it no way in, sent with the list it needs.
  assert.match((await refusal(fixture({ run: HELD }), { mcp: ["linear"], excludeTools: excluded })).refusal, /^On every host .* mcp-excluded/);
  // A server the overlay does not even hold: it is the file that leaves it no way in.
  assert.match((await refusal(fixture({ run: HELD, mcpJson: { mcpServers: {} } }), { mcp: ["linear"], excludeTools: excluded })).refusal, /^On every host/);
});

test("a cut only this host's routing makes warns, and one that was there before the edit says nothing", async () => {
  // The own tools left, but no discovery tool to find them with: a host that exposes the server directly still reaches it.
  const excluded = ["codemode", "tool_search", "read_mcp_resource"];
  const f = fixture({ run: { ...HELD, mcp: ["linear"] } });
  assert.equal(pickup(f, { ...HELD, mcp: ["linear"], excludeTools: excluded }).refused, "mcp-excluded");
  const words = await warned(f, { excludeTools: excluded });
  assert.match(words, /^On this host this trigger's jobs would be refused as mcp-excluded, before they spend\. linear: run\.excludeTools removes every tool that reaches it .* Another host's overlay may route it another way\./);
  const planned = await f.service.preview(ask(f, { excludeTools: excluded }), operator);
  assert.deepEqual(await f.service.apply(planned, operator), { ok: true });
  // Already cut before this edit: an edit that adds one more exclusion speaks only of what it moved, which is nothing here.
  await quiet(fixture({ run: { ...HELD, mcp: ["linear"], excludeTools: excluded } }), { excludeTools: [...excluded, "write"] });
  // One way left in is a way in, as the check says.
  await quiet(fixture({ run: { ...HELD, mcp: ["linear"] } }), { excludeTools: ["mcp__linear__*"] });
  // A server added with the list that cuts it: said once, by the route, and not again by the server's own check.
  const added = await warned(fixture({ run: HELD }), { mcp: ["linear"], excludeTools: excluded });
  assert.equal(added.split("refused as mcp-excluded").length - 1, 1, added);
});

test("each of the check's other answers is said, by the reason it would refuse with, only of a server the edit adds", async () => {
  const f = fixture({ env: {} });
  assert.match(await warned(f, { mcp: ["nobody"] }), /^On this host this trigger's jobs would be refused as mcp-server-unknown, before they spend\. nobody: the overlay's mcp\.json does not offer it\. Declare the server in the overlay `mcp\.json`, or fix the name in `run\.mcp`\./);
  const off = fixture({ mcpJson: { mcpServers: { docs: { url: "https://docs.example.com/mcp", description: "Docs", enabled: false } } } });
  assert.match(await warned(off, { mcp: ["docs"] }), /refused as mcp-server-unknown.*docs: the overlay's mcp\.json turns it off/);
  const none = fixture({ mcpJson: null });
  assert.match(await warned(none, { mcp: ["docs"] }), /refused as mcp-config-invalid.*The list: the overlay holds no mcp\.json/);
  const broken = fixture({ mcpJson: "{ not json" });
  assert.match(await warned(broken, { mcp: ["docs"] }), /refused as mcp-config-invalid.*cannot be read whole/);
  await quiet(none, { mcp: ["forge"] });
  const reserved = fixture({ mcpJson: { mcpServers: { k: { url: "https://k.example.com/mcp", description: "K", headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}" } } } }, run: { secrets: { ANTHROPIC_API_KEY: "op://v/r" } } });
  assert.match(await warned(reserved, { mcp: ["k"] }), /refused as mcp-secret-reserved.*k: it references ANTHROPIC_API_KEY, which this deployment uses for the job's own credentials\. Give the server's credential a variable of its own\./);
  // A server already on the trigger that this host refuses neither speaks nor hides the one being added.
  const both = fixture({ run: { mcp: ["linear"] }, env: { PI_FORWARD_ENV: "" } });
  const said = await quiet(both, { mcp: ["linear", "docs"] });
  assert.ok(!said.summary.join(" ").includes("mcp-secret-unmapped"), said.summary.join(" | "));
});

test("the egress rules are this host's: its PI_EGRESS, its allowlist file and its declared endpoints", async () => {
  const armed = { env: { PI_EGRESS: "" } };
  const f = fixture(armed);
  assert.match(await warned(f, { mcp: ["docs"] }), /refused as mcp-egress-unreachable.*docs: /);
  nodeFs.writeFileSync(join(f.dir, "egress-allowlist.conf"), "docs.example.com\n");
  await quiet(f, { mcp: ["docs"] });
  // A declared endpoint at the server's own host and port is the other way through the proxy.
  await quiet(fixture({ ...armed, deps: { readEndpoints: () => [{ id: "docs", host: "docs.example.com", port: 443 }] } }), { mcp: ["docs"] });
  assert.match(await warned(fixture({ ...armed, deps: { readEndpoints: () => [{ id: "other", host: "other.example.com", port: 443 }] } }), { mcp: ["docs"] }), /refused as mcp-egress-unreachable/);
  const runner = fixture({ env: { PI_EGRESS: "" }, mcpJson: { mcpServers: { r: { command: "npx", args: ["-y", "some-server@1.0.0"], allowPackageRunner: true, description: "R" } } } });
  assert.match(await warned(runner, { mcp: ["r"] }), /refused as mcp-package-runner.*r: it fetches its server from /);
});

test("what could not be read says which, and what follows from that: never a refusal", async () => {
  const notRead = "This host's .env could not be read as the worker reads it, so the worker's pickup check could not be run.";
  const cases = [
    [{ deps: { readHostEnv: () => { throw new Error("untrusted"); } } }, notRead],
    [{ env: { PI_EGRESS: "banana" } }, "This host's PI_EGRESS or PI_FORWARD_ENV is one the worker refuses, so the worker's pickup check could not be run."],
    [{ env: { PI_FORWARD_ENV: "GITHUB_TOKEN" } }, "This host's PI_EGRESS or PI_FORWARD_ENV is one the worker refuses, so the worker's pickup check could not be run."],
    [{ env: { PI_EGRESS: "" }, deps: { readEndpoints: () => { throw new Error("no"); } } }, "This host's model endpoints could not be read, so the worker's pickup check could not judge docs."],
    [{ deps: { readHostEnv: () => ({ env: { PI_EGRESS: "0" }, unread: ["PI_FORWARD_ENV"] }) } }, "This host's .env holds PI_FORWARD_ENV in a line that could not be read as the worker reads it, so the worker's pickup check could not be run."],
  ];
  for (const [options, sentence] of cases) {
    const f = fixture(options);
    const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
    assert.deepEqual(out.plan?.warnings, [sentence, TAIL], JSON.stringify(out));
    assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  }
  // The allowlist, by its own name: the worker's own check turns an unreadable list into a refusal of its own.
  const dir = fixture({ env: { PI_EGRESS: "" } });
  nodeFs.mkdirSync(join(dir.dir, "egress-allowlist.conf"));
  assert.match(await warned(dir, { mcp: ["docs"] }), /refused as mcp-egress-unreachable.*egress-allowlist\.conf cannot be read \(EISDIR\)/);
});

test("a key's .env line the reader cannot vouch for is unknown: neither absent nor held, and the sentence says so", async () => {
  const hostEnv = (keys) => ({ env: { PI_EGRESS: "0", PI_FORWARD_ENV: "LINEAR_API_KEY" }, unread: keys.includes("LINEAR_API_KEY") ? ["LINEAR_API_KEY"] : [] });
  const f = fixture({ deps: { readHostEnv: hostEnv } });
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.deepEqual(out.plan.warnings, ["LINEAR_API_KEY is forwarded by this host, and its line in the .env could not be read as the worker reads it, so whether linear gets that key could not be judged here.", TAIL]);
  // A key the trigger passes itself needs no line: nothing to say.
  await quiet(fixture({ run: HELD, deps: { readHostEnv: hostEnv } }), { mcp: ["linear"] });
  // A server that reads no such key is not told about it.
  await quiet(fixture({ deps: { readHostEnv: hostEnv } }), { mcp: ["docs"] });
});

test("a read that may pass on a second try says so as a warning, and a pickup asks again", async () => {
  const f = fixture();
  const flaky = { ...nodeFs, readFileSync: (path, ...rest) => { if (String(path).endsWith("mcp.json")) throw Object.assign(new Error("busy"), { code: "EIO" }); return nodeFs.readFileSync(path, ...rest); } };
  const service = createTriggerEnvironmentActions({ paths: f.paths, env: HOST_ENV, fs: flaky, now: () => NOW });
  const out = await service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.deepEqual(out.plan.warnings, ["An overlay file the worker's pickup check reads could not be read just now, so it could not judge docs; a pickup asks again.", TAIL]);
  const tools = fixture({ run: { mcp: ["docs"] } });
  const toolsService = createTriggerEnvironmentActions({ paths: tools.paths, env: HOST_ENV, fs: flaky, now: () => NOW });
  assert.deepEqual((await toolsService.preview(ask(tools, { excludeTools: ["write"] }), operator)).plan.warnings, ["This host's overlay mcp.json could not be read, so whether these tools still reach a server could not be judged here.", TAIL]);
});

test("the check runs only for an edit of the servers or the exclusions, and speaks only of what that edit touched", async () => {
  const run = { provider: "anthropic", model: "claude-haiku-4-5", mcp: ["linear"] };
  const noKey = { env: { PI_FORWARD_ENV: "" } };
  // The file already says something the check would refuse. None of these touches it, and none is told about it.
  for (const change of [{ flow: "review" }, { packages: false }, { maxCostUsd: "1" }, { model: "claude-sonnet-5-5" }, { provider: "anthropic", model: "claude-sonnet-5-5" }, { provider: "openai" }, { models: [HAIKU] }, { excludeTools: ["write"] }]) {
    const f = fixture({ run, ...noKey });
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan, JSON.stringify([change, out]));
    assert.ok(!out.summary.join(" ").includes("linear:"), JSON.stringify([change, out.summary]));
    assert.ok(!out.summary.join(" ").includes("mcp-secret-unmapped"), JSON.stringify(change));
  }
  // The job as the worker resolves it: a role's model reaches its provider's key, though the file names neither.
  const mcpJson = { mcpServers: { k: { url: "https://k.example.com/mcp", description: "K", headers: { Authorization: "Bearer ${OPENAI_API_KEY}" } } } };
  const roles = fixture({ mcpJson, doc: { modelRoles: { default: { oai: "openai/gpt-4o" } }, triggers: [cron, comment({ model: "role:oai", secrets: { OPENAI_API_KEY: "op://v/r" } })] }, env: { PI_ALLOWED_MODELS: HAIKU } });
  assert.match(await warned(roles, { mcp: ["k"] }), /^On this host this trigger's jobs would be refused as mcp-secret-reserved/);
  // Removing the servers leaves nothing to check.
  await quiet(fixture({ run, ...noKey }), { mcp: null });
  // The overlay moved between the two: a warning is no reason to stop a person who was told nothing, and the file alone still decides.
  const later = fixture({ run: HELD });
  const planned = await later.service.preview(ask(later, { mcp: ["linear"] }), operator);
  assert.ok(planned.plan);
  nodeFs.writeFileSync(join(later.paths.globalPiDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  assert.deepEqual(await later.service.apply(planned, operator), { ok: true });
});

test("settings or a project's list it cannot read warn on an edit of the servers, in words about that check and not a model or a cap", async () => {
  const unsettled = fixture();
  nodeFs.writeFileSync(unsettled.paths.settingsFile, "{ not json");
  const settings = await warned(unsettled, { mcp: ["docs"] });
  assert.equal(settings, `The deployment's settings could not be read as the worker reads them, so the worker's pickup check could not be run. ${TAIL}`);
  const projects = fixture();
  projects.paths.projectsFile = join(projects.dir, "projects.json");
  nodeFs.writeFileSync(projects.paths.projectsFile, "{ not json");
  assert.equal(await warned(projects, { mcp: ["docs"] }), `The trigger's project or role policy could not be read, so the worker's pickup check could not be run. ${TAIL}`);
});

test("a project whose role takes a key warns of that project's jobs alone, since another project's run clean", async () => {
  const mcpJson = { mcpServers: { k: { url: "https://k.example.com/mcp", description: "K", headers: { Authorization: "Bearer ${OPENAI_API_KEY}" } } } };
  const doc = { modelRoles: { default: { main: HAIKU }, web: { main: "openai/gpt-4o" } }, triggers: [cron, comment({ model: "role:main", secrets: { OPENAI_API_KEY: "op://v/r" } })] };
  const f = fixture({ mcpJson, doc });
  f.paths.projectsFile = join(f.dir, "projects.json");
  nodeFs.writeFileSync(f.paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }, { id: "api", members: ["github:acme/api"] }] }));
  const words = await warned(f, { mcp: ["k"] });
  assert.match(words, /^On this host this trigger's jobs in project web would be refused as mcp-secret-reserved, before they spend\. k: it references OPENAI_API_KEY/);
  assert.ok(!words.includes("every job"), words);
});

test("what the file alone would refuse has no Undo button; what this host only warns of can be put back", async () => {
  const f = fixture({ run: { mcp: ["linear"] }, env: { PI_FORWARD_ENV: "" } });
  const warnedBack = await write(f, { mcp: null });
  assert.deepEqual(warnedBack.plan.inverse.body.mcp, ["linear"], "the way back warns, and a warning is no refusal");
  const excluded = ["mcp__linear__*", "read_mcp_resource"];
  const cut = fixture({ run: { ...HELD, mcp: ["linear"], excludeTools: excluded } });
  const out = await write(cut, { excludeTools: null });
  assert.equal(out.plan.inverse, null);
  assert.match(out.plan.undo, /^Edit trigger row 2 back by hand: this page would refuse what it said before\. On every host this trigger's jobs would be refused as mcp-excluded/);
  const fine = fixture({ run: { ...HELD, mcp: ["linear"] } });
  assert.deepEqual((await write(fine, { mcp: null })).plan.inverse.body.mcp, ["linear"]);
});

// ---- the words --------------------------------------------------------------------------------------------------------

const WORDS = [
  ["flow", { resume: true }, { flow: "review" }, ["Flow: fix to review."]],
  ["a provider set", { resume: true }, { provider: "anthropic" }, ["Provider: the deployment's to anthropic."]],
  ["a provider changed", { provider: "anthropic", model: "claude-haiku-4-5" }, { provider: "openai", model: "gpt-4o" }, ["Provider: anthropic to openai.", "Model: claude-haiku-4-5 to gpt-4o."]],
  ["a model removed", { model: "claude-sonnet-5-5" }, { model: null }, ["Model: claude-sonnet-5-5 removed, so its jobs use the deployment's."]],
  ["a provider removed", { provider: "anthropic" }, { provider: null }, ["Provider: anthropic removed, so its jobs use the deployment's."]],
  ["a cap added", { resume: true }, { maxCostUsd: "2" }, ["Job cap: $2.00, where this trigger set none."]],
  ["a cap lowered", { maxCostUsd: "2.50" }, { maxCostUsd: "1" }, ["Job cap: $2.50 to $1.00."]],
  ["a cap raised is a widening", { maxCostUsd: "1" }, { maxCostUsd: "2" }, ["Job cap: $1.00 to $2.00.", "This widens what each job may spend: up to $2.00."]],
  ["a cap removed with no deployment cap", { maxCostUsd: "1" }, { maxCostUsd: null }, ["Job cap: $1.00 removed; the deployment sets none, so its jobs have no cap.", "This widens what each job may spend: no cap at all."]],
  ["a list added with no deployment list", { resume: true }, { models: [HAIKU] }, [`Allowed models: ${HAIKU}, where this trigger listed none.`]],
  ["a list member added", { models: [HAIKU] }, { models: [HAIKU, SONNET] }, [`Allowed models: ${SONNET} added.`, `This widens which models its jobs may call: ${SONNET}.`]],
  ["a list member removed", { models: [HAIKU, SONNET] }, { models: [HAIKU] }, [`Allowed models: ${SONNET} removed.`]],
  ["a list swapped", { models: [HAIKU, SONNET] }, { models: [HAIKU, OPUS] }, [`Allowed models: ${OPUS} added, ${SONNET} removed.`, `This widens which models its jobs may call: ${OPUS}.`]],
  ["a list reordered", { models: [HAIKU, SONNET] }, { models: [SONNET, HAIKU] }, ["Allowed models: the same models in a new order."]],
  ["a list removed", { models: [HAIKU] }, { models: null }, ["Allowed models: the list removed.", "This widens which models its jobs may call: any model."]],
  ["a fallback added says no widening: it must already be allowed", { models: [HAIKU, SONNET] }, { fallbackModels: [SONNET] }, [`Fallback models: ${SONNET}, where this trigger listed none.`]],
  ["a fallback changed", { models: [HAIKU, SONNET, OPUS], fallbackModels: [SONNET] }, { fallbackModels: [OPUS] }, [`Fallback models: ${OPUS} added, ${SONNET} removed.`]],
  ["fallbacks reordered", { models: [HAIKU, SONNET, OPUS], fallbackModels: [SONNET, OPUS] }, { fallbackModels: [OPUS, SONNET] }, ["Fallback models: the same models in a new order."]],
  ["fallbacks removed", { models: [HAIKU, SONNET], fallbackModels: [SONNET] }, { fallbackModels: null }, ["Fallback models: the list removed."]],
  ["an MCP server off", { mcp: ["docs", "linear"] }, { mcp: ["docs"] }, ["MCP: linear off."]],
  ["every MCP server off", { mcp: ["docs"] }, { mcp: null }, ["MCP: docs off."]],
  ["MCP reordered", { mcp: ["docs", "linear"] }, { mcp: ["linear", "docs"] }, ["MCP: the same servers in a new order."]],
  ["packages off", { resume: true }, { packages: false }, ["Staged packages: off."]],
  ["packages back on by null", { packages: false }, { packages: null }, ["Staged packages: on.", "This widens what its jobs load: every package staged on the host that runs them."]],
  ["packages back on by true", { packages: false }, { packages: true }, ["Staged packages: on.", "This widens what its jobs load: every package staged on the host that runs them."]],
  ["a tool off", { resume: true }, { excludeTools: ["bash"] }, ["Tools: bash off."]],
  ["a tool back on", { excludeTools: ["bash", "write"] }, { excludeTools: ["write"] }, ["Tools: bash on.", "This widens what its jobs can do: bash back on."]],
  ["every removal gone", { excludeTools: ["bash"] }, { excludeTools: null }, ["Tools: bash on.", "This widens what its jobs can do: bash back on."]],
  ["tools reordered", { excludeTools: ["bash", "write"] }, { excludeTools: ["write", "bash"] }, ["Tools: the same removals in a new order."]],
];
for (const [what, run, change, want] of WORDS) {
  test(`in words, never an arrow: ${what}`, async () => {
    const f = fixture({ run });
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan, JSON.stringify(out));
    assert.equal(out.summary[0], "Change trigger row 2");
    assert.deepEqual(out.plan.changes.flatMap((c) => [c.line, ...(c.widening ? [c.widening] : [])]), want);
    assert.deepEqual(out.summary.slice(1, 1 + want.length), want, "the lines lead with the change, each widening beside it");
    for (const line of out.summary) assert.doesNotMatch(line, /->|→|=>/);
  });
}

test("a key held as null reads as absent, in the loader's rule, so no sentence quotes it and deleting it is no change", async () => {
  for (const [held, change] of [[{ model: null }, { model: null }], [{ provider: null }, { provider: null }], [{ maxCostUsd: null }, { maxCostUsd: null }], [{ models: null }, { models: null }], [{ fallbackModels: null }, { fallbackModels: null }], [{ mcp: null }, { mcp: null }], [{ excludeTools: null }, { excludeTools: null }]]) {
    const f = fixture({ run: held });
    const before = f.read();
    assert.deepEqual(await f.service.preview(ask(f, change), operator), { unchanged: "trigger row 2 already says this." }, JSON.stringify(held));
    assert.equal(f.read(), before, "and writes nothing");
  }
  for (const [held, change, line] of [
    [{ maxCostUsd: null }, { maxCostUsd: "1" }, "Job cap: $1.00, where this trigger set none."],
    [{ model: null }, { model: "claude-sonnet-5-5" }, "Model: the deployment's to claude-sonnet-5-5."],
    [{ provider: null }, { provider: "anthropic" }, "Provider: the deployment's to anthropic."],
    [{ models: null }, { models: [HAIKU] }, `Allowed models: ${HAIKU}, where this trigger listed none.`],
    [{ models: [HAIKU], fallbackModels: null }, { fallbackModels: [HAIKU] }, `Fallback models: ${HAIKU}, where this trigger listed none.`],
    [{ mcp: null }, { mcp: ["docs"] }, "MCP: docs on."],
    [{ excludeTools: null }, { excludeTools: ["bash"] }, "Tools: bash off."],
  ]) {
    const f = fixture({ run: held });
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan, JSON.stringify(out));
    assert.equal(out.plan.changes[0].line, line);
    assert.doesNotMatch(out.summary.join("\n"), /\bnull\b/, JSON.stringify(held));
  }
});

test("two spellings of one amount are no change: nothing to say, write or undo, and the file keeps the one it had", async () => {
  for (const [held, sent] of [[1.5, "1.50"], ["1.50", 1.5], ["2", "2.00"], [2, "2"]]) {
    const f = fixture({ run: { maxCostUsd: held } });
    const before = f.read();
    assert.deepEqual(await f.service.preview(ask(f, { maxCostUsd: sent }), operator), { unchanged: "trigger row 2 already says this." }, JSON.stringify([held, sent]));
    assert.equal(f.read(), before);
  }
  const f = fixture({ run: { maxCostUsd: 1.5 } });
  const out = await write(f, { maxCostUsd: "1.50", packages: false });
  assert.deepEqual(out.plan.changes.map((change) => change.key), ["packages"]);
  assert.equal(f.entry().run.maxCostUsd, 1.5, "beside a real change, the same amount is still not written");
  assert.deepEqual(Object.keys(out.plan.inverse.body).sort(), ["index", "packages", "pageDigest"]);
  // A different amount is a change, and a bad one is the funnel's.
  const g = fixture({ run: { maxCostUsd: 1.5 } });
  assert.equal((await g.service.preview(ask(g, { maxCostUsd: "1.51" }), operator)).plan.changes[0].line, "Job cap: $1.50 to $1.51.");
  assert.match((await refusal(g, { maxCostUsd: "lots" })).refusal, /^rejected: /);
  // Two values neither of which parses are not one amount: the funnel names what is wrong, and no sentence says it is fine.
  const bad = fixture({ doc: { triggers: [cron, comment({ maxCostUsd: "lots" })] } });
  assert.match((await bad.service.preview(ask(bad, { maxCostUsd: "heaps" }), operator)).refusal, /^rejected: /);
});

test("no packages key and `true` load the same packages and are not one file: each can be cleared and put back, and says what moves", async () => {
  // What a job does, from the file each one leaves: the loader keeps `true` and `requiring` counts it, and nothing else reads it.
  const stays = /^Staged packages: stay on, /;
  const off = fixture({ run: { packages: true, resume: true } });
  const before = off.read();
  const cleared = await off.service.preview(ask(off, { packages: null }), operator);
  assert.deepEqual(cleared.plan.changes, [{ key: "packages", line: "Staged packages: stay on, and the file no longer says this flow needs them." }], "no widening: a job loads what it loaded");
  assert.match(cleared.plan.changes[0].line, stays);
  assert.deepEqual(await off.service.apply(cleared, operator), { ok: true });
  assert.equal(Object.hasOwn(off.entry().run, "packages"), false, "the key is gone from the file");
  assert.equal(parseTriggers(off.read(), off.paths.triggersPath)[1].run.packages, undefined);
  // Of this row alone, since doctor counts them all: a second row's `true` keeps its check failing, and the sentence does not say it stops.
  const other = fixture({ doc: { triggers: [cron, comment({ packages: true }), { on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "fix", packages: true } }] } });
  const one = await other.service.preview(ask(other, { packages: null }), operator);
  assert.doesNotMatch(one.summary.join(" "), /doctor/);
  assert.deepEqual(await other.service.apply(one, operator), { ok: true });
  assert.equal(parseTriggers(other.read(), other.paths.triggersPath).filter((t) => t.run.packages === true).length, 1, "doctor's `requiring`, by its own filter, still counts the other row");
  // Its Undo writes it back, in its place, byte for byte.
  const back = await off.service.preview(undoBody(cleared.plan.inverse), operator);
  assert.ok(back.plan, JSON.stringify(back));
  assert.deepEqual(back.plan.changes, [{ key: "packages", line: "Staged packages: stay on, and the file now says this flow needs them, so doctor fails a host with none staged." }]);
  assert.deepEqual(await off.service.apply(back, operator), { ok: true });
  assert.equal(off.read(), before);
  // What the file already says, either way, is still no change.
  for (const [run, change] of [[{ packages: true }, { packages: true }], [{}, { packages: null }], [{ packages: false }, { packages: false }]]) {
    const f = fixture({ run });
    const held = f.read();
    assert.deepEqual(await f.service.preview(ask(f, change), operator), { unchanged: "trigger row 2 already says this." }, JSON.stringify([run, change]));
    assert.equal(f.read(), held);
  }
  // A real switch: `false` to on widens by either way of saying it, and neither is what `true` to on says.
  for (const on of [null, true]) {
    const f = fixture({ run: { packages: false } });
    const out = await f.service.preview(ask(f, { packages: on }), operator);
    assert.deepEqual(out.plan.changes[0], { key: "packages", line: "Staged packages: on.", widening: "This widens what its jobs load: every package staged on the host that runs them." });
  }
});

test("what a widening reads against: the job's cap and list, not the trigger's own", async () => {
  // Above the deployment's it would refuse; here the cap moves within it, and it runs under the deployment's when removed.
  const f = fixture({ run: { maxCostUsd: "1" }, settings: { maxCostUsd: "5" } });
  const removed = await f.service.preview(ask(f, { maxCostUsd: null }), operator);
  assert.deepEqual(removed.plan.changes[0], { key: "maxCostUsd", line: "Job cap: $1.00 removed; its jobs run under the deployment's $5.00.", widening: "This widens what each job may spend: up to $5.00." });
  // A cap at the deployment's, removed: the job's cap does not move, so no widening is said.
  const same = fixture({ run: { maxCostUsd: "5" }, settings: { maxCostUsd: "5" } });
  const none = await same.service.preview(ask(same, { maxCostUsd: null }), operator);
  assert.equal(none.plan.changes[0].widening, undefined);

  // run.models replaces PI_ALLOWED_MODELS (`effectiveJobOf`), so a list where there was none can widen.
  const env = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: HAIKU } });
  const wider = await env.service.preview(ask(env, { models: [HAIKU, SONNET] }), operator);
  assert.deepEqual(wider.plan.changes[0], { key: "models", line: `Allowed models: ${HAIKU}, ${SONNET}, where this trigger listed none.`, widening: `This widens which models its jobs may call: ${SONNET}.` });
  const narrower = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${SONNET}` } });
  assert.equal((await narrower.service.preview(ask(narrower, { models: [HAIKU] }), operator)).plan.changes[0].widening, undefined);
  // Removing a list where the deployment has a narrower one: nothing becomes callable.
  const back = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, SONNET] }, env: { PI_ALLOWED_MODELS: HAIKU } });
  assert.deepEqual((await back.service.preview(ask(back, { models: null }), operator)).plan.changes[0], { key: "models", line: "Allowed models: the list removed." });
  const wide = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] }, env: { PI_ALLOWED_MODELS: `${HAIKU},${SONNET}` } });
  assert.equal((await wide.service.preview(ask(wide, { models: null }), operator)).plan.changes[0].widening, `This widens which models its jobs may call: ${SONNET}.`);
});

test("a widening under a role map is the real resolver's before and after, naming what becomes callable", async () => {
  const roles = { default: { editor: SONNET } };
  const doc = (run) => ({ modelRoles: roles, triggers: [cron, comment({ provider: "anthropic", model: "claude-haiku-4-5", ...run })] });
  const job = { provider: "anthropic", model: "claude-haiku-4-5" };
  assert.deepEqual(resolveModelRoles(job, roles, null).models, [HAIKU, SONNET], "what a job may call today");
  assert.deepEqual(resolveModelRoles({ ...job, models: [HAIKU, OPUS] }, roles, null).models, [HAIKU, OPUS, SONNET], "and with the list");

  const added = fixture({ doc: doc({}) });
  const widened = await added.service.preview(ask(added, { models: [HAIKU, OPUS] }), operator);
  assert.deepEqual(widened.plan.changes[0], { key: "models", line: `Allowed models: ${HAIKU}, ${OPUS}, where this trigger listed none.`, widening: `This widens which models its jobs may call: ${OPUS}.` });

  // The same list taken away: the real list stays, so "any model" would be false, and nothing widens.
  assert.deepEqual(resolveModelRoles(job, roles, null).models, [HAIKU, SONNET]);
  const removed = fixture({ doc: doc({ models: [HAIKU, OPUS] }) });
  const narrowed = await removed.service.preview(ask(removed, { models: null }), operator);
  assert.deepEqual(narrowed.plan.changes[0], { key: "models", line: "Allowed models: the list removed." });
  assert.ok(!narrowed.summary.some((line) => line.includes("any model")));

  // A model edit alone can widen too: the resolver unions the main model into the list, and no key named a list.
  const moved = fixture({ doc: doc({}) });
  const dearer = await moved.service.preview(ask(moved, { model: "claude-opus-5-5" }), operator);
  assert.deepEqual(dearer.plan.changes.at(-1), { key: "model", line: "Model: claude-haiku-4-5 to claude-opus-5-5.", widening: `This widens which models its jobs may call: ${OPUS}.` });
  // Back on a model a role already names: nothing new.
  const toRole = fixture({ doc: doc({}) });
  assert.equal((await toRole.service.preview(ask(toRole, { model: "claude-sonnet-5-5" }), operator)).plan.changes.at(-1).widening, undefined);
  // No role map and no list on either side: a job could call anything already, so a model edit widens nothing.
  const plain = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } });
  assert.equal((await plain.service.preview(ask(plain, { model: "claude-opus-5-5" }), operator)).plan.changes.at(-1).widening, undefined);
  // A cap edit moves no list, and has no model line to hang one on.
  const capped = fixture({ doc: doc({}) });
  assert.deepEqual((await capped.service.preview(ask(capped, { maxCostUsd: "5" }), operator)).plan.changes, [{ key: "maxCostUsd", line: "Job cap: $5.00, where this trigger set none." }]);
});

test("a role a project declares is judged per project: a model only one project's jobs gain is still said", async () => {
  // A job in project web may already call opus through its role, and a job in no project may not: the edit widens the second.
  const doc = { modelRoles: { default: { editor: SONNET }, web: { architect: OPUS } }, triggers: [cron, comment({ provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, SONNET] })] };
  const f = fixture({ doc });
  f.paths.projectsFile = join(f.dir, "projects.json");
  nodeFs.writeFileSync(f.paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
  const out = await f.service.preview(ask(f, { models: [HAIKU, SONNET, OPUS] }), operator);
  assert.equal(out.plan.changes[0].widening, `This widens which models its jobs may call: ${OPUS}.`);
  // And a change that gives no project's jobs anything new says nothing, though one project's list holds more than another's.
  assert.equal((await f.service.preview(ask(f, { models: [SONNET, HAIKU] }), operator)).plan.changes[0].widening, undefined);
});

const LOADS = {
  hosts: [
    { name: "mini1", state: "current", mcp: [{ name: "linear", enabled: true, where: "mcp.example.com", keys: ["LINEAR_API_KEY"] }, { name: "docs", enabled: false, where: "docs.example.com", keys: [] }], unread: [], more: {} },
    { name: "build3", state: "old", mcp: [{ name: "linear", enabled: true, where: "mcp.example.com", keys: ["LINEAR_API_KEY"] }], unread: [], more: {} },
    { name: "mini2", state: "unknown", why: "absent" },
    { name: "cut", state: "current", mcp: [], unread: [], more: { mcp: 3 } },
    { name: "unread", state: "current", mcp: [], unread: ["mcp"], more: {} },
    { name: "bare", state: "current", mcp: [], unread: [], more: {} },
  ],
};
test("a server turned on is a widening that names where it connects and with which key, and what a host without it does", async () => {
  const f = fixture({ deps: { readHostLoads: async () => LOADS } });
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.deepEqual(out.plan.changes[0], { key: "mcp", line: "MCP: linear on.", widening: "This widens what its jobs reach: a job that reaches its container connects to mcp.example.com, with LINEAR_API_KEY by name." });
  assert.ok(out.summary.includes("A job on a host without linear, or with it off, is refused as mcp-server-unknown, before it spends; a host with no overlay or no mcp.json refuses it as mcp-config-invalid. mini1 has it; bare does not; build3, cut, mini2 and unread read unknown."), out.summary.join("\n"));
});

test("a server off on a host reads as lacking, and a server hosts disagree about names no host", async () => {
  const f = fixture({ deps: { readHostLoads: async () => LOADS } });
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.match(out.summary.find((line) => line.startsWith("A job on a host")), /bare and mini1 do not; build3, cut, mini2 and unread read unknown\.$/);
  // No host has docs on, so where it connects is known to none.
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to docs.");

  const differ = fixture({ deps: { readHostLoads: async () => ({ hosts: [{ name: "a", state: "current", mcp: [{ name: "x", enabled: true, where: "one.example", keys: [] }], unread: [], more: {} }, { name: "b", state: "current", mcp: [{ name: "x", enabled: true, where: "two.example", keys: [] }], unread: [], more: {} }] }) } });
  const two = await differ.service.preview(ask(differ, { mcp: ["x"] }), operator);
  assert.equal(two.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to x.");
  const bare = fixture({ deps: { readHostLoads: async () => ({ hosts: [{ name: "a", state: "current", mcp: [{ name: "x", enabled: true, where: "one.example", keys: [] }], unread: [], more: {} }] }) } });
  assert.equal((await bare.service.preview(ask(bare, { mcp: ["x"] }), operator)).plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to one.example.");
  const noWhere = fixture({ deps: { readHostLoads: async () => ({ hosts: [{ name: "a", state: "current", mcp: [{ name: "x", enabled: true, where: null, keys: [] }], unread: [], more: {} }] }) } });
  assert.equal((await noWhere.service.preview(ask(noWhere, { mcp: ["x"] }), operator)).plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to x.");
});

test("an old publication says nothing of where a server connects, as it says nothing of whether a host has it", async () => {
  const held = fixture({ run: HELD, deps: { readHostLoads: async () => ({ hosts: [{ name: "old1", state: "old", mcp: [{ name: "linear", enabled: true, where: "stale.example", keys: ["K"] }], unread: [], more: {} }] }) } });
  const said = await held.service.preview(ask(held, { mcp: ["linear"] }), operator);
  assert.equal(said.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to linear.");
  assert.ok(said.summary.some((line) => line.endsWith("old1 reads unknown.")), said.summary.join("\n"));
  assert.ok(!said.summary.join(" ").includes("old1 has it"));
});

test("no host's publication says that, and is never read as lacking the server", async () => {
  const f = fixture({ deps: { readHostLoads: async () => ({ hosts: [] }) } });
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.ok(out.summary.some((line) => line.endsWith("No host has published which servers it has.")), out.summary.join("\n"));
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to linear.");
});

test("a read of the publications that failed says that it failed, and not that no host has published", async () => {
  const failed = " What the hosts published could not be read, so which of them have it is unknown.";
  // Valkey down, through the real view, as the console reads it.
  const down = () => readHostLoadsView({}, { readHosts: async () => { throw new Error("down"); }, readLoads: async () => { throw new Error("down"); } });
  for (const readHostLoads of [down, async () => ({ unreachable: true }), async () => ({ unreachable: true, hosts: [] }), async () => { throw new Error("down"); }, async () => null]) {
    const f = fixture({ deps: { readHostLoads } });
    const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
    const line = out.summary.find((one) => one.startsWith("A job on a host"));
    assert.ok(line.endsWith(failed), line);
    assert.ok(!out.summary.join(" ").includes("No host has published"));
    assert.equal(out.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to linear.");
    assert.deepEqual(out.plan.warnings, [], "an edit of a server says it on that server's line, and no flow is in question");
  }
  // Live hosts it can name, whose publications it could not read: each reads unknown, by name.
  const named = fixture({ deps: { readHostLoads: () => readHostLoadsView({}, { readHosts: async () => ({ hosts: [{ name: "mini1" }, { name: "build3" }] }), readLoads: async () => { throw new Error("down"); } }) } });
  const out = await named.service.preview(ask(named, { mcp: ["linear"] }), operator);
  assert.ok(out.summary.some((line) => line.endsWith("build3 and mini1 read unknown.")), out.summary.join("\n"));
});

test("the one sentence on where a job connects is true beside every warning: it stays, and says it of a job that gets that far", async () => {
  const hosts = { readHostLoads: async () => ({ hosts: [{ name: "mini1", state: "current", mcp: [{ name: "linear", enabled: true, where: "mcp.example.com", keys: ["LINEAR_API_KEY"] }], unread: [], more: {} }] }) };
  const sentence = "This widens what its jobs reach: a job that reaches its container connects to mcp.example.com, with LINEAR_API_KEY by name.";
  for (const [what, run, env, change, warning] of [
    ["an unknown model", {}, {}, { model: "no-such-model-9" }, /model-unknown/],
    ["no failover candidate", { provider: "anthropic", model: "claude-haiku-4-5" }, {}, { fallbackModels: [SONNET] }, /model-failover-no-candidate/],
    ["a key this host does not hold", {}, { PI_FORWARD_ENV: "" }, {}, /mcp-secret-unmapped/],
    ["nothing at all", { secrets: { LINEAR_API_KEY: "op://v/l" } }, {}, {}, null],
  ]) {
    const f = fixture({ run, env, deps: hosts });
    const out = await f.service.preview(ask(f, { mcp: ["linear"], ...change }), operator);
    assert.ok(out.plan, JSON.stringify([what, out]));
    assert.equal(out.plan.changes.find((one) => one.key === "mcp").widening, sentence, what);
    if (warning) assert.match(out.plan.warnings.join(" "), warning, what);
  }
  // A thin cap, the third way a job may stop before it connects.
  const thin = fixture({ run: HELD, deps: hosts });
  const out = await thin.service.preview(ask(thin, { mcp: ["linear"], provider: "anthropic", model: "claude-opus-5-5", maxCostUsd: "2.62144" }), operator);
  assert.ok(out.summary.some((line) => line.includes("clears this $2.62144 job cap")), out.summary.join("\n"));
  assert.equal(out.plan.changes.find((one) => one.key === "mcp").widening, sentence);
});

const LOADED_HOST = (name, over = {}) => ({ name, state: "current", at: NOW, skills: ["triage"], extensions: [], mcp: [], packages: [], flows: [], unread: [], more: {}, ...over });
const flowFixture = (hosts, run = {}) => fixture({ run, deps: { readHostLoads: async () => (Array.isArray(hosts) ? { hosts } : hosts) } });

test("a flow the hosts that answered do not hold warns, names them, and leaves the Confirm: a repository can gain it", async () => {
  const f = flowFixture([LOADED_HOST("mini1"), LOADED_HOST("build3")]);
  const out = await f.service.preview(ask(f, { flow: "no-such-flow" }), operator);
  assert.deepEqual(out.plan.warnings, ["build3 and mini1 have no skill named no-such-flow in their overlay. A job there runs without its flow unless something else it loads holds it, such as its repository."]);
  assert.ok(out.summary.includes(out.plan.warnings[0]));
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  assert.equal(f.entry().run.flow, "no-such-flow");
  assert.equal(await warned(flowFixture([LOADED_HOST("mini1")]), { flow: "no-such-flow" }), "mini1 has no skill named no-such-flow in its overlay. A job there runs without its flow unless something else it loads holds it, such as its repository.");
});

test("a flow says nothing of a host that holds it, and only the hosts without it are named", async () => {
  await quiet(flowFixture([LOADED_HOST("mini1", { skills: ["review"] })]), { flow: "review" });
  await quiet(flowFixture([LOADED_HOST("mini1", { flows: [{ trigger: 0, flow: "review", tier: "overlay", package: null, repo: "absent" }] })]), { flow: "review" });
  await quiet(flowFixture([LOADED_HOST("mini1", { flows: [{ trigger: 0, flow: "review", tier: "package", package: "pkg", repo: "absent" }] })]), { flow: "review" });
  assert.match(await warned(flowFixture([LOADED_HOST("mini1", { skills: ["review"] }), LOADED_HOST("build3")]), { flow: "review" }), /^build3 has no skill named review/);
  // On a row that withholds the packages, no sentence offers one as where a job may find it.
  assert.doesNotMatch(await warned(flowFixture([LOADED_HOST("mini1")], { packages: false }), { flow: "review" }), /package/);
  // A package this trigger withholds is no skill it gets, and another trigger's repository or skills folder is not its own.
  assert.match(await warned(flowFixture([LOADED_HOST("mini1", { flows: [{ trigger: 0, flow: "review", tier: "package", package: "pkg", repo: "absent" }] })], { packages: false }), { flow: "review" }), /^mini1 has no skill named review/);
  for (const tier of ["repository", "trigger"]) assert.match(await warned(flowFixture([LOADED_HOST("mini1", { flows: [{ trigger: 0, flow: "review", tier, package: null, repo: "present" }] })]), { flow: "review" }), /^mini1 has no skill named review/);
});

test("a flow claims no host's answer when none answered: no publication, an old one, a cut or unread list, or a read that failed", async () => {
  for (const hosts of [
    [],
    [LOADED_HOST("mini1", { state: "old" })],
    [{ name: "mini1", state: "unknown", why: "absent" }],
    [LOADED_HOST("mini1", { unread: ["skills"] })],
    [LOADED_HOST("mini1", { more: { skills: 3 } })],
  ]) await quiet(flowFixture(hosts), { flow: "no-such-flow" });
  // A read that failed says so, as it does of a server: "What the hosts published could not be read".
  for (const readHostLoads of [async () => ({ unreachable: true, hosts: [] }), async () => { throw new Error("down"); }, async () => null, () => readHostLoadsView({}, { readHosts: async () => { throw new Error("down"); }, readLoads: async () => { throw new Error("down"); } })]) {
    const f = fixture({ deps: { readHostLoads } });
    const out = await f.service.preview(ask(f, { flow: "no-such-flow" }), operator);
    assert.deepEqual(out.plan.warnings, ["What the hosts published could not be read, so which of them have no-such-flow is unknown."]);
    assert.ok(out.summary.includes(out.plan.warnings[0]));
  }
  // A flow it did not touch reads no host at all.
  let reads = 0;
  const f = fixture({ deps: { readHostLoads: async () => { reads += 1; return { hosts: [LOADED_HOST("mini1")] }; } } });
  await quiet(f, { packages: false });
  assert.deepEqual(await f.service.preview(ask(f, { flow: "fix" }), operator), { unchanged: "trigger row 2 already says this." });
  assert.equal(reads, 0);
});

test("a .env line the worker's loader reads differently is named by its line, and the keys it hides are not blamed for it", async () => {
  const f = withEnvFile({}, "PI_EGRESS=0\nPI_FORWARD_ENV=LINEAR_API_KEY\nLINEAR_API_KEY=ab cd\n");
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.deepEqual(out.plan.warnings, ["Line 3 of this host's .env could not be read as the worker reads it, so the worker's pickup check could not be run.", TAIL]);
  assert.doesNotMatch(out.summary.join(" "), /PI_FORWARD_ENV/);
  const cap = withEnvFile({ provider: "anthropic", model: "claude-haiku-4-5" }, "PI_MAX_COST_USD=2\nOTHER=ab cd\n");
  assert.equal(await warned(cap, { maxCostUsd: "5" }), "Line 2 of this host's .env could not be read as the worker reads it, so the deployment's job cap and its list of models could not be judged here. A trigger's cap above what the worker reads makes it refuse the whole file.");
});

test("the forge server is no host's to lack, and a server taken away reads no host at all", async () => {
  let reads = 0;
  const f = fixture({ deps: { readHostLoads: async () => { reads++; return LOADS; } } });
  const forge = await f.service.preview(ask(f, { mcp: ["forge"] }), operator);
  assert.equal(forge.plan.changes[0].widening, "This widens what its jobs reach: a job that reaches its container connects to the job's own forge server.");
  assert.ok(!forge.summary.some((line) => line.startsWith("A job on a host")));
  assert.equal(reads, 0);
  const both = await f.service.preview(ask(f, { mcp: ["linear", "forge"] }), operator);
  assert.match(both.plan.changes[0].widening, /connects to mcp\.example\.com, with LINEAR_API_KEY by name and the job's own forge server\.$/);
  assert.equal(reads, 1);
  const off = fixture({ run: { mcp: ["linear"] }, deps: { readHostLoads: async () => { reads++; return LOADS; } } });
  assert.equal((await off.service.preview(ask(off, { mcp: null }), operator)).plan.changes[0].widening, undefined);
  assert.equal(reads, 1);
});

test("when a change takes effect is said of this file on this host, of the jobs in line, of running jobs and of other hosts", async () => {
  const f = fixture();
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  for (const line of [
    "The services reading this file use it from their next reload, for the jobs they queue after that.",
    "A job already in line keeps what it was queued with and runs without this change, unless it is named below as refused. A running job is not touched.",
    "A host with its own copy of this file keeps what it has until that copy changes.",
  ]) assert.ok(out.summary.includes(line), line);
  assert.ok(!out.summary.some((line) => /New deliveries use this|start after this/.test(line)), "nothing says this reaches every host, or a job already in line");
  // Divergent files freeze cron (docs/multi-host.md, trap 2), so a schedule's change waits for the copies to agree, this host's included.
  const schedule = await f.service.preview(ask(f, { packages: false }, 0), operator);
  assert.ok(schedule.summary.includes("While hosts' copies differ on a schedule, no host installs a change to one, so this one moves when they agree."), schedule.summary.join("\n"));
  assert.ok(!out.summary.some((line) => line.startsWith("While hosts' copies differ")), "a webhook trigger has no schedule to freeze");
});

// ---- a tool taken back, and a file as the loader reads it --------------------------------------------------------------------

test("a tool taken out of the list widens only if a job would really have it: pi's defaults, and not what stays off without an extension", async () => {
  for (const name of EXCLUDABLE_TOOL_NAMES) {
    const f = fixture({ run: { excludeTools: [name, "grep"].filter((tool, at, all) => all.indexOf(tool) === at) } });
    const kept = name === "grep" ? ["bash"] : ["grep"];
    const out = await f.service.preview(ask(f, { excludeTools: kept }), operator);
    const change = out.plan.changes[0];
    if (DEFAULT_ON_TOOL_NAMES.has(name)) {
      assert.equal(change.widening, `This widens what its jobs can do: ${name} back on.`, name);
      assert.ok(change.line.includes(`${name} on`), change.line);
    } else {
      assert.equal(change.widening, undefined, name);
      assert.ok(change.line.includes(`${name} no longer removed, and off unless an extension turns it on`), change.line);
    }
  }
  // What the card's Tools row says stays off is this same set, and the pin holds it.
  const off = [...EXCLUDABLE_TOOL_NAMES].filter((name) => !DEFAULT_ON_TOOL_NAMES.has(name));
  assert.ok(off.length > 0);
  for (const name of off) assert.ok(TRIGGER_GETS_WORDS.toolsOn.includes(name), name);
  // A server's own tools come back with it: there is no default to compare them with, and the server is named.
  const server = fixture({ run: { ...HELD, mcp: ["linear"], excludeTools: ["mcp__linear__*"] } });
  assert.equal((await server.service.preview(ask(server, { excludeTools: null }), operator)).plan.changes[0].widening, "This widens what its jobs can do: mcp__linear__* back on.");
});

const WATCH_ENTRY = (run = {}) => ({ on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service", "error.type"], window: "10m", cooldown: "6h", maxPerDay: 4 }, run: { kind: "local", folder: "/nowhere", flow: "triage", task: "look", maxCostUsd: "1", ...run } });
const WATCH_DOC = (run) => ({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } }, triggers: [WATCH_ENTRY(run)] });

test("a watch rule's jobs never get edit, write, bash or powershell, whatever the file's list says, so taking one out widens nothing", async () => {
  const f = fixture({ doc: WATCH_DOC({ excludeTools: ["bash", "read"] }) });
  const out = await f.service.preview(ask(f, { excludeTools: ["read"] }, 0), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.changes, [{ key: "excludeTools", line: "Tools: the file's list no longer names bash, and what its jobs lack does not change." }]);
  // A tool the loader does not hold back is a real change, and says so.
  const back = await f.service.preview(ask(f, { excludeTools: ["bash"] }, 0), operator);
  assert.equal(back.plan.changes[0].widening, "This widens what its jobs can do: read back on.");
  // And a preview of one speaks of neither a queue nor a refusal: no job of it carries an index.
  assert.ok(!out.summary.some((line) => /trigger-skew|named below/.test(line)), out.summary.join("\n"));
});

test("a watch rule takes no mcp, packages or fallback models: the funnel refuses each in the loader's words, and nothing is written", async () => {
  for (const change of [{ mcp: ["docs"] }, { packages: false }, { fallbackModels: [SONNET] }]) {
    const f = fixture({ doc: WATCH_DOC({}) });
    const before = f.read();
    const out = await refusal(f, change, 0);
    assert.match(out.refusal, /^rejected: .*watch: unsupported run field/, JSON.stringify(change));
    assert.equal(f.read(), before);
  }
  const f = fixture({ doc: WATCH_DOC({}) });
  const fine = await f.service.preview(ask(f, { model: "claude-haiku-4-5", provider: "anthropic" }, 0), operator);
  assert.ok(fine.plan, JSON.stringify(fine));
});

test("a file the loader refused as it was: a true line for what moved, and no way back that this page would refuse", async () => {
  for (const [held, change, line] of [
    [{ excludeTools: [] }, { excludeTools: null }, "Tools: the empty list the file held removed."],
    [{ mcp: [] }, { mcp: null }, "MCP: the empty list the file held removed."],
    [{ models: [] }, { models: null }, "Allowed models: the list removed."],
    [{ maxCostUsd: 0 }, { maxCostUsd: null }, null],
  ]) {
    const f = fixture({ doc: { triggers: [cron, comment(held)] } });
    assert.throws(() => parseTriggers(f.read(), f.paths.triggersPath), JSON.stringify(held));
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan, JSON.stringify([held, out]));
    if (line !== null) assert.equal(out.plan.changes[0].line, line);
    assert.doesNotMatch(out.summary.join(" "), /: \.|project or role policy/, JSON.stringify(out.summary));
    assert.equal(out.plan.inverse, null, JSON.stringify(held));
    assert.equal(out.plan.undo, "Edit trigger row 2 back by hand: the file did not load as it was, and this page will not write that back");
    assert.deepEqual(await f.service.apply(out, operator), { ok: true });
    assert.doesNotThrow(() => parseTriggers(f.read(), f.paths.triggersPath));
  }
});

test("a body that changes nothing reads as no change, whichever way it got here: nothing sent, or what the file holds", async () => {
  const f = fixture({ run: { models: [HAIKU] } });
  const before = f.read();
  assert.deepEqual(await f.service.preview({ index: 1, pageDigest: f.digest() }, operator), { unchanged: "trigger row 2 already says this." });
  assert.deepEqual(await f.service.preview(ask(f, { models: [HAIKU] }), operator), { unchanged: "trigger row 2 already says this." });
  assert.equal(f.read(), before);
  // What it saw is still asked first: a page out of date is told so, and not that nothing changed.
  assert.equal((await f.service.preview({ index: 1, pageDigest: "a".repeat(64) }, operator)).state, "changed");
  assert.deepEqual(await f.service.apply({ payload: { body: { index: 1, pageDigest: f.digest() } } }, operator), { invalid: "trigger row 2 already says this." });
});

test("a hand-written file: the first write rewrites all of it, the Confirm says so, and the Undo says what it restores", async () => {
  const f = fixture();
  const written = f.read();
  // The writer's own layout: nothing else moves, and the way back is the bytes.
  const same = await f.service.preview(ask(f, { packages: false }), operator);
  assert.equal(same.plan.undo, "Put trigger row 2 back as it was");
  assert.ok(!same.summary.some((line) => line.includes("the writer's layout")), same.summary.join("\n"));

  const hand = fixture();
  nodeFs.writeFileSync(hand.paths.triggersPath, JSON.stringify(JSON.parse(written)).replace('"triggers":', '"triggers" : '));
  const handBytes = hand.read();
  const out = await hand.service.preview(ask(hand, { packages: false }), operator);
  const sentence = "This file is not in the writer's layout, so this write also rewrites all of it: spacing and line breaks move in lines this change does not touch, and what each key says does not. Undo puts the values back, not that layout.";
  assert.ok(out.summary.includes(sentence), out.summary.join("\n"));
  assert.equal(out.plan.undo, "Put trigger row 2's values back; the file keeps the layout this write gave it");
  assert.deepEqual(await hand.service.apply(out, operator), { ok: true });
  const undone = await hand.service.preview(undoBody(out.plan.inverse), operator);
  assert.ok(undone.plan, JSON.stringify(undone));
  assert.equal(undone.plan.undo, "Put trigger row 2 back as it was", "the writer's own layout from here");
  assert.deepEqual(await hand.service.apply(undone, operator), { ok: true });
  assert.deepEqual(JSON.parse(hand.read()), JSON.parse(handBytes), "every value back");
  assert.notEqual(hand.read(), handBytes, "and not the bytes, as the page said");
});

test("host names read in order, whatever order the registry answers in", async () => {
  const hosts = [{ name: "mini1", state: "current", mcp: [{ name: "linear", enabled: true, where: "mcp.example.com", keys: [] }], unread: [], more: {} }, { name: "build3", state: "current", mcp: [{ name: "linear", enabled: true, where: "mcp.example.com", keys: [] }], unread: [], more: {} }];
  const f = fixture({ run: HELD, deps: { readHostLoads: async () => ({ hosts }) } });
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.ok(out.summary.some((line) => line.endsWith("build3 and mini1 have it.")), out.summary.join("\n"));
});

test("the audit line and the file it writes are said, by the person who is asking", async () => {
  const f = fixture();
  const out = await f.service.preview(ask(f, { packages: false }), { ...operator, name: "alice" });
  assert.equal(out.summary.at(-1), "Written to triggers.json on this host and audited as trigger-edit, by alice at the console.");
  assert.equal(out.target, f.paths.triggersPath);
  assert.match(out.beforeDigest, /^[a-f0-9]{64}$/);
  assert.match(out.afterDigest, /^[a-f0-9]{64}$/);
  const unnamed = await f.service.preview(ask(f, { packages: false }), { surface: "console", role: "operator" });
  assert.equal(unnamed.summary.at(-1), "Written to triggers.json on this host and audited as trigger-edit, by the operator at the console.");
});

test("the audit row's digests are the file's own, so a reader can tie the row to the bytes", async () => {
  const { createHash } = await import("node:crypto");
  const f = fixture();
  const before = f.read();
  const out = await write(f, { packages: false });
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  assert.equal(out.beforeDigest, sha(before));
  assert.equal(out.afterDigest, sha(f.read()));
});

// ---- the jobs in line -------------------------------------------------------------------------------------------------

/** Real jobs, read through the worker's real check, on whatever file the planner hands it. */
function skewFixture(jobs, options = {}) {
  const waiting = { rows: jobs.map((job) => ({ jobId: job.id, queue: "pi-jobs" })) };
  const seen = [];
  const f = fixture({
    ...options,
    deps: {
      readSkew: (index, dry) => {
        seen.push(dry);
        return readTriggerSkew({ index, waiting, triggersPath: f.paths.triggersPath, fs: dry, lookupJob: async (_q, id) => ({ data: jobs.find((job) => job.id === id).data }) });
      },
    },
  });
  return { f, seen };
}
const queued = (id, extra = {}) => ({ id, data: { kind: "github", flow: "fix", trigger: { matched: { index: 1, type: "comment" } }, ...extra } });

test("jobs in line are judged on the PROPOSED entry: the job the new key refuses is named, and the file on disk would not refuse it", async () => {
  const { f, seen } = skewFixture([queued("gh-c9e1")]);
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.deepEqual(out.plan.skew, { rows: [{ jobId: "gh-c9e1", queue: "pi-jobs", field: "mcp" }], incomplete: false });
  assert.ok(out.summary.includes("With this change, a host reading this file refuses 1 of this trigger's jobs in line, before it spends: gh-c9e1 as trigger-skew (run.mcp)."), out.summary.join("\n"));
  // The control, the same job against the file as it stands: nothing refuses it.
  const today = await readTriggerSkew({ index: 1, waiting: { rows: [{ jobId: "gh-c9e1", queue: "pi-jobs" }] }, triggersPath: f.paths.triggersPath, lookupJob: async () => ({ data: queued("gh-c9e1").data }) });
  assert.deepEqual(today.rows, []);
  // What the planner handed over holds the proposed file, and the disk does not.
  assert.equal(JSON.parse(seen[0].readFileSync(f.paths.triggersPath, "utf8")).triggers[1].run.mcp[0], "linear");
  assert.equal(f.entry().run.mcp, undefined);
});

test("a job that already carries the field, one of another trigger, and one of another flow are not refused", async () => {
  const { f } = skewFixture([queued("has", { mcp: ["linear"] }), { id: "other", data: { kind: "github", flow: "fix", trigger: { matched: { index: 0, type: "cron" } } } }]);
  const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
  assert.deepEqual(out.plan.skew, { rows: [], incomplete: false });
  assert.ok(!out.summary.some((line) => line.includes("a host reading this file refuses")));

  // An edit of the flow: the entry no longer names the job's flow, so its identity fails and "unknown" runs (`makeCheckWaitSkew`).
  const flow = skewFixture([queued("a")], { run: { mcp: ["docs"] } });
  const moved = await flow.f.service.preview(ask(flow.f, { flow: "review" }), operator);
  assert.deepEqual(moved.plan.skew.rows, []);
});

// The sentence says a job in line runs without this change unless it is named. So every field the card writes, each with what the
// real check says of the file that write leaves: a field that is not narrowing refuses nobody, and saying otherwise was false.
const IN_LINE = [
  [{ flow: "review" }, null],
  [{ provider: "openai", model: "gpt-4o" }, null],
  [{ model: "claude-sonnet-5-5" }, null],
  [{ maxCostUsd: "2" }, "maxCostUsd"],
  [{ models: [HAIKU] }, "models"],
  [{ fallbackModels: [SONNET] }, "fallbackModels"],
  [{ mcp: ["docs"] }, "mcp"],
  [{ packages: false }, null],
  [{ excludeTools: ["bash"] }, null],
];
test("the rows below hold every field the card writes", () => {
  assert.deepEqual(new Set(IN_LINE.flatMap(([change]) => Object.keys(change))), new Set(CARD_FIELDS));
});
for (const [change, field] of IN_LINE) {
  test(`a job in line under ${JSON.stringify(change)}: ${field === null ? "runs, and no sentence names it" : `refused, as run.${field}`}, as the worker's own check says of the written file`, async () => {
    // A job that carries the list, so the one thing it lacks is what this row adds.
    const carried = "fallbackModels" in change ? { models: [HAIKU, SONNET] } : {};
    const { f } = skewFixture([queued("gh-1", carried)], { run: { provider: "anthropic", model: "claude-haiku-4-5", ...carried, ...(change.fallbackModels ? { models: [HAIKU, SONNET] } : {}) } });
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan, JSON.stringify(out));
    assert.deepEqual(out.plan.skew.rows, field === null ? [] : [{ jobId: "gh-1", queue: "pi-jobs", field }], JSON.stringify(change));
    assert.equal(out.summary.some((line) => line.includes("gh-1 as trigger-skew")), field !== null);
    assert.deepEqual(await f.service.apply(out, operator), { ok: true });
    const answer = await makeCheckWaitSkew({ triggersPath: f.paths.triggersPath })(queued("gh-1", carried).data);
    assert.deepEqual(answer, field === null ? { ok: true } : { skewed: true, field });
  });
}

test("a schedule's jobs carry no index the check can compare, so nothing reads them and no sentence speaks of refusing them", async () => {
  let reads = 0;
  const f = fixture({ deps: { readSkew: async () => { reads += 1; return { rows: [], incomplete: true }; } } });
  const out = await f.service.preview(ask(f, { maxCostUsd: "2" }, 0), operator);
  assert.equal(reads, 0);
  assert.deepEqual(out.plan.skew, { rows: [], incomplete: false });
  assert.ok(out.summary.includes("A job already in line keeps what it was queued with and runs without this change. A running job is not touched."), out.summary.join("\n"));
  assert.ok(!out.summary.some((line) => /trigger-skew|named below/.test(line)), out.summary.join("\n"));
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  const answer = await makeCheckWaitSkew({ triggersPath: f.paths.triggersPath })({ kind: "local", flow: "tidy", trigger: { id: "daily" } });
  assert.deepEqual(answer, { ok: true }, "the worker's own check, on the file with its new cap");
});

test("the sentence about jobs refused stops at their names: a /command's job is not re-run from a page", async () => {
  const { f } = skewFixture([queued("gh-1")]);
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.ok(!out.summary.join(" ").includes("Re-run"), out.summary.join("\n"));
});

test("a job waiting on conditions it lost reads as wait-skew, and many jobs are counted and named up to a bound", async () => {
  const f = fixture({ deps: { readSkew: async () => ({ rows: [{ jobId: "w", queue: "q", conditions: 2 }], incomplete: false }) } });
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  assert.ok(out.summary.includes("With this change, a host reading this file refuses 1 of this trigger's jobs in line, before it spends: w as wait-skew (its wait conditions)."));
  const rows = Array.from({ length: 7 }, (_, i) => ({ jobId: `gh-${i}`, queue: "q", field: "mcp" }));
  const many = fixture({ deps: { readSkew: async () => ({ rows, incomplete: false }) } });
  const said = await many.service.preview(ask(many, { packages: false }), operator);
  assert.ok(said.summary.includes("With this change, a host reading this file refuses 7 of this trigger's jobs in line, before they spend: gh-0 as trigger-skew (run.mcp), gh-1 as trigger-skew (run.mcp), gh-2 as trigger-skew (run.mcp), gh-3 as trigger-skew (run.mcp), gh-4 as trigger-skew (run.mcp) and 2 more."), said.summary.join("\n"));
});

test("a queue it could not read whole says so and refuses nothing: a free refusal at pickup is no reason to stop a person", async () => {
  const cut = "The jobs in line could not all be read, so any of them may also be refused as trigger-skew.";
  for (const readSkew of [async () => ({ rows: [], incomplete: true }), async () => { throw new Error("down"); }, async () => null, () => new Promise(() => {})]) {
    const f = fixture({ deps: { readSkew, jobsReadMs: 5 } });
    const out = await f.service.preview(ask(f, { packages: false }), operator);
    assert.ok(out.plan, JSON.stringify(out));
    assert.equal(out.plan.skew.incomplete, true);
    assert.ok(out.summary.includes(cut), out.summary.join("\n"));
  }
  const both = fixture({ deps: { readSkew: async () => ({ rows: [{ jobId: "gh-1", queue: "q", field: "mcp" }], incomplete: true }) } });
  const out = await both.service.preview(ask(both, { packages: false }), operator);
  assert.ok(out.summary.includes(cut));
  assert.ok(out.summary.some((line) => line.includes("gh-1 as trigger-skew")));
});

test("the fleet reader judges the file it is handed, and its own by default", async () => {
  const f = fixture({ run: { mcp: ["docs"] } });
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir: tempDir("pd-800-logs-"), triggersPath: f.paths.triggersPath }, { makeQueueFn: () => ({ close: async () => {} }) });
  // An empty line asks for no job: what differs is which file the read could open.
  const noFile = { readFileSync: () => { throw new Error("no such file"); } };
  assert.deepEqual(await reader.triggerSkew(1, { rows: [] }), { rows: [], queued: [], incomplete: false });
  assert.deepEqual(await reader.triggerSkew(1, { rows: [] }, { fs: noFile }), { rows: [], incomplete: true });
  await reader.dispose?.();
});

test("the worker's check reads through the dry run: it sees the proposed bytes, by stat and by read", async () => {
  // The seam `readTriggerSkew` depends on, against the real dry run rather than a stub of one.
  const f = fixture();
  let dry = null;
  const svc = createTriggerEnvironmentActions({ paths: f.paths, env: HOST_ENV, now: () => NOW, readSkew: async (_i, fs) => { dry = fs; return { rows: [], incomplete: false }; } });
  await svc.preview(ask(f, { mcp: ["linear"] }), operator);
  const check = makeCheckWaitSkew({ triggersPath: f.paths.triggersPath, fs: dry });
  assert.deepEqual(await check({ kind: "github", flow: "fix", trigger: { matched: { index: 1, type: "comment" } } }), { skewed: true, field: "mcp" });
});

// ---- each host's release ----------------------------------------------------------------------------------------------

const tables = { triggers: { supported: 2, runTable: { packages: 2 } }, jobData: { table: {} } };
const jobTables = { triggers: {}, jobData: { table: { mcp: 2 } } };

test("while the need is 1 nothing reads a host, and a registry that cannot answer refuses nothing", async () => {
  let reads = 0;
  const f = fixture({ deps: { readHosts: async () => { reads++; throw new Error("down"); } } });
  const out = await f.service.preview(ask(f, { packages: false, mcp: ["docs"], excludeTools: ["bash"], flow: "review", maxCostUsd: "1", provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU], fallbackModels: [HAIKU] }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.need, { triggersVersion: 1, jobDataVersion: 1 }, "every field the card writes is version 1 at this release");
  assert.equal(reads, 0);
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  assert.equal(reads, 0);
  assert.equal(JSON.parse(f.read()).version, undefined);
  assert.ok(!out.summary.some((line) => /Stamps the file|reads what this change needs|each read what/.test(line)));
});

const host = (name, triggersVersion, jobDataVersion = 1) => ({ name, ...(triggersVersion === undefined ? {} : { triggersVersion }), ...(jobDataVersion === undefined ? {} : { jobDataVersion }) });

test("a proposed file needing version 2 refuses a host on a lower version, naming it and what it would do", async () => {
  const f = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("mini1", "2"), host("mini2", "1")] }) } });
  const before = f.read();
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  assert.equal(out.refusal, "This change needs the triggers file at version 2. mini2 reads less, and would hold every job this file touches. Upgrade that host first.");
  assert.equal(out.status, 409);
  assert.equal(f.read(), before);
});

test("a host that publishes no version refuses too: it would drop the key and run the job wider", async () => {
  for (const missing of [undefined, null, ""]) {
    const f = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("mini1", "2"), { name: "old1", jobDataVersion: "2", triggersVersion: missing }, { name: "old2" }] }) } });
    const out = await f.service.preview(ask(f, { packages: false }), operator);
    assert.equal(out.refusal, "This change needs the triggers file at version 2. old1 and old2 publish no version, and would drop what they do not know, which can run a job wider on a clean record. Upgrade those hosts first.", String(missing));
  }
  const both = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("a", "1"), { name: "b" }] }) } });
  assert.equal((await both.service.preview(ask(both, { packages: false }), operator)).refusal, "This change needs the triggers file at version 2. a reads less, and would hold every job this file touches; b publishes no version, and would drop what it does not know, which can run a job wider on a clean record. Upgrade those hosts first.");
  const junk = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("a", "banana")] }) } });
  assert.match((await junk.service.preview(ask(junk, { packages: false }), operator)).refusal, /a reads less/);
});

test("an unreadable registry refuses, since unknown is not every host", async () => {
  for (const readHosts of [async () => ({ unreachable: "timed out" }), async () => { throw new Error("down"); }, async () => null, async () => ({})]) {
    const f = fixture({ deps: { versionTables: tables, readHosts } });
    const out = await f.service.preview(ask(f, { packages: false }), operator);
    assert.equal(out.refusal, "The live hosts could not be read, so nothing says each reads what this change needs. Nothing was written; try again.");
    assert.equal(out.status, 503);
  }
  const unwired = fixture({ deps: { versionTables: tables } });
  assert.equal((await unwired.service.preview(ask(unwired, { packages: false }), operator)).status, 503, "wired to nothing fails closed");
});

test("every host at or above the need passes, with the stamp said out loud and written", async () => {
  const f = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("mini1", "2"), host("mini2", 3), host("build3", "2")] }) } });
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.need, { triggersVersion: 2, jobDataVersion: 1 });
  assert.ok(out.summary.includes("Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's."));
  assert.ok(out.summary.includes("build3, mini1 and mini2 each read what this change needs."));
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  assert.equal(JSON.parse(f.read()).version, 2);
});

test("a file already at the version is not stamped again, and still needs each host to read it", async () => {
  const f = fixture({ doc: { version: 2, triggers: [cron, comment({ packages: false })] }, deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("one", "2")] }) } });
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.ok(!out.summary.some((line) => line.startsWith("Stamps the file")));
  assert.ok(out.summary.includes("one reads what this change needs."));
  const older = fixture({ doc: { version: 2, triggers: [cron, comment({ packages: false })] }, deps: { versionTables: tables, readHosts: async () => ({ hosts: [host("one", "1")] }) } });
  assert.match((await older.service.preview(ask(older, { mcp: ["docs"] }), operator)).refusal, /one reads less/);
});

test("no live host passes and says none could be checked", async () => {
  const f = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts: [{ noName: true }] }) } });
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  assert.ok(out.plan);
  assert.ok(out.summary.includes("No host is live right now, so no host's release could be checked."));
});

test("the job data's own need is judged by its own field, beside or without the file's", async () => {
  const f = fixture({ deps: { versionTables: jobTables, readHosts: async () => ({ hosts: [host("a", "1", "1")] }) } });
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.equal(out.refusal, "This change needs the job data at version 2. a reads less, and would hold every job this file touches. Upgrade that host first.");
  const fine = fixture({ deps: { versionTables: jobTables, readHosts: async () => ({ hosts: [host("a", "1", "2")] }) } });
  assert.ok((await fine.service.preview(ask(fine, { mcp: ["docs"] }), operator)).plan);
  const two = fixture({ deps: { versionTables: { triggers: { supported: 2, runTable: { mcp: 2 } }, jobData: { table: { mcp: 2 } } }, readHosts: async () => ({ hosts: [host("a", "1", "1")] }) } });
  assert.match((await two.service.preview(ask(two, { mcp: ["docs"] }), operator)).refusal, /^This change needs the triggers file at version 2 and the job data at version 2\./);
});

test("a run key the loader drops reaches no job, so it needs no version, as doctor counts it", async () => {
  // `packageCanary` is a real row of the job data's own table, and a trigger cannot set it: the loader keeps no such key.
  let reads = 0;
  const f = fixture({ run: { packageCanary: { name: "x", version: "1.0.0" } }, deps: { readHosts: async () => { reads++; return { hosts: [] }; } } });
  const out = await f.service.preview(ask(f, { flow: "review" }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
  assert.equal(reads, 0);
});

test("the Confirm asks the hosts again: one that left the fleet's release after the preview stops the write", async () => {
  let hosts = [host("a", "2")];
  const f = fixture({ deps: { versionTables: tables, readHosts: async () => ({ hosts }) } });
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  assert.ok(out.plan);
  hosts = [host("a", "2"), host("b", "1")];
  const before = f.read();
  assert.match((await f.service.apply(out, operator)).invalid, /b reads less/);
  assert.equal(f.read(), before);
});

// ---- authority --------------------------------------------------------------------------------------------------------

test("a person at the operator console alone: refused at the preview and at the apply, before any file is read", async () => {
  const f = fixture();
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  const before = f.read();
  const noRead = { readFileSync() { assert.fail("private read"); }, lstatSync() { assert.fail("private read"); } };
  const service = createTriggerEnvironmentActions({ paths: f.paths, fs: noRead, now: () => NOW });
  for (const ctx of [undefined, {}, { surface: "tool", role: "operator" }, { surface: "console", role: "viewer" }, { surface: "console", role: "agent" }, { surface: "api", role: "operator" }, { surface: "console" }]) {
    assert.deepEqual(await service.preview(ask(f, { packages: false }), ctx), { refusal: "Only a person in the operator console can change what a trigger's jobs get.", status: 403 }, JSON.stringify(ctx));
    assert.deepEqual(await service.apply(out, ctx), { invalid: "Only a person in the operator console can change what a trigger's jobs get." }, JSON.stringify(ctx));
  }
  assert.equal(f.read(), before);
});
