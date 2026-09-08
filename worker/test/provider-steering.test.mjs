import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDER_STEERING_VARS } from "../src/provider-steering.mjs";

// The bolt (issue #314). A hand-written table that restates a derivable source is either derived or
// pinned, never trusted, and this one is pinned in BOTH directions against the pinned artifacts
// themselves. The point is not that the current list is right today; it is that a pi bump which adds a
// steering variable fails HERE rather than opening a hole nobody notices.

// pi is resolved rather than skipped-around, so a below-floor box skips the file instead of erroring it,
// exactly like env-allowlist.test.mjs and provider-key.test.mjs.
let piAiDir;
let importError;
try {
	piAiDir = dirname(fileURLToPath(await import.meta.resolve("@earendil-works/pi-ai")));
} catch (error) {
	importError = error;
}
if (!piAiDir && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`provider-steering tests are REQUIRED here but pi-ai could not be resolved.\n${importError}`);
}
const skip = piAiDir ? false : "pi-ai not installed; CI runs these";

/** Every `NAME` matched by `re` in the .js files under `dir`, skipping the named subdirectories. */
function namesIn(dir, re, skipDirs) {
	const found = new Set();
	const walk = (d) => {
		for (const entry of readdirSync(d)) {
			if (skipDirs.has(entry)) continue;
			const p = join(d, entry);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".js")) for (const m of readFileSync(p, "utf8").matchAll(re)) found.add(m[1]);
		}
	};
	walk(dir);
	return found;
}

// SOURCE 1: pi's own provider configuration. `getProviderEnvValue(name, env)` is
// `env?.[name] || process.env[name]`, so every one of these is read from the real environment of the
// process the runner starts, which is the environment `run.secrets` writes into.
const PI_READ = /getProviderEnvValue\(\s*"([A-Za-z0-9_]+)"/g;
// SOURCE 2: the defaults inside the provider SDKs pi constructs clients from. These fire only when pi
// passes nothing for the option, which is the conditional the anthropic pin next door is about.
const SDK_READ = /readEnv\)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;

test("the set is exactly what the pinned pi and its provider SDKs read, in both directions", { skip }, () => {
	const derived = new Set([
		...namesIn(piAiDir, PI_READ, new Set(["node_modules"])),
		...namesIn(sdkDir("@anthropic-ai/sdk"), SDK_READ, new Set(["node_modules", "src", "_shims"])),
		...namesIn(sdkDir("openai"), SDK_READ, new Set(["node_modules", "src", "_shims"])),
	]);

	// A guard before the comparison, because an extractor that matches nothing would pass a subtraction and
	// fail an equality in a way that reads like a list problem rather than a scanner problem.
	assert.ok(derived.size > 20, `the extractors matched ${derived.size} names, which is too few to be real`);

	const missing = [...derived].filter((n) => !PROVIDER_STEERING_VARS.has(n)).sort();
	const extra = [...PROVIDER_STEERING_VARS].filter((n) => !derived.has(n)).sort();
	assert.deepEqual(
		missing,
		[],
		`pi or a provider SDK now reads ${missing.join(", ")} and the reserved set does not know about it. Do NOT delete this assertion: add the names to worker/src/provider-steering.mjs after checking what each one steers, because a trigger can bind anything this set does not name.`,
	);
	assert.deepEqual(
		extra,
		[],
		`the reserved set names ${extra.join(", ")}, which nothing in the pinned pi or its SDKs reads any more. Remove them, or the set has stopped being a derivation.`,
	);
});

test("the extractors still find the sites they are anchored on", { skip }, () => {
	// The failure this guards is silent: pi renames its accessor, both extractors match nothing, the
	// subtraction is empty in both directions and the bolt passes while pinning air. So each source is
	// asserted to contain a name only IT can supply.
	const fromPi = namesIn(piAiDir, PI_READ, new Set(["node_modules"]));
	assert.ok(fromPi.has("AZURE_OPENAI_BASE_URL"), "pi's getProviderEnvValue is no longer where azure's base URL is read -- find where it moved before touching the list");
	assert.ok(fromPi.has("AWS_BEARER_TOKEN_BEDROCK"), "pi's getProviderEnvValue is no longer where bedrock's credentials are read");
	const fromSdk = namesIn(sdkDir("@anthropic-ai/sdk"), SDK_READ, new Set(["node_modules", "src", "_shims"]));
	assert.ok(fromSdk.has("ANTHROPIC_BASE_URL"), "the Anthropic SDK constructor no longer defaults baseURL from the environment -- re-check the pin in env-allowlist.test.mjs before trusting this");
});

test("the names that motivated the issue are all in, and an ordinary name is not", { skip }, () => {
	// A literal pin beside the derivation, because a derived set is correct at any value and therefore
	// blind to a change IN that value. These are the ones measured to redirect a provider call.
	for (const name of ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_SECRET_ACCESS_KEY", "AWS_BEDROCK_SKIP_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_WEB_IDENTITY_TOKEN_FILE"]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} must be reserved`);
	}
	// And the bound. Reserving every name would make run.secrets useless, which is the feature this
	// protects rather than replaces.
	for (const name of ["STRIPE_KEY", "MY_APP_TOKEN", "DATABASE_URL", "NPM_TOKEN", "SENTRY_DSN"]) {
		assert.equal(PROVIDER_STEERING_VARS.has(name), false, `${name} is an operator's own secret and must stay bindable`);
	}
});

test("bedrock is why the key variables stay in this set rather than being left to the pre-spend gate", { skip }, async () => {
	// `providerKeyCandidates("amazon-bedrock")` is undefined, so the pre-spend gate reserved NOTHING at all
	// for a bedrock deployment: a trigger could bind AWS_SECRET_ACCESS_KEY outright and every job of that
	// trigger would run on the trigger author's account. Asserted against pi's real answer, not a fixture.
	const { providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	assert.deepEqual(providerKeyCandidates("amazon-bedrock"), [], "if bedrock ever gains a key variable, this test's premise is gone and the comment above needs revisiting");
	for (const name of ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} is reserved by THIS set or by nothing`);
	}
});

test("this module imports nothing", () => {
	// `triggers.mjs` is the shared validator: the receiver loads it and admin/build.mjs inlines it into the
	// published console. Same rule as reserved-env.mjs, provider-key.mjs and json-duplicates.mjs.
	const src = readFileSync(new URL("../src/provider-steering.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "provider-steering.mjs must stay import-free");
});

/** Resolve a bundled provider SDK's directory from this repo's own node_modules. */
function sdkDir(name) {
	return fileURLToPath(new URL(`../../node_modules/${name}`, import.meta.url));
}
