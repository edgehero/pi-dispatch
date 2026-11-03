import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONSOLE_PICKS, CONSOLE_TRANSCRIPT } from "../../launch/console-picks.mjs";
import { CONSOLE_THEMES, CONSOLE_WIDTHS, matrixOf, picksPlan } from "../../launch/console-render.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #752: `render-images.mjs --console` turns the goldens into images. What it shoots is held here without Chrome: a
// browser run belongs to whoever renders, and PNGs are not held to bytes. A stale pick still fails here, on the name.

const SCRIPT = fileURLToPath(new URL("../../launch/render-images.mjs", import.meta.url));
const GOLDENS = fileURLToPath(new URL("./fixtures/console/", import.meta.url));
const keysIn = (dir, prefix = "") => readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => `${prefix}${f.slice(0, -".html".length)}`);
const KEYS = [...keysIn(GOLDENS), ...keysIn(join(GOLDENS, "panels"), "panels/")];
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("the full matrix is every golden at both widths and both themes, each in a file of its own", () => {
  const shots = matrixOf(KEYS);
  assert.deepEqual([...CONSOLE_WIDTHS], [1440, 375]);
  assert.deepEqual([...CONSOLE_THEMES], ["light", "dark"]);
  assert.equal(shots.length, KEYS.length * 4);
  assert.equal(new Set(shots.map((shot) => shot.file)).size, shots.length, "no two shots write one file");
  assert.ok(shots.every((shot) => /^[a-z0-9.-]+\.(1440|375)\.(light|dark)\.png$/.test(shot.file)), "a flat folder of plain names");
});

test("every pick names a golden that exists, with a name of its own", () => {
  const plan = picksPlan();
  assert.equal(plan.length, CONSOLE_PICKS.length);
  assert.equal(new Set(plan.map((shot) => shot.file)).size, plan.length);
  for (const shot of plan) {
    assert.ok(KEYS.includes(shot.key), `${shot.file}: no golden ${shot.key}`);
    assert.ok(CONSOLE_WIDTHS.includes(shot.width), `${shot.file}: a width the console is checked at`);
    assert.ok(CONSOLE_THEMES.includes(shot.theme));
    assert.match(shot.file, /^console-[a-z-]+\.png$/);
  }
});

test("the live run page's pick gets the transcript, and the transcript holds nothing a run could not have said", () => {
  const live = picksPlan().find((shot) => shot.file === "console-run-live.png");
  assert.equal(live.key, "panels/run-live-armed.operator");
  assert.equal(live.transcript, "gh-b3d7", "the run id the page's stream asks by");
  assert.equal(picksPlan().find((shot) => shot.file === "console-question.png").transcript, "gh-2f6a");
  for (const shot of picksPlan().filter((pick) => pick.transcript)) assert.ok(Array.isArray(CONSOLE_TRANSCRIPT[shot.transcript]), `${shot.file}: its run has a transcript`);
  for (const entries of Object.values(CONSOLE_TRANSCRIPT)) {
    assert.ok(entries.length > 0);
    assert.deepEqual(entries.map((entry) => entry.id), entries.map((_, at) => String(at + 1)), "ids in order, as the stream's cursor needs");
    const at = entries.map((entry) => entry.ts);
    assert.deepEqual(at, [...at].sort((a, b) => a - b), "times in order");
  }
});

test("the flags refuse what makes no sense, in a sentence, before anything starts", () => {
  for (const [args, said] of [
    [["--all"], /--all and --only go with --console/],
    [["--only", "overview.operator"], /--all and --only go with --console/],
    [["--console", "--all", "--only", "overview.operator"], /pick one/],
    [["--console", "--png"], /--console takes neither --png nor --url/],
    [["--console", "--url", "redis://127.0.0.1:6379/9"], /--console takes neither --png nor --url/],
  ]) {
    const got = run(args);
    assert.equal(got.status, 2, args.join(" "));
    assert.match(got.stderr, said);
  }
});

test("--console needs Chrome and says so, and needs no server", () => {
  const got = run(["--console", "--out", tempDir("console-render-")], { CHROME: "/nonexistent/chrome", PATH: "/nonexistent" });
  assert.equal(got.status, 2);
  assert.match(got.stderr, /--console needs Google Chrome/);
  assert.doesNotMatch(got.stderr, /valkey-server/, "it never asks for a server");
});
