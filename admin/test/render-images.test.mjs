import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findOnPath } from "../../launch/server-binary.mjs";
import { svgRows } from "../../launch/transcript-svg.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The README's panel images (issue #599): `launch/render-images.mjs` draws them from the shipped panel over a canned
 * deployment it seeds into a Valkey of its own. Run twice here, its SVGs must be byte-identical to each other and to
 * the committed `docs/images` files, hold only the fixture's synthetic names, and carry no terminal escape. Chrome
 * never runs here (no `--png`).
 *
 * The script needs a Valkey-protocol server that runs BullMQ's Lua, which no in-process fake does: a `valkey-server`
 * or `redis-server` on PATH (it starts its own on a free port), or else VALKEY_TEST_URL, where it takes database 7
 * (the suite's other live tests use 0 and 12 to 15) and refuses unless that database is empty, emptying it again when
 * done. Without either it is skipped.
 */
const SCRIPT = fileURLToPath(new URL("../../launch/render-images.mjs", import.meta.url));
const BIN = findOnPath(["valkey-server", "redis-server"]);
const BASE = process.env.VALKEY_TEST_URL;
const URL_ARGS = BIN ? [] : BASE ? ["--url", `${BASE.replace(/\/\d*$/, "")}/7`] : null;
const skip = URL_ARGS === null ? "needs valkey-server or redis-server on PATH, or VALKEY_TEST_URL" : false;
const run = promisify(execFile);

async function render() {
  const out = tempDir("render-images-");
  // The child's environment is the PATH (to find the server) and the TMPDIR (the suite's own) alone; the script empties
  // its environment anyway before any project module loads.
  await run(process.execPath, [SCRIPT, "--out", out, ...URL_ARGS], { env: { PATH: process.env.PATH ?? "", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }, timeout: 120_000 });
  return Object.fromEntries(["dispatch-dashboard.svg", "dispatch-hosts.svg"].map((f) => [f, readFileSync(join(out, f), "utf8")]));
}

test("render-images: two runs draw byte-identical SVGs of the LIST and the HOSTS view, with synthetic names only", { skip, timeout: 240_000 }, async () => {
  const first = await render();
  // The committed images ARE this render: a change to the panel, the fixture or the clock shows up here, and the fix is
  // to re-render them (and look at them), not to edit this test.
  for (const [file, svg] of Object.entries(first)) {
    const committed = readFileSync(fileURLToPath(new URL(`../../docs/images/${file}`, import.meta.url)), "utf8");
    assert.ok(svg === committed, `docs/images/${file} is not what the script draws now: run \`node launch/render-images.mjs\` (and --png for the PNGs), look at the images, bump their ?v= in both READMEs, and commit them`);
  }
  const second = await render();
  for (const [file, svg] of Object.entries(first)) {
    assert.equal(second[file], svg, `${file} is the same bytes on a second run`);
    const text = svgRows(svg).join("\n");
    assert.doesNotMatch(svg, /\x1b/, `${file} carries no terminal escape`);
    assert.doesNotMatch(svg, /\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\//, `${file} names no path of this machine`);
    assert.doesNotMatch(svg, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${file} holds no email address`);
    const host = hostname().split(".")[0];
    if (host.length >= 3) assert.ok(!svg.toLowerCase().includes(host.toLowerCase()), `${file} does not name this machine`);
    for (const name of ["mini1", "mini2", "build3"]) assert.ok(text.includes(name) || file === "dispatch-dashboard.svg", `${file} shows ${name}`);
  }
  const list = svgRows(first["dispatch-dashboard.svg"]).join("\n");
  assert.match(list, /j projects · u hosts/, "the LIST announces the HOSTS view on the runs divider");
  const hosts = svgRows(first["dispatch-hosts.svg"]).join("\n");
  assert.match(hosts, /hosts · 3 live · last 7d/);
  assert.match(hosts, /Jobs only: a machine busy with other work reads as idle/);
});
