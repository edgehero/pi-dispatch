import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as realFs from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planProjectsWrite, readProjects, writeProjects, writeScopedLimits } from "../src/read-model.mjs";
import { checkProjectRows, parseScopedLimits } from "@edgehero/pi-dispatch/scoped-limits";
import { escapeInterpreted } from "../src/panel.mjs";
import { escapeControls, parseProjects } from "@edgehero/pi-dispatch/projects";

/**
 * Issue #499 part C: the admin's projects surfaces. The reader and the writer (`readProjects`, `planProjectsWrite`,
 * `writeProjects`), the four tools, the `dispatch_costs` project filter, and how a project's `name` is shown.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
function toolCtx({ hasUI = true, answer = true } = {}) {
  const shown = [];
  const ui = { confirm: async (title, message) => { shown.push({ title, message }); return answer; } };
  return { ctx: { hasUI, ui: hasUI ? ui : {} }, shown };
}
const textOf = (res) => JSON.parse(res.content[0].text);

/** An in-memory fs that records every call, so a test can see HOW a file was written, not only what it holds. */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const ops = [];
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return {
    files,
    ops,
    readFileSync(path) {
      if (!files.has(String(path))) throw enoent(path);
      return files.get(String(path));
    },
    writeFileSync(path, data) {
      ops.push(["write", String(path)]);
      files.set(String(path), data);
    },
    renameSync(from, to) {
      ops.push(["rename", String(from), String(to)]);
      if (!files.has(String(from))) throw enoent(from);
      files.set(String(to), files.get(String(from)));
      files.delete(String(from));
    },
  };
}

const PROJECTS = (projects) => JSON.stringify({ version: 1, projects });
const LIMITS = (limits) => JSON.stringify({ version: 2, limits });

// ── the reader ──────────────────────────────────────────────────────────────────────────────────────────

test("readProjects: the worker's file, `unset` when PI_PROJECTS_FILE is unset, never a cwd guess", () => {
  const fs = memFs({ "p.json": PROJECTS([{ id: "shop", members: ["github:acme/web"] }]), "bad.json": "{nope" });
  assert.deepEqual(readProjects({ projectsPath: null, fs }), { unset: true });
  assert.deepEqual(readProjects({ projectsPath: "p.json", fs }), { projects: [{ id: "shop", name: null, members: ["github:acme/web"] }] });
  assert.deepEqual(readProjects({ projectsPath: "absent.json", fs }), { missing: true });
  assert.match(readProjects({ projectsPath: "bad.json", fs }).invalid, /not valid JSON/);
});

// ── the writer ──────────────────────────────────────────────────────────────────────────────────────────

test("writeProjects writes through the worker's parser, by tmp and rename, never in place", () => {
  const fs = memFs({ "p.json": PROJECTS([]) });
  const res = writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => [...l, { id: "shop", name: "Webshop", members: ["github:acme/web", "/srv/shop//tools/"] }] });
  assert.deepEqual(res, { ok: true });
  assert.equal(fs.ops.length, 2, "one write, one rename");
  const [[w, tmp], [r, from, to]] = fs.ops;
  assert.equal(w, "write");
  assert.match(tmp, new RegExp(`^p\\.json\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`), "a tmp file of its own: pid and random");
  assert.deepEqual([r, from, to], ["rename", tmp, "p.json"], "renamed over the real one");
  assert.ok(![...fs.files.keys()].some((k) => k.endsWith(".tmp")), "no tmp file left behind");
  const written = fs.files.get("p.json");
  assert.deepEqual(parseProjects(written, "p.json"), [{ id: "shop", name: "Webshop", members: ["github:acme/web", "/srv/shop/tools"] }], "the loader reads it back, members in their stored spelling");
  assert.deepEqual(JSON.parse(written), { version: 1, projects: [{ id: "shop", name: "Webshop", members: ["github:acme/web", "/srv/shop/tools"] }] });
});

test("writeProjects refuses what the worker would refuse, and writes nothing", () => {
  for (const [mutate, re] of [
    [(l) => [...l, { id: "Shop", members: ["github:acme/web"] }], /id must match/],
    [(l) => [...l, { id: "shop", members: ["acme/web"] }], /bare repo/],
    [(l) => [...l, { id: "web", members: ["github:acme/web"] }], /claimed by both "shop" and "web"/],
    [(l) => [...l, { id: "shop", members: ["/srv/x"] }], /duplicate id "shop"/],
    [(l) => [...l, { id: "x", members: [] }], /members must be a non-empty array/],
  ]) {
    const fs = memFs({ "p.json": PROJECTS([{ id: "shop", members: ["github:acme/web"] }]) });
    const before = fs.files.get("p.json");
    assert.match(writeProjects({ projectsPath: "p.json", fs, mutate }).invalid, re);
    assert.equal(fs.files.get("p.json"), before);
    assert.deepEqual(fs.ops, []);
  }
  const newer = memFs({ "p.json": JSON.stringify({ version: 9, projects: [] }) });
  assert.match(writeProjects({ projectsPath: "p.json", fs: newer, mutate: (l) => l }).invalid, /newer pi-dispatch/, "a newer file is never re-stamped");
  assert.match(writeProjects({ projectsPath: null, fs: memFs(), mutate: (l) => l }).invalid, /PI_PROJECTS_FILE is unset/);
  const missing = memFs();
  assert.deepEqual(writeProjects({ projectsPath: "p.json", fs: missing, mutate: (l) => [...l, { id: "a", members: ["/srv/a"] }] }), { ok: true }, "a missing file starts from no projects");
});

test("the pair rule: a write that removes a project a scoped-limits row names is refused, naming the row, and writes nothing", () => {
  const fs = memFs({ "p.json": PROJECTS([{ id: "shop", members: ["github:acme/web"] }, { id: "ops", members: ["/srv/ops"] }]), "sl.json": LIMITS([{ scope: "acme/api", day: 3 }, { scope: "project:shop", day: 2 }]) });
  const before = fs.files.get("p.json");
  const del = writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => l.filter((p) => p.id !== "shop") });
  assert.match(del.invalid, /^project:shop \(index 1\) in sl\.json names this project.*delete or change that row first.*Nothing was written$/);
  assert.equal(fs.files.get("p.json"), before);
  // A project no row names deletes; an edit that keeps the id is never judged against the row.
  assert.deepEqual(writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => l.filter((p) => p.id !== "ops") }), { ok: true });
  assert.deepEqual(writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => l.map((p) => ({ ...p, members: ["/srv/new"] })) }), { ok: true });
  // A scoped-limits file that does not load cannot rule a row out: a removal is refused, an unrelated edit is not.
  fs.files.set("sl.json", "{broken");
  assert.match(writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: () => [] }).invalid, /scoped-limits file does not load.*cannot be ruled out/);
  assert.deepEqual(writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => l.map((p) => ({ ...p, name: "N" })) }), { ok: true });
});

test("the pair rule's honest half: a row that ALREADY dangles does not block an unrelated write, which says pending", () => {
  const fs = memFs({ "p.json": PROJECTS([{ id: "shop", members: ["/srv/a"] }]), "sl.json": LIMITS([{ scope: "project:gone", day: 2 }]) });
  const res = writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => [...l, { id: "ops", members: ["/srv/b"] }] });
  assert.equal(res.ok, true);
  assert.match(res.pending, /^project:gone in sl\.json names a project that is not in this file; the worker applies this once its live scoped limits no longer name gone; if they do, it keeps its last good projects/);
  // Adding the missing project mends the pair: nothing pending.
  assert.deepEqual(writeProjects({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => [...l, { id: "gone", members: ["/srv/c"] }] }), { ok: true });
});

test("planProjectsWrite never writes; no refusal quotes a project's name", () => {
  const fs = memFs({ "p.json": PROJECTS([{ id: "shop", name: "Secret Label", members: ["github:acme/web"] }]), "sl.json": LIMITS([{ scope: "project:shop", day: 1 }]) });
  const plan = planProjectsWrite({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: () => [] });
  assert.ok(plan.invalid);
  assert.ok(!plan.invalid.includes("Secret Label"));
  const ok = planProjectsWrite({ projectsPath: "p.json", scopedLimitsPath: "sl.json", fs, mutate: (l) => l });
  assert.ok(typeof ok.text === "string" && Array.isArray(ok.projects));
  assert.deepEqual(fs.ops, [], "a plan writes nothing");
});

// ── the name ────────────────────────────────────────────────────────────────────────────────────────────

test("escapeInterpreted shows the panel's control class as visible text and keeps everything else", () => {
  assert.equal(escapeInterpreted("Web‮shop"), "Web\\u{202E}shop");
  assert.equal(escapeInterpreted("a​b⁦c"), "a\\u{200B}b\\u{2066}c");
  assert.equal(escapeInterpreted("Webshop אב café"), "Webshop אב café", "letters of any script, and a plain space, are kept");
  assert.equal(escapeInterpreted("\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}"), "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", "a flag sequence composes and is kept");
});

// ── the tools ───────────────────────────────────────────────────────────────────────────────────────────

function deployment({ projects, limits } = {}) {
  const dir = tempDir("pd-499c-");
  const p = join(dir, "projects.json");
  const sl = join(dir, "scoped-limits.json");
  if (projects !== undefined) writeFileSync(p, PROJECTS(projects));
  if (limits !== undefined) writeFileSync(sl, LIMITS(limits));
  process.env.PI_PROJECTS_FILE = p;
  process.env.PI_SCOPED_LIMITS_FILE = sl;
  return { p, sl, read: () => JSON.parse(readFileSync(p, "utf8")) };
}

test("the project tools refuse with no interactive operator and write nothing", async () => {
  const d = deployment({ projects: [{ id: "shop", members: ["github:acme/web"] }] });
  const before = readFileSync(d.p, "utf8");
  const { ctx } = toolCtx({ hasUI: false });
  for (const [name, params] of [["dispatch_project_add", { id: "ops", members: ["/srv/ops"] }], ["dispatch_project_edit", { id: "shop", name: "x" }], ["dispatch_project_delete", { id: "shop" }]]) {
    await assert.rejects(() => toolByName(name).execute("id", params, undefined, undefined, ctx), /interactive operator/, name);
  }
  assert.equal(readFileSync(d.p, "utf8"), before);
});

test("dispatch_project_add: an approved confirm writes the project; a declined one writes nothing", async () => {
  const d = deployment({ projects: [] });
  const no = toolCtx({ answer: false });
  assert.equal(textOf(await toolByName("dispatch_project_add").execute("id", { id: "shop", members: ["github:acme/web"] }, undefined, undefined, no.ctx)).applied, false);
  assert.deepEqual(d.read().projects, []);
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_project_add").execute("id", { id: "shop", name: "Web‮shop", members: ["github:acme/web", "/srv/shop"] }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.deepEqual(d.read().projects, [{ id: "shop", name: "Web‮shop", members: ["github:acme/web", "/srv/shop"] }], "the file holds the name as given");
  assert.ok(!shown[0].message.includes("‮") && shown[0].message.includes("Web\\\\u{202E}shop"), "the confirm shows it escaped");
  assert.ok(!JSON.stringify(out).includes("‮"), "so does the tool result");
  assert.match(shown[0].message, /record project shop from their next pickup/);
});

test("dispatch_project_add refuses a bad entry BEFORE the confirm", async () => {
  deployment({ projects: [{ id: "shop", members: ["github:acme/web"] }] });
  const { ctx, shown } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_project_add").execute("id", { id: "web", members: ["github:acme/web"] }, undefined, undefined, ctx), /claimed by both/);
  await assert.rejects(() => toolByName("dispatch_project_add").execute("id", { id: "api", members: ["acme/api"] }, undefined, undefined, ctx), /bare repo/);
  assert.equal(shown.length, 0, "the operator is never asked to approve a write that would be refused");
});

test("dispatch_project_edit: members replace, the confirm says a member leaving widens what it may spend, the id is kept", async () => {
  const d = deployment({ projects: [{ id: "shop", name: "Shop", members: ["github:acme/web", "/srv/shop"] }] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_project_edit").execute("id", { id: "shop", members: ["/srv/shop"] }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.deepEqual(d.read().projects, [{ id: "shop", name: "Shop", members: ["/srv/shop"] }], "the name is carried");
  assert.match(shown[0].message, /github:acme\/web leaves the project: a project:shop row no longer counts it, which widens what it may spend/);
  await toolByName("dispatch_project_edit").execute("id", { id: "shop", name: "" }, undefined, undefined, ctx);
  assert.deepEqual(d.read().projects, [{ id: "shop", members: ["/srv/shop"] }], "an empty name removes it");
  await assert.rejects(() => toolByName("dispatch_project_edit").execute("id", { id: "nope", name: "x" }, undefined, undefined, ctx), /no project with id "nope"/);
});

test("dispatch_project_delete is refused BEFORE the confirm while a scoped-limits row names the project", async () => {
  const d = deployment({ projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "ops", members: ["/srv/ops"] }], limits: [{ scope: "project:shop", day: 2 }] });
  const { ctx, shown } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_project_delete").execute("id", { id: "shop" }, undefined, undefined, ctx), /project:shop \(index 0\) .* names this project/);
  assert.equal(shown.length, 0);
  assert.deepEqual(d.read().projects.map((p) => p.id), ["shop", "ops"]);
  const out = textOf(await toolByName("dispatch_project_delete").execute("id", { id: "ops" }, undefined, undefined, ctx));
  assert.deepEqual(out, { applied: true, deleted: "ops" });
  assert.deepEqual(d.read().projects.map((p) => p.id), ["shop"]);
});

test("the project tools refuse while PI_PROJECTS_FILE is unset, saying why", async () => {
  delete process.env.PI_PROJECTS_FILE;
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_project_add").execute("id", { id: "shop", members: ["/srv/a"] }, undefined, undefined, ctx), /PI_PROJECTS_FILE is unset/);
  assert.deepEqual(textOf(await toolByName("dispatch_projects").execute("id", {}, undefined, undefined, undefined)), { unset: true });
});

test("dispatch_projects lists each project with its escaped name, members and the rows that cap it", async () => {
  deployment({ projects: [{ id: "shop", name: "Web‮shop", members: ["github:acme/web"] }, { id: "ops", members: ["/srv/ops"] }], limits: [{ scope: "acme/api", day: 1 }, { scope: "project:shop", day: 2 }] });
  const out = textOf(await toolByName("dispatch_projects").execute("id", {}, undefined, undefined, undefined));
  assert.deepEqual(out, { projects: [
    { id: "shop", name: "Web\\u{202E}shop", members: ["github:acme/web"], limitRows: [1] },
    { id: "ops", name: null, members: ["/srv/ops"], limitRows: [] },
  ] });
});

// ── dispatch_costs ──────────────────────────────────────────────────────────────────────────────────────

test("dispatch_costs: byProject in the fold, and the project filter scopes every arm to the runs recorded under it", async () => {
  const logsDir = tempDir("pd-499c-logs-");
  process.env.PI_LOGS_DIR = logsDir;
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const rec = (jobId, project, cost) => ({ jobId, kind: "github", target: "acme/web#1", flow: "fix", startedAt: at(now - 60_000), endedAt: at(now - 30_000), outcome: "completed", tokens: { input: 1, output: 1, total: 2, cost, metered: true }, usage: null, dollars: null, ...(project === undefined ? {} : { project }) });
  writeFileSync(join(logsDir, "a.json"), JSON.stringify(rec("a", "shop", 0.5)));
  writeFileSync(join(logsDir, "b.json"), JSON.stringify(rec("b", null, 0.25)));
  writeFileSync(join(logsDir, "c.json"), JSON.stringify(rec("c", undefined, 0.125)));
  deployment({ projects: [] });
  const dir = tempDir("pd-499c-cfg-");
  process.env.PI_SETTINGS_FILE = join(dir, "settings.json");
  process.env.PI_SUBSCRIPTIONS_FILE = join(dir, "subscriptions.json");
  process.env.PI_TRIGGERS_FILE = join(dir, "triggers.json");
  process.env.VALKEY_URL = "not-a-url";
  try {
    const all = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(all.fold.byProject.map((r) => [r.key, r.label, r.runs, r.cost.usd]), [["shop", "shop", 1, 0.5], [null, "(no project)", 2, 0.375]]);
    const shop = textOf(await toolByName("dispatch_costs").execute("id", { project: "shop" }, undefined, undefined, undefined));
    assert.deepEqual(shop.fold.byProject.map((r) => [r.key, r.runs]), [["shop", 1]]);
    assert.equal(shop.fold.provenance.runsTotal, 1, "every arm is scoped, not one table");
    assert.deepEqual(shop.fold.byRepo.map((r) => r.runs), [1]);
    await assert.rejects(() => toolByName("dispatch_costs").execute("id", { project: "(no project)" }, undefined, undefined, undefined), /project must be a project id/);
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// ── PR #569's review: unreadable files, the tmp name, the re-check, symlinks, the mode, escaping ────────────

const asRoot = process.getuid?.() === 0;

test("only ENOENT is missing: an UNREADABLE projects.json refuses the write and the reader says unreadable", { skip: asRoot }, () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }, { id: "ops", members: ["/srv/b"] }] });
  chmodSync(d.p, 0o200);
  let res;
  let read;
  try {
    read = readProjects({ projectsPath: d.p });
    res = writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, mutate: (l) => [...l, { id: "new", members: ["/srv/c"] }] });
  } finally {
    chmodSync(d.p, 0o644);
  }
  assert.deepEqual(read, { unreadable: "EACCES" });
  assert.match(res.invalid, /could not be read \(EACCES\), so its projects cannot be kept; nothing was written/);
  assert.deepEqual(d.read().projects.map((p) => p.id), ["shop", "ops"], "every project kept");
});

test("only ENOENT is missing: an UNREADABLE scoped-limits file cannot rule a row out, so a removal is refused", { skip: asRoot }, () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }], limits: [{ scope: "project:shop", day: 1 }] });
  chmodSync(d.sl, 0o200);
  let res;
  try {
    res = writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, mutate: (l) => l.filter((p) => p.id !== "shop") });
  } finally {
    chmodSync(d.sl, 0o644);
  }
  assert.match(res.invalid, /scoped-limits file .* could not be read \(EACCES\), so a row naming shop cannot be ruled out/);
  checkProjectRows(parseScopedLimits(readFileSync(d.sl, "utf8"), d.sl), parseProjects(readFileSync(d.p, "utf8"), d.p), d.sl, d.p);
});

test("writeScopedLimits: an UNREADABLE limits file refuses rather than starting from no rows", { skip: asRoot }, () => {
  const d = deployment({ projects: [], limits: [{ scope: "acme/web", day: 3 }] });
  chmodSync(d.sl, 0o200);
  let res;
  try {
    res = writeScopedLimits({ scopedLimitsPath: d.sl, projectsPath: d.p, mutate: (l) => [...l, { scope: "acme/api", day: 1 }] });
  } finally {
    chmodSync(d.sl, 0o644);
  }
  assert.match(res.invalid, /could not be read \(EACCES\); nothing was written/);
  assert.deepEqual(parseScopedLimits(readFileSync(d.sl, "utf8"), d.sl).map((l) => l.scope), ["acme/web"]);
});

test("a second session's write between this one's read and its rename is refused, never silently lost", () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }] });
  let fired = false;
  const fsA = {
    ...realFs,
    readFileSync: (p, e) => {
      const out = realFs.readFileSync(p, e);
      if (!fired && p === d.p) {
        fired = true;
        assert.deepEqual(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, mutate: (l) => [...l, { id: "bbb", members: ["/srv/b"] }] }), { ok: true });
      }
      return out;
    },
  };
  const a = writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, fs: fsA, mutate: (l) => [...l, { id: "aaa", members: ["/srv/c"] }] });
  assert.match(a.invalid, /changed after this change was built from it.*nothing was written/);
  assert.deepEqual(d.read().projects.map((p) => p.id), ["shop", "bbb"], "B's approved write stands");
  assert.ok(!readdirSync(join(d.p, "..")).some((f) => f.endsWith(".tmp")), "A's tmp file is removed");
});

test("a second session's write between this one's tmp write and its rename: separate tmp files, and the re-check refuses", () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }] });
  let fired = false;
  const fsA = {
    ...realFs,
    writeFileSync: (p, data, o) => {
      realFs.writeFileSync(p, data, o);
      if (!fired) {
        fired = true;
        assert.deepEqual(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, mutate: (l) => [...l, { id: "bbb", members: ["/srv/b"] }] }), { ok: true });
      }
    },
  };
  assert.match(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, fs: fsA, mutate: (l) => [...l, { id: "aaa", members: ["/srv/c"] }] }).invalid, /changed after this change was built/);
  assert.deepEqual(d.read().projects.map((p) => p.id), ["shop", "bbb"]);
});

test("across the two files: a project delete judged before a row add lands is refused by the re-check", () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }], limits: [] });
  let fired = false;
  const fsA = {
    ...realFs,
    readFileSync: (p, e) => {
      const out = realFs.readFileSync(p, e);
      if (!fired && p === d.sl) {
        fired = true;
        assert.equal(writeScopedLimits({ scopedLimitsPath: d.sl, projectsPath: d.p, mutate: (l) => [...l, { scope: "project:shop", day: 1 }] }).ok, true);
      }
      return out;
    },
  };
  assert.match(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, fs: fsA, mutate: (l) => l.filter((p) => p.id !== "shop") }).invalid, /changed after this change was built/);
  checkProjectRows(parseScopedLimits(readFileSync(d.sl, "utf8"), d.sl), parseProjects(readFileSync(d.p, "utf8"), d.p), d.sl, d.p);
});

test("both writers REFUSE a symlinked file, with a plain message, and touch neither the link nor its target", () => {
  const d = deployment({});
  const target = join(d.p, "..", "shared-projects.json");
  writeFileSync(target, PROJECTS([{ id: "shop", members: ["/srv/a"] }]));
  symlinkSync(target, d.p);
  const before = readFileSync(target, "utf8");
  const res = writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, mutate: (l) => [...l, { id: "ops", members: ["/srv/b"] }] });
  assert.match(res.invalid, /is a symbolic link, and the admin writes only a regular file; edit the file it points to, or point PI_PROJECTS_FILE at the real path\. Nothing was written$/);
  assert.equal(lstatSync(d.p).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), before);
  const slTarget = join(d.p, "..", "shared-limits.json");
  writeFileSync(slTarget, LIMITS([{ scope: "acme/web", day: 1 }]));
  symlinkSync(slTarget, d.sl);
  const sl = writeScopedLimits({ scopedLimitsPath: d.sl, projectsPath: null, mutate: (l) => [...l, { scope: "acme/api", day: 2 }] });
  assert.match(sl.invalid, /point PI_SCOPED_LIMITS_FILE at the real path/);
  assert.equal(parseScopedLimits(readFileSync(slTarget, "utf8"), slTarget).length, 1);
  // A dangling link is a link too: refused, never replaced by a regular file.
  const d2 = deployment({});
  symlinkSync(join(d2.p, "..", "nowhere.json"), d2.p);
  assert.match(writeProjects({ projectsPath: d2.p, scopedLimitsPath: d2.sl, mutate: (l) => [...l, { id: "a", members: ["/srv/a"] }] }).invalid, /symbolic link/);
  assert.ok(!readdirSync(join(d.p, "..")).some((f) => f.endsWith(".tmp")));
});

test("the mode is kept, and so are the owner and group: a file the worker owns stays the worker's", () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }] });
  chmodSync(d.p, 0o640);
  assert.deepEqual(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, mutate: (l) => l }), { ok: true });
  assert.equal(statSync(d.p).mode & 0o777, 0o640);
  // Another user's file (an injected stat): the tmp file is given that owner before the rename.
  const chowned = [];
  const asWorker = (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 4242, gid: 4343 });
  const fsOther = { ...realFs, statSync: (p) => (p === d.p ? asWorker(realFs.statSync(p)) : realFs.statSync(p)), chownSync: (p, uid, gid) => chowned.push([p, uid, gid]) };
  assert.deepEqual(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, fs: fsOther, mutate: (l) => l }), { ok: true });
  assert.equal(chowned.length, 1);
  assert.match(chowned[0][0], /projects\.json\.\d+\.[0-9a-f]{12}\.tmp$/, "the tmp file, before the rename");
  assert.deepEqual(chowned[0].slice(1), [4242, 4343]);
  // When the owner cannot be given back, nothing is written.
  const before = readFileSync(d.p, "utf8");
  const fsDenied = { ...fsOther, chownSync: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } };
  const res = writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, fs: fsDenied, mutate: (l) => [...l, { id: "ops", members: ["/srv/b"] }] });
  assert.match(res.invalid, /owned by uid 4242 gid 4343, and the new file could not be given that owner \(EPERM\).*Nothing was written$/);
  assert.equal(readFileSync(d.p, "utf8"), before);
  assert.ok(!readdirSync(join(d.p, "..")).some((f) => f.endsWith(".tmp")), "the tmp file is dropped");
  // The same rule in the scoped-limits writer.
  writeFileSync(d.sl, LIMITS([{ scope: "acme/web", day: 1 }]));
  const fsDeniedSl = { ...realFs, statSync: (p) => (p === d.sl ? asWorker(realFs.statSync(p)) : realFs.statSync(p)), chownSync: fsDenied.chownSync };
  assert.match(writeScopedLimits({ scopedLimitsPath: d.sl, projectsPath: null, fs: fsDeniedSl, mutate: (l) => l }).invalid, /could not be given that owner/);
});

test("a tmp file that cannot be created is a plain refusal, not a raw fs error", () => {
  const d = deployment({ projects: [{ id: "shop", members: ["/srv/a"] }] });
  const fsFull = { ...realFs, writeFileSync: (p, ...rest) => { if (String(p).endsWith(".tmp")) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); return realFs.writeFileSync(p, ...rest); } };
  assert.match(writeProjects({ projectsPath: d.p, scopedLimitsPath: d.sl, fs: fsFull, mutate: (l) => l }).invalid, /could not be written \(ENOSPC/);
});

test("the re-check covers the confirm dialog: an edit while another session's dialog is open is refused, never lost", async () => {
  const d = deployment({ projects: [{ id: "shop", name: "Shop", members: ["/srv/a"] }] });
  const edit = toolByName("dispatch_project_edit");
  let b = null;
  const ctxA = { hasUI: true, ui: { confirm: async () => {
    b = await edit.execute("b", { id: "shop", members: ["/srv/a", "/srv/b"] }, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
    return true;
  } } };
  await assert.rejects(() => edit.execute("a", { id: "shop", name: "Webshop" }, undefined, undefined, ctxA), /changed after this change was built from it/);
  assert.equal(textOf(b).applied, true);
  assert.deepEqual(d.read().projects[0], { id: "shop", name: "Shop", members: ["/srv/a", "/srv/b"] }, "B's change stands, A wrote nothing");
});

test("the scoped-limit writers re-check against the pre-confirm read too", async () => {
  deployment({ projects: [], limits: [{ scope: "acme/web", day: 1 }] });
  const sl = process.env.PI_SCOPED_LIMITS_FILE;
  for (const [name, params] of [["dispatch_limit_edit", { index: 0, day: 5 }], ["dispatch_limit_delete", { index: 0 }], ["dispatch_limit_add", { scope: "acme/api", day: 2 }]]) {
    writeFileSync(sl, LIMITS([{ scope: "acme/web", day: 1 }]));
    const ctx = { hasUI: true, ui: { confirm: async () => {
      writeFileSync(sl, LIMITS([{ scope: "acme/web", day: 1 }, { scope: "acme/other", day: 9 }])); // another session, mid-dialog
      return true;
    } } };
    await assert.rejects(() => toolByName(name).execute("id", params, undefined, undefined, ctx), /changed after this change was built from it/, name);
    assert.deepEqual(parseScopedLimits(readFileSync(sl, "utf8"), sl).map((l) => l.scope), ["acme/web", "acme/other"], `${name} wrote nothing`);
  }
});

test("the worker's escapeControls escapes exactly the panel's escapeInterpreted set, over every code point", () => {
  const onlyPanel = [];
  const onlyWorker = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const a = escapeInterpreted(ch) !== ch;
    const b = escapeControls(ch) !== ch;
    if (a && !b) onlyPanel.push(cp.toString(16));
    if (b && !a) onlyWorker.push(cp.toString(16));
  }
  assert.deepEqual(onlyPanel, []);
  assert.deepEqual(onlyWorker, []);
});

test("members and refusals are escaped in tool results, dispatch_projects and errors", async () => {
  deployment({ projects: [] });
  const { ctx, shown } = toolCtx({ answer: true });
  const evil = "/srv/x\u202egnp.cod\u009b";
  const res = await toolByName("dispatch_project_add").execute("id", { id: "shop", members: [evil] }, undefined, undefined, ctx);
  const text = res.content[0].text;
  for (const ch of ["\u202e", "\u009b"]) assert.ok(!text.includes(ch) && !shown[0].message.includes(ch), `U+${ch.codePointAt(0).toString(16)} escaped`);
  assert.ok(text.includes("\\\\u{202E}"), "shown as visible text");
  const list = (await toolByName("dispatch_projects").execute("id", {}, undefined, undefined, undefined)).content[0].text;
  assert.ok(!list.includes("\u202e") && !list.includes("\u009b"));
  await assert.rejects(
    () => toolByName("dispatch_project_add").execute("id", { id: "ops", members: [evil] }, undefined, undefined, ctx),
    (e) => /claimed by both/.test(e.message) && !e.message.includes("\u202e") && !e.message.includes("\u009b") && e.message.includes("\\u{202E}"),
  );
});
