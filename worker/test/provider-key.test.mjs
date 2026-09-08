import { test } from "node:test";
import assert from "node:assert/strict";
// Static, unlike env-allowlist below: provider-key.mjs imports nothing at all, so its own rules are
// testable on a box where pi-ai will not load and the oracle round-trips skip.
import { OAUTH_KEY_RE, apiKeyVariable } from "../src/provider-key.mjs";

// env-allowlist imports @earendil-works/pi-ai (for findEnvKeys). That needs node >=22.19.0 and installed
// deps, so the round-trips skip on a below-floor dev box and run in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure. Same guard as
// env-allowlist.test.mjs and doctor.test.mjs, same reason.
let piMod;
let piImportError;
try {
	piMod = await import("../src/env-allowlist.mjs");
} catch (error) {
	piImportError = error;
}
if (!piMod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`the provider-key oracle tests are REQUIRED here but pi-ai could not import.\n${piImportError}`);
}
const skipNoPi = piMod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;
const { piProviders, providerKeyCandidates } = piMod ?? {};

test("apiKeyVariable takes the first NON-OAuth candidate, not the first candidate", () => {
	assert.equal(apiKeyVariable(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]), "ANTHROPIC_API_KEY");
	assert.equal(apiKeyVariable(["GEMINI_API_KEY"]), "GEMINI_API_KEY");
	// Order within the non-OAuth names is still pi's: the FIRST one wins, because pi reads the first
	// present name and ignores the rest.
	assert.equal(apiKeyVariable(["A_KEY", "B_KEY"]), "A_KEY");
});

test("apiKeyVariable falls back to the first candidate only when every one is an OAuth token", () => {
	// No provider pi has today is this shape. The fallback exists so the day one appears the caller gets
	// pi's own answer rather than null, which would read as "pi knows no variable for this provider".
	assert.equal(apiKeyVariable(["SOMETHING_OAUTH_TOKEN"]), "SOMETHING_OAUTH_TOKEN");
});

test("apiKeyVariable returns null for an empty list, which is the caller's cue to refuse", () => {
	// `?? candidates[0] ?? null`: without the second `??` this returns undefined, and a caller testing
	// `if (!name)` would still refuse but a caller building an object would write a key named "undefined".
	assert.equal(apiKeyVariable([]), null);
});

test("the OAuth suffix rule is pinned against pi, not against a table", { skip: skipNoPi }, () => {
	// Both directions, with pi as the oracle. The suffix rule is the ONE credential fact this project
	// holds itself, because it is a statement about a credential that must NOT be used and so cannot come
	// from a table of credentials that do.
	assert.ok(OAUTH_KEY_RE.test(providerKeyCandidates("anthropic")[0]), "anthropic's first candidate IS the OAuth token");
	const matching = [...piProviders(), "radius"].flatMap((id) => providerKeyCandidates(id).filter((name) => OAUTH_KEY_RE.test(name)));
	assert.deepEqual(matching, ["ANTHROPIC_OAUTH_TOKEN"], "exactly one variable pi reads is an OAuth token today");
});

test("every provider pi reads a key for resolves to a non-OAuth variable pi actually reads", { skip: skipNoPi }, () => {
	// The selection is only useful if its answer is a member of pi's own list -- a name pi does not read
	// would be injected and ignored, and the job would fail auth with a variable set.
	for (const id of [...piProviders(), "radius"]) {
		const candidates = providerKeyCandidates(id);
		const picked = apiKeyVariable(candidates);
		if (candidates.length === 0) {
			assert.equal(picked, null, `${id} has no key variable, so there is nothing to pick`);
			continue;
		}
		assert.ok(candidates.includes(picked), `${id}: ${picked} is one of pi's own names`);
		assert.ok(!OAUTH_KEY_RE.test(picked), `${id}: ${picked} is not a subscription login`);
	}
});
