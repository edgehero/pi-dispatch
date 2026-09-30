import { test } from "node:test";
import assert from "node:assert/strict";
// Static, unlike env-allowlist below: provider-key.mjs imports nothing at all, so its own rules are
// testable on a box where pi-ai will not load and the oracle round-trips skip.
import { BEARER_KEY_RE, OAUTH_KEY_RE, apiKeyVariable, nonApiKeyKind } from "../src/provider-key.mjs";

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

test("apiKeyVariable skips the bearer token too, which pi 0.99.1 lists FIRST (#509)", () => {
	assert.equal(apiKeyVariable(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]), "ANTHROPIC_API_KEY");
	assert.equal(apiKeyVariable(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]), "ANTHROPIC_API_KEY");
	// The two rules are distinct: `_OAUTH_TOKEN` does not end in `_AUTH_TOKEN` (an O sits before AUTH), so
	// each kind is named for what it is and doctor can give each its own advice.
	assert.equal(nonApiKeyKind("ANTHROPIC_AUTH_TOKEN"), "bearer");
	assert.equal(nonApiKeyKind("ANTHROPIC_OAUTH_TOKEN"), "oauth");
	assert.equal(nonApiKeyKind("ANTHROPIC_API_KEY"), null);
	assert.equal(nonApiKeyKind("HF_TOKEN"), null, "a bare _TOKEN suffix is an ordinary key variable");
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

test("provider-key.mjs imports nothing, which is the property that lets both callers share it", async () => {
	// Load-bearing, and stated as such in INT-CONTAINER-RUNTIME-CONTRACT. doctor.mjs imports this file
	// STATICALLY, and reaches env-allowlist.mjs only through `await import` so its Node-floor check prints
	// before pi is loaded. An import added here would be pulled into doctor's static graph and every test in
	// doctor.test.mjs would ERROR at load on a below-floor box instead of skipping, with
	// PI_DISPATCH_REQUIRE_WORKER_TESTS -- the mechanism built to tell those two cases apart -- never getting
	// to speak. Same pin, same wording, as forges.test.mjs carries for the same reason.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/provider-key.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(source), false, "provider-key.mjs must stay import-free");
});

test("the OAuth suffix rule is pinned against pi, not against a table", { skip: skipNoPi }, () => {
	// Both directions, with pi as the oracle. The suffix rule is the ONE credential fact this project
	// holds itself, because it is a statement about a credential that must NOT be used and so cannot come
	// from a table of credentials that do.
	// At the 0.99.1 pin anthropic's list is [ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY]
	// (issue #509): the bearer token first, the OAuth token second, and both ahead of the API key.
	const anthropic = providerKeyCandidates("anthropic");
	assert.ok(BEARER_KEY_RE.test(anthropic[0]), "anthropic's first candidate IS the bearer token");
	assert.ok(OAUTH_KEY_RE.test(anthropic[1]), "anthropic's second candidate IS the OAuth token");
	const matching = [...piProviders(), "radius"].flatMap((id) => providerKeyCandidates(id).filter((name) => OAUTH_KEY_RE.test(name)));
	assert.deepEqual(matching, ["ANTHROPIC_OAUTH_TOKEN"], "exactly one variable pi reads is an OAuth token today");
	const bearer = [...piProviders(), "radius"].flatMap((id) => providerKeyCandidates(id).filter((name) => BEARER_KEY_RE.test(name)));
	assert.deepEqual(bearer, ["ANTHROPIC_AUTH_TOKEN"], "exactly one variable pi reads is a bearer token today");
});

test("the bearer rule is pi's own distinction, not ours: pi's getEnvApiKey skips the same variable", { skip: skipNoPi }, async () => {
	// pi sends ANTHROPIC_AUTH_TOKEN as `Authorization: Bearer` and its own API-key lookup steps over it,
	// so an API key written under it would be a value in the wrong header. Asked of pi, with an env that
	// carries only the bearer token beside an API key: pi's API key is the API key, not the token.
	const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");
	assert.equal(getEnvApiKey("anthropic", { ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_API_KEY: "sk-key" }), "sk-key");
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
