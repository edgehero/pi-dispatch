import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { renderScopedLimits, sizeBits } from "../src/render.mjs";

/**
 * Issue #596, phase 1: a project row's job SIZE through the model-callable limit writers. `memory`, `cpus`, `hostShare`
 * and `minJobs` ride `dispatch_limit_add` and `dispatch_limit_edit` behind the same confirm as every other field, judged
 * by the worker's own parsers BEFORE the confirm and shown in the one spelling the file will hold; the file is stamped
 * version 3 only when a row carries one; and the views say a size, with `hostShare` and `minJobs` marked as not
 * enforced yet.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { validateToolArguments } = await import("@earendil-works/pi-ai");

function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
function toolCtx({ answer = true } = {}) {
  const shown = [];
  const ui = { confirm: async (title, message) => { shown.push({ title, message }); return answer; } };
  return { ctx: { hasUI: true, ui }, shown };
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

function deployment(limits) {
  const dir = tempDir("pd-596-size-");
  const projects = join(dir, "projects.json");
  writeFileSync(projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  const path = join(dir, "scoped-limits.json");
  if (limits !== undefined) writeFileSync(path, JSON.stringify(limits));
  process.env.PI_PROJECTS_FILE = projects;
  process.env.PI_SCOPED_LIMITS_FILE = path;
  return path;
}

test("dispatch_limit_add writes a project size in its one spelling, stamps version 3, and asks first", async () => {
  const path = deployment({ version: 1, limits: [] });
  const { ctx, shown } = toolCtx();
  const tool = toolByName("dispatch_limit_add");
  // As pi hands the arguments over: through its own validator.
  const args = validateToolArguments(tool, { name: tool.name, arguments: { scope: "project:shop", memory: "1024m", cpus: "0.50", hostShare: 50, minJobs: 1 } });
  await tool.execute("id", args, undefined, undefined, ctx);
  assert.equal(shown.length, 1);
  assert.match(shown[0].message, /"memory":"1g","cpus":0\.5,"hostShare":50,"minJobs":1/, "the confirm shows exactly what the file will hold");
  assert.deepEqual(read(path), { version: 3, limits: [{ scope: "project:shop", memory: "1g", cpus: 0.5, hostShare: 50, minJobs: 1 }] });
});

test("a malformed or misplaced size is refused before the confirm, by both writers, and nothing is written", async () => {
  const initial = { version: 3, limits: [{ scope: "project:shop", memory: "2g" }, { scope: "acme/api", day: 3 }] };
  for (const [params, why] of [
    [{ scope: "project:shop", memory: "256m" }, /memory: a memory size must be at least 512m/],
    [{ scope: "project:shop", memory: "4GB" }, /memory: a memory size is a whole number/],
    [{ scope: "project:shop", cpus: 0.1 }, /cpus: a CPU size must be at least 0.25/],
    [{ scope: "project:shop", cpus: "1.234" }, /cpus: a CPU size is a number above 0 with at most two decimals/],
    [{ scope: "acme/web", memory: "2g" }, /belong on a project row/],
    [{ scope: "project:shop", minJobs: 2 }, /minJobs needs memory or cpus on the same row/],
  ]) {
    const path = deployment(initial);
    const { ctx, shown } = toolCtx();
    await assert.rejects(() => toolByName("dispatch_limit_add").execute("id", params, undefined, undefined, ctx), why, JSON.stringify(params));
    assert.equal(shown.length, 0, `${JSON.stringify(params)}: never asked to approve a value the write would refuse`);
    assert.deepEqual(read(path), initial);
  }
  const path = deployment(initial);
  const { ctx, shown } = toolCtx();
  await assert.rejects(() => toolByName("dispatch_limit_edit").execute("id", { index: 0, memory: "100m" }, undefined, undefined, ctx), /at least 512m/);
  await assert.rejects(() => toolByName("dispatch_limit_edit").execute("id", { index: 1, cpus: 2 }, undefined, undefined, ctx), /cpus belong on a project row/);
  assert.equal(shown.length, 0);
  assert.deepEqual(read(path), initial);
});

test("dispatch_limit_edit replaces a sent size field, CARRIES the others, and an edit of a count never drops a size", async () => {
  const path = deployment({ version: 3, limits: [{ scope: "project:shop", concurrent: 2, memory: "2g", cpus: 1, hostShare: 40, minJobs: 1 }] });
  const { ctx, shown } = toolCtx();
  await toolByName("dispatch_limit_edit").execute("id", { index: 0, cpus: 0.25 }, undefined, undefined, ctx);
  assert.deepEqual(read(path).limits[0], { scope: "project:shop", concurrent: 2, memory: "2g", cpus: 0.25, hostShare: 40, minJobs: 1 });
  assert.match(shown[0].message, /"cpus":1,.*\n→ .*"cpus":0\.25/s);
  await toolByName("dispatch_limit_edit").execute("id", { index: 0, concurrent: 3 }, undefined, undefined, ctx);
  assert.deepEqual(read(path).limits[0], { scope: "project:shop", concurrent: 3, memory: "2g", cpus: 0.25, hostShare: 40, minJobs: 1 });
  assert.equal(read(path).version, 3);
});

test("the views say a project's size with its hostShare and minJobs, which the host budget enforces (#596 phase 2)", () => {
  assert.deepEqual(sizeBits({ scope: "project:shop", memory: "16g", cpus: 4, hostShare: 50, minJobs: 2 }), ["memory 16g", "4 CPUs", "hostShare 50%", "minJobs 2"]);
  assert.deepEqual(sizeBits({ scope: "project:shop", cpus: 1 }), ["1 CPU"]);
  assert.deepEqual(sizeBits({ scope: "acme/web", day: 3, memory: null, cpus: null, hostShare: null, minJobs: null }), [], "a version 3 row with no size says nothing");
  const text = renderScopedLimits({ limits: { limits: [{ scope: "project:shop", concurrent: 2, memory: "1536m", cpus: 0.5 }] }, scopedBudget: null, projects: { projects: [{ id: "shop", members: ["github:acme/web"] }] } });
  assert.equal(text, "Scoped limits:\n  project:shop: <=2 at once · memory 1536m · 0.5 CPUs · 1 member");
});

test("dispatch_limits lists a sized row with its size in the summary", async () => {
  deployment({ version: 3, limits: [{ scope: "project:shop", memory: "2g", cpus: 0.5, dayUsd: "5" }] });
  process.env.VALKEY_URL = "not-a-url"; // degrade synchronously
  const rows = JSON.parse((await toolByName("dispatch_limits").execute("id", {}, undefined, undefined, {})).content[0].text);
  assert.match(rows[0].summary, /memory 2g · 0\.5 CPUs/);
  assert.equal(rows[0].memory, "2g");
});

test("the panel's edit dialogs carry a row's size, which they do not prompt for, through an edit of its counts", async () => {
  const path = deployment({ version: 3, limits: [{ scope: "project:shop", concurrent: 2, memory: "2g", cpus: 0.5, hostShare: 40, minJobs: 1, dayUsd: "5" }] });
  const answers = { scope: "", day: "", week: "", month: "", concurrent: "3" };
  const ui = {
    select: async (_title, labels) => labels[0],
    input: async (label) => answers[Object.keys(answers).find((k) => label.toLowerCase().startsWith(k === "concurrent" ? "concurrent" : k))] ?? "",
    confirm: async () => true,
  };
  const said = [];
  await indexMod.editScopedLimitViaDialogs({ scopedLimitsPath: path, projectsFile: process.env.PI_PROJECTS_FILE }, ui, (m) => said.push(m));
  assert.deepEqual(read(path).limits[0], { scope: "project:shop", concurrent: 3, dayUsd: "5.00", memory: "2g", cpus: 0.5, hostShare: 40, minJobs: 1 }, said.join("\n"));
  assert.equal(read(path).version, 3);
});

test("the admin's size-field tables are the worker's SIZE_LIMIT_FIELDS, in its order, so no copy can drift (P1G1-C2)", async () => {
  const { SIZE_LIMIT_FIELDS } = await import("@edgehero/pi-dispatch/scoped-limits");
  assert.deepEqual(Object.keys(indexMod.SIZE_FIELD_SCHEMAS), [...SIZE_LIMIT_FIELDS], "both tools' schemas spread this one table");
  assert.deepEqual(Object.keys(indexMod.SIZE_FIELD_RIDES), [...SIZE_LIMIT_FIELDS], "the builder rides each field by this one table");
  for (const name of ["dispatch_limit_add", "dispatch_limit_edit"]) {
    const props = Object.keys(toolByName(name).parameters.properties);
    for (const field of SIZE_LIMIT_FIELDS) assert.ok(props.includes(field), `${name} takes ${field}`);
  }
});
