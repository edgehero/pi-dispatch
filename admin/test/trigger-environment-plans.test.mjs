// The person's change to what a trigger's jobs get (issue #800): the real planner against a real triggers file, its bytes read
// back after each write. Nothing here hand-writes a plan or a file the writer did not write, because a shape written by hand
// can hide the defect it stands in for.
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeMcpCheck } from "@edgehero/pi-dispatch/mcp-preflight";
import { makeCheckWaitSkew } from "@edgehero/pi-dispatch/triggers-file";
import { FIRST_CALL_SHORT_TASK_BYTES, builtinModel, firstCallFloorMicros } from "@edgehero/pi-dispatch/model-catalog";
import { parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { createCostGuard } from "../../image/runner/src/usage-meter.mjs";
import { createFleetReader, readTriggerSkew } from "../src/read-model.mjs";
import { CARD_FIELDS, readTriggerEntryDigest, triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { doneBannerHtml } from "../src/console/confirm-view.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const operator = { surface: "console", role: "operator", name: "ops" };
const HAIKU = "anthropic/claude-haiku-4-5"; // a short task's first call: $0.343574 at the pin
const SONNET = "anthropic/claude-sonnet-5-5"; // $1.327148
const OPUS = "anthropic/claude-opus-5-5"; // $2.654295, and its floor $2.62144

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
    [{ index: 1, pageDigest: digest }, /Send at least one field/],
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
  assert.equal(readTriggerEntryDigest({ triggersPath: f.paths.triggersPath, index: 1 }), seen, "the reader a page draws it with");
  assert.equal(readTriggerEntryDigest({ triggersPath: f.paths.triggersPath, index: 9 }), null);
  assert.equal(readTriggerEntryDigest({ triggersPath: join(f.dir, "absent.json"), index: 1 }), null);

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

test("a file not in the writer's own shape comes out in it, as every writer of this file leaves it, and its values stay", async () => {
  const f = fixture();
  const compact = JSON.stringify({ triggers: [comment({ steer: true })] });
  nodeFs.writeFileSync(f.paths.triggersPath, compact);
  const out = await f.service.preview({ index: 0, pageDigest: triggerEntryDigest(JSON.parse(compact).triggers[0]), packages: false }, operator);
  assert.equal(out.beforeText, compact);
  assert.deepEqual(await f.service.apply(out, operator), { ok: true });
  assert.equal(f.read(), text({ triggers: [comment({ steer: true, packages: false })] }));
  const again = await f.service.preview({ index: 0, pageDigest: f.digest(0), packages: false }, operator);
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
  assert.equal(out.refusal, "anthropic/claude-opus-5-5 needs at least $2.654295 for a short task's first call, above this trigger's $2.00 job cap, so the runner would refuse every call to it before it is sent. Choose another model, or a job cap of at least $2.654295; a longer task needs more.");
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
    assert.equal(admits(cap, model, 4465), true);
    assert.equal(admits(cap - 1, model, FIRST_CALL_SHORT_TASK_BYTES), false, "and it is the least that does");
    const clean = await f.service.preview(ask(f, { provider, model: id, maxCostUsd: printed }), operator);
    assert.ok(clean.plan, JSON.stringify(clean));
    assert.ok(!clean.summary.some((line) => line.includes("only for the smallest first call")), clean.summary.join("\n"));
    // Why the floor is no answer: it admits a request smaller than any job sends, and neither of the two a job does.
    const floor = firstCallFloorMicros(model);
    assert.equal(admits(floor, model, 4096), true);
    assert.equal(admits(floor, model, 4465), false, "a job's smallest first call");
    assert.equal(admits(floor, model, FIRST_CALL_SHORT_TASK_BYTES), false, "a short task's");
  });
}

test("a cap that clears the floor and not a short task previews, with a warning that most jobs would be refused before they spend", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5" } });
  const out = await f.service.preview(ask(f, { maxCostUsd: "2.62144" }), operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.ok(out.summary.includes("anthropic/claude-opus-5-5 clears this $2.62144 job cap only for the smallest first call: a short task's needs $2.654295, so most jobs that call it would be refused before they spend. Choose another model, or a job cap of at least $2.654295; a longer task needs more."), out.summary.join("\n"));
  assert.deepEqual(await f.service.apply(out, operator), { ok: true }, "a warning, not a refusal: the person has read it");
  // Under a deployment's cap no value here clears it, and the warning says so instead of offering one.
  const held = fixture({ run: { provider: "anthropic", model: "claude-opus-5-5" }, settings: { maxCostUsd: "2.63" } });
  const said = await held.service.preview(ask(held, { flow: "review", model: "claude-opus-5-5", provider: "anthropic" }), operator);
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

test("a listed model and a fallback above the cap refuse by name; the deployment's own list and a role map's others do not", async () => {
  const listed = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, settings: { maxCostUsd: "2" } });
  assert.match((await refusal(listed, { models: [HAIKU, OPUS] })).refusal, /^anthropic\/claude-opus-5-5 needs at least/);
  const fallback = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, OPUS] }, settings: { maxCostUsd: "5" } });
  assert.match((await refusal(fallback, { fallbackModels: [OPUS], maxCostUsd: "2" })).refusal, /^anthropic\/claude-opus-5-5 needs at least/);
  // A fallback this trigger names off the deployment's list counts as named, though no list of its own holds it.
  const envFallback = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${OPUS}` } });
  assert.match((await refusal(envFallback, { fallbackModels: [OPUS], maxCostUsd: "2" })).refusal, /^anthropic\/claude-opus-5-5 needs at least/);
  // The deployment allows a dear model this trigger never named: lowering this trigger's cap is no fault of that model's.
  const envList = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${OPUS}` } });
  assert.ok((await envList.service.preview(ask(envList, { maxCostUsd: "1" }), operator)).plan);
  const roles = fixture({ doc: { modelRoles: { default: { architect: OPUS } }, triggers: [cron, comment({ provider: "anthropic", model: "claude-haiku-4-5" })] } });
  assert.ok((await roles.service.preview(ask(roles, { maxCostUsd: "1" }), operator)).plan);
});

test("a role resolves first: the bound and the catalog judge the model it names", async () => {
  const doc = { modelRoles: { default: { editor: OPUS, cheap: HAIKU } }, triggers: [cron, comment({ model: "role:cheap" })] };
  const f = fixture({ doc });
  assert.ok((await f.service.preview(ask(f, { maxCostUsd: "1" }), operator)).plan);
  assert.match((await refusal(f, { model: "role:editor", maxCostUsd: "1" })).refusal, /^anthropic\/claude-opus-5-5 needs at least/);
  assert.match((await refusal(f, { model: "role:nobody" })).refusal, /could not be resolved \(model-role-unknown\): every job would be refused before it spends/);
});

test("a model the deployment does not know, one off the list and a fallback off it each refuse for free, with the reason a job would get", async () => {
  const f = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } });
  assert.match((await refusal(f, { model: "claude-typo" })).refusal, /^anthropic\/claude-typo is a model this deployment does not know \(not-in-catalog\), so every job would be refused as model-unknown/);
  assert.match((await refusal(f, { models: [HAIKU, "anthropic/claude-typo"] })).refusal, /claude-typo is a model this deployment does not know/);

  const envList = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: SONNET } });
  assert.match((await refusal(envList, { model: "claude-haiku-4-5", maxCostUsd: "5" })).refusal, /^anthropic\/claude-haiku-4-5 is not on the models this trigger's jobs may call, so every job would be refused as model-not-allowed/);

  const noList = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" } });
  assert.match((await refusal(noList, { fallbackModels: [SONNET] })).refusal, /^Every fallback must be on the allowed list .* and anthropic\/claude-sonnet-5-5 is not, so every job would be refused as model-failover-no-candidate/);
  const offEnv = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: HAIKU } });
  assert.match((await refusal(offEnv, { fallbackModels: [SONNET] })).refusal, /anthropic\/claude-sonnet-5-5 is not/);
  const onEnv = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5" }, env: { PI_ALLOWED_MODELS: `${HAIKU},${SONNET}` } });
  assert.ok((await onEnv.service.preview(ask(onEnv, { fallbackModels: [SONNET] }), operator)).plan);
  const declared = fixture({ run: { provider: "anthropic", model: "claude-fable-5" } });
  assert.match((await refusal(declared, { models: ["anthropic/claude-fable-5"] })).refusal, /claude-fable-5 declares fallback models the allowed list does not name, so every job would be refused as model-not-allowed/);
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

  const down = fixture({ deps: { checkModelsKnown: () => ({ unavailable: "EIO" }) } });
  assert.match((await refusal(down, { maxCostUsd: "1" })).refusal, /models\.json could not be read just now/);
  const silent = fixture({ deps: { checkModelsKnown: () => ({}) } });
  assert.match((await refusal(silent, { maxCostUsd: "1" })).refusal, /did not judge this change/);
});

// ---- the worker's own pickup check --------------------------------------------------------------------------------------

const HELD = { secrets: { LINEAR_API_KEY: "op://vault/linear" } };
/** The real check, as the worker's wiring builds it, for a job with this `run`: what the next job of the trigger would meet. */
const pickup = (f, job, { egress = false, forwardEnv = [], hostEnv = {} } = {}) => makeMcpCheck({ globalPiDir: f.paths.globalPiDir, forwardEnv, hostEnv, egress })({ kind: "github", provider: "anthropic", ...job });

test("a server whose key the trigger does not pass refuses at the preview, in the worker's own reason, with what to do", async () => {
  const f = fixture({ env: { PI_FORWARD_ENV: "" } });
  const before = f.read();
  assert.equal(pickup(f, { mcp: ["linear"] }).refused, "mcp-secret-unmapped", "what the real check says of the next job");
  const out = await refusal(f, { mcp: ["linear"] });
  assert.equal(out.refusal, "On this host every job of this trigger would be refused as mcp-secret-unmapped, before it spends. linear: it references LINEAR_API_KEY, which the trigger does not pass (run.secrets, or a PI_FORWARD_ENV name the worker holds a value for). Pass the credential the server needs in the trigger's `run.secrets`. `run.secrets` is set in the triggers file, not on this page, and a value only the worker's own service environment holds cannot be seen from here.");
  assert.equal(out.status, 400);
  assert.equal(f.read(), before);
});

test("what passes the real check passes the preview: a key the trigger passes, or one forwarded with a value on this host", async () => {
  const held = fixture({ run: HELD, env: { PI_FORWARD_ENV: "" } });
  assert.ok((await held.service.preview(ask(held, { mcp: ["linear"] }), operator)).plan);
  const forwarded = fixture({ env: { PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "a value" } });
  assert.ok((await forwarded.service.preview(ask(forwarded, { mcp: ["linear"] }), operator)).plan);
  // Named in PI_FORWARD_ENV with no value here: the worker's rule, since `buildContainerEnv` forwards only what it holds.
  const empty = fixture({ env: { PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "" } });
  assert.match((await refusal(empty, { mcp: ["linear"] })).refusal, /refused as mcp-secret-unmapped/);
});

test("removing every way to a server refuses at the preview as the check refuses it, whichever of the two the edit sent", async () => {
  const excluded = ["mcp__linear__*", "read_mcp_resource"];
  const f = fixture({ run: { ...HELD, mcp: ["linear"] } });
  assert.equal(pickup(f, { ...HELD, mcp: ["linear"], excludeTools: excluded }).refused, "mcp-excluded");
  const out = await refusal(f, { excludeTools: excluded });
  assert.equal(out.refusal, "On this host every job of this trigger would be refused as mcp-excluded, before it spends. linear: run.excludeTools removes every tool that reaches it (its own, the discovery tools that reach them, and read_mcp_resource). Remove the server from `run.mcp`, or keep a tool that reaches it out of `run.excludeTools`.");
  assert.ok((await f.service.preview(ask(f, { excludeTools: ["mcp__linear__*"] }), operator)).plan, "one way left in is a way in, as the check says");
  // The server added to a trigger whose exclusions already leave it no way in, sent with the list it needs.
  const g = fixture({ run: HELD });
  assert.match((await refusal(g, { mcp: ["linear"], excludeTools: excluded })).refusal, /refused as mcp-excluded/);
});

test("each of the check's other refusals is said, by the reason it would refuse with", async () => {
  const f = fixture({ env: {} });
  assert.match((await refusal(f, { mcp: ["nobody"] })).refusal, /^On this host every job of this trigger would be refused as mcp-server-unknown, before it spends\. nobody: the overlay's mcp\.json does not offer it\. Declare the server in the overlay `mcp\.json`, or fix the name in `run\.mcp`\.$/);
  const off = fixture({ mcpJson: { mcpServers: { docs: { url: "https://docs.example.com/mcp", description: "Docs", enabled: false } } } });
  assert.match((await refusal(off, { mcp: ["docs"] })).refusal, /refused as mcp-server-unknown.*docs: the overlay's mcp\.json turns it off/);
  const none = fixture({ mcpJson: null });
  assert.match((await refusal(none, { mcp: ["docs"] })).refusal, /refused as mcp-config-invalid.*The list: the overlay holds no mcp\.json/);
  const broken = fixture({ mcpJson: "{ not json" });
  assert.match((await refusal(broken, { mcp: ["docs"] })).refusal, /refused as mcp-config-invalid.*cannot be read whole/);
  assert.ok((await none.service.preview(ask(none, { mcp: ["forge"] }), operator)).plan, "the forge's own server needs no overlay file");
  const reserved = fixture({ mcpJson: { mcpServers: { k: { url: "https://k.example.com/mcp", description: "K", headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}" } } } }, run: { secrets: { ANTHROPIC_API_KEY: "op://v/r" } } });
  assert.match((await refusal(reserved, { mcp: ["k"] })).refusal, /refused as mcp-secret-reserved.*k: it references ANTHROPIC_API_KEY, which this deployment uses for the job's own credentials\. Give the server's credential a variable of its own\./);
});

test("the egress rules are this host's: its PI_EGRESS, its allowlist file and its declared endpoints", async () => {
  const armed = { env: { PI_EGRESS: "" } };
  const f = fixture(armed);
  assert.match((await refusal(f, { mcp: ["docs"] })).refusal, /refused as mcp-egress-unreachable.*docs: /);
  nodeFs.writeFileSync(join(f.dir, "egress-allowlist.conf"), "docs.example.com\n");
  assert.ok((await f.service.preview(ask(f, { mcp: ["docs"] }), operator)).plan, "the host on its allowlist is reachable");
  // A declared endpoint at the server's own host and port is the other way through the proxy.
  const declared = fixture({ ...armed, deps: { readEndpoints: () => [{ id: "docs", host: "docs.example.com", port: 443 }] } });
  assert.ok((await declared.service.preview(ask(declared, { mcp: ["docs"] }), operator)).plan);
  const elsewhere = fixture({ ...armed, deps: { readEndpoints: () => [{ id: "other", host: "other.example.com", port: 443 }] } });
  assert.match((await refusal(elsewhere, { mcp: ["docs"] })).refusal, /refused as mcp-egress-unreachable/);
  const runner = fixture({ env: { PI_EGRESS: "" }, mcpJson: { mcpServers: { r: { command: "npx", args: ["-y", "some-server@1.0.0"], allowPackageRunner: true, description: "R" } } } });
  assert.match((await refusal(runner, { mcp: ["r"] })).refusal, /refused as mcp-package-runner.*r: it fetches its server from /);
});

test("a host's .env it cannot read as the worker does, or a bad value in it, says the check could not run and writes nothing", async () => {
  const sentence = "This host's .env could not be read as the worker reads it, so the worker's pickup check could not be run. Nothing was written.";
  for (const deps of [{ readHostEnv: () => { throw new Error("untrusted"); } }]) {
    const f = fixture({ deps });
    assert.deepEqual(await f.service.preview(ask(f, { mcp: ["docs"] }), operator), { refusal: sentence, status: 409 });
  }
  const badEgress = fixture({ env: { PI_EGRESS: "banana" } });
  assert.equal((await badEgress.service.preview(ask(badEgress, { mcp: ["docs"] }), operator)).refusal, sentence);
  const badForward = fixture({ env: { PI_FORWARD_ENV: "GITHUB_TOKEN" } });
  assert.equal((await badForward.service.preview(ask(badForward, { mcp: ["docs"] }), operator)).refusal, sentence);
  const throwing = fixture({ env: { PI_EGRESS: "" }, deps: { readEndpoints: () => { throw new Error("no"); } } });
  assert.equal((await throwing.service.preview(ask(throwing, { mcp: ["docs"] }), operator)).refusal, sentence);
});

test("a read that may pass on a second try says try again, and asks for no refusal the worker would not make", async () => {
  const f = fixture();
  const flaky = { ...nodeFs, readFileSync: (path, ...rest) => { if (String(path).endsWith("mcp.json")) throw Object.assign(new Error("busy"), { code: "EIO" }); return nodeFs.readFileSync(path, ...rest); } };
  const service = createTriggerEnvironmentActions({ paths: f.paths, env: HOST_ENV, fs: flaky, now: () => NOW });
  assert.deepEqual(await service.preview(ask(f, { mcp: ["docs"] }), operator), { refusal: "An overlay file the worker's pickup check reads could not be read just now, so this change could not be judged; try again.", status: 409 });
});

test("the check runs only for a change that reaches it, with the job's real provider, and a Confirm asks it again", async () => {
  const run = { provider: "anthropic", model: "claude-haiku-4-5", mcp: ["linear"] };
  const noKey = { env: { PI_FORWARD_ENV: "" } };
  // The file already says something the check refuses. An edit of something it does not read is no reason to refuse a person.
  for (const change of [{ flow: "review" }, { packages: false }, { maxCostUsd: "1" }, { fallbackModels: null }]) {
    const f = fixture({ run, ...noKey });
    const out = await f.service.preview(ask(f, change), operator);
    assert.ok(out.plan ?? out.unchanged, JSON.stringify([change, out]));
  }
  for (const change of [{ excludeTools: ["bash"] }, { model: "claude-sonnet-5-5" }, { provider: "anthropic", model: "claude-sonnet-5-5" }, { models: [HAIKU] }]) {
    const f = fixture({ run, ...noKey });
    assert.match((await refusal(f, change)).refusal, /refused as mcp-secret-unmapped/, JSON.stringify(change));
  }
  // A model edit moves which keys the job keeps for itself: a key the job now needs can no longer be handed to a server.
  const mcpJson = { mcpServers: { k: { url: "https://k.example.com/mcp", description: "K", headers: { Authorization: "Bearer ${OPENAI_API_KEY}" } } } };
  const moved = fixture({ mcpJson, run: { provider: "anthropic", model: "claude-haiku-4-5", mcp: ["k"], secrets: { OPENAI_API_KEY: "op://v/r" } } });
  assert.match((await refusal(moved, { provider: "openai", model: "gpt-4o" })).refusal, /refused as mcp-secret-reserved/);
  const byProvider = fixture({ mcpJson, run: { model: "gpt-4o", mcp: ["k"], secrets: { OPENAI_API_KEY: "op://v/r" } } });
  assert.match((await refusal(byProvider, { provider: "openai" })).refusal, /refused as mcp-secret-reserved/, "the provider alone moves it");
  // The job as the worker resolves it: a role's model reaches its provider's key, though the file names neither.
  const roles = fixture({ mcpJson, doc: { modelRoles: { default: { oai: "openai/gpt-4o" } }, triggers: [cron, comment({ model: "role:oai", secrets: { OPENAI_API_KEY: "op://v/r" } })] }, env: { PI_ALLOWED_MODELS: HAIKU } });
  assert.match((await refusal(roles, { mcp: ["k"] })).refusal, /refused as mcp-secret-reserved/);
  // Settings it cannot read leave the check nothing to judge a job by: said, and not a crash.
  const unsettled = fixture();
  nodeFs.writeFileSync(unsettled.paths.settingsFile, "{ not json");
  assert.match((await refusal(unsettled, { mcp: ["docs"] })).refusal, /settings file is invalid/);
  // Removing the servers leaves nothing to check.
  const gone = fixture({ run, ...noKey });
  assert.ok((await gone.service.preview(ask(gone, { mcp: null }), operator)).plan);
  // The overlay moved between the two: the Confirm meets what the next job would.
  const later = fixture({ run: HELD });
  const planned = await later.service.preview(ask(later, { mcp: ["linear"] }), operator);
  assert.ok(planned.plan);
  nodeFs.writeFileSync(join(later.paths.globalPiDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const before = later.read();
  assert.match((await later.service.apply(planned, operator)).invalid, /refused as mcp-server-unknown/);
  assert.equal(later.read(), before);
});

test("what the page would refuse today has no Undo button: removing a server the check refuses says by hand why", async () => {
  const f = fixture({ run: { mcp: ["linear"] }, env: { PI_FORWARD_ENV: "" } });
  const out = await write(f, { mcp: null });
  assert.equal(out.plan.inverse, null);
  assert.match(out.plan.undo, /^Edit trigger row 2 back by hand: this page would refuse what it said before\. On this host every job of this trigger would be refused as mcp-secret-unmapped/);
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
  ["a list removed", { models: [HAIKU] }, { models: null }, ["Allowed models: the list removed, so any model is allowed.", "This widens which models its jobs may call: any model."]],
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
  ["packages true where the default said so", { resume: true }, { packages: true }, ["Staged packages: stay on; only what the file says changes."]],
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
  // Removing a list where the deployment has one: it applies, and it is said which.
  const back = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU, SONNET] }, env: { PI_ALLOWED_MODELS: HAIKU } });
  assert.deepEqual((await back.service.preview(ask(back, { models: null }), operator)).plan.changes[0], { key: "models", line: "Allowed models: the list removed, so PI_ALLOWED_MODELS applies." });
  const wide = fixture({ run: { provider: "anthropic", model: "claude-haiku-4-5", models: [HAIKU] }, env: { PI_ALLOWED_MODELS: `${HAIKU},${SONNET}` } });
  assert.equal((await wide.service.preview(ask(wide, { models: null }), operator)).plan.changes[0].widening, `This widens which models its jobs may call: ${SONNET}.`);
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
  assert.deepEqual(out.plan.changes[0], { key: "mcp", line: "MCP: linear on.", widening: "This widens what its jobs reach: those that start after this connect to mcp.example.com, with LINEAR_API_KEY by name." });
  assert.ok(out.summary.includes("A job on a host without linear, or with it off, is refused as mcp-server-unknown, before it spends; a host with no overlay or no mcp.json refuses it as mcp-config-invalid. mini1 and build3 have it; bare does not; mini2, cut and unread have not said."), out.summary.join("\n"));
});

test("a server off on a host reads as lacking, and a server hosts disagree about names no host", async () => {
  const f = fixture({ deps: { readHostLoads: async () => LOADS } });
  const out = await f.service.preview(ask(f, { mcp: ["docs"] }), operator);
  assert.match(out.summary.find((line) => line.startsWith("A job on a host")), /mini1, build3 and bare do not; mini2, cut and unread have not said\.$/);
  // No host has docs on, so where it connects is known to none.
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs reach: those that start after this connect to docs.");

  const differ = fixture({ deps: { readHostLoads: async () => ({ hosts: [{ name: "a", state: "current", mcp: [{ name: "x", enabled: true, where: "one.example", keys: [] }], unread: [], more: {} }, { name: "b", state: "current", mcp: [{ name: "x", enabled: true, where: "two.example", keys: [] }], unread: [], more: {} }] }) } });
  const two = await differ.service.preview(ask(differ, { mcp: ["x"] }), operator);
  assert.equal(two.plan.changes[0].widening, "This widens what its jobs reach: those that start after this connect to x.");
  const bare = fixture({ deps: { readHostLoads: async () => ({ hosts: [{ name: "a", state: "current", mcp: [{ name: "x", enabled: true, where: "one.example", keys: [] }], unread: [], more: {} }] }) } });
  assert.equal((await bare.service.preview(ask(bare, { mcp: ["x"] }), operator)).plan.changes[0].widening, "This widens what its jobs reach: those that start after this connect to one.example.");
  const noWhere = fixture({ deps: { readHostLoads: async () => ({ hosts: [{ name: "a", state: "current", mcp: [{ name: "x", enabled: true, where: null, keys: [] }], unread: [], more: {} }] }) } });
  assert.equal((await noWhere.service.preview(ask(noWhere, { mcp: ["x"] }), operator)).plan.changes[0].widening, "This widens what its jobs reach: those that start after this connect to x.");
});

test("no host's publication, or one that cannot be read, says so and is never read as lacking the server", async () => {
  for (const readHostLoads of [async () => ({ hosts: [] }), async () => ({ unreachable: true }), async () => { throw new Error("down"); }, async () => null]) {
    const f = fixture({ deps: { readHostLoads } });
    const out = await f.service.preview(ask(f, { mcp: ["linear"] }), operator);
    assert.ok(out.summary.some((line) => line.endsWith("No host has published which servers it has.")), out.summary.join("\n"));
    assert.equal(out.plan.changes[0].widening, "This widens what its jobs reach: those that start after this connect to linear.");
  }
});

test("the forge server is no host's to lack, and a server taken away reads no host at all", async () => {
  let reads = 0;
  const f = fixture({ deps: { readHostLoads: async () => { reads++; return LOADS; } } });
  const forge = await f.service.preview(ask(f, { mcp: ["forge"] }), operator);
  assert.equal(forge.plan.changes[0].widening, "This widens what its jobs reach: those that start after this connect to the job's own forge server.");
  assert.ok(!forge.summary.some((line) => line.startsWith("A job on a host")));
  assert.equal(reads, 0);
  const both = await f.service.preview(ask(f, { mcp: ["linear", "forge"] }), operator);
  assert.match(both.plan.changes[0].widening, /connect to mcp\.example\.com, with LINEAR_API_KEY by name and connect to the job's own forge server\.$/);
  assert.equal(reads, 1);
  const off = fixture({ run: { mcp: ["linear"] }, deps: { readHostLoads: async () => { reads++; return LOADS; } } });
  assert.equal((await off.service.preview(ask(off, { mcp: null }), operator)).plan.changes[0].widening, undefined);
  assert.equal(reads, 1);
});

test("the audit line and the file it writes are said, by the person who is asking", async () => {
  const f = fixture();
  const out = await f.service.preview(ask(f, { packages: false }), { ...operator, name: "alice" });
  assert.equal(out.summary.at(-1), "Written to triggers.json and audited as trigger-edit, by alice at the console.");
  assert.equal(out.target, f.paths.triggersPath);
  assert.match(out.beforeDigest, /^[a-f0-9]{64}$/);
  assert.match(out.afterDigest, /^[a-f0-9]{64}$/);
  const unnamed = await f.service.preview(ask(f, { packages: false }), { surface: "console", role: "operator" });
  assert.equal(unnamed.summary.at(-1), "Written to triggers.json and audited as trigger-edit, by the operator at the console.");
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
  assert.ok(out.summary.includes("With this change, 1 of this trigger's jobs in line is refused before it spends: gh-c9e1 as trigger-skew (run.mcp). Re-run it from its page."), out.summary.join("\n"));
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
  assert.ok(!out.summary.some((line) => line.includes("refused before")));

  // An edit of the flow: the entry no longer names the job's flow, so its identity fails and "unknown" runs (`makeCheckWaitSkew`).
  const flow = skewFixture([queued("a")], { run: { mcp: ["docs"] } });
  const moved = await flow.f.service.preview(ask(flow.f, { flow: "review" }), operator);
  assert.deepEqual(moved.plan.skew.rows, []);
});

test("every narrowing field the card writes is named by the worker's own table when a queued job lacks it", async () => {
  for (const [change, field] of [[{ models: [HAIKU] }, "models"], [{ models: [HAIKU, SONNET], fallbackModels: [SONNET] }, "models"], [{ maxCostUsd: "2" }, "maxCostUsd"], [{ mcp: ["docs"] }, "mcp"]]) {
    const { f } = skewFixture([queued("gh-1")], { run: { provider: "anthropic", model: "claude-haiku-4-5" } });
    const out = await f.service.preview(ask(f, change), operator);
    assert.deepEqual(out.plan.skew.rows, [{ jobId: "gh-1", queue: "pi-jobs", field }], JSON.stringify(change));
    assert.ok(out.summary.some((line) => line.includes(`gh-1 as trigger-skew (run.${field})`)), out.summary.join("\n"));
  }
});

test("a job waiting on conditions it lost reads as wait-skew, and many jobs are counted and named up to a bound", async () => {
  const f = fixture({ deps: { readSkew: async () => ({ rows: [{ jobId: "w", queue: "q", conditions: 2 }], incomplete: false }) } });
  const out = await f.service.preview(ask(f, { packages: false }), operator);
  assert.ok(out.summary.includes("With this change, 1 of this trigger's jobs in line is refused before it spends: w as wait-skew (its wait conditions). Re-run it from its page."));
  const rows = Array.from({ length: 7 }, (_, i) => ({ jobId: `gh-${i}`, queue: "q", field: "mcp" }));
  const many = fixture({ deps: { readSkew: async () => ({ rows, incomplete: false }) } });
  const said = await many.service.preview(ask(many, { packages: false }), operator);
  assert.ok(said.summary.includes("With this change, 7 of this trigger's jobs in line are refused before they spend: gh-0 as trigger-skew (run.mcp), gh-1 as trigger-skew (run.mcp), gh-2 as trigger-skew (run.mcp), gh-3 as trigger-skew (run.mcp), gh-4 as trigger-skew (run.mcp) and 2 more. Re-run each from its page."), said.summary.join("\n"));
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
  assert.ok(out.summary.includes("mini1, mini2 and build3 each read what this change needs."));
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
