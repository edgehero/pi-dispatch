import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { writeInputs, writeSettings, writeTriggers } from "../src/read-model.mjs";
import { fileSnapshot } from "../../worker/src/file-expect.mjs";
import { applyStandingAnswerAdd } from "../src/answerer-actions.mjs";
import { applyZeroTouchFilePlan } from "../src/zero-touch-actions.mjs";

// Issue #642: `writeSettings` and `writeTriggers` take the console's `expect` (a `writeInputs` snapshot) and re-check it
// right before the rename. The snapshot is taken here, through the admin, and compared in the worker, so the two
// encodings must be one.

test("writeInputs and the worker's re-check share one snapshot encoding: text, null for missing, a marker for unreadable", () => {
  const dir = tempDir("pd-642-enc-");
  const file = join(dir, "f.json");
  realFs.writeFileSync(file, "{}\n");
  const paths = [file, join(dir, "missing.json"), dir];
  assert.deepEqual(writeInputs({ paths }).map((i) => i.text), paths.map((p) => fileSnapshot(realFs, p)));
});

test("writeSettings with expect refuses a settings file another session changed after the preview, and writes nothing", () => {
  const dir = tempDir("pd-642-settings-");
  const settingsFile = join(dir, "settings.json");
  realFs.writeFileSync(settingsFile, `${JSON.stringify({ model: "a" }, null, 2)}\n`);
  const expect = writeInputs({ paths: [settingsFile] });
  realFs.writeFileSync(settingsFile, `${JSON.stringify({ model: "b" }, null, 2)}\n`);
  const res = writeSettings({ settingsFile, expect, mutate: (o) => ({ ...o, maxTurns: 9 }) });
  assert.match(res.invalid, /settings\.json changed after this change was built from it \(another session wrote it\); nothing was written/);
  assert.deepEqual(JSON.parse(realFs.readFileSync(settingsFile, "utf8")), { model: "b" });
  assert.deepEqual(realFs.readdirSync(dir), ["settings.json"], "no tmp left behind");
  const ok = writeSettings({ settingsFile, expect: writeInputs({ paths: [settingsFile] }), mutate: (o) => ({ ...o, maxTurns: 9 }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(realFs.readFileSync(settingsFile, "utf8")), { model: "b", maxTurns: 9 });
  // Without expect: what it always did.
  assert.equal(writeSettings({ settingsFile, mutate: (o) => ({ ...o, maxTurns: 10 }) }).ok, true);
});

test("writeTriggers through the read model takes expect too (the worker's locked writer)", () => {
  const dir = tempDir("pd-642-triggers-");
  const triggersPath = join(dir, "triggers.json");
  const cron = (id) => ({ on: { type: "cron", id, pattern: "0 3 * * *" }, run: { kind: "local", folder: "/tmp", flow: "f", task: "t" } });
  realFs.writeFileSync(triggersPath, `${JSON.stringify({ triggers: [cron("a")] }, null, 2)}\n`);
  const expect = writeInputs({ paths: [triggersPath] });
  realFs.writeFileSync(triggersPath, `${JSON.stringify({ triggers: [cron("a"), cron("b")] }, null, 2)}\n`);
  assert.match(writeTriggers({ triggersPath, expect, mutate: (l) => [...l, cron("c")] }).invalid, /changed after this change was built from it/);
  assert.equal(JSON.parse(realFs.readFileSync(triggersPath, "utf8")).triggers.length, 2);
});

// The two appliers that hand the shared writer's answer on with nothing between: one failed read, the re-check after it
// passing, and each says the writer's sentence with the file as it was. `mutate` would empty the list if it were ever called.
for (const [what, apply, kind] of [["a standing answer", applyStandingAnswerAdd, "standing-answer-add"], ["a Zero touch fix", applyZeroTouchFilePlan, "instructions"]]) {
  test(`${what}: a failed read of the triggers file refuses, and no trigger is lost`, () => {
    const dir = tempDir("pd-eio-apply-");
    const triggersPath = join(dir, "triggers.json");
    const before = `${JSON.stringify({ triggers: [{ on: { type: "cron", id: "a", pattern: "0 1 * * *" }, run: { kind: "local", folder: "/w", flow: "f" } }] }, null, 2)}\n`;
    realFs.writeFileSync(triggersPath, before);
    let armed = true;
    const fs = { ...realFs, readFileSync: (path, ...rest) => {
      if (armed && path === triggersPath) {
        armed = false;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return realFs.readFileSync(path, ...rest);
    } };
    const res = apply({ plan: { kind, mutate: () => [], expect: [{ path: triggersPath, text: before }] }, paths: { triggersPath }, fs });
    assert.equal(res.invalid, `the triggers file ${triggersPath} could not be read (EIO), so its triggers cannot be kept; nothing was written`);
    assert.equal(realFs.readFileSync(triggersPath, "utf8"), before);
  });
}
