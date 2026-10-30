import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { piOwnPackageDir } from "../../image/runner/src/usage-meter.mjs";
import { providerKeyCandidates, piProviders } from "../../worker/src/env-allowlist.mjs";
import { generateProviderKeys } from "../../.github/scripts/provider-key-names.mjs";
import { PROVIDER_KEY_NAMES, PROVIDER_KEYS_SOURCE_SHA256, providerKeyNames } from "../src/provider-key-names.mjs";

test("the console's provider-key source hash is the installed pinned artifact, not upstream HEAD", () => {
  const source = readFileSync(join(piOwnPackageDir("pi-ai"), "dist/env-api-keys.js"));
  assert.equal(createHash("sha256").update(source).digest("hex"), PROVIDER_KEYS_SOURCE_SHA256, "Read the new pinned env-api-keys.js before regenerating the catalogue");
});
test("every generated provider and key order equals the worker's discovery against pinned pi", async () => {
  assert.deepEqual(Object.keys(PROVIDER_KEY_NAMES), piProviders().sort());
  for (const provider of piProviders()) assert.deepEqual(providerKeyNames(provider), providerKeyCandidates(provider), provider);
  assert.deepEqual(providerKeyNames("__proto__"), []);
  assert.deepEqual(providerKeyNames("unknown-custom-provider"), []);
  assert.equal(readFileSync(new URL("../src/provider-key-names.mjs", import.meta.url), "utf8"), await generateProviderKeys());
});
