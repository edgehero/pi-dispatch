import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeInputs, writePauseWindows } from "../src/read-model.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// `writePauseWindows`' `expect` (issue #640): the console's confirm applies exactly what its preview was built from, or
// nothing. Real files, since the re-check reads the disk.
const add = (w) => (list) => [...list, w];
const W1 = { scope: "acme/web", from: "22:00", to: "06:00" };
const W2 = { scope: "acme/api", from: "01:00", to: "02:00" };

function setup(initial) {
  const dir = tempDir("pd-pwx-");
  const path = join(dir, "pause-windows.json");
  if (initial !== undefined) fs.writeFileSync(path, initial);
  return { dir, path };
}

test("with a matching expect the write lands", () => {
  const { path } = setup(JSON.stringify({ windows: [] }));
  const expect = writeInputs({ paths: [path], fs });
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), expect, fs }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).windows[0].scope, "acme/web");
});

test("a stale expect refuses, writes nothing and leaves no tmp file", () => {
  const { dir, path } = setup(JSON.stringify({ windows: [] }));
  const expect = writeInputs({ paths: [path], fs });
  // Another session writes between the preview and the confirm.
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W2), fs }), { ok: true });
  const between = fs.readFileSync(path, "utf8");
  const res = writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), expect, fs });
  assert.match(res.invalid, /pause-windows\.json changed after this change was built from it \(another session wrote it\); nothing was written/);
  assert.equal(fs.readFileSync(path, "utf8"), between, "the other session's write stands");
  assert.deepEqual(fs.readdirSync(dir), ["pause-windows.json"]);
});

test("an expect taken while the file was missing refuses once the file exists, and lands while it is still missing", () => {
  const { path } = setup();
  const expect = writeInputs({ paths: [path], fs });
  assert.deepEqual(expect, [{ path, text: null }]);
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), expect, fs }), { ok: true });
  assert.match(writePauseWindows({ pauseWindowsPath: path, mutate: add(W2), expect, fs }).invalid, /changed after/);
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).windows.length, 1);
});

test("without expect the default is unchanged: a missing or invalid file is repaired, a rejected edit writes nothing", () => {
  const { path } = setup();
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).windows.length, 1);
  fs.writeFileSync(path, "not json");
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W2), fs }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")).windows.map((w) => w.scope), ["acme/api"]);
  const before = fs.readFileSync(path, "utf8");
  assert.match(writePauseWindows({ pauseWindowsPath: path, mutate: add({ scope: "x", from: "09:00", to: "09:00" }), fs }).invalid, /from and to must differ/);
  assert.equal(fs.readFileSync(path, "utf8"), before);
});

test("without expect a write that lands between this call's read and its rename is not overwritten", () => {
  const { path } = setup(JSON.stringify({ windows: [] }));
  const racing = {
    ...fs,
    writeFileSync(p, data, opts) {
      fs.writeFileSync(p, data, opts);
      if (p.endsWith(".tmp")) fs.writeFileSync(path, JSON.stringify({ windows: [W2] }));
    },
  };
  assert.match(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs: racing }).invalid, /changed after/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")).windows, [W2]);
});

test("each write has a tmp file of its own: another writer's tmp at the old shared name is neither used nor touched", () => {
  const { dir, path } = setup(JSON.stringify({ windows: [] }));
  // What a second process mid-write would have on disk under a shared `<file>.tmp` name.
  fs.writeFileSync(`${path}.tmp`, "another writer's bytes\n");
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).windows[0].scope, "acme/web");
  assert.equal(fs.readFileSync(`${path}.tmp`, "utf8"), "another writer's bytes\n");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["pause-windows.json", "pause-windows.json.tmp"], "this write left no tmp of its own");
});
