import assert from "node:assert/strict";
import { test } from "node:test";
import * as worker from "@edgehero/pi-dispatch/provider-key-names";
import * as admin from "../src/provider-key-names.mjs";

// Issue #1013: the generated table is the worker's leaf (worker/test/provider-key-names.test.mjs holds it to pinned pi);
// the console reads that one table, never a copy of its own.
test("the console's provider-key table is the worker's generated leaf, re-exported", () => {
  assert.deepEqual(Object.keys(admin).sort(), ["PROVIDER_KEYS_SOURCE_SHA256", "PROVIDER_KEY_NAMES", "providerKeyNames"]);
  assert.equal(admin.PROVIDER_KEY_NAMES, worker.PROVIDER_KEY_NAMES);
  assert.equal(admin.PROVIDER_KEYS_SOURCE_SHA256, worker.PROVIDER_KEYS_SOURCE_SHA256);
  assert.equal(admin.providerKeyNames, worker.providerKeyNames);
});
