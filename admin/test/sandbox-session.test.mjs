import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The panel's sandbox entry point, loaded through pi's own jiti exactly as the extension is (#277).
 *
 * RUN_DETAIL advertises `b` from `readSandboxInfo`'s `retained` verdict, and the key press goes through
 * `resolveSandbox`. Both have to refuse a run from another venue, or the panel offers a key the worker's own
 * choke point then refuses -- or, before #277, opens it.
 */
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "admin-sandbox-agent-"));

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

/** A retention root holding one run, written the way `retainJobDir` writes it. */
function retainedRoot(extra) {
  const sandboxDir = mkdtempSync(join(tmpdir(), "admin-sbx-"));
  mkdirSync(join(sandboxDir, "gh-1"), { recursive: true });
  writeFileSync(join(sandboxDir, "gh-1", "manifest.json"), JSON.stringify({ jobId: "gh-1", kind: "github", image: "pi-job:latest", workspace: "/w", createdAt: "2026-09-14T08:00:00.000Z", keepUntil: null, ...extra }));
  return sandboxDir;
}

const NOW = Date.parse("2026-09-14T09:00:00.000Z");

test("the panel does not advertise a sandbox for a run from another venue, and says which (#277)", () => {
  const paths = { sandboxDir: retainedRoot({ backend: "far" }), sandboxRetentionHours: 24 };
  const info = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW });
  assert.equal(info.retained, false, "`retained` is the verdict the dashboard's `b` guard reads");
  assert.match(info.reason, /ran on far/);
});

test("a local run, and one retained before venues were recorded, are still re-openable from the panel", () => {
  const local = { sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 };
  assert.deepEqual(mod.readSandboxInfo(local, "gh-1", { now: () => NOW }), { retained: true, pinned: false, expiresIn: "23h" });
  const old = { sandboxDir: retainedRoot({}), sandboxRetentionHours: 24 };
  assert.equal(mod.readSandboxInfo(old, "gh-1", { now: () => NOW }).retained, true);
});

test("a manifest that names no venue is not advertised either", () => {
  const paths = { sandboxDir: retainedRoot({ backend: null }), sandboxRetentionHours: 24 };
  const info = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW });
  assert.equal(info.retained, false);
  assert.match(info.reason, /no venue recorded/);
});
