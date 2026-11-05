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

test("without expect the default is unchanged: a missing file starts one, a rejected edit writes nothing", () => {
  const { path } = setup();
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).windows.length, 1);
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

// Only a missing file may start from nothing. `failed` makes the reads named by `which` fail, and every other one succeed.
const failed = (path, which) => {
  let reads = 0;
  return { ...fs, readFileSync: (p, ...rest) => {
    if (p === path) {
      reads += 1;
      if (which(reads)) throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return fs.readFileSync(p, ...rest);
  } };
};
for (const [what, which, withExpect] of [
  ["one failed read, the re-check against the preview passing", (n) => n === 1, true],
  ["one failed read, no preview", (n) => n === 1, false],
  ["every read failing, the re-check comparing two failures", () => true, false],
]) {
  test(`a file that is there and cannot be read refuses, with every window kept: ${what}`, () => {
    const text = JSON.stringify({ windows: [W1, W2] });
    const { dir, path } = setup(text);
    let mutated = false;
    const res = writePauseWindows({ pauseWindowsPath: path, mutate: () => { mutated = true; return []; }, expect: withExpect ? [{ path, text }] : null, fs: failed(path, which) });
    assert.equal(res.invalid, `the pause-windows file ${path} could not be read (EIO), so its windows cannot be kept; nothing was written`);
    assert.equal(mutated, false);
    assert.equal(fs.readFileSync(path, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["pause-windows.json"]);
  });
}

test("only a file that holds nothing starts from nothing: missing, empty, whitespace, a byte-order mark alone", () => {
  const { path } = setup();
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).windows.length, 1);
  for (const nothing of ["", "\n  \n", "\ufeff", "\ufeff\n"]) {
    const empty = setup(nothing);
    assert.deepEqual(writePauseWindows({ pauseWindowsPath: empty.path, mutate: add(W1), fs }), { ok: true }, JSON.stringify(nothing));
    assert.equal(JSON.parse(fs.readFileSync(empty.path, "utf8")).windows.length, 1);
  }
});

for (const [what, text, says] of [
  ["a stray comma", `{ "windows": [,\n  ${JSON.stringify(W1)},\n  ${JSON.stringify(W2)}\n] }\n`, "is not valid JSON"],
  ["a byte-order mark before a whole file", `\ufeff${JSON.stringify({ windows: [W1] })}\n`, "is not valid JSON (it starts with a byte-order mark)"],
  ["a bare list", `${JSON.stringify([W1, W2])}\n`, "is not a JSON object"],
  ["null", "null\n", "is not a JSON object"],
  ["a string", '"windows"\n', "is not a JSON object"],
  ["a number", "7\n", "is not a JSON object"],
  ["an object for windows", `${JSON.stringify({ windows: { a: W1 } })}\n`, 'has a "windows" that is not a list'],
  ["null for windows", `${JSON.stringify({ windows: null })}\n`, 'has a "windows" that is not a list'],
]) {
  test(`a pause-windows file with ${what} refuses a write, in words, with every byte kept and mutate never asked`, () => {
    const { path, dir } = setup(text);
    let asked = false;
    const res = writePauseWindows({ pauseWindowsPath: path, mutate: (list) => { asked = true; return [...list, W1]; }, fs });
    assert.deepEqual(res, { invalid: `the pause-windows file ${path} ${says}, so its windows cannot be kept; nothing was written. Fix the file, or move it aside to start from an empty one`, malformed: true });
    assert.equal(asked, false);
    assert.equal(fs.readFileSync(path, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["pause-windows.json"], "and no tmp file");
  });
}

test("a file a newer release wrote is told to upgrade, whatever shape its windows have, by both writers' reading", () => {
  const text = '{ "version": 99, "windows": { "future": true } }\n';
  const { path } = setup(text);
  const res = writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs });
  assert.equal(res.newer, true);
  assert.match(res.invalid, /written by a newer pi-dispatch/);
  assert.equal(fs.readFileSync(path, "utf8"), text);
});

test("a key written twice refuses, since the windows a person can read in the file would go on a write", () => {
  const text = `{ "windows": [${JSON.stringify(W1)}, ${JSON.stringify(W2)}], "windows": [] }\n`;
  const { path } = setup(text);
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs }), { invalid: `the pause-windows file ${path} has a key written twice, so its windows cannot be kept; nothing was written. Fix the file, or move it aside to start from an empty one`, malformed: true });
  assert.equal(fs.readFileSync(path, "utf8"), text);
});

test("the refusal quotes nothing of the file, whatever it holds", () => {
  const { path } = setup('{ "windows": [, "a secret-looking word" ] }');
  assert.doesNotMatch(writePauseWindows({ pauseWindowsPath: path, mutate: add(W1), fs }).invalid, /secret/);
});

test("a file with no windows key, and one with a bad window, are not refused: what they hold can be kept or fixed", () => {
  const blocks = setup(`${JSON.stringify({ later: { kept: true } })}\n`);
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: blocks.path, mutate: add(W1), fs }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(blocks.path, "utf8")), { later: { kept: true }, windows: [W1] });
  const bad = setup(`${JSON.stringify({ windows: [{ scope: "x", from: "09:00", to: "09:00" }, W2] })}\n`);
  assert.deepEqual(writePauseWindows({ pauseWindowsPath: bad.path, mutate: (list) => list.slice(1), fs }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(bad.path, "utf8")).windows, [W2]);
});

test("a read failing at the re-check says so, and names no other session", () => {
  const text = JSON.stringify({ windows: [W1] });
  const { dir, path } = setup(text);
  const res = writePauseWindows({ pauseWindowsPath: path, mutate: (list) => list, expect: [{ path, text }], fs: failed(path, (n) => n === 2) });
  assert.equal(res.invalid, `${path} could not be read (EIO) when this change was checked against it; nothing was written. Look again and retry`);
  assert.equal(fs.readFileSync(path, "utf8"), text);
  assert.deepEqual(fs.readdirSync(dir), ["pause-windows.json"]);
});

for (const [what, method] of [["the tmp file's write", "writeFileSync"], ["the rename", "renameSync"]]) {
  test(`a failure of ${what} throws with the old file whole, and leaves no tmp file`, () => {
    const text = JSON.stringify({ windows: [W1] });
    const { dir, path } = setup(text);
    const failing = { ...fs, [method]: (target, ...rest) => {
      // A write that gets part of the way: the bytes are there, and the call still fails.
      if (method === "writeFileSync") fs.writeFileSync(target, "half", { flag: "wx" });
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    } };
    assert.throws(() => writePauseWindows({ pauseWindowsPath: path, mutate: add(W2), fs: failing }), (e) => e.code === "ENOSPC");
    assert.equal(fs.readFileSync(path, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["pause-windows.json"]);
  });
}
