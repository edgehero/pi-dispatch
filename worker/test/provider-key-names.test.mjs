import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { piOwnPackageDir } from "../../image/runner/src/usage-meter.mjs";
import { declaredProviderKey, providerKeyCandidates, piProviders } from "../src/env-allowlist.mjs";
import { apiKeyVariable } from "../src/provider-key.mjs";
import { DECLARABLE_PROVIDER_KEYS } from "../src/triggers.mjs";
import { generateProviderKeys } from "../../.github/scripts/provider-key-names.mjs";
import { PROVIDER_KEY_NAMES, PROVIDER_KEYS_SOURCE_SHA256, providerKeyNames } from "../src/provider-key-names.mjs";

// The one generated table of pi's provider key variables (#751), the worker's data-only leaf since issue #1013: the
// triggers loader judges a declared key by it, and the console re-exports it (admin/test/provider-key-names.test.mjs).
test("the provider-key source hash is the installed pinned artifact, not upstream HEAD", () => {
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

test("issue #1013: the loader's declarable keys are exactly the names the worker admits as some pi provider's declared key", () => {
	// The worker's own rule, asked of every provider pi has with its API-key variable bound: what the loader lets an answer
	// rule or the zeroTouch block declare is what some job could take as its key, and nothing else.
	const admitted = new Set(piProviders().map((provider) => {
		const name = apiKeyVariable(providerKeyCandidates(provider));
		return name === null ? null : declaredProviderKey({ provider, secrets: { [name]: "ref" } });
	}).filter((name) => name !== null));
	assert.deepEqual(DECLARABLE_PROVIDER_KEYS, [...admitted].sort());
	assert.ok(DECLARABLE_PROVIDER_KEYS.includes("OPENAI_API_KEY") && !DECLARABLE_PROVIDER_KEYS.includes("COPILOT_GITHUB_TOKEN") && !DECLARABLE_PROVIDER_KEYS.includes("ANTHROPIC_OAUTH_TOKEN"));
});
