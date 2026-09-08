import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDER_STEERING_VARS } from "../src/provider-steering.mjs";

// The bolt (issue #314). A hand-written table that restates a derivable source is either derived or
// pinned, never trusted, and this one is pinned in BOTH directions against the pinned artifacts. The point
// is not that today's list is right; it is that a pi bump which starts reading a new steering variable
// fails HERE rather than opening a hole nobody notices.

let piEntry;
let importError;
try {
	piEntry = fileURLToPath(await import.meta.resolve("@earendil-works/pi-ai"));
} catch (error) {
	importError = error;
}
if (!piEntry && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`provider-steering tests are REQUIRED here but pi-ai could not be resolved.\n${importError}`);
}
const skip = piEntry ? false : "pi-ai not installed; CI runs these";

/** Every .js/.mjs/.cjs file under `dir`, ignoring nested dependencies. */
function sourcesUnder(dir) {
	const files = [];
	const walk = (d) => {
		for (const entry of readdirSync(d)) {
			if (entry === "node_modules") continue;
			const p = `${d}/${entry}`;
			if (statSync(p).isDirectory()) walk(p);
			// BOTH builds. pi-ai is `"type": "module"` so it loads the .mjs tree, and reading only .js
			// would measure a build pi never runs -- harmless while the two agree, and silently empty for a
			// package that ships only one of them.
			else if (/\.(js|mjs|cjs)$/.test(p)) files.push(p);
		}
	};
	walk(dir);
	return files;
}

// The SDKs do not agree on one accessor, so all four spellings are matched. `process.env["NAME"]` is not
// padding: it is the only way `AZURE_OPENAI_ENDPOINT` is read, inside a package the first three cover.
const ACCESSORS = [
	/getProviderEnvValue\(\s*["']([A-Za-z0-9_]+)["']/g,
	/readEnv\)?\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
	/getEnv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
	/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
];

function namesIn(dir) {
	const found = new Set();
	for (const file of sourcesUnder(dir)) {
		const src = readFileSync(file, "utf8");
		for (const re of ACCESSORS) for (const m of src.matchAll(re)) found.add(m[1]);
	}
	return found;
}

/**
 * The packages pi imports a client from, read off pi's OWN import statements.
 *
 * Discovered rather than listed, and that is the part that matters: a hardcoded pair covered two of the
 * five SDKs pi actually builds clients with, and the three it missed included the one that redirects a
 * Gemini call. Deriving the list means a pi bump that adds an SDK fails this file instead of quietly
 * widening the surface.
 */
function clientPackages() {
	const builtin = new Set(builtinModules);
	const specs = new Set();
	for (const file of sourcesUnder(dirname(piEntry))) {
		for (const m of readFileSync(file, "utf8").matchAll(/from\s*["']([^."'][^"']*)["']/g)) {
			let spec = m[1];
			if (spec.startsWith(".") || spec.startsWith("node:")) continue;
			spec = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			if (builtin.has(spec) || spec.startsWith("@earendil-works/")) continue;
			specs.add(spec);
		}
	}
	return [...specs].sort();
}

test("the set is exactly what the pinned pi and the SDKs it imports read, minus the key variables", { skip }, async () => {
	// Resolved THROUGH pi rather than from a path guess, so this reads the copy pi itself loads even if a
	// version conflict ever pushes one under a nested node_modules.
	const req = createRequire(piEntry);
	const derived = namesIn(dirname(piEntry));
	const scanned = [];
	for (const spec of clientPackages()) {
		let dir;
		try {
			dir = dirname(req.resolve(spec));
		} catch {
			continue; // not resolvable from pi (a types-only or optional dependency)
		}
		scanned.push(spec);
		for (const name of namesIn(dir)) derived.add(name);
	}

	// Guards before the comparison. An extractor that matched nothing would pass a subtraction and fail an
	// equality in a way that reads like a list problem rather than a scanner problem.
	assert.ok(derived.size > 20, `the extractors matched ${derived.size} names, too few to be real`);
	for (const spec of ["@anthropic-ai/sdk", "openai", "@google/genai"]) {
		assert.ok(scanned.includes(spec), `${spec} is no longer imported by pi, or is no longer resolvable from it -- check what replaced it BEFORE touching the list`);
	}

	// A provider's KEY variables are `providerKeyCandidates`' business, refused pre-spend against the job's
	// own provider, and the bound that gate keeps is deliberate: an anthropic job may bind OPENAI_API_KEY
	// for a flow that talks to OpenAI. Subtracted HERE rather than by hand in the module, so the two stay
	// one derivation: only four of pi's thirty-one key variables happen to appear as literals in a scanned
	// artifact, so leaving them in would have broken that documented bound for four names and not the
	// other twenty-seven.
	const { piProviders, providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	const providerKeys = new Set(piProviders().flatMap((id) => providerKeyCandidates(id)));
	assert.ok(providerKeys.size > 25, `only ${providerKeys.size} provider key variables; the subtraction below is probably reading the wrong thing`);
	for (const name of providerKeys) derived.delete(name);

	// The residuals are unreachable by any literal scan of the packages pi imports, so they are excluded
	// from the comparison and asserted separately below. Everything else must match exactly.
	const residual = new Set(["AWS_CONFIG_FILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_SHARED_CREDENTIALS_FILE", "ALL_PROXY", "all_proxy", "http_proxy", "https_proxy", "no_proxy"]);
	const missing = [...derived].filter((n) => !PROVIDER_STEERING_VARS.has(n)).sort();
	const extra = [...PROVIDER_STEERING_VARS].filter((n) => !derived.has(n) && !residual.has(n)).sort();
	assert.deepEqual(
		missing,
		[],
		`pi or an SDK it imports now reads ${missing.join(", ")} and the reserved set does not know about it. Do NOT delete this assertion: add the names to worker/src/provider-steering.mjs after checking what each one steers, because a trigger can bind anything this set does not name.`,
	);
	assert.deepEqual(
		extra,
		[],
		`the reserved set names ${extra.join(", ")}, which nothing in the pinned pi or its SDKs reads any more. Remove them, or the set has stopped being a derivation.`,
	);
});

test("each source the derivation depends on still yields names", { skip }, () => {
	// The failure this guards is silent, and it is the one that nearly shipped: a package whose names the
	// extractors cannot see contributes zero, the union stays above the size guard because the other
	// sources carry it, and the bolt passes while covering less than it says. Asserted per source.
	const req = createRequire(piEntry);
	const expected = {
		"@earendil-works/pi-ai": ["AZURE_OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK"],
		"@anthropic-ai/sdk": ["ANTHROPIC_BASE_URL"],
		openai: ["OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT"],
		"@google/genai": ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL"],
	};
	for (const [spec, needles] of Object.entries(expected)) {
		const dir = spec === "@earendil-works/pi-ai" ? dirname(piEntry) : dirname(req.resolve(spec));
		const found = namesIn(dir);
		for (const needle of needles) {
			assert.ok(found.has(needle), `${spec} no longer yields ${needle} -- the accessor it used has changed, so this source is contributing nothing and the set has silently stopped covering it`);
		}
	}
});

test("the computed-key residuals are the ONLY hand-written members, and they are still unfindable", { skip }, () => {
	// "Derived, never curated" has to be true or said. These seven are read through keys the source builds
	// at runtime, so no extractor can see them; that is asserted here, so the day one of them becomes a
	// literal it moves out of the residual list rather than sitting there unexamined.
	const req = createRequire(piEntry);
	const derived = namesIn(dirname(piEntry));
	for (const spec of clientPackages()) {
		try {
			for (const name of namesIn(dirname(req.resolve(spec)))) derived.add(name);
		} catch {}
	}
	for (const name of ["AWS_CONFIG_FILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_SHARED_CREDENTIALS_FILE", "all_proxy", "https_proxy"]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} must be reserved`);
		assert.equal(derived.has(name), false, `${name} is now reachable by the scan: move it out of UNREACHABLE_BY_SCAN so the derivation owns it`);
	}
	// And the sites that make them necessary still exist, so the residual is evidence rather than folklore.
	// Searched rather than read from a fixed path: @smithy/core's `exports` map does not expose the file,
	// and a layout change should not read as the const having gone.
	const smithyRoot = dirname(dirname(req.resolve("@smithy/node-http-handler"))).replace(/@smithy\/[^/]+$/, "@smithy/core");
	const smithyHit = sourcesUnder(smithyRoot).some((f) => /ENV_ENDPOINT_URL\s*=\s*"AWS_ENDPOINT_URL"/.test(readFileSync(f, "utf8")));
	assert.ok(smithyHit, "the smithy endpoint resolver no longer defines AWS_ENDPOINT_URL -- re-check whether it is still read, and how, before trusting the residual list");
	const proxy = readFileSync(`${dirname(piEntry)}/utils/node-http-proxy.js`, "utf8");
	assert.match(proxy, /toLowerCase\(\)/, "pi's proxy reader no longer lowercases its key, so the lowercase spellings may no longer be read");
});

test("the copy of pi this bolt reads and the copy the runner dispatches through agree", { skip }, () => {
	// `image/runner/src/usage-meter.mjs` carries this repo's own warning that `import.meta.resolve` lies
	// here: the runner runs pi through `@earendil-works/pi-coding-agent`, which nests its OWN pi-ai, while
	// this file resolves the hoisted one. They are the same version today and the extracted names are
	// identical -- but nothing said so, and a bolt that measures a copy nobody runs is a bolt that passes
	// while the thing it guards has moved.
	const hoisted = dirname(piEntry);
	const nested = `${dirname(dirname(dirname(piEntry)))}/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist`;
	let nestedFiles;
	try {
		nestedFiles = sourcesUnder(nested);
	} catch {
		return; // no nested copy in this layout: nothing to disagree with
	}
	// The guard is on what was actually READ, not on the path variables: pointing the scan at the hoisted
	// tree would otherwise satisfy the comparison by comparing a set with itself, and no assertion about
	// the two path strings can see that. Found by a mutation check.
	assert.ok(
		nestedFiles.some((f) => f.includes("pi-coding-agent")),
		"this test is not reading the nested copy at all, so its comparison is a set against itself",
	);
	const nestedNames = new Set();
	for (const file of nestedFiles) {
		const src = readFileSync(file, "utf8");
		for (const re of ACCESSORS) for (const m of src.matchAll(re)) nestedNames.add(m[1]);
	}
	assert.ok(nestedNames.size > 20, `the nested copy yielded ${nestedNames.size} names, so this is measuring an empty directory rather than a second pi`);
	assert.deepEqual(
		[...nestedNames].sort(),
		[...namesIn(hoisted)].sort(),
		"the nested pi-ai the runner dispatches through reads a DIFFERENT set of provider variables than the hoisted one this bolt measures -- reserve against the nested copy, which is the one that runs",
	);
});

test("the names that motivated the issue are all in, and an ordinary secret is not", { skip }, () => {
	// A literal pin beside the derivation, because a derived set is correct at any value and therefore
	// blind to a change IN that value. Each of these was measured redirecting or substituting for real.
	for (const name of [
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
		"OPENAI_BASE_URL",
		"GOOGLE_GEMINI_BASE_URL",
		"GOOGLE_VERTEX_BASE_URL",
		"AWS_ENDPOINT_URL",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_BEDROCK_SKIP_AUTH",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
	]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} must be reserved`);
	}
	// And the bound. Reserving every name would make run.secrets useless, which is the feature this
	// protects rather than replaces.
	for (const name of ["STRIPE_KEY", "MY_APP_TOKEN", "DATABASE_URL", "NPM_TOKEN", "SENTRY_DSN"]) {
		assert.equal(PROVIDER_STEERING_VARS.has(name), false, `${name} is an operator's own secret and must stay bindable`);
	}
});

test("bedrock is why the key variables stay in this set rather than being left to the pre-spend gate", { skip }, async () => {
	// `providerKeyCandidates("amazon-bedrock")` is empty, so the pre-spend gate reserved NOTHING at all for
	// a bedrock deployment: a trigger could bind AWS_SECRET_ACCESS_KEY outright and every job of it would
	// run on the trigger author's account. Asserted against pi's real answer, not a fixture.
	const { providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	assert.deepEqual(providerKeyCandidates("amazon-bedrock"), [], "if bedrock ever gains a key variable, this test's premise is gone and the comment above needs revisiting");
	for (const name of ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} is reserved by THIS set or by nothing`);
	}
});

test("this set and the pre-spend provider gate are COMPLEMENTARY, not one subsuming the other", { skip }, async () => {
	// Worth pinning because it is easy to conclude the wrong thing in either direction. This set is derived
	// from what pi and its SDKs READ, and pi's key table is DATA rather than accessor calls, so most
	// provider key variables are not in here: measured, 27 of 31. So the pre-spend gate and doctor's
	// per-provider check both still have work to do, and a fixture using one of the four names both cover
	// would silently stop exercising them -- which is exactly what happened to two doctor tests when this
	// landed.
	const { piProviders, providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	const keys = new Set(piProviders().flatMap((p) => providerKeyCandidates(p)));
	const outside = [...keys].filter((k) => !PROVIDER_STEERING_VARS.has(k));
	assert.ok(outside.length > 20, `only ${outside.length} provider key variables sit outside this set; if that ever reaches zero, the pre-spend gate is dead code and should be reasoned about rather than left`);
	assert.ok(outside.includes("HF_TOKEN") && outside.includes("ANTHROPIC_OAUTH_TOKEN"), "the doctor fixtures depend on these two being outside");
});

test("this module imports nothing", () => {
	// `triggers.mjs` is the shared validator: the receiver loads it and admin/build.mjs inlines it into the
	// published console, so nothing this module reaches may drag pi or node:fs into that graph. Same rule
	// as reserved-env.mjs, provider-key.mjs and json-duplicates.mjs.
	const src = readFileSync(new URL("../src/provider-steering.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "provider-steering.mjs must stay import-free");
});
