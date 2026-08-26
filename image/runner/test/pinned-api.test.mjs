import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// Pure -- no static pi import in its module graph -- so it needs none of the gating below. Importing
// the runner's OWN candidate resolver is deliberate: the layout fact it encodes is the thing that
// breaks silently, so pin the function the runner actually calls rather than a copy of its reasoning.
import { resolvePiAiCompat } from "../src/usage-meter.mjs";

/**
 * REQ-UPSTREAM-CONTRACT-TESTS -- assert against the PINNED ARTIFACT, not against HEAD.
 *
 * This exists because of a real and expensive mistake. Every claim about pi in this
 * project was verified by reading source at `earendil-works/pi @ 5e336cf` -- which is
 * HEAD, not the 0.80.7 release we pin. `ModelRuntime` is a value export in that source
 * and DOES NOT EXIST in 0.80.7 at all: pi's changelog files it under [Unreleased] and
 * the changelog was exactly right. The runner imported it, the image built cleanly, and
 * every job would have died on a missing export.
 *
 * Reading a moving branch to verify a fixed version is not verification. These tests
 * import the package the lockfile actually resolves and assert the symbols exist there,
 * so the next time HEAD and the pin disagree, a test says so instead of a container.
 */
const pkg = "@earendil-works/pi-coding-agent";

let mod;
let importError;
try {
	mod = await import(pkg);
} catch (error) {
	importError = error;
}

const required = process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1";
if (!mod && required) {
	throw new Error(`${pkg} must be importable here; a skip would hide a pin/HEAD mismatch.\n${importError}`);
}
const skip = mod ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

/** Every value the runner imports at runtime. If pi drops one, the job dies on module load. */
const REQUIRED_VALUE_EXPORTS = [
	"createAgentSession",
	"getAgentDir",
	"AuthStorage",
	"ModelRegistry",
	"SessionManager",
	"SettingsManager",
	"DefaultResourceLoader",
];

test("the pinned package exports everything the runner imports", { skip }, () => {
	const missing = REQUIRED_VALUE_EXPORTS.filter((name) => typeof mod[name] === "undefined");
	assert.deepEqual(missing, [], `pinned ${pkg} is missing value exports the runner needs: ${missing}`);
});

test("model/auth wiring is the 0.80.7 shape, not HEAD's", { skip }, () => {
	// The [Unreleased] migration replaces these two with an async ModelRuntime. When the pin
	// moves past it, THIS fails -- which is the signal to rewrite run-job.mjs's wiring,
	// rather than discovering it when every queued job becomes a no-op.
	assert.equal(typeof mod.AuthStorage?.create, "function", "AuthStorage.create missing");
	assert.equal(typeof mod.ModelRegistry?.create, "function", "ModelRegistry.create missing");
	assert.equal(
		typeof mod.ModelRuntime,
		"undefined",
		"ModelRuntime now EXISTS at the pin -- the [Unreleased] migration shipped. " +
			"Rewrite run-job.mjs to modelRuntime and re-verify sdk.d.ts before bumping.",
	);
});

test("the resource-loader options the instruction model depends on still exist", { skip }, () => {
	// These are asserted behaviourally in loader.test.mjs, but a rename would fail there with
	// a confusing symptom (an empty prompt) rather than a clear one. This names them.
	const loader = Object.getOwnPropertyNames(mod.DefaultResourceLoader?.prototype ?? {});
	for (const method of ["reload", "getAppendSystemPrompt", "getAgentsFiles", "getSkills"]) {
		assert.ok(loader.includes(method), `DefaultResourceLoader.${method} missing at the pin`);
	}
});

test("the pinned pi-ai still exposes the Usage shape the runner's token meter reads", { skip }, () => {
  // REQ-UPSTREAM-CONTRACT-TESTS for issue #25 / OQ-010. The runner accumulates per-turn
  // `event.message.usage` (a required `Usage` on the assistant AgentMessage). `Usage` is a TYPE-only
  // export -- no runtime value on `mod` -- so a `typeof mod.Usage` check is the wrong tool. Assert the
  // pinned .d.ts still declares the field and its shape, so a pin bump that drops or reshapes usage fails
  // HERE rather than turning every job's token accounting silently to zero. Resolve pi-ai from
  // pi-coding-agent's own context so this checks the exact copy the runner uses.
  // pi-ai is ESM-only (its `exports` has no `require` condition and hides ./package.json), so resolve its
  // main entry (./dist/index.js) via import.meta.resolve and read the sibling types.d.ts. The lockfile pins
  // pi-ai to the same 0.80.7 pi-coding-agent depends on, so the hoisted copy is the pinned artifact.
  const typesPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "types.d.ts");
  const src = readFileSync(typesPath, "utf8");

  assert.match(src, /\n\s*usage:\s*Usage;/, "AssistantMessage.usage: Usage must remain a REQUIRED field (not optional, not renamed)");

  const usage = src.match(/export interface Usage \{([\s\S]*?)\n\}/);
  assert.ok(usage, "the Usage interface must exist in the pinned pi-ai");
  // The cache-split fields are pinned alongside the four originals because the per-model ledger
  // (issue #53) accumulates them per row -- they are exactly what the flat totals collapse. A pin bump
  // that drops the split would not error anywhere: finite() coerces the absent fields to 0 and every
  // ledger row silently reports a cache-free run, so the loss must fail HERE instead. cacheWrite1h and
  // reasoning are optional at the pin (Anthropic-only split / provider-dependent breakdown) and the
  // meter already defaults them to 0; declared-but-optional is the shape this pin holds them to.
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"]) {
    assert.match(usage[1], new RegExp(`\\b${field}\\b`), `Usage.${field} must remain declared -- the meter's flat totals or its ledger rows sum it`);
  }
  // The meter dereferences usage.cost.total, so `cost` must stay an OBJECT declaring `total`. A bare-name
  // check on `cost` would keep passing if a pin bump flattened it to `cost: number`, while the meter
  // silently recorded $0 for every job -- the exact silent-zero this contract test exists to prevent.
  assert.match(usage[1], /cost:\s*\{[\s\S]*?\btotal\b/, "Usage.cost must remain an object declaring `total` -- the meter reads usage.cost.total");
});

test("the runner imports nothing the pinned package does not export", { skip }, () => {
	// Catches a new import added to run-job.mjs that only exists at HEAD -- the exact
	// mistake this file was written for, generalised so it cannot recur silently.
	const source = readFileSync(fileURLToPath(new URL("../run-job.mjs", import.meta.url)), "utf8");
	const block = source.match(/import\s*\{([^}]+)\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/);
	assert.ok(block, "could not find the runner's pi import block");

	const imported = block[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const missing = imported.filter((name) => typeof mod[name] === "undefined");
	assert.deepEqual(missing, [], `run-job.mjs imports symbols absent from the pinned package: ${missing}`);
});

/* ------------------------------------------------------------------------------------------------
 * Issue #58: the process-wide usage meter. Everything below pins a fact the meter DEPENDS ON and
 * cannot detect the loss of at runtime -- each one, if it changed under a pin bump, would leave the
 * meter installing cleanly, logging success, and counting nothing or counting wrong.
 * ---------------------------------------------------------------------------------------------- */

/** The pinned pi-ai's dist dir, resolved exactly as the Usage test above resolves it. */
function piAiDist() {
	return dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
}

/** Read a file next to the pinned pi-coding-agent's dist/index.js. */
function agentDistFile(...segments) {
	const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	return readFileSync(join(dist, ...segments), "utf8");
}

test("the registry methods the meter installs through still exist at the pin", { skip }, () => {
	// registerProvider is the ONLY installation route that survives a reload: ModelRegistry.refresh()
	// re-applies its stored provider configs, so our wrappers come back. Registering through compat
	// directly would not. unregisterProvider is pinned because the meter deliberately does NOT call it
	// (it calls refresh() -> resetApiProviders(), wiping every wrapper) -- a maintainer who "tidies up"
	// the never-unregistered probe needs that method to still mean what the comment says it means.
	const registry = Object.getOwnPropertyNames(mod.ModelRegistry?.prototype ?? {});
	for (const method of ["registerProvider", "unregisterProvider", "refresh"]) {
		assert.ok(registry.includes(method), `ModelRegistry.${method} missing at the pin -- the meter installs through it`);
	}

	// run-job.mjs hoists the SessionManager purely to read this BEFORE the session exists. Without a
	// root session id the meter files every call as unattributed, rootTotal stays 0, and the
	// root-vs-fanout split the exit line reports silently collapses into one bucket.
	const sessions = Object.getOwnPropertyNames(mod.SessionManager?.prototype ?? {});
	assert.ok(sessions.includes("getSessionId"), "SessionManager.getSessionId missing -- run-job.mjs reads the root id from it");
});

test("getContextUsage and the ContextUsage shape the session store's bound is written against still exist", { skip }, () => {
	// The context bound (issue #186) is the only place this project asks pi how full a session is, and
	// there is no fallback: a bytes-against-window estimate has no calibration here, and the transcript is
	// the whole branch INCLUDING what compaction folded away, so it over-reads exactly past the threshold
	// the bound exists for. If this method goes, the bound must be redesigned rather than re-aimed.
	const sessionMethods = Object.getOwnPropertyNames(mod.AgentSession?.prototype ?? {});
	assert.ok(sessionMethods.includes("getContextUsage"), "AgentSession.getContextUsage missing at the pin -- run-job.mjs reads the context reading off it");

	// A TYPE contract, so `typeof` is the wrong tool. Both field NAMES are load-bearing: run-job.mjs reads
	// `tokens` and `contextWindow` off the object and renames the second to `window` on the exit line, so
	// a rename upstream would silently produce `undefined` on every run and the host would read that as an
	// old runner rather than as a break.
	const types = agentDistFile("core", "extensions", "types.d.ts");
	assert.match(types, /export interface ContextUsage \{/, "ContextUsage is gone from the pinned types");
	assert.match(types, /ContextUsage \{[^}]*\btokens\b/, "ContextUsage.tokens is gone -- the exit line's numerator");
	assert.match(types, /ContextUsage \{[^}]*\bcontextWindow\b/, "ContextUsage.contextWindow is gone -- the exit line's denominator");

	// NULLABILITY is the half a reader gets wrong. `tokens` is null right after a compaction, before the
	// next assistant message re-establishes a count, and getContextUsage itself returns undefined when pi
	// has no model or no window. Both are why the runner omits the key entirely rather than emitting a
	// zero, and why the host's gate passes on absence instead of inventing a denominator.
	assert.match(types, /tokens: number \| null;/, "ContextUsage.tokens stopped being nullable -- re-check whether the runner still needs its guard");

	// The OTHER bound's input, pinned here for the same reason and with more at stake. The conversation-age
	// gate reads `SessionHeader.timestamp` and fails CLOSED when it cannot: if a pin bump renames or drops
	// that field, PI_SESSION_MAX_AGE_DAYS stops being a bound and becomes a deployment-wide refusal to
	// resume anything, reported as `conversation-too-old`, with nothing else in this suite noticing.
	const header = agentDistFile("core", "session-manager.d.ts");
	assert.match(header, /export interface SessionHeader \{/, "SessionHeader is gone from the pinned types");
	assert.match(header, /SessionHeader \{[^}]*\btimestamp: string;/, "SessionHeader.timestamp is gone or is no longer a string -- the conversation-age bound reads it and fails closed without it");
});

test("ProviderConfigInput still accepts the { api, streamSimple } pair the meter registers", { skip }, () => {
	// A TYPE contract, so `typeof` is the wrong tool -- assert the pinned .d.ts still declares it. If
	// registerProvider stopped accepting a bare streamSimple override (say it started requiring
	// `models` or `baseUrl`), the meter's registration would throw inside install and degrade to
	// ok:false -- which is caught, logged once, and looks exactly like an unsupported layout.
	const src = agentDistFile("core", "model-registry.d.ts");
	assert.match(
		src,
		/registerProvider\(providerName: string, config: ProviderConfigInput\): void;/,
		"ModelRegistry.registerProvider's signature changed",
	);

	const input = src.match(/export interface ProviderConfigInput \{([\s\S]*?)\n\}/);
	assert.ok(input, "the ProviderConfigInput interface must exist in the pinned package");
	assert.match(input[1], /\n\s*api\?:/, "ProviderConfigInput.api must stay optional-but-declared -- the meter sets it");
	assert.match(
		input[1],
		/\n\s*streamSimple\?:\s*\(model:[^)]*\)\s*=>/,
		"ProviderConfigInput.streamSimple must remain a declared function field -- it IS the meter's hook",
	);
});

test("the pinned pi-ai still exposes the api-provider registry the meter meters at", { skip }, () => {
	const src = readFileSync(join(piAiDist(), "compat.d.ts"), "utf8");
	for (const fn of ["getApiProvider", "getApiProviders", "registerApiProvider", "resetApiProviders"]) {
		// The optional `<...>` covers registerApiProvider, which is generic. Anchoring on the "(" that
		// follows the name (or its type parameters) is what stops `getApiProvider` from being satisfied
		// by `getApiProviders` -- a prefix match here would let the singular accessor disappear unnoticed.
		assert.match(
			src,
			new RegExp(`export declare function ${fn}(?:<[^>]*>)?\\(`),
			`compat.${fn} missing at the pin -- the meter probes, arms and re-arms through these`,
		);
	}

	// The single field that makes per-session attribution possible. Nothing else on the wire carries a
	// session identity, so if this were dropped every call would land in looseTotal, rootTotal and
	// otherTotal would both be 0, and the exit line would stop being able to show that a job fanned
	// out at all -- with no error anywhere. That is the silent collapse this pin exists to catch.
	const types = readFileSync(join(piAiDist(), "types.d.ts"), "utf8");
	const options = types.match(/export interface StreamOptions \{([\s\S]*?)\n\}/);
	assert.ok(options, "the StreamOptions interface must exist in the pinned pi-ai");
	assert.match(
		options[1],
		/\n\s*sessionId\?:\s*string;/,
		"StreamOptions.sessionId must remain declared -- lose it and root/other attribution silently collapses",
	);
});

test("pi still refuses to auto-retry the hard stop -- a non-error stopReason is NOT retryable", { skip }, async () => {
	// The fact that makes the token cap a spend CONTROL rather than a spend AMPLIFIER, and until now the
	// only one in this module asserted purely in prose. When the cap is breached the meter answers the
	// next call with a synthetic terminal assistant message carrying stopReason "aborted"
	// (makeHardStopStream in src/usage-meter.mjs); pi's AgentSession then asks isRetryableAssistantError
	// whether to restart that turn. The predicate's first line returns false for anything whose
	// stopReason !== "error", so our brake ends the run. Widen that predicate -- to any message carrying
	// an errorMessage, say -- and the SAME brake starts feeding pi's PAID auto-retry loop: the cap would
	// then generate spend on every capped call instead of stopping it, with the log still reading like a
	// clean stop.
	//
	// BEHAVIOURAL rather than a text regex, because the predicate really is a value export of the pinned
	// pi-ai: dist/index.js re-exports dist/utils/retry.js and compat re-exports index.js, which is exactly
	// how pi's own core/agent-session.js gets it. Resolve the pi-ai copy the way the Usage test above
	// does, then read utils/retry.js as a sibling of that entry.
	const retryUrl = new URL("./utils/retry.js", import.meta.resolve("@earendil-works/pi-ai"));
	assert.ok(
		existsSync(fileURLToPath(retryUrl)),
		"the pinned pi-ai no longer ships dist/utils/retry.js -- find where isRetryableAssistantError moved, " +
			"re-point this pin at it, and re-confirm that a non-error stopReason is still non-retryable before bumping.",
	);

	const { isRetryableAssistantError } = await import(retryUrl.href);
	assert.equal(
		typeof isRetryableAssistantError,
		"function",
		"isRetryableAssistantError is no longer an export of the pinned pi-ai -- re-read by hand how pi decides to " +
			"restart a failed assistant turn, because makeHardStopStream's safety is defined entirely by that decision.",
	);

	// The message makeHardStopStream actually emits, reduced to the fields the predicate can read.
	assert.equal(
		isRetryableAssistantError({ role: "assistant", stopReason: "aborted", errorMessage: "pi-dispatch: token cap exceeded" }),
		false,
		"pi now treats a stopReason:\"aborted\" message as RETRYABLE -- the meter's hard stop has become a trigger " +
			"for pi's paid auto-retry loop. Do not bump the pin until makeHardStopStream ends capped calls by a route " +
			"pi will not restart (and re-verify the new route here).",
	);

	// The control. Without it the assertion above would still pass against a predicate gutted to
	// `return false`, and this pin would be pinning nothing. The error text carries several independently
	// retryable tokens so that pi editing one entry of its pattern list cannot fail this spuriously.
	assert.equal(
		isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: "503 service unavailable: upstream overloaded" }),
		true,
		"pi no longer retries a plainly transient stopReason:\"error\" turn -- the predicate this pin relies on has " +
			"been rewritten, so re-derive what does and does not restart a turn before trusting the aborted case above.",
	);

	// The other half of the same contract, guarded as source text in the style of the pi-ai import ban
	// below: the pin only means anything while our own code still emits "aborted". A maintainer aligning
	// makeHardStopStream with pi's createSetupErrorMessage would otherwise switch to "error" and keep a
	// fully green suite while every capped call started paying for retries.
	const meterSrc = readFileSync(fileURLToPath(new URL("../src/usage-meter.mjs", import.meta.url)), "utf8");
	assert.match(
		meterSrc,
		/stopReason:\s*"aborted"/,
		"makeHardStopStream no longer emits stopReason \"aborted\" -- whatever it emits now must be a value " +
			"isRetryableAssistantError rejects, or the token cap drives pi's paid retry loop.",
	);
	assert.ok(
		!/stopReason:\s*"error"/.test(meterSrc),
		"usage-meter.mjs now builds a stopReason:\"error\" message -- that is the ONE value pi will auto-retry, " +
			"so a hard stop shaped like it turns the cap into a spend amplifier.",
	);
});

test("pi still ships NO process-wide usage surface of its own", { skip }, () => {
	// The negative fact that justifies src/usage-meter.mjs existing at all, in the same shape as the
	// ModelRuntime pin above. usage-meter.mjs is ~450 lines of upstream-shaped workaround; the day pi
	// ships its own cross-session usage accounting, this fails and tells a maintainer to check whether
	// the workaround can be deleted rather than carried forever as unexplained ballast.
	for (const name of ["UsageTracker", "UsageMeter", "createUsageTracker", "getProcessUsage"]) {
		assert.equal(
			typeof mod[name],
			"undefined",
			`pi now exports ${name} -- re-verify whether src/usage-meter.mjs is still needed, or whether its ` +
				"probe-and-wrap install can be replaced by an upstream surface before bumping the pin.",
		);
	}

	// Those four names are guesses at what pi would invent FROM SCRATCH, and pi would not start from
	// scratch: AgentSession.getSessionStats(): SessionStats already exists, per instance. The realistic
	// way pi grows process-wide accounting is therefore CROSS-SESSION AGGREGATION over that existing
	// surface -- a module-level or static getSessionStats, an aggregate field on SessionStats, or an
	// exported registry of live sessions a caller can walk and sum. None of those contain the string
	// "Usage" or "Tracker", so the loop above would sail straight past every one of them. Anchor on the
	// per-instance method first: if it is gone, the checks below are aimed at a surface that no longer
	// exists and their silence means nothing.
	assert.ok(
		Object.getOwnPropertyNames(mod.AgentSession?.prototype ?? {}).includes("getSessionStats"),
		"AgentSession.prototype.getSessionStats is gone -- the per-instance surface the rest of this test is " +
			"defined against moved. Re-read pi's stats API and re-target these checks before trusting them again.",
	);

	assert.equal(
		typeof mod.getSessionStats,
		"undefined",
		"pi now exports a MODULE-LEVEL getSessionStats -- that is cross-session accounting shipped upstream. " +
			"Check whether it covers subagent fanout, and if it does, delete src/usage-meter.mjs rather than " +
			"bumping the pin under it.",
	);
	assert.equal(
		typeof mod.AgentSession?.getSessionStats,
		"undefined",
		"AgentSession.getSessionStats is now a STATIC, i.e. an accessor that spans sessions rather than one " +
			"instance -- re-evaluate whether src/usage-meter.mjs's probe-and-wrap install is still needed at all.",
	);

	// Pattern-based, not name-based, so a name nobody here thought of still trips it. Split each export
	// on camelCase/underscore boundaries and look for a cross-cutting word next to a usage word (a
	// process-wide accessor) or next to `session` (a registry the caller could walk). Word-level matching
	// is what keeps `toolCalls` from reading as "all" and `calculateContextTokens` from reading as a total.
	const wordsOf = (name) => name.split(/(?<=[a-z0-9])(?=[A-Z])|_/).map((word) => word.toLowerCase());
	const CROSS_CUTTING = new Set(["all", "every", "aggregate", "aggregated", "combined", "cumulative", "global", "process", "registry", "registries", "sessions"]);
	const USAGE = new Set(["usage", "stats", "statistics", "cost", "costs", "spend", "tokens", "totals"]);
	const ENUMERATION = new Set(["all", "every", "registry", "registries", "list", "active", "live", "pool", "tracker"]);

	const aggregate = Object.keys(mod).filter((name) => {
		const words = wordsOf(name);
		return words.some((word) => CROSS_CUTTING.has(word)) && words.some((word) => USAGE.has(word));
	});
	assert.deepEqual(
		aggregate,
		[],
		`pi now exports a cross-session usage accessor (${aggregate}) -- this negative pin exists so that day is ` +
			"loud. Re-evaluate whether src/usage-meter.mjs can be DELETED in favour of it, rather than carrying " +
			"~450 lines of probe-and-wrap workaround forever as unexplained ballast.",
	);

	const registry = Object.keys(mod).filter((name) => {
		const words = wordsOf(name);
		return words.some((word) => word === "session" || word === "sessions") && words.some((word) => ENUMERATION.has(word));
	});
	assert.deepEqual(
		registry,
		[],
		`pi now exports a session registry/enumerator (${registry}) -- a caller can walk it and sum ` +
			"getSessionStats() itself, which is most of what src/usage-meter.mjs is for. Re-evaluate the meter " +
			"against it before bumping the pin.",
	);

	// And the third route: the aggregate arriving as a FIELD on the existing per-session type, where no
	// export name changes at all and both scans above stay silent. A type contract, so assert the pinned
	// .d.ts -- same tool as the Usage and ProviderConfigInput pins.
	const stats = agentDistFile("core", "agent-session.d.ts").match(/export interface SessionStats \{([\s\S]*?)\n\}/);
	assert.ok(stats, "the SessionStats interface must exist in the pinned package -- it is what this pin is defined against");
	const crossSession = [...stats[1].matchAll(/^\s*(\w+)\??:/gm)]
		.map((match) => match[1])
		.filter((field) => wordsOf(field).some((word) => CROSS_CUTTING.has(word) || word === "other" || word === "children"));
	assert.deepEqual(
		crossSession,
		[],
		`SessionStats now declares cross-session field(s) (${crossSession}) -- pi grew its aggregate on the existing ` +
			"per-session type instead of a new export, so nothing else in this test would have noticed. Re-evaluate " +
			"whether src/usage-meter.mjs is still needed before bumping the pin.",
	);
});

test("the runner never imports pi-ai directly -- a static import makes the meter a silent no-op", { skip }, () => {
	// THE trap this whole module is shaped around. Two copies of pi-ai are installed with SEPARATE
	// module-level registries; pi-coding-agent uses the nested one. A plain specifier from runner code
	// binds the hoisted copy, so the meter registers into a registry nobody dispatches through: it
	// reports ok:true, logs a tag, and counts zero. Nothing at runtime can tell you that happened,
	// which is why it is asserted against the source text.
	const runJob = readFileSync(fileURLToPath(new URL("../run-job.mjs", import.meta.url)), "utf8");
	assert.ok(
		!runJob.includes("@earendil-works/pi-ai"),
		"run-job.mjs must not name pi-ai at all -- the meter reaches it by runtime-probed dynamic import",
	);

	// Same rule for the meter itself, checked as a static IMPORT rather than as a string: its docstring
	// quotes the bad specifier on purpose, to explain why it is forbidden.
	const meterSrc = readFileSync(fileURLToPath(new URL("../src/usage-meter.mjs", import.meta.url)), "utf8");
	assert.ok(
		!/^\s*import\s[^\n]*["'][^"']*@earendil-works[^"']*["']/m.test(meterSrc),
		"usage-meter.mjs must have NO static pi import -- the candidate copy is decided by runtime probe",
	);

	// And the two call sites that are invisible when dropped. Without installProcessUsageMeter the
	// runner silently falls back to per-session accounting; without the arm() after createAgentSession,
	// any api id an extension registered during session construction stays unwrapped until the meter's
	// own interval catches it -- so the first call of a package-provided model goes uncounted.
	assert.match(runJob, /installProcessUsageMeter\(/, "run-job.mjs must install the process-wide meter");
	assert.match(runJob, /usageMeter\.arm\(\)/, "run-job.mjs must re-arm the meter AFTER createAgentSession");
});

test("the nested pi-ai copy exists and is NOT the one a bare specifier resolves to", { skip }, () => {
	// The layout fact, pinned. If npm ever flattens this tree the nested candidate disappears and the
	// meter falls back to the hoisted copy -- which is correct THEN and catastrophic now, so the
	// fallback must never become the silent default while the nested copy still exists.
	const candidates = resolvePiAiCompat();
	assert.ok(candidates.length > 0, "the runner must find at least one pi-ai compat candidate");
	assert.equal(candidates[0].tag, "nested", "the NESTED copy must be tried first -- it is the one pi mutates");

	const nested = fileURLToPath(candidates[0].url);
	assert.ok(existsSync(nested), "the nested pi-coding-agent/node_modules copy of pi-ai/dist/compat.js must exist");

	const hoisted = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat"));
	assert.notEqual(
		nested,
		hoisted,
		"the nested and hoisted pi-ai copies collapsed into one file -- re-verify usage-meter.mjs's probe, " +
			"which exists solely because import.meta.resolve names the copy pi does NOT use",
	);
});

test("the accepted compat copy still has a providers/all.js sibling exposing a POPULATED builtin catalog", { skip }, async () => {
	// The second layout fact the meter depends on, pinned in the same style as the nested-copy test above and
	// for the same reason: installProcessUsageMeter loads `./providers/all.js` as a SIBLING of the compat url
	// it accepted (resolving it by specifier would reopen the two-copies trap), and on ANY failure it sets
	// fallbackModels = null and carries on. Nothing logs, nothing throws, the meter still reports ok:true.
	//
	// What that silently costs: overriding a builtin api id flips compat's `shouldUseBuiltinModels` to false,
	// so compat routes catalog models to our wrapper instead of to its own collection. With fallbackModels
	// null the wrapper delegates straight to the registry entry, skipping the catalog's per-provider auth
	// layer -- which is exactly where cloudflare-ai-gateway and cloudflare-workers-ai substitute their baseUrl
	// placeholders and inject their headers. Those two providers break outright, and only under this pin bump.
	const candidates = resolvePiAiCompat();
	assert.ok(candidates.length > 0, "the runner must find at least one pi-ai compat candidate");

	const siblingUrl = new URL("./providers/all.js", candidates[0].url);
	assert.ok(
		existsSync(fileURLToPath(siblingUrl)),
		"providers/all.js is gone from beside the accepted compat.js -- installProcessUsageMeter degrades " +
			"fallbackModels to null SILENTLY, which disables catalog-model auth fidelity for cloudflare-ai-gateway " +
			"and cloudflare-workers-ai. Re-verify usage-meter.mjs's sibling load before bumping the pin.",
	);

	const all = await import(siblingUrl.href);
	assert.equal(
		typeof all?.builtinModels,
		"function",
		"providers/all.js no longer exports builtinModels() -- the meter's `all?.builtinModels?.()` yields " +
			"undefined, fallbackModels goes null with no error, and the cloudflare providers lose their auth layer.",
	);

	const models = all.builtinModels();
	assert.equal(typeof models?.getModel, "function", "builtinModels() must return a catalog with getModel -- the wrapper calls it per stream");

	// A populated catalog, not merely a callable one: an empty catalog makes every getModel() miss, which is
	// indistinguishable at run time from fallbackModels being null in the first place.
	const known = models.getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(known, "the builtin catalog must still resolve a known builtin model (anthropic/claude-sonnet-4-5)");
	assert.equal(typeof known.api, "string", "a catalog model must carry the `api` id the wrapper compares against model.api");

	// The two providers this whole fallback exists for. Their ids are read from the catalog itself, so a
	// renamed model does not fail here -- only a provider that stopped shipping models does.
	for (const provider of ["cloudflare-ai-gateway", "cloudflare-workers-ai"]) {
		const entry = models.getProviders?.().find((p) => p?.id === provider);
		assert.ok(entry, `${provider} is gone from the builtin catalog -- the meter's fallback can no longer serve it`);
		const first = entry.getModels?.()?.[0];
		assert.ok(first?.id, `${provider} ships no builtin models -- its baseUrl/header substitution is unreachable through the catalog`);
		assert.ok(
			models.getModel(provider, first.id),
			`getModel(${provider}, ...) resolves nothing -- the meter would bypass that provider's auth layer entirely`,
		);
	}
});

test("pi hands extensions ITS OWN pi-ai and pi-coding-agent, not a second copy", { skip }, () => {
	// If an extension resolved its own pi-ai, its sessions would dispatch through a DIFFERENT
	// module-level registry and the meter would see none of their calls -- coverage would silently halve
	// on exactly the fanout jobs #58 is about, and the totals would still look plausible. pi's extension
	// loader prevents that by aliasing both packages to its own entries; that is what this pins.
	const loader = agentDistFile("core", "extensions", "loader.js");
	assert.match(loader, /"@earendil-works\/pi-ai":\s*piAiCompatEntry/, "the jiti alias for pi-ai is gone");
	assert.match(loader, /"@earendil-works\/pi-coding-agent":\s*piCodingAgentEntry/, "the jiti alias for pi-coding-agent is gone");
	// The bundled-binary path uses virtual modules instead of aliases; both must keep pointing at pi's own.
	assert.match(loader, /"@earendil-works\/pi-ai":\s*_bundledPiAiCompat/, "the virtual-module mapping for pi-ai is gone");
	assert.match(
		loader,
		/"@earendil-works\/pi-coding-agent":\s*_bundledPiCodingAgent/,
		"the virtual-module mapping for pi-coding-agent is gone",
	);
});
