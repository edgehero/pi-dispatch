import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileViewsFixture, noSnapshotFleet } from "./helpers/no-snapshot.mjs";

/**
 * The outage fixtures in a test file that imports no temp folder helper of its own and first uses them inside a test
 * (issue #988). The helper loads the temp folder helper at that first use, so the folder it makes is removed when
 * that test ends: the fixtures must then be written again, never read as a deployment whose files are all missing.
 */

let first = null;
let settingsPath = null;

test("the first use of the outage fixtures, inside a test, reads the deployment's files", () => {
  first = fileViewsFixture({ pinned: false });
  settingsPath = first.settings.path;
  assert.deepEqual(first.projects.projects.map((p) => p.id), ["web"]);
  assert.equal(first.triggers.triggers.length, 2);
  assert.ok(existsSync(settingsPath));
});

test("a later test of the same file still reads them: the folder the first test's end removed is written again", () => {
  assert.equal(existsSync(settingsPath), false, "the first folder went with the test that made it");
  const again = fileViewsFixture({ pinned: false });
  assert.deepEqual(again.projects, first.projects, "never `missing`");
  assert.deepEqual(again.triggers, first.triggers);
  assert.deepEqual(again.settings.overlay, first.settings.overlay);
  assert.deepEqual(noSnapshotFleet().fileViews().projects, first.projects);
  assert.ok(existsSync(again.settings.path));
});
