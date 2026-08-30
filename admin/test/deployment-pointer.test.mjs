import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  POINTER_VERSION,
  POINTER_ENV_ALLOWLIST,
  pointerPath,
  readPointer,
  applyDeploymentPointer,
  reapplyDeploymentPointer,
  takePointerNotice,
  writePointer,
  resetForTests,
} from "../src/deployment-pointer.mjs";

/**
 * In-memory fs for the pointer tests: readFileSync/writeFileSync/renameSync over a plain object, with a
 * recorded call sequence so the writePointer test can assert the atomic tmp-then-rename protocol exactly.
 */
function fakeFs(initial = {}) {
  const files = { ...initial };
  const calls = [];
  return {
    files,
    calls,
    readFileSync(p) {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return files[p];
    },
    writeFileSync(p, data) {
      calls.push(["writeFileSync", p]);
      files[p] = String(data);
    },
    renameSync(a, b) {
      calls.push(["renameSync", a, b]);
      files[b] = files[a];
      delete files[a];
    },
  };
}

// Every fake env pins the pointer location so the tests never look at the real ~/.pi/agent.
const P = "/pointer.json";
const DIR = "/home/op/pi-dispatch";

function envWith(extra = {}) {
  return { PI_DISPATCH_DEPLOYMENT_FILE: P, ...extra };
}

function pointerJson(env, { version = 1, deploymentDir = DIR } = {}) {
  return JSON.stringify({ version, deploymentDir, env });
}

test("applyDeploymentPointer layers allowed absolute entries into an unset env", () => {
  resetForTests();
  const fs = fakeFs({
    [P]: pointerJson({
      VALKEY_URL: "redis://10.0.0.5:6379",
      PI_LOGS_DIR: join(DIR, "logs"),
      PI_TRIGGERS_FILE: join(DIR, "triggers.json"),
    }),
  });
  const env = envWith();
  const res = applyDeploymentPointer(env, { fs });
  assert.deepEqual(res.applied.sort(), ["PI_LOGS_DIR", "PI_TRIGGERS_FILE", "VALKEY_URL"]);
  assert.equal(env.VALKEY_URL, "redis://10.0.0.5:6379");
  assert.equal(env.PI_LOGS_DIR, join(DIR, "logs"));
  assert.equal(env.PI_TRIGGERS_FILE, join(DIR, "triggers.json"));
  assert.equal(takePointerNotice(), undefined, "a valid pointer surfaces nothing");
});

test("an operator-set var is never overwritten — not even an empty export", () => {
  resetForTests();
  const fs = fakeFs({
    [P]: pointerJson({
      PI_LOGS_DIR: "/deploy/logs",
      PI_TRIGGERS_FILE: "/deploy/triggers.json",
      VALKEY_URL: "redis://deploy:6379",
    }),
  });
  // An empty string IS operator intent (resolvePaths' `||` keys treat it as fall-back-to-default, and the
  // pointer must not second-guess that choice).
  const env = envWith({ PI_LOGS_DIR: "/operator/logs", PI_TRIGGERS_FILE: "" });
  applyDeploymentPointer(env, { fs });
  assert.equal(env.PI_LOGS_DIR, "/operator/logs", "the operator's export wins");
  assert.equal(env.PI_TRIGGERS_FILE, "", "an empty operator export also wins");
  assert.equal(env.VALKEY_URL, "redis://deploy:6379", "unset keys still layer in");
});

test("a second applyDeploymentPointer is a no-op (memoized), even after the file changes", () => {
  resetForTests();
  const fs = fakeFs({ [P]: pointerJson({ PI_LOGS_DIR: "/a/logs" }) });
  const env = envWith();
  applyDeploymentPointer(env, { fs });
  assert.equal(env.PI_LOGS_DIR, "/a/logs");
  fs.files[P] = pointerJson({ PI_LOGS_DIR: "/b/logs", VALKEY_URL: "redis://b:6379" });
  const second = applyDeploymentPointer(env, { fs });
  assert.deepEqual(second, { applied: [] }, "the memo makes the second call a no-op");
  assert.equal(env.PI_LOGS_DIR, "/a/logs", "the changed file is not re-read");
  assert.equal(env.VALKEY_URL, undefined);
});

test("reapplyDeploymentPointer updates only module-owned keys; an operator var planted between calls survives", () => {
  resetForTests();
  const fs = fakeFs({ [P]: pointerJson({ PI_LOGS_DIR: "/a/logs", VALKEY_URL: "redis://a:6379" }) });
  const env = envWith();
  applyDeploymentPointer(env, { fs });
  // The operator exports a var AFTER the first apply; the wizard then rewrites the pointer and reapplies.
  env.PI_SETTINGS_FILE = "/operator/settings.json";
  fs.files[P] = pointerJson({
    PI_LOGS_DIR: "/b/logs",
    PI_SETTINGS_FILE: "/b/settings.json",
    PI_TRIGGERS_FILE: "/b/triggers.json",
  });
  reapplyDeploymentPointer(env, { fs });
  assert.equal(env.PI_LOGS_DIR, "/b/logs", "a module-owned key follows the rewritten pointer");
  assert.equal(env.PI_SETTINGS_FILE, "/operator/settings.json", "the operator's later export is untouchable");
  assert.equal(env.PI_TRIGGERS_FILE, "/b/triggers.json", "a still-unset key layers in on reapply");
  assert.equal(env.VALKEY_URL, "redis://a:6379", "an owned key the new pointer dropped keeps its last value");
  // Reapply IS the refresh: a later plain apply must stay memoized.
  fs.files[P] = pointerJson({ PI_LOGS_DIR: "/c/logs" });
  assert.deepEqual(applyDeploymentPointer(env, { fs }), { applied: [] });
  assert.equal(env.PI_LOGS_DIR, "/b/logs");
});

test("a newer pointer version is ignored whole, with one notice naming both versions", () => {
  resetForTests();
  const fs = fakeFs({ [P]: pointerJson({ PI_LOGS_DIR: "/deploy/logs" }, { version: 2 }) });
  const read = readPointer({ path: P, fs });
  assert.match(read.ignored, /version 2/, "the reason names the file's version");
  assert.match(read.ignored, new RegExp(`version ${POINTER_VERSION}`), "and the supported version");
  const env = envWith();
  applyDeploymentPointer(env, { fs });
  assert.equal(env.PI_LOGS_DIR, undefined, "an ignored pointer applies nothing");
  const note = takePointerNotice();
  assert.match(note, /2/);
  assert.match(note, /1/);
  assert.equal(takePointerNotice(), undefined, "the notice is drained on first take");
});

test("readPointer degrades on every malformed shape and reports absence distinctly", () => {
  resetForTests();
  const cases = [
    ["{nope", /unparseable JSON/],
    ["[1,2]", /not a JSON object/],
    ['"a string"', /not a JSON object/],
    [JSON.stringify({ deploymentDir: DIR, env: {} }), /version/],
    [JSON.stringify({ version: 0, deploymentDir: DIR, env: {} }), /version/],
    [JSON.stringify({ version: "1", deploymentDir: DIR, env: {} }), /version/],
    [JSON.stringify({ version: 1, env: {} }), /deploymentDir/],
    [JSON.stringify({ version: 1, deploymentDir: "relative/dir", env: {} }), /deploymentDir/],
    [JSON.stringify({ version: 1, deploymentDir: DIR, env: "nope" }), /env/],
    [JSON.stringify({ version: 1, deploymentDir: DIR, env: ["nope"] }), /env/],
  ];
  for (const [text, reason] of cases) {
    const res = readPointer({ path: P, fs: fakeFs({ [P]: text }) });
    assert.match(res.ignored, reason, `ignored: ${text}`);
  }
  assert.deepEqual(readPointer({ path: P, fs: fakeFs() }), { absent: true }, "no file is the normal state, not an error");
});

test("unknown keys, PI_DISPATCH_RUN_ROOTS, credential-shaped keys, and relative path values are dropped", () => {
  resetForTests();
  const fs = fakeFs({
    [P]: pointerJson({
      PI_TRIGGERS_FILE: join(DIR, "triggers.json"), // the one survivor
      PI_DISPATCH_RUN_ROOTS: "/a:/b", // a capability grant, never honored from a pointer
      GITHUB_TOKEN: "ghs_secret", // credential-shaped: paths only, never credentials
      SOME_FUTURE_KEY: "/abs/x",
      PI_LOGS_DIR: "relative/logs", // relative path value: would resolve against the wrong cwd
      VALKEY_URL: 6379, // non-string value
      PI_SETTINGS_FILE: "", // empty value can only mask a working default
    }),
  });
  const read = readPointer({ path: P, fs });
  assert.deepEqual(read.pointer.env, { PI_TRIGGERS_FILE: join(DIR, "triggers.json") });
  const env = envWith();
  applyDeploymentPointer(env, { fs });
  assert.equal(env.PI_TRIGGERS_FILE, join(DIR, "triggers.json"));
  assert.equal(env.PI_DISPATCH_RUN_ROOTS, undefined, "the AI-run allowlist cannot widen via a pointer");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.SOME_FUTURE_KEY, undefined);
  assert.equal(env.PI_LOGS_DIR, undefined);
  assert.equal(env.VALKEY_URL, undefined);
  assert.equal(env.PI_SETTINGS_FILE, undefined);
});

test("writePointer rejects a pointer the read side would ignore, without writing", () => {
  resetForTests();
  const fs = fakeFs();
  const bad = [
    { version: 2, deploymentDir: DIR, env: {} }, // newer than this build writes
    { version: 1, deploymentDir: "relative/dir", env: {} },
    { version: 1, env: {} },
    "not an object",
  ];
  for (const pointer of bad) {
    const res = writePointer({ path: P, pointer, fs });
    assert.ok(res.invalid, `rejected: ${JSON.stringify(pointer)}`);
  }
  assert.deepEqual(fs.calls, [], "a rejected pointer is never written");
  assert.deepEqual(fs.files, {});
});

test("writePointer writes the NORMALIZED pointer atomically: tmp then rename, 2-space JSON, trailing newline", () => {
  resetForTests();
  const fs = fakeFs();
  const res = writePointer({
    path: P,
    pointer: {
      version: 1,
      deploymentDir: DIR,
      env: {
        PI_LOGS_DIR: join(DIR, "logs"),
        PI_DISPATCH_RUN_ROOTS: "/a", // dropped before the bytes exist
        PI_TRIGGERS_FILE: "relative/triggers.json", // relative: dropped
      },
      note: "unknown top-level fields drop too",
    },
    fs,
  });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(fs.calls, [
    ["writeFileSync", `${P}.tmp`],
    ["renameSync", `${P}.tmp`, P],
  ], "the write is tmp+rename, in that order — atomic");
  assert.equal(`${P}.tmp` in fs.files, false, "the tmp file is renamed away");
  const text = fs.files[P];
  const expected = { version: 1, deploymentDir: DIR, env: { PI_LOGS_DIR: join(DIR, "logs") } };
  assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`, "2-space JSON with a trailing newline, hand-editable");
  assert.deepEqual(readPointer({ path: P, fs }), { pointer: expected }, "the write round-trips through the read side");
});

test("pointerPath: agent-dir default, PI_CODING_AGENT_DIR override, PI_DISPATCH_DEPLOYMENT_FILE override, || fallback on empty", () => {
  assert.equal(pointerPath({}), join(homedir(), ".pi", "agent", "pi-dispatch-deployment.json"));
  assert.equal(
    pointerPath({ PI_CODING_AGENT_DIR: "/custom/agent" }),
    join("/custom/agent", "pi-dispatch-deployment.json"),
  );
  assert.equal(pointerPath({ PI_DISPATCH_DEPLOYMENT_FILE: "/elsewhere/p.json" }), "/elsewhere/p.json");
  // `||` semantics on both reads: an empty override falls back rather than producing "" or "/pi-dispatch...".
  assert.equal(pointerPath({ PI_DISPATCH_DEPLOYMENT_FILE: "" }), join(homedir(), ".pi", "agent", "pi-dispatch-deployment.json"));
  assert.equal(
    pointerPath({ PI_CODING_AGENT_DIR: "", PI_DISPATCH_DEPLOYMENT_FILE: "" }),
    join(homedir(), ".pi", "agent", "pi-dispatch-deployment.json"),
  );
});

test("resetForTests clears the memo, the notice, and the owned-key ledger", () => {
  resetForTests();
  const fs = fakeFs({ [P]: pointerJson({ PI_LOGS_DIR: "/a/logs" }, { version: 2 }) });
  applyDeploymentPointer(envWith(), { fs });
  resetForTests();
  assert.equal(takePointerNotice(), undefined, "the retained notice does not leak across a reset");
  // The memo is cleared: a fresh apply re-reads the (now valid, changed) file into a fresh env.
  fs.files[P] = pointerJson({ PI_LOGS_DIR: "/b/logs" });
  const env = envWith();
  const res = applyDeploymentPointer(env, { fs });
  assert.deepEqual(res.applied, ["PI_LOGS_DIR"]);
  assert.equal(env.PI_LOGS_DIR, "/b/logs");
});

test("the allowlist is exactly the seven resolvePaths path/URL keys, and the version constant is 1", () => {
  // A guard for the contract itself: adding a key here must be a reviewed decision (the docblock's
  // "paths only, never credentials, never capability grants"), so the exact list is pinned.
  assert.deepEqual([...POINTER_ENV_ALLOWLIST].sort(), [
    "PI_LOGS_DIR",
    "PI_PAUSE_WINDOWS_FILE",
    "PI_SCOPED_LIMITS_FILE",
    "PI_SETTINGS_FILE",
    "PI_SUBSCRIPTIONS_FILE",
    "PI_TRIGGERS_FILE",
    "VALKEY_URL",
  ]);
  assert.equal(POINTER_VERSION, 1);
});
