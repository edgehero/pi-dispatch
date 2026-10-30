import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, fork } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NODE_BUNDLE_OPTIONS, NODE_REQUIRE_PRELUDE } from "../bundle-options.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

test("both published ESM entry points load in plain Node without jiti's CommonJS require", async () => {
  const dir = tempDir("dispatch-esm-bundle-");
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(dir, "node_modules"), "junction");
  for (const [entry, exported] of [["index.ts", "default"], ["console/cli.mjs", "runCli"]]) {
    const outfile = join(dir, entry.replaceAll("/", "-").replace(/\.(ts|mjs)$/, ".mjs"));
    await build({ ...NODE_BUNDLE_OPTIONS, entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))], outfile, banner: { js: NODE_REQUIRE_PRELUDE }, logLevel: "silent" });
    const program = `import assert from "node:assert/strict"; assert.equal(typeof require, "undefined"); const mod = await import(${JSON.stringify(pathToFileURL(outfile).href)}); assert.equal(typeof mod[${JSON.stringify(exported)}], "function"); console.log("loaded");`;
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", timeout: 30_000 }).trim(), "loaded");
  }
});

test("the shipped sandbox monitor is a separate bundled IPC program and refuses invalid tracking configuration", async () => {
  const source = fileURLToPath(new URL("../../worker/src/sandbox-session-monitor.mjs", import.meta.url));
  const script = readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
  assert.ok(script.includes('entryPoints: [join(here, "../worker/src/sandbox-session-monitor.mjs")]'));
  assert.ok(script.includes('outfile: join(here, "dist/sandbox-session-monitor.mjs")'));
  const dir = tempDir("dispatch-monitor-bundle-");
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(dir, "node_modules"), "junction");
  const outfile = join(dir, "sandbox-session-monitor.mjs");
  await build({ ...NODE_BUNDLE_OPTIONS, entryPoints: [source], outfile, banner: { js: NODE_REQUIRE_PRELUDE }, logLevel: "silent" });
  const child = fork(outfile, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const ready = once(child, "message", { signal: AbortSignal.timeout(5000) });
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    // The invalid scheme refuses before any socket or runtime operation is possible.
    child.send({ valkeyUrl: "invalid://tracking", host: "mini1", id: "gh-1" });
    assert.deepEqual((await ready)[0], { ready: false });
    assert.equal((await exited)[0], 0);
  } finally { child.kill(); }
});
