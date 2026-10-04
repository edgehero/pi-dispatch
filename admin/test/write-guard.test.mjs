import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { JUDGED_COMMAND_TOOLS, PATH_WRITE_TOOLS, PI_UNICODE_SPACES, UNJUDGED_TOOLS, envNamedFiles, makeWriteGuard, piResolveToCwd, readSmallRegularFile, targetIdentity } from "../src/write-guard.mjs";
import { execFileSync, spawnSync } from "node:child_process";

// The operator session's write guard (issue #504 part C, admin/src/write-guard.mjs). The guarded files are real files
// in a temp deployment, so links, case and the not-yet-existing rules are judged by the real filesystem.

// The package root (its main entry is dist/index.js), so the paths below read as they do in the package.
const piDir = join(fileURLToPath(new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const piDist = (rel) => join(piDir, rel);
const piSource = (rel) => readFileSync(piDist(rel), "utf8");

function deployment({ create = ["envelope.json", "projects.json", "scoped-limits.json", "triggers.json", "settings.json"] } = {}) {
  const dir = tempDir("pd-guard-");
  const names = { envelope: "envelope.json", projects: "projects.json", limits: "scoped-limits.json", triggers: "triggers.json", settings: "settings.json" };
  const path = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, join(dir, n)]));
  for (const n of create) writeFileSync(join(dir, n), "{}\n");
  const guarded = [
    { path: path.envelope, label: "the allocation envelope (PI_ENVELOPE_FILE)", tool: "dispatch_envelope_set" },
    { path: path.projects, label: "projects.json (PI_PROJECTS_FILE)", tool: "dispatch_project_add" },
    { path: path.limits, label: "scoped-limits.json (PI_SCOPED_LIMITS_FILE)", tool: "dispatch_limit_add" },
    { path: path.triggers, label: "triggers.json (PI_TRIGGERS_FILE)", tool: "dispatch_trigger_add" },
    { path: path.settings, label: "the settings overlay (PI_SETTINGS_FILE)", tool: "dispatch_set" },
  ];
  return { dir, path, guard: makeWriteGuard({ guardedFiles: () => guarded, home: dir }) };
}
const write = (path, extra = {}) => ({ type: "tool_call", toolName: "write", toolCallId: "c1", input: { path, content: "x" }, ...extra });
const edit = (path) => ({ type: "tool_call", toolName: "edit", toolCallId: "c2", input: { path, edits: [{ oldText: "{}", newText: "[]" }] } });

// ── pinned against pi 0.99.1 ────────────────────────────────────────────────────────────────────────────────────────

test("the judged tool set is exactly pi's built-in tool set, each classified (dist/core/tools allToolNames)", async () => {
  const { allToolNames } = await import(pathToFileURL(piDist("dist/core/tools/index.js")).href);
  assert.deepEqual([...allToolNames].sort(), [...PATH_WRITE_TOOLS, ...JUDGED_COMMAND_TOOLS, ...UNJUDGED_TOOLS].sort(), "a pi bump that adds or renames a built-in tool must be classified here before it ships");
  // write and edit name their target in `input.path`, resolved by resolveToCwd against ctx.cwd: the mirror's premise.
  for (const tool of PATH_WRITE_TOOLS) assert.match(piSource(`dist/core/tools/${tool}.js`), /const absolutePath = resolveToCwd\(path, ctx\?\.cwd \|\| cwd\);/, `${tool} resolves input.path through resolveToCwd`);
});

test("pi's path rules are mirrored: the needles in the pinned source, and the same answer as pi's own resolveToCwd", async () => {
  const utils = piSource("dist/utils/paths.js");
  assert.ok(utils.includes(`const UNICODE_SPACES = ${PI_UNICODE_SPACES.toString()};`), "the Unicode space class is pi's, character for character");
  assert.match(utils, /if \(options\.stripAtPrefix && normalized\.startsWith\("@"\)\) \{\n\s+normalized = normalized\.slice\(1\);/, "one leading @ is dropped");
  assert.match(utils, /if \(normalized === "~"\)\n\s+return home;\n\s+if \(normalized\.startsWith\("~\/"\)/, "~ and ~/ expand to the home directory");
  assert.match(utils, /if \(\/\^file:\\\/\\\/\/\.test\(normalized\)\) \{\n\s+return fileURLToPath\(normalized\);/, "a file:// URL becomes its path");
  assert.match(piSource("dist/core/tools/path-utils.js"), /return resolvePath\(filePath, cwd, \{ normalizeUnicodeSpaces: true, stripAtPrefix: true \}\);/, "resolveToCwd turns both on");
  const { resolveToCwd } = await import(pathToFileURL(piDist("dist/core/tools/path-utils.js")).href);
  const cwd = join(homedir(), "work", "deploy");
  const inputs = ["envelope.json", "./sub/../envelope.json", "@envelope.json", "@@envelope.json", "~", "~/envelope.json", "@~/envelope.json", "/abs/../etc/x.json", "a\u00A0b.json", "a\u2003b\u202Fc.json", "a\u3000.json", "file:///tmp/e%20x.json", " envelope.json", "~user/x.json", "dir\\\\x.json"];
  for (const input of inputs) assert.equal(piResolveToCwd(input, cwd), resolveToCwd(input, cwd), `same target as pi for ${JSON.stringify(input)}`);
});

// ── what is blocked ─────────────────────────────────────────────────────────────────────────────────────────────────

test("write and edit are blocked on each guarded file, and the reason names the file and its tool, never the path", () => {
  const d = deployment();
  for (const [key, p] of Object.entries(d.path)) {
    for (const ev of [write(p), edit(p)]) {
      const r = d.guard(ev, { cwd: "/" });
      assert.equal(r?.block, true, `${ev.toolName} ${key}`);
      assert.match(r.reason, /^pi-dispatch blocked this (write|edit): it writes .+\(PI_[A-Z_]+_FILE\), which only the operator changes/);
      assert.ok(!r.reason.includes(d.dir), "no full path in what the model reads");
    }
  }
});

test("every spelling pi itself resolves to a guarded file is blocked: relative to ctx.cwd, @, ~, Unicode spaces, file://", () => {
  const d = deployment();
  const spaced = join(d.dir, "my envelope.json");
  writeFileSync(spaced, "{}");
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: d.path.envelope, label: "the allocation envelope (PI_ENVELOPE_FILE)" }, { path: spaced, label: "the allocation envelope (PI_ENVELOPE_FILE)" }], home: d.dir });
  const ctx = { cwd: d.dir };
  for (const p of ["envelope.json", "./envelope.json", "sub/../envelope.json", "@envelope.json", "~/envelope.json", "@~/envelope.json", pathToFileURL(d.path.envelope).href, "my\u00A0envelope.json", "my\u2009envelope.json"]) {
    assert.equal(guard(write(p), ctx)?.block, true, `blocked: ${JSON.stringify(p)}`);
  }
});

test("a symlink, a hard link, a directory link and a case variant of a guarded file are the guarded file", () => {
  const d = deployment();
  const other = tempDir("pd-guard-other-");
  symlinkSync(d.path.envelope, join(other, "innocent.json"));
  linkSync(d.path.projects, join(other, "hard.json"));
  symlinkSync(d.dir, join(other, "deploy"));
  const ctx = { cwd: other };
  assert.equal(d.guard(write("innocent.json"), ctx)?.block, true, "a symlink to the envelope");
  assert.equal(d.guard(write("hard.json"), ctx)?.block, true, "a hard link to projects.json");
  assert.equal(d.guard(edit("deploy/scoped-limits.json"), ctx)?.block, true, "through a directory link");
  // A case variant: on a case-insensitive volume it IS the file (same dev and inode); on a case-sensitive one it is a
  // different new file, which the fold below still blocks when the guarded name is missing.
  if (existsSync(join(d.dir, "ENVELOPE.JSON"))) assert.equal(d.guard(write(join(d.dir, "ENVELOPE.JSON")), ctx)?.block, true, "a case variant on this case-insensitive volume");
});

test("a guarded file that does not exist yet is guarded too: its name (case-folded), a dangling link to it, a link to its folder", () => {
  const d = deployment({ create: [] });
  const other = tempDir("pd-guard-other-");
  symlinkSync(d.path.envelope, join(other, "later.json")); // dangling: the envelope is not there yet
  symlinkSync(d.dir, join(other, "deploy"));
  const ctx = { cwd: other };
  assert.equal(d.guard(write(d.path.envelope), ctx)?.block, true, "the name itself");
  assert.equal(d.guard(write(join(d.dir, "Envelope.JSON")), ctx)?.block, true, "a case variant of a missing guarded name");
  assert.equal(d.guard(write("later.json"), ctx)?.block, true, "a dangling link, followed as create would follow it");
  assert.equal(d.guard(write("deploy/triggers.json"), ctx)?.block, true, "through a directory link");
  const missingDir = join(d.dir, "nested", "deeper");
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: join(missingDir, "envelope.json"), label: "the allocation envelope (PI_ENVELOPE_FILE)" }] });
  assert.equal(guard(write("deploy/nested/deeper/envelope.json"), ctx)?.block, true, "a guarded path whose folder does not exist yet");
});

test("a nested call (ctx.executeTool, parentToolCallId set) is judged like any other", () => {
  const d = deployment();
  assert.equal(d.guard(write(d.path.envelope, { toolCallId: "c1/1", parentToolCallId: "c1" }), { cwd: "/" })?.block, true);
});

test("powershell naming a guarded file is blocked by its text; bash is a named residual and passes", () => {
  const d = deployment();
  const ps = (command) => ({ type: "tool_call", toolName: "powershell", toolCallId: "p", input: { command } });
  assert.equal(d.guard(ps("Set-Content -Path .\\Projects.JSON -Value '{}'"), { cwd: d.dir })?.block, true, "case-folded");
  assert.equal(d.guard(ps("Get-ChildItem"), { cwd: d.dir }), undefined);
  assert.equal(d.guard({ type: "tool_call", toolName: "bash", toolCallId: "b", input: { command: "echo {} > projects.json" } }, { cwd: d.dir }), undefined, "bash is not judged (SECURITY.md names it)");
});

// ── what passes, and failing closed ─────────────────────────────────────────────────────────────────────────────────

test("an unrelated path, a reader tool, and a session with no guarded files pass", () => {
  const d = deployment();
  mkdirSync(join(d.dir, "notes"));
  for (const p of ["notes/plan.md", join(d.dir, "envelope.json.bak"), join(d.dir, "envelope.jsonx"), "projects.json.tmp"]) assert.equal(d.guard(write(p), { cwd: d.dir }), undefined, `passes: ${p}`);
  assert.equal(d.guard({ type: "tool_call", toolName: "read", toolCallId: "r", input: { path: d.path.envelope } }, { cwd: d.dir }), undefined);
  const none = makeWriteGuard({ guardedFiles: () => [] });
  assert.equal(none(write(d.path.envelope), { cwd: d.dir }), undefined);
});

test("a target it cannot resolve is BLOCKED (fail closed), naming the code; so is a path that is not a string", () => {
  const d = deployment();
  const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
  const fs = { statSync: () => { throw eacces; }, lstatSync: () => { throw eacces; }, readlinkSync: () => { throw eacces; } };
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: d.path.envelope, label: "the allocation envelope (PI_ENVELOPE_FILE)" }], fs });
  const r = guard(write(join(d.dir, "other.json")), { cwd: d.dir });
  assert.equal(r?.block, true);
  assert.match(r.reason, /could not resolve the target path \(EACCES\)/);
  assert.equal(d.guard({ type: "tool_call", toolName: "write", toolCallId: "w", input: { path: 7 } }, { cwd: d.dir })?.block, true);
  const broken = makeWriteGuard({ guardedFiles: () => { throw new Error("pointer unreadable"); } });
  assert.equal(broken(write("x.json"), { cwd: d.dir })?.block, true, "a guard that cannot list its files blocks");
});

test("targetIdentity: a link loop is an error (and so a block), never a hang", () => {
  const dir = tempDir("pd-guard-loop-");
  symlinkSync(join(dir, "b"), join(dir, "a"));
  symlinkSync(join(dir, "a"), join(dir, "b"));
  assert.throws(() => targetIdentity(join(dir, "a", "x.json")), (e) => ["ELOOP", "ENOENT"].includes(e.code) || /symbolic links/.test(e.message));
});

test("the extension's own handler guards all five of the deployment's files, at the paths the deployment resolves", async () => {
  const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
  const indexMod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const handlers = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "on" ? (event, h) => event === "tool_call" && handlers.push(h) : () => {}) });
  const keys = { PI_ENVELOPE_FILE: "envelope.json", PI_PROJECTS_FILE: "projects.json", PI_SCOPED_LIMITS_FILE: "scoped-limits.json", PI_TRIGGERS_FILE: "triggers.json", PI_SETTINGS_FILE: "settings.json" };
  const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  const dir = tempDir("pd-guard-wired-");
  try {
    for (const [k, name] of Object.entries(keys)) {
      writeFileSync(join(dir, name), "{}\n");
      process.env[k] = join(dir, name);
    }
    indexMod.default(pi);
    assert.equal(handlers.length, 1, "one tool_call handler");
    for (const [k, name] of Object.entries(keys)) {
      const r = await handlers[0](write(join(dir, name)), { cwd: "/" });
      assert.equal(r?.block, true, `${k} is guarded`);
      assert.ok(r.reason.includes(k), `the reason names ${k}`);
    }
    assert.equal(await handlers[0](write(join(dir, "notes.md")), { cwd: "/" }), undefined, "an unrelated file in the same folder passes");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the fold is a full case fold: a long s (U+017F) and a KELVIN SIGN (U+212A) cannot create a guarded name", () => {
  const d = deployment({ create: [] });
  const ctx = { cwd: d.dir };
  // APFS folds U+017F to s: writing `ſettings.json` here would create the guarded settings.json (measured in review).
  assert.equal(d.guard(write("ſettings.json"), ctx)?.block, true, "long s");
  assert.equal(d.guard(write("SETTINGS.JSON"), ctx)?.block, true, "plain case");
  const kelvin = join(d.dir, "kelvin.json");
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: kelvin, label: "a guarded file (PI_TEST_FILE)" }] });
  assert.equal(guard(write("Kelvin.json"), ctx)?.block, true, "kelvin sign");
  assert.equal(guard(write("kelvin.json.bak"), ctx), undefined, "a different name still passes");
  // Where the volume itself folds, the existing file IS the guarded file by identity too.
  writeFileSync(d.path.settings, "{}");
  if (existsSync(join(d.dir, "ſettings.json"))) assert.equal(d.guard(write("ſettings.json"), ctx)?.block, true, "an existing file reached by the long s");
});

test("the fold also takes the capital sharp s (U+1E9E) to ss, as APFS does", () => {
  const d = deployment({ create: [] });
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: join(d.dir, "business-envelope.json"), label: "a guarded file (PI_TEST_FILE)" }] });
  assert.equal(guard(write("busine\u1E9E-envelope.json"), { cwd: d.dir })?.block, true);
});

test("powershell: a guarded name matches only as a path segment, and through the fold", () => {
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: "/d/.env", label: "the deployment's .env (PI_*_FILE)" }, { path: "/d/projects.json", label: "projects.json (PI_PROJECTS_FILE)" }] });
  const ps = (command) => guard({ type: "tool_call", toolName: "powershell", toolCallId: "p", input: { command } }, { cwd: "/" });
  for (const c of ["node -e \"console.log(process.env.HOME)\"", "Get-Content .envrc", "Copy-Item .env.example x", "Get-Content projects.jsonx", "Get-Content myprojects.json"]) assert.equal(ps(c), undefined, `passes: ${c}`);
  for (const c of ["Set-Content .env 'x'", "Set-Content .\\projec\u017F.json 'x'".replace("projec\u017F", "project\u017F"), "Set-Content PROJECTS.JSON 'x'", "Remove-Item \"C:\\d\\projects.json\""]) assert.equal(ps(c)?.block, true, `blocked: ${c}`);
});

test("a .env that is a FIFO or a link to /dev/zero adds nothing and never hangs or grows (review round 3)", { timeout: 10_000, skip: spawnSync("mkfifo", ["--help"]).error ? "no mkfifo here" : false }, () => {
  const dir = tempDir("pd-guard-fifo-");
  execFileSync("mkfifo", [join(dir, ".env")]);
  assert.deepEqual(envNamedFiles(dir), [], "a FIFO: opened non-blocking, refused by fstat, nothing read");
  assert.equal(readSmallRegularFile(join(dir, ".env")), null);
  const zero = tempDir("pd-guard-zero-");
  symlinkSync("/dev/zero", join(zero, ".env"));
  assert.deepEqual(envNamedFiles(zero), [], "a device: not a regular file");
  assert.equal(readSmallRegularFile(join(zero, ".env")), null, "and not one byte of it is read");
  const big = tempDir("pd-guard-big-");
  writeFileSync(join(big, ".env"), `PI_PROJECTS_FILE=/dep/projects.json\n${"#".repeat(1024 * 1024)}\n`);
  assert.deepEqual(envNamedFiles(big), [], "past the 1 MiB cap: nothing, not a prefix");
});

test("envNamedFiles reads every way a loader might take a value: comment, quotes, ~, $HOME; the last assignment per key", () => {
  const dir = tempDir("pd-guard-readings-");
  const at = (text) => {
    writeFileSync(join(dir, ".env"), text);
    return envNamedFiles(dir, { home: "/home/op" }).filter((g) => !g.path.endsWith("/.env")).map((g) => g.path);
  };
  assert.ok(at("PI_PROJECTS_FILE=/dep/projects.json # the projects").includes("/dep/projects.json"));
  assert.ok(at('PI_PROJECTS_FILE="/dep/projects.json" # c').includes("/dep/projects.json"));
  assert.ok(at('PI_PROJECTS_FILE=/dep/"projects".json').includes("/dep/projects.json"));
  for (const v of ["~/dep/projects.json", "$HOME/dep/projects.json", "${HOME}/dep/projects.json"]) assert.ok(at(`PI_PROJECTS_FILE=${v}`).includes("/home/op/dep/projects.json"), v);
  assert.ok(!at("PI_PROJECTS_FILE=$HOMEDIR/x.json").includes("/home/op/x.json"), "$HOMEDIR is not $HOME");
  assert.deepEqual(at("PI_PROJECTS_FILE=/a/projects.json\nPI_PROJECTS_FILE=/b/projects.json"), ["/b/projects.json"], "the last assignment, as the loaders take it");
  assert.deepEqual(at("\uFEFFexport PI_ENVELOPE_FILE=/dep/envelope.json\r\n"), ["/dep/envelope.json"], "a BOM, export and CRLF");
  assert.deepEqual(at("# PI_PROJECTS_FILE=/dep/projects.json\nPI_OTHER_FILE=/x"), [], "a comment and an unguarded key name nothing");
});

test("powershell: trailing dots and spaces (stripped by Windows) still name the file; .env.example still does not", () => {
  const guard = makeWriteGuard({ guardedFiles: () => [{ path: "/d/projects.json", label: "projects.json (PI_PROJECTS_FILE)" }, { path: "/d/.env", label: "the deployment's .env (PI_*_FILE)" }] });
  const ps = (command) => guard({ type: "tool_call", toolName: "powershell", toolCallId: "p", input: { command } }, { cwd: "/" });
  for (const c of ["Set-Content projects.json. x", "Set-Content 'projects.json.' x", "Set-Content projects.json... x", "Set-Content 'projects.json . ' x"]) assert.equal(ps(c)?.block, true, c);
  for (const c of ["Copy-Item .env.example x", "Get-Content projects.json.bak"]) assert.equal(ps(c), undefined, c);
});
