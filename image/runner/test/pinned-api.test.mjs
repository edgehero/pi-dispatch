import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
// Pure -- no static pi import in its module graph -- so it needs none of the gating below. Importing
// the runner's OWN candidate resolver is deliberate: the layout fact it encodes is the thing that
// breaks silently, so pin the function the runner actually calls rather than a copy of its reasoning.
import { BOUND_OVERHEAD_TOKENS, callCostBound, COMPLETIONS_CATALOG_HOSTS, COMPLETIONS_EXTRA_HOSTS, completionsOwnServer, IMAGE_RESIZE_MAX, piOwnPackageDir, PRICED_APIS, resolvePiAiCompat, RUNTIME_RESULT_METHODS, RUNTIME_STREAM_METHODS, VIRTUAL_MODEL_API } from "../src/usage-meter.mjs";
import * as catalogModels from "./helpers/catalog-models.mjs";
import { classifyPromptRejection, classifyStopReason, decideExit, loadRetryPredicate, STOP_REASONS } from "../src/outcome.mjs";
import { jobSettings } from "../src/config.mjs";
import { createJobModelRuntime, jobModelRuntimeOptions } from "../src/model-runtime.mjs";
import { attachTokenBudget } from "../src/token-budget.mjs";
import { attachTurnBudget } from "../src/turn-budget.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
// Importing the child preload runs nothing without a ledger directory.
import { makeLibraryResolveHook, MODEL_RUNTIME_SUFFIX, PI_ENTRIES, PI_SUBCOMMANDS } from "../src/child-preload.mjs";

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
	"ModelRuntime",
	"SessionManager",
	"SettingsManager",
	"DefaultResourceLoader",
	// The eight tool factories tools.mjs derives the excludable set from (issue #291; powershell joined at
	// the 0.99.1 pin, issue #509). The import scan below reads run-job.mjs only, so these earn their guard here.
	"createReadToolDefinition",
	"createBashToolDefinition",
	"createPowerShellToolDefinition",
	"createEditToolDefinition",
	"createWriteToolDefinition",
	"createGrepToolDefinition",
	"createFindToolDefinition",
	"createLsToolDefinition",
];

test("the pinned package exports everything the runner imports", { skip }, () => {
	const missing = REQUIRED_VALUE_EXPORTS.filter((name) => typeof mod[name] === "undefined");
	assert.deepEqual(missing, [], `pinned ${pkg} is missing value exports the runner needs: ${missing}`);
});

test("model/auth wiring is the ModelRuntime shape the runner builds (0.99.1), not the 0.80.7 one", { skip }, () => {
	// OQ-005's migration shipped between 0.80.7 and this pin (issue #509): AuthStorage left the exports
	// (0.80.8) and ModelRegistry.create(auth, path) is gone, replaced by an async ModelRuntime.create handed
	// to createAgentSession as `modelRuntime`. This pins the shape run-job.mjs and src/model-runtime.mjs
	// build against, so the next reshaping fails here rather than as every queued job's first line.
	assert.equal(typeof mod.ModelRuntime?.create, "function", "ModelRuntime.create missing");
	const proto = Object.getOwnPropertyNames(mod.ModelRuntime?.prototype ?? {});
	for (const method of ["getModel", "hasConfiguredAuth", "setRuntimeApiKey", "getError"]) {
		assert.ok(proto.includes(method), `ModelRuntime.${method} missing -- run-job.mjs or the loopback helper calls it`);
	}
	assert.equal(typeof mod.AuthStorage, "undefined", "AuthStorage is exported again -- re-read which credential layer createAgentSession uses before trusting the runtime wiring");
	assert.equal(typeof mod.ModelRegistry?.create, "undefined", "ModelRegistry.create is back -- re-read whether the facade still delegates to a ModelRuntime");

	// The TYPES, where a changed parameter would not throw: hasConfiguredAuth took the MODEL at 0.80.7 and
	// takes the PROVIDER id now; handed a model object it would silently answer false for every job.
	const dts = agentDistFile("core", "model-runtime.d.ts");
	assert.match(dts, /\n {4}static create\(options\?: CreateModelRuntimeOptions\): Promise<ModelRuntime>;/, "ModelRuntime.create's signature moved");
	assert.match(dts, /\n {4}hasConfiguredAuth\(providerId: string\): boolean;/, "hasConfiguredAuth no longer takes a provider id -- run-job.mjs passes model.provider");
	assert.match(dts, /\n {4}getModel\(providerId: string, modelId: string\): Model<Api> \| undefined;/, "getModel's signature moved");
	const options = dts.match(/export interface CreateModelRuntimeOptions \{([\s\S]*?)\n\}/);
	assert.ok(options, "CreateModelRuntimeOptions must exist in the pinned package");
	for (const [field, type] of [["authPath", "string"], ["modelsPath", "string \\| null"], ["modelsStore", "ModelsStore"], ["allowModelNetwork", "boolean"]]) {
		assert.match(options[1], new RegExp(`\\n\\s*${field}\\?: ${type};`), `CreateModelRuntimeOptions.${field} moved -- src/model-runtime.mjs sets it`);
	}
	// And the two network gates src/model-runtime.mjs's comment relies on, as source: PI_OFFLINE is read
	// ONCE, at create (so enforceOfflineMode must run first), and a network refresh also needs the option.
	const src = agentDistFile("core", "model-runtime.js");
	assert.match(src, /process\.env\.PI_OFFLINE === undefined\);/, "ModelRuntime.create no longer reads PI_OFFLINE at construction -- re-check the runner's ordering");
	assert.match(src, /runtime\.modelNetworkEnabled && options\.allowModelNetwork === true/, "the create-time network refresh gate moved");
});

test("the job's model runtime writes no catalog cache beside a read-only models.json (the default store is the control)", { skip }, async () => {
	// src/model-runtime.mjs's measured claim, kept measured. The runner's modelsPath is the operator overlay's
	// :ro /opt/pi-global/models.json when mounted, and pi's default FileModelsStore writes models-store.json
	// BESIDE it. Here a 0555 directory stands in for the :ro mount (chmod does not bind root, so a root-run
	// suite would see nothing fail; the image runs non-root and CI does too).
	const readOnly = tempDir("pi-ro-overlay-");
	const agentDir = tempDir("pi-ro-agent-");
	const modelsPath = join(readOnly, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: "http://127.0.0.1:1" } } }));
	chmodSync(readOnly, 0o555);
	try {
		const job = await createJobModelRuntime({ ModelRuntime: mod.ModelRuntime, agentDir, modelsPath });
		const jobRefresh = await job.refresh({ allowNetwork: false });
		assert.deepEqual([...jobRefresh.errors.keys()], [], "the job's runtime must not try to write a catalog cache anywhere");
		assert.equal(job.getError(), undefined);
		assert.ok(job.getModel("anthropic", "claude-sonnet-4-5-20250929"), "the overlay still applies and the builtin catalog still resolves");
		assert.deepEqual(readdirSync(readOnly), ["models.json"], "nothing written beside the overlay");
		assert.deepEqual(jobModelRuntimeOptions({ agentDir, modelsPath }).allowModelNetwork, false);

		// THE CONTROL: the same files through pi's default store. Without it, a pin bump that stopped caching
		// catalogs would leave the assertion above passing about nothing.
		if (process.getuid?.() !== 0) {
			const { modelsStore: _discarding, ...defaults } = jobModelRuntimeOptions({ agentDir, modelsPath });
			const control = await mod.ModelRuntime.create(defaults);
			const controlRefresh = await control.refresh({ allowNetwork: false });
			const codes = [...controlRefresh.errors.values()].map((error) => error?.code ?? error?.cause?.code);
			assert.ok(codes.length > 0 && codes.every((code) => code === "EACCES"), `pi's default store no longer writes beside models.json (got ${JSON.stringify(codes.slice(0, 3))}) -- re-read src/model-runtime.mjs's reason for the discarding store`);
		}
	} finally {
		chmodSync(readOnly, 0o755);
	}
});

test("the job's settings mean what jobSettings says at the pin, each against pi's own default (issue #509)", { skip }, async () => {
	// Each key is read back through the getter pi itself calls, beside the default it replaces: a key pi stopped
	// reading, or a default that moved to where the pin is a no-op, fails here instead of silently costing money.
	const job = mod.SettingsManager.inMemory(jobSettings({ maxRetries: 2, baseDelayMs: 2000 }));
	const stock = mod.SettingsManager.inMemory({});
	// Cache warming: pi 0.86.0's default re-sends the prefix during long tool runs, as extra paid requests.
	assert.equal(stock.getCacheWarmingMode(), "streaming", "pi's default cache warming moved -- re-check whether the pin still changes anything");
	assert.equal(job.getCacheWarmingMode(), "off", "cacheWarming: \"off\" is no longer honoured -- a job pays to keep a cache warm");
	// The retry settings pi's _prepareRetry reads, including the new backoff cap.
	assert.deepEqual(job.getRetrySettings(), { enabled: true, maxRetries: 2, baseDelayMs: 2000, maxAgentDelayMs: 60_000 });
	const retry = await import(new URL("./utils/retry.js", resolvePiAiCompat()[0].url).href);
	assert.equal(retry.DEFAULT_MAX_AGENT_RETRY_DELAY_MS, 60_000, "pi's default agent retry cap moved: jobSettings pins the old value, decide deliberately whether to follow");
	assert.equal(retry.retryDelayMs(job.getRetrySettings(), 2), 4000, "at the runner's defaults the second retry waits 4 s and the cap does not bind");
	assert.equal(retry.retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 60_000 }, 7), 60_000, "and it binds once base * 2^(n-1) passes 60 s");
	// Telemetry: the setting, and the env override enforceTelemetryOff exists to close.
	assert.equal(stock.getEnableInstallTelemetry(), true, "pi's default install telemetry moved");
	assert.equal(job.getEnableInstallTelemetry(), false);
	const telemetry = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core", "telemetry.js")).href);
	assert.equal(telemetry.isInstallTelemetryEnabled(job, "1"), true, "the premise: PI_TELEMETRY overrides the setting -- if this is false, enforceTelemetryOff guards nothing");
	assert.equal(telemetry.isInstallTelemetryEnabled(job, "0"), false, "the value enforceTelemetryOff writes must read as off");
	assert.equal(telemetry.isInstallTelemetryEnabled(job, undefined), false, "and with no override, the setting decides");
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
  // pi-ai to the same 0.99.1 pi-coding-agent depends on, so the hoisted copy is the pinned artifact.
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
 * Issue #58: the process-wide usage meter (redesigned for the 0.99.1 pin, issue #509: the choke point is
 * ModelRuntime.prototype, and pi-ai's api-provider registry is the compat half for legacy extension calls).
 * Everything below pins a fact the meter DEPENDS ON and cannot detect the loss of at runtime -- each one,
 * if it changed under a pin bump, would leave the meter installing cleanly, logging success, and counting
 * nothing or counting wrong.
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

test("the ModelRuntime methods the meter wraps still exist at the pin, with options in the position it reads", { skip }, () => {
	// The runtime half (issue #509) wraps these five on ModelRuntime.prototype and reads the call's options
	// off the LAST argument for sessionId attribution. A method renamed away is a call the meter no longer
	// sees; a moved options argument is every call filed as unattributed, rootTotal 0, the fanout hidden.
	const proto = Object.getOwnPropertyNames(mod.ModelRuntime?.prototype ?? {});
	for (const method of [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS]) {
		assert.ok(proto.includes(method), `ModelRuntime.${method} missing at the pin -- the meter wraps it`);
	}
	const dts = agentDistFile("core", "model-runtime.d.ts");
	for (const [method, second] of [["streamSimple", "context: Context"], ["stream", "context: Context"], ["streamDeferred", "handle: DeferredHandle"], ["generateImages", "context: ImagesContext"], ["classify", "context: ClassifierContext"]]) {
		assert.match(dts, new RegExp(`\\n {4}${method}(?:<[^>]*>)?\\(model: [^,]+, ${second}, options\\?: [^)]+\\): `), `ModelRuntime.${method}'s (model, ${second.split(":")[0]}, options) shape moved`);
	}
	// The two result methods must still carry usage, or the meter records every one of them as unpriced.
	const types = readFileSync(new URL("./types.d.ts", resolvePiAiCompat()[0].url), "utf8");
	for (const iface of ["AssistantImages", "ClassifierResult"]) {
		assert.match(types.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "", /\n\s*usage\?: Usage;/, `${iface}.usage moved -- the meter reads it off classify/generateImages results`);
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

test("every model call a session or an extension makes reaches a ModelRuntime method the meter wraps", { skip }, () => {
	// WHY the prototype is the choke point at 0.99.1, pinned as source (the behavioural proof is
	// usage-meter.integration.test.mjs and usage-meter.fidelity.test.mjs). If any of these call sites
	// starts calling a provider some other way, the meter keeps installing, keeps logging ok:true, and stops
	// counting that path -- the silent loss this file exists to catch.
	const sdk = agentDistFile("core", "sdk.js");
	assert.match(sdk, /\n {12}return modelRuntime\.streamSimple\(model, context, requestOptions\);/, "the session's streamFn no longer returns modelRuntime.streamSimple -- re-find the session's model path");
	assert.match(sdk, /\n {4}const agent = new Agent\(\{/, "createAgentSession no longer builds the Agent itself");
	// Compaction and branch summaries reuse the session's streamFn (so they are counted, under their own id).
	assert.match(agentDistFile("core", "agent-session.js"), /streamFn: this\.agent\.streamFunction,/, "summaries no longer reuse the session's streamFn");
	// The cache warmer (off in a job, jobSettings) goes through the runtime too.
	assert.match(agentDistFile("core", "cache-warmer.js"), /\.streamSimple\(run\.model, run\.context, \{/, "the cache warmer's call moved");
	// ctx.modelRegistry is a facade over the runtime: every one of its model calls lands on a wrapped method.
	const registry = agentDistFile("core", "model-registry.js");
	for (const call of ["stream", "streamSimple", "complete", "classify"]) {
		assert.match(registry, new RegExp(`return this\\.runtime\\.${call}\\(model, context, options\\);`), `ModelRegistry.${call} no longer forwards to its runtime`);
	}
	// The runtime's convenience methods call the instance's own wrapped ones (so they are counted once).
	const runtime = agentDistFile("core", "model-runtime.js");
	for (const [convenience, via] of [["complete", "stream"], ["completeSimple", "streamSimple"], ["fetchDeferred", "streamDeferred"]]) {
		assert.match(runtime, new RegExp(`${convenience}\\(model, (?:context|handle), options\\) \\{\\n\\s*return this\\.${via}\\(model, (?:context|handle), options\\)\\.result\\(\\);`), `ModelRuntime.${convenience} no longer goes through this.${via}`);
	}
	// Trap #4: a virtual model re-enters this.streamSimple with the physical one, and its api id is the
	// constant the meter skips.
	assert.match(runtime, /return this\.streamSimple\(route\.model, context, \{/, "a routed virtual model no longer re-enters this.streamSimple");
	assert.match(agentDistFile("core", "virtual-models.js"), new RegExp(`export const VIRTUAL_MODEL_API = "${VIRTUAL_MODEL_API}";`), "the virtual api id moved -- usage-meter.mjs's VIRTUAL_MODEL_API must follow it");
	// Trap #5: a composed provider with no builtin base resolves the api in the COMPAT registry, which is
	// where the two halves meet. If this line goes, so does the reason for the AsyncLocalStorage.
	const composer = agentDistFile("core", "provider-composer.js");
	assert.match(composer, /import \{ getApiProvider \} from "@earendil-works\/pi-ai\/compat";/, "the composer no longer reads the compat registry");
	assert.match(composer, /const api = getApiProvider\(model\.api\);/, "the composed provider's registry fallback moved");

	// The extension-provider contract the integration fixture registers through (pi.registerProvider lands
	// on ModelRuntime.registerProvider at 0.99.1): a bare { api, streamSimple } pair is still accepted.
	const input = agentDistFile("core", "provider-composer.d.ts").match(/export interface ProviderConfigInput \{([\s\S]*?)\n\}/);
	assert.ok(input, "the ProviderConfigInput interface must exist in the pinned package");
	assert.match(input[1], /\n\s*api\?: Api;/, "ProviderConfigInput.api must stay optional-but-declared");
	assert.match(input[1], /\n\s*streamSimple\?: \(model: Model<Api>, context: TranscriptContext, options\?: SimpleStreamOptions\) => AssistantMessageEventStream;/, "ProviderConfigInput.streamSimple's shape moved");
});

test("the pinned pi-ai still exposes the api-provider registry the meter's compat half arms", { skip }, () => {
	const src = readFileSync(join(piAiDist(), "compat.d.ts"), "utf8");
	for (const fn of ["getApiProvider", "getApiProviders", "registerApiProvider", "resetApiProviders"]) {
		// The optional `<...>` covers registerApiProvider, which is generic. Anchoring on the "(" that
		// follows the name (or its type parameters) is what stops `getApiProvider` from being satisfied
		// by `getApiProviders` -- a prefix match here would let the singular accessor disappear unnoticed.
		assert.match(
			src,
			new RegExp(`export declare function ${fn}(?:<[^>]*>)?\\(`),
			`compat.${fn} missing at the pin -- the compat half arms and re-arms through these`,
		);
	}
	// registerApiProvider's sourceId is what files one registration per api id under METER_PROVIDER_PREFIX.
	assert.match(src, /export declare function registerApiProvider<[^>]*>\(provider: ApiProvider<TApi, TOptions>, sourceId\?: string\): void;/, "registerApiProvider's (provider, sourceId) shape moved");

	// The single field that makes per-session attribution possible. Nothing else on the wire carries a
	// session identity, so if this were dropped every call would land in looseTotal, rootTotal and
	// otherTotal would both be 0, and the exit line would stop being able to show that a job fanned
	// out at all -- with no error anywhere. At 0.99.1 StreamOptions EXTENDS ProviderRequestOptions (0.86.0),
	// so the pattern admits the clause and still requires the field on StreamOptions itself.
	const types = readFileSync(join(piAiDist(), "types.d.ts"), "utf8");
	const options = types.match(/export interface StreamOptions(?: extends [^{]+)? \{([\s\S]*?)\n\}/);
	assert.ok(options, "the StreamOptions interface must exist in the pinned pi-ai");
	assert.match(
		options[1],
		/\n\s*sessionId\?:\s*string;/,
		"StreamOptions.sessionId must remain declared -- lose it and root/other attribution silently collapses",
	);
});

test("STOP_REASONS is exactly the pinned pi-ai's StopReason union, in order", { skip }, () => {
	// The bolt outcome.test.mjs's literal list owes (CLAUDE.md: a table restating a derivable source is derived
	// or pinned). Read from the NESTED copy, the one whose providers produce the terminal message.
	const types = readFileSync(new URL("./types.d.ts", resolvePiAiCompat()[0].url), "utf8");
	const union = types.match(/export type StopReason = ([^;]+);/)?.[1].match(/"([^"]+)"/g)?.map((name) => name.slice(1, -1));
	assert.deepEqual(STOP_REASONS, union, "pi-ai's StopReason union moved: classify every new reason explicitly in outcome.mjs, then update STOP_REASONS");
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

	// And the call sites that are invisible when dropped. Without installProcessUsageMeter the runner
	// silently falls back to per-session accounting. Without the class and the instance, the runtime half
	// cannot wrap or prove anything. Installed AFTER the runtime and BEFORE the session, or the session's
	// first call goes unmetered. Without the arm() after createAgentSession, an api id an extension
	// registered in the legacy registry during session construction stays unwrapped until the meter's own
	// interval catches it.
	assert.match(runJob, /installProcessUsageMeter\(\{ ModelRuntime, runtime: modelRuntime, meter, log, guard: policyGuard, children: childWatch \}\)/, "run-job.mjs must install the process-wide meter on the class it imports and the instance the session uses");
	assert.ok(runJob.indexOf("createJobModelRuntime({") < runJob.indexOf("installProcessUsageMeter({"), "the meter installs after the runtime exists");
	assert.ok(runJob.indexOf("installProcessUsageMeter({") < runJob.indexOf("createAgentSession({"), "the meter installs before the session exists");
	assert.ok(runJob.indexOf("installProcessUsageMeter({") < runJob.indexOf("await buildLoadedResourceLoader({"), "the meter installs before any extension loads (issue #543)");
	assert.match(runJob, /\n\t\tmodelRuntime,\n\t\tmodel,\n/, "the session must be created on the SAME runtime the meter proved");
	assert.match(runJob, /usageMeter\.arm\(\)/, "run-job.mjs must re-arm the meter AFTER createAgentSession");
});

test("the runner's first pi-ai candidate IS the copy pi hands its extensions, wherever npm put it (issue #587)", { skip }, async () => {
	// The layout fact this replaced ("the nested copy exists and is not the hoisted one") held while pi-coding-agent
	// shipped a shrinkwrap. pi 1.0.1 dropped it, and at the 1.0.3 pin the root overrides keep ONE copy of every pi
	// package, so a dev checkout and the image now look alike. What the meter depends on is not the layout but the
	// identity, so the identity is what is pinned: the first candidate, found by pi-coding-agent's own lookup, loads
	// the very module object pi's VIRTUAL_MODULES hands an extension for a bare pi-ai import.
	const candidates = resolvePiAiCompat();
	assert.ok(candidates.length > 0, "the runner must find at least one pi-ai compat candidate");
	assert.equal(candidates[0].tag, "pi", "pi's OWN copy must be tried first -- it is the one pi mutates");
	assert.ok(existsSync(fileURLToPath(candidates[0].url)), "pi's own pi-ai/dist/compat.js must exist");
	const { VIRTUAL_MODULES } = await import(new URL("./core/extensions/virtual-modules.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	assert.equal(await import(candidates[0].url), VIRTUAL_MODULES["@earendil-works/pi-ai"], "the first candidate is not the module pi hands its extensions");
	// And pi-agent-core, the other package pinned facts are read from, is found the same way and is the version pi declares.
	const agentDeps = JSON.parse(readFileSync(join(agentPackageDir(), "package.json"), "utf8")).dependencies;
	for (const name of ["pi-ai", "pi-agent-core"]) {
		const version = JSON.parse(readFileSync(join(piOwnPackageDir(name), "package.json"), "utf8")).version;
		assert.equal(`^${version}`, agentDeps[`@earendil-works/${name}`], `${name}: the copy pi's lookup finds is not the release pi depends on`);
	}
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
	// What wrapProviderStreams calls per stream: getProvider(id), that provider's getModels() to compare apis
	// (pi-ai 0.99.1 compat.js's getBuiltinProviderForModel), its own stream functions, and the collection's
	// streamSimple/stream for the cloudflare providers.
	assert.equal(typeof models?.getProvider, "function", "builtinModels() must return a catalog with getProvider -- the compat wrapper calls it per stream");
	assert.equal(typeof models?.streamSimple, "function", "the catalog collection must still stream -- the cloudflare path goes through it");
	assert.equal(typeof models?.stream, "function");
	assert.equal(typeof models?.getModel, "function");
	const compatSrc = readFileSync(fileURLToPath(candidates[0].url), "utf8");
	assert.match(compatSrc, /const provider = compatModels\.getProvider\(model\.provider\);\n\s*return provider\?\.getModels\(\)\.some\(\(candidate\) => candidate\.api === model\.api\) \? provider : undefined;/, "compat's builtin-provider test moved -- wrapProviderStreams mirrors it");
	assert.match(compatSrc, /if \(model\.provider\.startsWith\("cloudflare-"\) && !hasResolvedCloudflareAuth\(options\)\) \{\n\s*return compatModels\.streamSimple\(model, transcript, options\);/, "compat's cloudflare branch moved -- wrapProviderStreams mirrors it");

	// A populated catalog, not merely a callable one: an empty catalog makes every getModel() miss, which is
	// indistinguishable at run time from fallbackModels being null in the first place.
	const known = models.getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(known, "the builtin catalog must still resolve a known builtin model (anthropic/claude-sonnet-4-5)");
	assert.equal(typeof known.api, "string", "a catalog model must carry the `api` id the wrapper compares against model.api");

	// The two providers this whole fallback exists for. Their ids are read from the catalog itself, so a
	// renamed model does not fail here -- only a provider that stopped shipping models does.
	for (const provider of ["cloudflare-ai-gateway", "cloudflare-workers-ai"]) {
		const entry = models.getProvider(provider);
		assert.ok(entry, `${provider} is gone from the builtin catalog -- the meter's fallback can no longer serve it`);
		const first = entry.getModels?.()?.[0];
		assert.ok(first?.id, `${provider} ships no builtin models -- its baseUrl/header substitution is unreachable through the catalog`);
		assert.ok(
			models.getModel(provider, first.id),
			`getModel(${provider}, ...) resolves nothing -- the meter would bypass that provider's auth layer entirely`,
		);
	}
});

test("pi hands extensions ITS OWN pi-ai and pi-coding-agent, not a second copy", { skip }, async () => {
	// If an extension resolved its own pi-coding-agent, a subagent session it built would run on a
	// DIFFERENT ModelRuntime class, one the meter never wrapped; its own pi-ai, a different legacy registry.
	// Coverage would silently halve on exactly the fanout jobs #58 is about, and the totals would still look
	// plausible. pi's extension loader prevents that by handing both packages as its own; this pins both
	// spellings of that, and then the IDENTITY the meter actually relies on.
	const loader = agentDistFile("core", "extensions", "loader.js");
	// The unbundled Node build (the runner's) uses jiti aliases to pi's own entries.
	assert.match(loader, /"@earendil-works\/pi-ai":\s*piAiCompatEntry/, "the jiti alias for pi-ai is gone");
	assert.match(loader, /"@earendil-works\/pi-coding-agent":\s*piCodingAgentEntry/, "the jiti alias for pi-coding-agent is gone");
	assert.match(loader, /const piCodingAgentEntry = packageIndex;/, "the pi-coding-agent alias no longer names pi's own index.js");
	assert.match(loader, /: \{ alias: getAliases\(\) \};/, "the Node build no longer resolves extensions through the aliases");
	// Bundled and source runtimes use virtual modules instead, moved into their own file at 0.99.1.
	const virtual = agentDistFile("core", "extensions", "virtual-modules.js");
	assert.match(virtual, /import \* as bundledPiAiCompat from "@earendil-works\/pi-ai\/compat";/, "the virtual pi-ai is no longer pi's own compat import");
	assert.match(virtual, /"@earendil-works\/pi-ai": bundledPiAiCompat,/, "the virtual-module mapping for pi-ai is gone");
	assert.match(virtual, /import \* as bundledPiCodingAgent from "\.\.\/\.\.\/index\.js";/, "the virtual pi-coding-agent is no longer pi's own index");
	assert.match(virtual, /"@earendil-works\/pi-coding-agent": bundledPiCodingAgent,/, "the virtual-module mapping for pi-coding-agent is gone");

	// The identities, at runtime. This map is also the compat half's acceptance oracle
	// (installProcessUsageMeter), so both halves of the meter rest on these two lines.
	const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const { VIRTUAL_MODULES } = await import(pathToFileURL(join(dist, "core", "extensions", "virtual-modules.js")).href);
	assert.equal(VIRTUAL_MODULES["@earendil-works/pi-coding-agent"].ModelRuntime, mod.ModelRuntime, "an extension's ModelRuntime is not the class run-job.mjs wraps");
	const nestedCompat = await import(resolvePiAiCompat()[0].url);
	assert.equal(VIRTUAL_MODULES["@earendil-works/pi-ai"], nestedCompat, "the pi-ai an extension gets is not the nested compat the meter's compat half arms");
});

test("an extension factory runs inside the resource loader's reload(), with no ctx, and that reload never resets the api registry (issue #543)", { skip }, () => {
	// What run-job.mjs's order rests on: it installs the meter and the guards BEFORE it builds the loader, because
	// the loader is where a factory runs. If a factory ran later (in createAgentSession, say), the order would still
	// be safe; if the loader's reload() reset pi-ai's legacy registry, installing first would make every compat
	// entry look displaced, and every capped or listed job would stop before its first prompt.
	const loader = agentDistFile("core", "extensions", "loader.js");
	assert.match(loader, /\n {8}await factory\(load\.api\);\n {8}load\.commit\(\);/, "a factory no longer runs while its extension is loaded");
	assert.match(agentDistFile("core", "resource-loader.js"), /await loadExtensionsCached\(extensionPaths, this\.cwd, this\.eventBus\);/, "the resource loader's reload() no longer loads the extensions");
	// At load the factory's pi API has no ctx: its action methods throw, and pi.registerProvider is queued until the
	// session binds. So a call it makes at load goes through a ModelRuntime of its own or pi-ai's legacy global
	// stream functions, never the job's runtime.
	assert.match(loader, /throw new Error\("Extension runtime not initialized\. Action methods cannot be called during extension loading\."\);/, "actions at load no longer throw");
	assert.match(loader, /registerProvider: \(name, config, extensionPath = "<unknown>"\) => \{\n\s*runtime\.pendingProviderRegistrations\.push\(/, "a provider registered at load is no longer queued for the session");
	// ModelRuntime's one static method builds an instance, so every model call it can make is on the prototype.
	assert.deepEqual(Object.getOwnPropertyNames(mod.ModelRuntime).filter((name) => typeof mod.ModelRuntime[name] === "function"), ["create"]);
	// Only AgentSession.reload() resets the registry, and the runner never calls it.
	const core = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const resetting = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".js") && readFileSync(path, "utf8").includes("resetApiProviders()")) resetting.push(path.slice(core.length + 1));
		}
	};
	walk(join(core, "core"));
	assert.deepEqual(resetting, [join("core", "agent-session.js")], "a second caller of resetApiProviders() appeared");
	assert.match(agentDistFile("core", "agent-session.js"), /\n {8}resetApiProviders\(\);\n {8}await this\._resourceLoader\.reload\(\);/, "AgentSession.reload() no longer resets the registry before it reloads");
});

// ── Issue #544: the extension discovery rule loader.mjs restates ─────────────────────────────────────────────
//
// discoverExtensionEntries lists the overlay's extensions/ by the rule pi applies to ~/.pi/agent/extensions,
// because pi reads an explicit directory path as a package root instead. A restated rule is pinned or it drifts:
// each step is a needle here, and the five functions it restates are held by hash, so a pin bump that changes any
// of them fails this test and the fix is to re-read pi and re-port, never to update the hash alone.

/** The text of one top-level `function name(...) {...}` in a pi dist file. */
function piFunction(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `pi no longer defines ${name}`);
	return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("pi's extension discovery rule is the one discoverExtensionEntries restates (issue #544)", { skip }, () => {
	const pm = agentDistFile("core", "package-manager.js");
	// The rule pi applies to its own agent dir's extensions/, which import-pi copies the overlay from.
	assert.match(pm, /addResources\("extensions", collectAutoExtensionEntries\(userDirs\.extensions\)/, "~/.pi/agent/extensions is no longer read by collectAutoExtensionEntries");
	const auto = piFunction(pm, "collectAutoExtensionEntries");
	assert.match(auto, /const rootEntries = resolveExtensionEntries\(dir\);\n\s*if \(rootEntries\) \{\n\s*return rootEntries;/, "a folder's own entries no longer win outright");
	assert.match(auto, /addIgnoreRules\(ig, dir, dir\);/, "the root's ignore files are no longer read");
	assert.match(auto, /if \(entry\.name\.startsWith\("\."\)\)\n\s*continue;\n\s*if \(entry\.name === "node_modules"\)\n\s*continue;/, "dotfiles or node_modules are no longer skipped");
	assert.match(auto, /if \(isFile && \(entry\.name\.endsWith\("\.ts"\) \|\| entry\.name\.endsWith\("\.js"\)\)\) \{\n\s*entries\.push\(fullPath\);/, "loose .ts/.js files are no longer extensions");
	assert.match(auto, /else if \(isDir\) \{\n\s*const resolvedEntries = resolveExtensionEntries\(fullPath\);/, "a subfolder no longer contributes its own entries");
	const entries = piFunction(pm, "resolveExtensionEntries");
	assert.match(entries, /manifest\?\.extensions\?\.length/, "a package.json pi.extensions list is no longer read");
	assert.match(entries, /if \(existsSync\(indexTs\)\) \{\n\s*return \[indexTs\];\n\s*\}\n\s*if \(existsSync\(indexJs\)\) \{\n\s*return \[indexJs\];/, "index.ts no longer wins over index.js");
	assert.match(pm, /const IGNORE_FILE_NAMES = \[".gitignore", ".ignore", ".fdignore"\];/);
	assert.match(pm, /\nimport ignore from "ignore";\n/, "pi's package manager no longer uses the ignore package the runner borrows");
	assert.deepEqual(
		{
			collectAutoExtensionEntries: sha256(auto),
			resolveExtensionEntries: sha256(entries),
			prefixIgnorePattern: sha256(piFunction(pm, "prefixIgnorePattern")),
			addIgnoreRules: sha256(piFunction(pm, "addIgnoreRules")),
			readPiManifest: sha256(piFunction(agentDistFile("core", "pi-manifest.js"), "readPiManifest")),
		},
		{
			collectAutoExtensionEntries: "93953e6669ea6b77e1b6344ffd36792441e4d5c3f781fa2b4ab4c389620d9d00",
			resolveExtensionEntries: "e2c7c741df8de29a3320a2ea9fc5698db51754c279d07d0688218753af74b3bd",
			prefixIgnorePattern: "279c9086c694d7d6d5afcb80e04d2e650d1a04898753fcbcbe3784e4e7d978ad",
			addIgnoreRules: "ea9a382bddaebd6a1e4a86ca9bc2386d6aa80b2abee946cdf0a100f96524b333",
			readPiManifest: "487feb8648a9bcd9a12351b1d8021bd784ebeaeb079de1b7c5325eb4c73bb3bb",
		},
		"a function discoverExtensionEntries restates changed at this pin: re-read it and re-port the rule",
	);
	// Why the directory cannot be passed: an explicit DIRECTORY path is a package root, and with neither a manifest nor
	// a resource subfolder pi adds the directory itself as the one extension.
	assert.match(pm, /const resources = this\.collectPackageResources\(resolved, accumulator, filter, metadata\);\n\s*if \(!resources\) \{\n\s*this\.addResource\(accumulator\.extensions, resolved, metadata, true\);/, "an explicit directory path is no longer one extension when it holds no package resources");
	// legacyOverlayLayout names what that package-root reading loaded before: the manifest's four fields, else the
	// four resource subfolders. MANIFEST_FIELDS restates both lists.
	assert.match(agentDistFile("core", "pi-manifest.js"), /const RESOURCE_FIELDS = \["extensions", "skills", "prompts", "themes"\];/);
	assert.match(pm, /const RESOURCE_TYPES = \["extensions", "skills", "prompts", "themes"\];/);
	assert.match(pm, /const manifest = readPiManifest\(join\(packageRoot, "package\.json"\)\);\n\s*if \(manifest\) \{/, "a root manifest no longer decides the package's resources");
	// MANIFEST_PATTERN_RE restates what the package reading expanded in a manifest's entries: globs and overrides.
	assert.match(pm, /function isOverridePattern\(s\) \{\n\s*return s\.startsWith\("!"\) \|\| s\.startsWith\("\+"\) \|\| s\.startsWith\("-"\);\n\}/);
	assert.match(pm, /function hasGlobPattern\(s\) \{\n\s*return s\.includes\("\*"\) \|\| s\.includes\("\?"\);\n\}/);
	// And a FILE path is loaded as that one extension, which is what the runner hands it.
	assert.match(pm, /if \(stats\.isFile\(\)\) \{\n\s*metadata\.baseDir = dirname\(resolved\);\n\s*this\.addResource\(accumulator\.extensions, resolved, metadata, true\);/);
	// The load errors the runner reports: pi's own { path, error } list, complete when extensionsOverride sees it.
	const loader = agentDistFile("core", "extensions", "loader.js");
	assert.match(loader, /errors\.push\(\{ path: extPath, error \}\);/, "a failed load is no longer recorded by its path");
	assert.match(
		agentDistFile("core", "resource-loader.js"),
		/extensionsResult\.errors\.push\(\{ path: resolved, error: `Extension path does not exist: \$\{resolved\}` \}\);\n\s*\}\n\s*\}\n\s*\}\n\s*this\.extensionsResult = this\.extensionsOverride \? this\.extensionsOverride\(extensionsResult\) : extensionsResult;/,
		"extensionsOverride no longer sees the finished error list",
	);
});

// ── Issue #291: run.excludeTools' pin surface ─────────────────────────────────────────────────────
//
// The feature rests on three textual pin facts (the behavioural half -- structural removal and the
// silent ignore of unknown names -- runs on a real session in loader.test.mjs): the option trio is
// declared with its exact types; the built-in tool set is what the loader's hand-written constant and
// the runner's factory derivation say; and the set stays unreachable through the package root, which
// is the whole reason tools.mjs derives it from the factories at all.

test("CreateAgentSessionOptions declares the tools trio, and INT-SDK-SESSION-OPTIONS' option table is exact", { skip }, () => {
	const src = agentDistFile("core", "sdk.d.ts");
	const iface = src.match(/export interface CreateAgentSessionOptions \{([\s\S]*?)\n\}/);
	assert.ok(iface, "CreateAgentSessionOptions must exist in the pinned package");
	// OQ-005's migration, landed at this pin: authStorage + modelRegistry became one modelRuntime option.
	assert.match(iface[1], /\n {4}modelRuntime\?: ModelRuntime;/, "modelRuntime?: ModelRuntime moved -- run-job.mjs passes the runtime the meter proved");
	// The TYPE is in the pattern, not just the name (the Usage.cost lesson at the top of this file): a
	// rename-with-substitute or a widened type must fail before a bump ships, not after.
	assert.match(iface[1], /\n {4}excludeTools\?: string\[\];/, "excludeTools?: string[] moved -- run-job passes it and the loader validates its members; re-verify the trio in the NEW tarball before bumping (OQ-005's rule)");
	assert.match(iface[1], /\n {4}tools\?: string\[\];/, "tools?: string[] moved -- the loader refuses run.tools on the claim this option exists upstream");
	assert.match(iface[1], /\n {4}noTools\?: "all" \| "builtin";/, "noTools's union moved -- the loader refuses run.noTools on this shape");
	// The bolt INT-SDK-SESSION-OPTIONS' hand-written "complete option set at <pin>" sentence has owed
	// since it was written (CLAUDE.md: a table restating a derivable source is derived or pinned, never
	// trusted). Top-level members only -- the 4-space indent excludes scopedModels' nested fields.
	const names = [...iface[1].matchAll(/^ {4}(\w+)\?:/gm)].map((m) => m[1]);
	assert.deepEqual(
		names,
		["cwd", "agentDir", "modelRuntime", "model", "thinkingLevel", "scopedModels", "noTools", "tools", "excludeTools", "customTools", "resourceLoader", "sessionManager", "settingsManager", "sessionStartEvent"],
		"the option set moved: update INT-SDK-SESSION-OPTIONS' 'complete option set' sentence in the same commit as the pin bump",
	);
	// The read-back half of the same contract: run-job's tools_excluded line and the loader acceptance
	// read these three off the session, so a rename must fail here with a name rather than as a
	// post-session TypeError in a paid container's log.
	const sessionDts = agentDistFile("core", "agent-session.d.ts");
	assert.match(sessionDts, /getActiveToolNames\(\): string\[\];/, "AgentSession.getActiveToolNames moved -- run-job's tools_excluded read-back and the loader acceptance call it");
	assert.match(sessionDts, /getAllTools\(\): ToolInfo\[\];/, "AgentSession.getAllTools moved -- the loader acceptance reads the registry through it");
	assert.match(sessionDts, /setActiveToolsByName\(toolNames: string\[\]\): void;/, "AgentSession.setActiveToolsByName moved -- the loader acceptance proves exclusion survives it");
});

test("the pinned built-in tool set matches the loader's constant and the runner's factory derivation", { skip }, async () => {
	// The exports map constrains bare specifiers only, so a file URL reaches the canonical set the root
	// does not export -- the meter's own resolver trick. Three spellings must agree: pi's allToolNames,
	// tools.mjs's factory derivation (what the runner enforces with), and worker/src/triggers.mjs's
	// EXCLUDABLE_TOOL_NAMES (what the loader refuses with; its own bolt is exclude-tools.pinned.test.mjs).
	const distDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const canonical = await import(`file://${join(distDir, "core", "tools", "index.js")}`);
	const { excludableToolNames } = await import("../src/tools.mjs");
	assert.deepEqual(
		[...excludableToolNames()].sort(),
		[...canonical.allToolNames].sort(),
		"the pinned pi's built-in tool set moved: grow tools.mjs's factory list, EXCLUDABLE_TOOL_NAMES, docs/exclude-tools.md and triggers.example.json together, then re-verify unknown names are still ignored silently",
	);
});

test("allToolNames stays UN-exported from the package root -- the day pi exports it, retire the reach-around", { skip }, () => {
	// A negative pin in the :310 section's spirit: when either symbol appears on the root, tools.mjs's
	// factory derivation and the file-URL imports here and in worker/test/exclude-tools.pinned.test.mjs
	// should collapse onto the public export -- loudly, via this message, not by someone noticing.
	assert.equal(typeof mod.allToolNames, "undefined", "pi now exports allToolNames from the root: prefer it over the factory derivation and the file-URL reach-in");
	assert.equal(typeof mod.createToolDefinition, "undefined", "pi now exports createToolDefinition from the root: same retirement applies");
});

// ── Issue #437: a provider's refusal of the credential, driven through the pinned pi-ai ─────────────
//
// providerAuthRefused in src/outcome.mjs matches pi-ai's DISPLAY STRING, because that string is all the
// runner is handed, and then asks pi-ai's own isRetryableAssistantError whether the message is transient.
// A pin bump that reformats one provider's error, or edits that predicate, would silently move a refusal
// back to retryable (or, worse, a transient error to not-retried) with every unit test still green, since
// those tests hold hand-written strings and a fake predicate. So each api family is driven for real: a
// loopback server answers with that provider's own error body, the family's stream() runs against it with
// a dummy key, and the terminal AssistantMessage goes through classifyStopReason with the predicate the
// runner itself loads, exactly as run-job.mjs does. Loopback only, so it runs in the offline, no-API-key
// CI context this file is for.
//
// The modules are the `./api/<family>` public export of the NESTED pi-ai copy (the one pi itself
// dispatches through, as resolvePiAiCompat encodes), reached as siblings of the compat url for the reason
// the providers/all.js test above gives: a bare specifier would name the hoisted copy instead.

test("the runner's retry predicate is pi-ai's own isRetryableAssistantError, from the nested copy", { skip }, async () => {
	const candidates = resolvePiAiCompat();
	const predicate = await loadRetryPredicate({ candidates });
	assert.equal(typeof predicate, "function", "no pinned compat candidate exports isRetryableAssistantError -- every 401/403 would retry again");
	const nested = await import(new URL("./utils/retry.js", candidates[0].url).href);
	assert.equal(predicate, nested.isRetryableAssistantError, "the predicate must be the nested copy's, the one pi's own session consults");
});

/** A JWT-shaped dummy the codex family can pull an account id out of before it sends anything. */
function dummyCodexToken() {
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-dummy" } })}.sig`;
}

const JSON_TYPE = "application/json";
const OPENAI_BODY = (status) => JSON.stringify({
	error: status === 401
		? { message: "Incorrect API key provided: dummy-key.", type: "invalid_request_error", param: null, code: "invalid_api_key" }
		: { message: "You are not allowed to sample from this model", type: "invalid_request_error", param: null, code: null },
});
// Two 403s that are NOT refusals, and that pi-ai's predicate calls transient: OpenRouter's wrapper around
// an upstream connection failure, and a gateway's HTML error page. Both match the bare status shape.
const OPENROUTER_UPSTREAM_403 = JSON.stringify({ error: { message: "Provider returned error", code: 403, metadata: { raw: "upstream connect error or disconnect/reset before headers" } } });
const HTML_RETRY_403 = "<html><head><title>403 Forbidden</title></head><body>Service temporarily unavailable, please retry your request</body></html>";

const refusal = (status, body, type = JSON_TYPE, headers = {}) => ({ status, body, type, headers, expect: "provider-auth-refused" });
const residual = (status, body, type = JSON_TYPE, headers = {}) => ({ status, body, type, headers, expect: "residual-infra" });
const transient = (status, body, type, headers = {}) => ({ status, body, type, headers, expect: "transient-infra" });

// Google answers a STREAMING error (pi-ai always streams) as text/event-stream with its JSON body pretty-
// printed, two spaces and a final newline, and @google/genai wraps that text rather than parsing it
// (issue #451, measured against the real endpoints in M0-d; an application/json stub produced a
// single-layer message production never sees, so these cells no longer use one).
const SSE_TYPE = "text/event-stream";
const GOOGLE_ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const GOOGLE_SSE_BODY = (code, status, message, details) => `${JSON.stringify({ error: { code, message, status, ...(details ? { details } : {}) } }, null, 2)}\n`;
const GOOGLE_UNAUTHENTICATED = "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.";
const GOOGLE_CELLS = {
	// A real bogus AI Studio key: HTTP 400, refused by its ErrorInfo reason.
	apiKeyInvalid: GOOGLE_SSE_BODY(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ "@type": GOOGLE_ERROR_INFO, reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } }]),
	// A real bogus Vertex api key: HTTP 401 UNAUTHENTICATED, reason ACCESS_TOKEN_TYPE_UNSUPPORTED.
	unauthenticated: GOOGLE_SSE_BODY(401, "UNAUTHENTICATED", GOOGLE_UNAUTHENTICATED, [{ "@type": GOOGLE_ERROR_INFO, reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED", metadata: { method: "google.cloud.aiplatform.v1.PredictionService.StreamGenerateContent", service: "aiplatform.googleapis.com" } }]),
	// PERMISSION_DENIED stays infra (never measured against a real endpoint; SERVICE_DISABLED asks to wait
	// for an enable to propagate and retry, which pi's predicate does not read as transient).
	permissionDenied: GOOGLE_SSE_BODY(403, "PERMISSION_DENIED", "Permission denied: Consumer 'api_key:AIza' has been suspended."),
	serviceDisabled: GOOGLE_SSE_BODY(403, "PERMISSION_DENIED", "Generative Language API has not been used in project 1 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=1 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.", [{ "@type": GOOGLE_ERROR_INFO, reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { consumer: "projects/1", service: "generativelanguage.googleapis.com" } }]),
	// Must stay infra. The quota wording carries "billing", which pi calls non-transient; infra by decision.
	quota: GOOGLE_SSE_BODY(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits."),
	exhausted: GOOGLE_SSE_BODY(429, "RESOURCE_EXHAUSTED", "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details."),
	badPayload: GOOGLE_SSE_BODY(400, "INVALID_ARGUMENT", 'Invalid JSON payload received. Unknown name "foo": Cannot find field.'),
	// UNAUTHENTICATED and API_KEY_INVALID only inside the message string: read by a byte match, not a parse.
	nestedInString: GOOGLE_SSE_BODY(400, "INVALID_ARGUMENT", 'upstream said "status": "UNAUTHENTICATED", reason API_KEY_INVALID'),
	// UNAUTHENTICATED without a measured reason stays infra: the real bogus Vertex key's status and message
	// minus its reason, and a hypothetical transient one pi's predicate does not read as transient.
	unauthenticatedBare: GOOGLE_SSE_BODY(401, "UNAUTHENTICATED", GOOGLE_UNAUTHENTICATED),
	backendUnavailable: GOOGLE_SSE_BODY(401, "UNAUTHENTICATED", "Authentication backend unavailable, try again later."),
};
const GOOGLE_ROW_CASES = [
	refusal(400, GOOGLE_CELLS.apiKeyInvalid, SSE_TYPE),
	refusal(401, GOOGLE_CELLS.unauthenticated, SSE_TYPE),
	residual(403, GOOGLE_CELLS.permissionDenied, SSE_TYPE),
	residual(403, GOOGLE_CELLS.serviceDisabled, SSE_TYPE),
	residual(429, GOOGLE_CELLS.quota, SSE_TYPE),
	transient(429, GOOGLE_CELLS.exhausted, SSE_TYPE),
	residual(400, GOOGLE_CELLS.badPayload, SSE_TYPE),
	residual(400, GOOGLE_CELLS.nestedInString, SSE_TYPE),
	residual(401, GOOGLE_CELLS.unauthenticatedBare, SSE_TYPE),
	residual(401, GOOGLE_CELLS.backendUnavailable, SSE_TYPE),
];
// Bedrock: pi-ai 0.80.7 lost AWS's message (it serialized the consumed response stream), so every message
// was `<prefix>: <status>: [object Object]`. pi-ai 0.99.1 fixed that: each message is now `<prefix>: <AWS's own
// message>`, with no status (measured here at the bump, issue #509), which is what moved the refusal rule
// from `UnrecognizedClientException: 403: ` to the exception name alone. Each cell pins the whole string:
// the rule reads only the name, and a pi-ai that changes the format again changes these cells, which is
// the moment to re-read what the message carries.
const BEDROCK_ERROR_TYPE = (name) => ({ "x-amzn-errortype": `${name}:http://internal.amazon.com/coral/com.amazon.coral.service/` });
const bedrockCell = (make, status, name, message, pinned) => ({ ...make(status, JSON.stringify({ message }), JSON_TYPE, BEDROCK_ERROR_TYPE(name)), pinned });

/**
 * The CLOSED expected table, one row per api family of the pinned pi-ai (its KnownApi union is ten chat
 * families, plus the images api named below). A cell that changes class under a pin bump fails with the
 * observed message, which is the evidence needed to decide whether providerAuthRefused's list grows or
 * shrinks. `residual-infra` cells are the accepted residual: the refusal is still retried until attempts
 * run out, or a must-stay-infra message pi calls non-transient that is not a refusal at all (a Google quota
 * 429, a bad payload). `transient-infra` cells are errors that must never be read as a refusal. A cell
 * with `pinned` also asserts the whole errorMessage, for a family whose rule deliberately reads only a
 * prefix of it.
 *
 * Not driven, on purpose: `openrouter-images` is pi-ai's IMAGES api (generateImages), and the three
 * classifier apis (0.99.1) serve classify(); neither is a chat stream, so their failures never become the
 * terminal AssistantMessage the runner classifies.
 */
const AUTH_REFUSAL_TABLE = [
	{
		api: "anthropic-messages", provider: "anthropic", path: "",
		cases: [
			refusal(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })),
			refusal(403, JSON.stringify({ type: "error", error: { type: "permission_error", message: "Your API key does not have permission to use the specified resource." } })),
			transient(403, HTML_RETRY_403, "text/html"),
		],
	},
	{
		api: "openai-completions", provider: "openai", path: "/v1",
		cases: [refusal(401, OPENAI_BODY(401)), refusal(403, OPENAI_BODY(403)), transient(403, OPENROUTER_UPSTREAM_403, JSON_TYPE), transient(403, HTML_RETRY_403, "text/html")],
	},
	{ api: "openai-responses", provider: "openai", path: "/v1", cases: [refusal(401, OPENAI_BODY(401)), refusal(403, OPENAI_BODY(403))] },
	{ api: "azure-openai-responses", provider: "azure", path: "/openai/v1", cases: [refusal(401, OPENAI_BODY(401)), refusal(403, OPENAI_BODY(403))] },
	{ api: "mistral-conversations", provider: "mistral", path: "", cases: [refusal(401, OPENAI_BODY(401)), refusal(403, OPENAI_BODY(403))] },
	// pi's own relay protocol: `<status> <statusText>: <message> (<code>)`, which the bare shape reads.
	{
		api: "pi-messages", provider: "pi-relay", path: "",
		cases: [401, 403].map((status) => refusal(status, JSON.stringify({ error: { message: "bad token", code: "unauthorized" } }))),
	},
	// @google/genai wraps Google's streamed body text as `{"error":{"message":"<body>","code":<http>,
	// "status":"<reason phrase>"}}` and pi-ai passes it on unchanged; providerAuthRefused parses both
	// layers (issue #451). The stub answers in the real format (M0-d stubsse matched the real bytes).
	{ api: "google-generative-ai", provider: "google", path: "/v1beta", cases: GOOGLE_ROW_CASES },
	// Same SDK, same wrap, with an api key and a custom baseUrl. Under ADC the refusal comes from Google's
	// OAuth token endpoint instead; those shapes are a residual, pinned by the google-vertex ADC tests below.
	{ api: "google-vertex", provider: "google-vertex", path: "/v1", cases: GOOGLE_ROW_CASES },
	// formatBedrockError names the exception, then AWS's message (0.99.1; the status and a lost body at
	// 0.80.7), and only the name is read (issues #451, #509). HTTP/1.1 is forced because the stub is
	// node:http and the SDK defaults to HTTP/2 (where the 0.80.7 lost body serialized differently, M0-d).
	// UnrecognizedClientException is the one name real AWS sent
	// for a bogus credential with a 403 (a bogus key and a bogus session token). AccessDeniedException
	// (measured for a bogus bearer token, but also an intermittent cross-region SCP/IAM denial or a
	// propagating fix, told apart only by the lost message) and ExpiredTokenException (never seen from real
	// AWS) are residual cells. The exception name rides x-amzn-errortype, as AWS sends it. The throttle cell
	// costs the SDK's own retries (three requests) before it reaches pi-ai.
	{
		api: "bedrock-converse-stream", provider: "amazon-bedrock", path: "", options: { env: { AWS_REGION: "us-east-1", AWS_BEDROCK_FORCE_HTTP1: "1" } },
		cases: [
			bedrockCell(refusal, 403, "UnrecognizedClientException", "The security token included in the request is invalid.", "UnrecognizedClientException: The security token included in the request is invalid."),
			bedrockCell(residual, 403, "AccessDeniedException", "User is not authorized to perform: bedrock:InvokeModelWithResponseStream", "AccessDeniedException: User is not authorized to perform: bedrock:InvokeModelWithResponseStream"),
			bedrockCell(residual, 403, "ExpiredTokenException", "The security token included in the request is expired", "ExpiredTokenException: The security token included in the request is expired"),
			bedrockCell(transient, 429, "ThrottlingException", "Too many requests, please wait before trying again.", "Throttling error: Too many requests, please wait before trying again."),
		],
	},
	// Residual BY DECISION (issue #451): the codex family throws `new Error(info.friendlyMessage ||
	// info.message)` with no status at all, and the real endpoint's 401 carried none on either transport
	// (the websocket upgrade fails without one, then SSE). The only thing to match is the server's own
	// sentence, which is a guess. SSE transport and no in-family retry, so one request reaches the stub and
	// the dummy token only has to carry an account id. The message is the one the real endpoint sent.
	{
		api: "openai-codex-responses", provider: "openai-codex", path: "", options: { transport: "sse", maxRetries: 0, apiKey: dummyCodexToken() },
		cases: [401, 403].map((status) => residual(status, JSON.stringify({ error: { message: "Could not parse your authentication token. Please try signing in again.", code: "invalid_token" } }))),
	},
];

test("each driven pi-ai chat family's credential refusal lands in its expected exit class, transient errors stay retryable (loopback, no key)", { skip }, async () => {
	const candidates = resolvePiAiCompat();
	assert.ok(candidates.length > 0, "the runner must find at least one pi-ai compat candidate");
	const isRetryable = await loadRetryPredicate({ candidates });
	assert.equal(typeof isRetryable, "function");

	let answer = { status: 500, body: "{}", type: JSON_TYPE, headers: {} };
	const requests = [];
	const server = createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		req.resume();
		req.on("end", () => {
			res.writeHead(answer.status, { "content-type": answer.type, ...answer.headers });
			res.end(answer.body);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;

	const observed = [];
	try {
		for (const row of AUTH_REFUSAL_TABLE) {
			const moduleUrl = new URL(`./api/${row.api}.js`, candidates[0].url);
			assert.ok(existsSync(fileURLToPath(moduleUrl)), `the pinned pi-ai no longer ships api/${row.api}.js -- re-derive its refusal shape`);
			const api = await import(moduleUrl.href);
			for (const cell of row.cases) {
				answer = cell;
				const before = requests.length;
				const model = {
					id: "pinned-probe",
					name: "pinned-probe",
					api: row.api,
					provider: row.provider,
					baseUrl: `${origin}${row.path}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 16,
				};
				const terminal = await api.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { apiKey: "dummy-key", ...row.options }).result();
				// The stub must actually have been asked: a family that errored before sending would produce
				// a message that proves nothing about how the provider's refusal is formatted.
				assert.ok(requests.length > before, `${row.api} ${cell.status}: the family never reached the loopback stub`);
				assert.equal(terminal.stopReason, "error", `${row.api} ${cell.status}: expected stopReason "error", got ${terminal.stopReason}`);
				const outcome = classifyStopReason(terminal, isRetryable);
				const got = outcome.reason === "provider-auth-refused"
					? "provider-auth-refused"
					: outcome.reason !== "error"
						? outcome.reason
						: isRetryable(terminal)
							? "transient-infra"
							: "residual-infra";
				observed.push({ api: row.api, status: cell.status, want: cell.expect, got, errorMessage: terminal.errorMessage, pinned: cell.pinned });
			}
		}
	} finally {
		server.close();
	}

	for (const { api, status, want, got, errorMessage, pinned } of observed) {
		assert.equal(
			got,
			want,
			`${api} ${status} now classifies as ${got} (errorMessage: ${JSON.stringify(errorMessage)}). The pinned pi-ai changed ` +
				"how this provider formats a refusal, or what it calls transient: re-derive providerAuthRefused's closed list in src/outcome.mjs and this table together.",
		);
		if (pinned !== undefined) {
			assert.equal(
				errorMessage,
				pinned,
				`${api} ${status}: the whole message moved. For bedrock this is pi-ai changing its format again ` +
					"(0.99.1 carries AWS's message, 0.80.7 lost it): re-read what the message now carries before touching the name rule.",
			);
		}
	}
	assert.equal(observed.length, AUTH_REFUSAL_TABLE.reduce((n, row) => n + row.cases.length, 0), "every cell must be driven");
	// The table covers the pinned KnownApi union exactly, so a family pi adds under a bump fails here
	// rather than being assumed to follow one of the shapes above.
	const types = readFileSync(fileURLToPath(new URL("./types.d.ts", candidates[0].url)), "utf8");
	const known = types.match(/export type KnownApi = ([^;]+);/)?.[1].match(/"([^"]+)"/g)?.map((name) => name.slice(1, -1));
	assert.deepEqual([...new Set(AUTH_REFUSAL_TABLE.map((row) => row.api))].sort(), [...known].sort(), "the table must hold one row per KnownApi family at the pin");
	// Renamed KnownImagesApi -> KnownImageApi by 0.99.1, which also added the classifier apis. Neither kind
	// returns an AssistantMessage (generateImages and classify answer AssistantImages / ClassifierResult), so
	// neither can be the terminal the runner classifies; both are pinned so a new one is looked at.
	assert.match(types, /export type KnownImageApi = "openrouter-images";/, "the image api set moved -- re-check whether any of it can end a chat turn");
	assert.match(types, /export type KnownClassifierApi = "typesafe-system-one" \| "cloudflare-workers-ai-system-one" \| "llama-cpp-classify";/, "the classifier api set moved -- re-check whether any of it can end a chat turn");
});

/**
 * Issues #449 and #455, against the REAL pinned AgentSession rather than a hand-written event order.
 *
 * The turn budget exempts the one turn_start that follows auto_retry_start when the failed turn ran no
 * tool, and re-aborts every turn_start past its cap. Both are only right while pi behaves as measured at
 * the pin: auto_retry_start BEFORE the retry's agent.continue() (agent_start, turn_start), and a fresh
 * AbortController for every run pi starts after an abort. The fakes in turn-budget.test.mjs and
 * outcome.test.mjs encode that; these keep them honest, so a pin bump that changes it fails here first.
 *
 * Zero spend, no key, no network past loopback: a node:http stub speaks the Anthropic messages api from a
 * per-request plan, the provider's baseUrl is pointed at it through a models.json override exactly as the
 * operator overlay does in the runner, and the key is a runtime dummy (ModelRuntime.setRuntimeApiKey, 0.99.1).
 * Built from the same public exports and the same src/ helpers run-job.mjs uses: the job's model runtime
 * (createJobModelRuntime) and the job's settings (jobSettings, so cache warming is off and the retry is pinned
 * the way the runner pins it; maxRetries 2 is PI_RETRY_MAX's default, and the base delay is shortened so the
 * backoff costs milliseconds). Resource discovery is switched off: it plays no part here, and a temp agentDir
 * with no extensions, skills or context files keeps the host's own pi setup out of the run. One custom tool,
 * `probe`, stands in for any tool the model calls.
 *
 * The helper also does what run-job.mjs does with a prompt() that REJECTS (issue #509): it tracks whether one
 * of pi's retries is in flight and hands the rejection to classifyPromptRejection, then decideExit, so a test
 * can assert the exit the runner would take, not only the budget state.
 */
const STUB_ANSWERS = (() => {
	const sse = (events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
	const start = (usage = { input_tokens: 10, output_tokens: 1 }) => ["message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, stop_sequence: null, usage } }];
	const stream = (res, events) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(sse(events));
	};
	let toolSeq = 0;
	return {
		429: (res) => {
			res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
			res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limited (loopback stub)" } }));
		},
		text: (res) => stream(res, [
			start(),
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
			["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
			["message_stop", { type: "message_stop" }],
		]),
		tool: (res) => stream(res, [
			start(),
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_stub_${++toolSeq}`, name: "probe", input: {} } }],
			["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
			["message_stop", { type: "message_stop" }],
		]),
		// A billed call that then fails mid-stream with a retryable error: its usage lands on the failed turn.
		errusage: (res) => stream(res, [start({ input_tokens: 5000, output_tokens: 1 }), ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]),
	};
})();

async function runLoopbackSession({ plan, maxTurns = 1, tokenCap = null, onSession }) {
	const requests = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const what = plan[Math.min(requests.length, plan.length - 1)];
			requests.push(what);
			STUB_ANSWERS[what](res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	let session;
	try {
		const agentDir = tempDir("pi-retry-agent-");
		const cwd = tempDir("pi-retry-cwd-");
		const origin = `http://127.0.0.1:${server.address().port}`;
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: origin } } }));
		const modelRuntime = await createJobModelRuntime({ ModelRuntime: mod.ModelRuntime, agentDir, modelsPath });
		await modelRuntime.setRuntimeApiKey("anthropic", "dummy-key-loopback-only");
		const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5-20250929");
		assert.ok(model, "the pinned catalog no longer has the probe model -- pick another anthropic-messages model");
		assert.equal(model.baseUrl, origin, "the models.json override must route the provider to the stub");
		assert.ok(modelRuntime.hasConfiguredAuth(model.provider), "the runtime dummy key must count as configured auth");
		const settingsManager = mod.SettingsManager.inMemory(jobSettings({ maxRetries: 2, baseDelayMs: 5 }));
		const resourceLoader = new mod.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await resourceLoader.reload();
		const toolRuns = [];
		const probe = {
			name: "probe",
			label: "probe",
			description: "a probe tool with no arguments",
			parameters: { type: "object", properties: {} },
			async execute(id) {
				toolRuns.push(id);
				return { content: [{ type: "text", text: `ran ${id}` }], details: {} };
			},
		};
		({ session } = await mod.createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			settingsManager,
			sessionManager: mod.SessionManager.inMemory(cwd),
			resourceLoader,
			customTools: [probe],
		}));
		const order = [];
		// run-job.mjs's retry tracking, verbatim in effect: armed by auto_retry_start, cleared by auto_retry_end.
		let retryInFlight = false;
		session.subscribe((event) => {
			order.push(event.type === "agent_end" ? `agent_end:${event.willRetry}` : event.type);
			if (event.type === "auto_retry_start") retryInFlight = true;
			if (event.type === "auto_retry_end") retryInFlight = false;
		});
		onSession?.(session);
		// The runner's own order: the terminal subscription, then the turn budget, then the fallback token budget.
		const budget = attachTurnBudget(session, maxTurns);
		const tokenBudget = tokenCap === null ? null : attachTokenBudget(session, tokenCap);
		let rejection = null;
		let rejected = null;
		try {
			await session.prompt("say ok");
		} catch (error) {
			rejection = error;
			rejected = classifyPromptRejection(error, { retryInFlight });
		}
		const last = session.messages.at(-1);
		return {
			budget: { ...budget.state },
			tokenBudget: tokenBudget && { ...tokenBudget.state },
			requests,
			toolRuns: toolRuns.length,
			order: order.filter((type) => !/^(message_update|queue_update|tool_execution_update)$/.test(type)),
			last,
			rejection,
			followUps: session.getFollowUpMessages().length,
			// The exit the runner takes, when the rejection is one it classifies; an unclassified rejection is
			// run-job's rethrow to classifyThrow, reported here as `rejection` with `exit` null.
			exit: rejection && !rejected ? null : decideExit({ budgetAborted: budget.state.aborted, budgetTurns: budget.state.turns, tokenAborted: tokenBudget?.state.aborted ?? false, terminal: last, rejected }),
		};
	} finally {
		session?.dispose();
		server.close();
	}
}

test("pi emits auto_retry_start before the retry's own agent_start/turn_start, so a recovered 429 is one budget turn (loopback, no key)", { skip }, async () => {
	const { budget, requests, order, last } = await runLoopbackSession({ plan: ["429", "text"] });

	// The order is asserted first so a pi bump fails on the order message, and the budget second so a
	// change to the budget fails on its own message rather than on the request count it causes.
	const retryAt = order.indexOf("auto_retry_start");
	assert.ok(retryAt !== -1, `pi no longer emits auto_retry_start on a retried 429: ${order.join(",")}`);
	assert.equal(order.filter((type) => type === "auto_retry_start").length, 1);
	// What the budget's exemption rests on: the failed turn's end, then auto_retry_start, THEN the
	// continuation's agent_start and turn_start, with no turn_start in between.
	const retryTurnAt = order.indexOf("turn_start", retryAt);
	assert.ok(order.indexOf("turn_start") < order.indexOf("agent_end:true"), "the failed turn opened before its agent_end");
	assert.ok(order.indexOf("agent_end:true") < retryAt, `auto_retry_start must follow the failed run's agent_end{willRetry:true}: ${order.join(",")}`);
	assert.ok(retryTurnAt > retryAt, `no turn_start after auto_retry_start: ${order.join(",")}`);
	assert.ok(order.indexOf("agent_start", retryAt) > retryAt && order.indexOf("agent_start", retryAt) < retryTurnAt, `the retry's agent_start must fall between auto_retry_start and its turn_start: ${order.join(",")}`);
	assert.equal(order.filter((type) => type === "turn_start").length, 2, `exactly the failed turn and its retry: ${order.join(",")}`);
	assert.ok(order.indexOf("auto_retry_end") > retryTurnAt, "auto_retry_end{success:true} arrives after the retry turn started, so it cannot be what clears the flag first");

	assert.deepEqual(
		budget,
		{ turns: 1, retryTurns: 1, aborted: false },
		"a recovered 429 under --max-turns 1 must be one budget turn and one retry turn, not a turn_budget stop",
	);
	assert.deepEqual(requests, ["429", "text"], "one 429 and one retried request must reach the stub");
	assert.equal(last?.stopReason, "stop", "the retried request's text reply ends the run");
});

test("a 429 that outlasts pi's retries is one budget turn and PI_RETRY_MAX retry turns, never a turn_budget stop (loopback, no key)", { skip }, async () => {
	const { budget, requests, order, last } = await runLoopbackSession({ plan: ["429"] });
	assert.deepEqual(budget, { turns: 1, retryTurns: 2, aborted: false }, "the runner then exits 1 on the 429, retried by the queue");
	assert.equal(requests.length, 3, "the first call and pi's two retries");
	assert.equal(last?.stopReason, "error");
	assert.ok(order.lastIndexOf("auto_retry_end") > order.lastIndexOf("agent_end:false"), `an exhausted streak ends with auto_retry_end, no further auto_retry_start: ${order.join(",")}`);
});

test("a retry-shaped throw after the turn's tools ran is never re-run for free: pi cannot resume it, and the runner exits 2 (loopback, no key)", { skip }, async () => {
	// Issue #455 gate round 1, A8, as it behaves at the 0.99.1 pin (issue #509). pi turns an exception thrown in
	// its loop into an assistant error; a listener throwing "fetch failed" on each tool result's message_end
	// made pi 0.80.7 retry turns whose tools had already run, each retry a new model call with fresh tool
	// results (9 paid calls at --max-turns 1 with the unguarded exemption). At 0.99.1 the retry omits the
	// failed attempt and continue() refuses a transcript that ends on the assistant, so prompt() REJECTS.
	// Left unclassified that is exit 1, and the queue would re-run the whole job, model call and tool run
	// included, on a fresh budget: #449/#455's rule forbids exactly that re-run for free.
	const shape = {
		plan: [...Array(8).fill("tool"), "text"],
		onSession: (session) =>
			session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "toolResult") throw new Error("fetch failed");
			}),
	};
	const UNRESUMABLE = "Cannot continue from message role: assistant";
	// Under --max-turns 1, and again under a cap that cannot fire, so the verdict is shown not to be the budget's.
	for (const maxTurns of [1, 100]) {
		const { budget, requests, toolRuns, order, rejection, exit } = await runLoopbackSession({ ...shape, maxTurns });
		// The premise, so this cannot pass for another reason: pi did schedule a retry, after its tool ran.
		assert.ok(order.includes("auto_retry_start"), `pi no longer retries a retry-shaped throw after a tool: ${order.join(",")}`);
		assert.ok(order.indexOf("tool_execution_start") < order.indexOf("auto_retry_start"), "the tool ran before the retry");
		// What 0.99.1 does with it: the retry never reaches the model, and prompt() rejects while it is in flight.
		assert.equal(rejection?.message, UNRESUMABLE, `pi's retry after a tool no longer ends in its continue() refusal (got ${rejection?.message ?? "a resolved prompt"}): re-derive classifyPromptRejection`);
		assert.ok(!order.includes("auto_retry_end"), `the retry must still be in flight when prompt() rejects -- the condition classifyPromptRejection reads: ${order.join(",")}`);
		// The outcome #455 pinned still holds: one counted turn, one paid call, one tool run, nothing re-run.
		assert.deepEqual(requests, ["tool"], `maxTurns ${maxTurns}: the retry must never reach the provider`);
		assert.equal(toolRuns, 1);
		assert.deepEqual(budget, { turns: 1, retryTurns: 0, aborted: false }, `maxTurns ${maxTurns}: no second turn started`);
		assert.deepEqual(exit, { code: 2, reason: "retry-unresumable", message: UNRESUMABLE }, `maxTurns ${maxTurns}: exit 2, never the queue's retry of work already paid for`);
	}
});

test("a queued follow-up after the budget aborts is aborted too: every over-cap turn re-aborts (loopback, no key)", { skip }, async () => {
	// Issue #455 gate round 1, A13 (pre-existing). A message queued for a follow-up made pi 0.80.7's
	// _handlePostAgentRun start a NEW run with a fresh AbortController after the budget's abort; a budget
	// that aborted once let it run on (7 paid calls at --max-turns 1, on main too). session.followUp is the
	// public queue a staged extension's sendUserMessage(deliverAs: "followUp") lands in.
	let turnStarts = 0;
	const { budget, requests, toolRuns, order, followUps, exit } = await runLoopbackSession({
		plan: [...Array(6).fill("tool"), "text"],
		onSession: (session) =>
			session.subscribe((event) => {
				if (event.type === "turn_start" && ++turnStarts === 2) void session.followUp("keep going");
			}),
	});
	// The premise at 0.99.1 (issue #509): the follow-up really was queued during the over-cap turn, and pi no
	// longer starts a run for it after the abort -- it is still in the queue when prompt() returns. If pi goes
	// back to starting that run, this premise fails first, and the outcome below is what must still hold.
	assert.equal(followUps, 1, "the follow-up was queued and is still queued: the premise the test is about");
	assert.equal(order.filter((type) => type === "agent_start").length, 1, `pi started a new run for the queued follow-up again, as 0.80.7 did: the re-abort path is live once more: ${order.join(",")}`);
	assert.equal(budget.aborted, true);
	assert.deepEqual(requests, ["tool"], "only the first, counted turn reaches the provider");
	assert.equal(toolRuns, 1);
	assert.equal(exit?.reason, "turn_budget");
});

test("a retry-shaped throw after a COMPLETED reply is not exempt: a queued follow-up is a counted turn (loopback, no key)", { skip }, async () => {
	// Gate round 2 of #455, A14. A listener throwing "fetch failed" at a clean reply's turn_end (the same
	// shape as ETIMEDOUT while persisting it) makes pi retry; agent.continue() from the reply then runs the
	// queued follow-up as new work, with no tool before it. Unguarded: 6 paid calls at --max-turns 1.
	let queued = false;
	const { budget, requests, order } = await runLoopbackSession({
		plan: ["text"],
		onSession: (session) =>
			session.subscribe((event) => {
				if (event.type === "turn_start" && !queued) {
					queued = true;
					void session.followUp("keep going");
				}
				if (event.type === "turn_end" && event.message.stopReason === "stop") throw new Error("fetch failed");
			}),
	});
	// The premise, so this cannot pass for another reason: pi did retry after the completed reply.
	assert.ok(order.includes("auto_retry_start"), `pi no longer retries a retry-shaped throw after a clean reply: ${order.join(",")}`);
	assert.deepEqual(budget, { turns: 2, retryTurns: 0, aborted: true }, "the follow-up's turn is the second real turn and trips the budget");
	assert.deepEqual(requests, ["text"], "the aborted follow-up turn never reaches the provider");
});

test("the fallback token budget stops pi's retry of the breaching turn (loopback, no key)", { skip }, async () => {
	// Issue #455 gate round 1, A11. The per-session token budget (the fallback when the process-wide meter
	// cannot install) aborts on the breaching turn's turn_end. At 0.80.7, when that turn FAILED with a
	// retryable error, pi's retry started with a fresh signal and the one abort never reached it; the re-abort
	// on the retry's turn_start did. The turn budget is set high so only the token budget can stop anything.
	const { tokenBudget, requests, order, exit } = await runLoopbackSession({ plan: ["errusage", "text"], maxTurns: 100, tokenCap: 100 });
	assert.equal(tokenBudget.aborted, true, "the failed call's usage breaches a cap of 100");
	// The premise at 0.99.1 (issue #509): the abort at turn_end now reaches pi before it decides to retry, so
	// no retry starts at all, and the failed run's agent_end says so. If pi retries again, the re-abort on the
	// retry's turn_start is what stops it, and the outcome below must still hold.
	assert.ok(!order.includes("auto_retry_start"), `pi retries the breaching turn again despite the abort, as 0.80.7 did: the re-abort path is live once more: ${order.join(",")}`);
	assert.ok(order.includes("agent_end:false"), `the failed run ends with willRetry:false: ${order.join(",")}`);
	assert.deepEqual(requests, ["errusage"], "no retried request reaches the provider");
	assert.deepEqual(exit, { code: 2, reason: "token_budget" });
});

test("google-vertex ADC: the pinned auth library's OAuth refusals keep their shapes and stay a retried residual (loopback, no key)", { skip }, async () => {
	// Issue #451. Under ADC, google-vertex fails at Google's OAuth token endpoint before Vertex is reached,
	// and the message is the auth library's, not pi-ai's: gtoken sets `${error}: ${error_description}` for a
	// service account, gaxios throws the bare RFC 6749 code for an authorized_user refresh. M0-d measured
	// both through pi-ai against the real endpoint, unchanged by pi-ai. They stay infra, a NAMED residual,
	// because the codes are not specific enough: invalid_grant also covers a clock-skewed JWT assertion and
	// a service account still propagating, both transient, and a bare invalid_client is too generic. This
	// drives the SAME library copies pi-ai's @google/genai resolves, their fetch redirected to the loopback
	// (the service-account and authorized_user token URLs are fixed to Google's), so the residual's shapes
	// are pinned: a bump that changes them, or pi-ai's verdict on them, fails here. The third form, the
	// external_account one, goes through the family's own stream() in the next test.
	const { createRequire } = await import("node:module");
	const { generateKeyPairSync } = await import("node:crypto");
	const candidates = resolvePiAiCompat();
	const isRetryable = await loadRetryPredicate({ candidates });
	const fromGenai = createRequire(createRequire(candidates[0].url).resolve("@google/genai"));
	const authLibrary = fromGenai("google-auth-library");
	const { Gaxios } = createRequire(fromGenai.resolve("google-auth-library"))("gaxios");

	let answer = { status: 500, body: {} };
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(answer.status, { "content-type": JSON_TYPE });
			res.end(JSON.stringify(answer.body));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const tokenUrls = [];
	const transporter = new Gaxios({
		fetchImplementation: (url, init) => {
			tokenUrls.push(String(url));
			return fetch(`http://127.0.0.1:${server.address().port}/token`, init);
		},
	});
	const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
	const credentials = {
		service_account: { type: "service_account", client_email: "probe@pinned-probe.iam.gserviceaccount.com", private_key: privateKey },
		authorized_user: { type: "authorized_user", client_id: "probe.apps.googleusercontent.com", client_secret: "probe", refresh_token: "1//probe" },
	};
	// The first and third are the exact messages M0-d saw from the real endpoint.
	const cells = [
		{ kind: "service_account", status: 400, body: { error: "invalid_grant", error_description: "Invalid grant: account not found" }, want: "invalid_grant: Invalid grant: account not found" },
		{ kind: "service_account", status: 401, body: { error: "invalid_client", error_description: "The OAuth client was not found." }, want: "invalid_client: The OAuth client was not found." },
		{ kind: "authorized_user", status: 401, body: { error: "invalid_client", error_description: "The OAuth client was not found." }, want: "invalid_client" },
		{ kind: "authorized_user", status: 400, body: { error: "invalid_grant", error_description: "Bad Request" }, want: "invalid_grant" },
	];
	try {
		for (const cell of cells) {
			answer = cell;
			const auth = new authLibrary.GoogleAuth({ credentials: credentials[cell.kind], scopes: ["https://www.googleapis.com/auth/cloud-platform"], clientOptions: { transporter } });
			const message = await auth.getAccessToken().then(() => null, (error) => error.message);
			assert.equal(message, cell.want, `${cell.kind} ${cell.body.error}: the pinned auth library reformatted its refusal`);
			const terminal = { role: "assistant", stopReason: "error", errorMessage: message, content: [] };
			assert.equal(isRetryable(terminal), false, `${cell.kind} ${cell.body.error}: pi-ai now calls this transient`);
			assert.deepEqual(classifyStopReason(terminal, isRetryable), { code: 1, reason: "error", message }, `${cell.kind} ${cell.body.error}: the residual moved`);
		}
	} finally {
		server.close();
	}
	assert.ok(tokenUrls.length >= cells.length && tokenUrls.every((url) => url === "https://oauth2.googleapis.com/token"), `the library asked ${JSON.stringify(tokenUrls)}, not Google's token endpoint`);
});

test("google-vertex ADC, external_account: the family's own stream() turns a token-endpoint refusal into a retried residual (loopback, no key)", { skip }, async () => {
	// Issue #451 gate round 1. An external_account credential names its own token_url, so the google-vertex
	// family's real stream() can be driven to a loopback token endpoint in-process, no TLS. Its refusal is a
	// third form, `Error code <code>: <description>` (google-auth-library's OAuth error parsing), and it
	// stays infra with the other ADC shapes: a bump that changes the form or its verdict fails here.
	const { writeFileSync } = await import("node:fs");
	const candidates = resolvePiAiCompat();
	const isRetryable = await loadRetryPredicate({ candidates });
	const requests = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			requests.push(`${req.method} ${req.url}`);
			res.writeHead(400, { "content-type": JSON_TYPE });
			res.end(JSON.stringify({ error: "invalid_grant", error_description: "The audience in ID Token does not match the expected audience." }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const dir = tempDir("pi-vertex-adc-");
	writeFileSync(join(dir, "subject.txt"), "probe-subject-token");
	writeFileSync(join(dir, "credentials.json"), JSON.stringify({
		type: "external_account",
		audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/probe/providers/probe",
		subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
		token_url: `http://127.0.0.1:${server.address().port}/v1/token`,
		credential_source: { file: join(dir, "subject.txt") },
	}));
	let terminal;
	try {
		const api = await import(new URL("./api/google-vertex.js", candidates[0].url).href);
		const model = {
			id: "pinned-probe", name: "pinned-probe", api: "google-vertex", provider: "google-vertex", baseUrl: "",
			reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 16,
		};
		terminal = await api.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
			project: "pinned-probe", location: "us-central1", env: { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "credentials.json") },
		}).result();
	} finally {
		server.close();
	}
	assert.deepEqual(requests, ["POST /v1/token"], "the family must have asked the loopback token endpoint, and only it");
	assert.equal(terminal.stopReason, "error");
	assert.equal(terminal.errorMessage, "Error code invalid_grant: The audience in ID Token does not match the expected audience.", "the external_account refusal form moved");
	assert.equal(isRetryable(terminal), false, "pi-ai now calls the external_account refusal transient");
	assert.deepEqual(classifyStopReason(terminal, isRetryable), { code: 1, reason: "error", message: terminal.errorMessage }, "the ADC residual moved");
});

// ── Issue #501: every pi-ai fact the cost bound rests on, pinned at the copy pi uses ─────────────────────────
//
// callCostBound (image/runner/src/usage-meter.mjs) restates pi-ai's pricing rules as a worst case. A restated
// rule is pinned or it drifts (CLAUDE.md), and here a drift is not a wrong number in a report: it is a cap that
// lets a call past it. So each rule the bound encodes is read out of the NESTED pi-ai copy (the one pi calls)
// and held here. A pin bump that changes any of them fails this file, and the fix is the bound, never the needle.

/** The nested pi-ai dist the runner's meter accepts, and one of its files. */
function nestedPiAi(...segments) {
	return readFileSync(join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), ...segments), "utf8");
}

test("PRICED_APIS is exactly the set of pi-ai api modules that reach calculateCost (issue #501)", { skip }, () => {
	const apiDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "api");
	const modules = readdirSync(apiDir).filter((name) => name.endsWith(".js") && !name.endsWith(".lazy.js")).map((name) => name.slice(0, -3));
	const source = new Map(modules.map((name) => [name, readFileSync(join(apiDir, `${name}.js`), "utf8")]));
	// Direct: imports calculateCost from ../models.js. Then the fixpoint over sibling imports (the two shared
	// modules carry it for the responses family and the system-one classifiers).
	const reaches = new Set(modules.filter((name) => /import \{[^}]*\bcalculateCost\b[^}]*\} from "\.\.\/models\.js";/.test(source.get(name))));
	assert.ok(reaches.has("openai-responses-shared") && reaches.has("system-one-shared"), "the premise: the two shared modules price");
	for (let grew = true; grew; ) {
		grew = false;
		for (const name of modules) {
			if (reaches.has(name)) continue;
			const siblings = [...source.get(name).matchAll(/from "\.\/([a-z0-9-]+)\.js";/g)].map((match) => match[1]);
			if (siblings.some((sibling) => reaches.has(sibling))) {
				reaches.add(name);
				grew = true;
			}
		}
	}
	// An api module is one pi loads for an api id: it has a `.lazy.js` that imports it, and the catalog files it
	// under that id.
	const catalogApis = new Set();
	const dataDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "providers", "data");
	for (const file of readdirSync(dataDir).filter((name) => name.endsWith(".json"))) {
		for (const key of Object.keys(JSON.parse(readFileSync(join(dataDir, file), "utf8")))) catalogApis.add(key);
	}
	const served = [...reaches].filter((name) => existsSync(join(apiDir, `${name}.lazy.js`)) && new RegExp(`"\\./${name}\\.(?:js|ts)"`).test(readFileSync(join(apiDir, `${name}.lazy.js`), "utf8"))).sort();
	assert.deepEqual(served, [...PRICED_APIS], "the priced apis moved -- update PRICED_APIS, the bound refuses everything else under a cap");
	for (const api of PRICED_APIS) assert.ok(catalogApis.has(api), `${api} is not an api id the catalog files models under`);
	// And the ones that do NOT price from the table, by name, so the refusal of each is a decision on record.
	for (const api of ["pi-messages", "openrouter-images", "llama-cpp-classify"]) assert.ok(!PRICED_APIS.includes(api) && modules.includes(api), api);
});

test("calculateCost: one table per call, the highest tier the input passes, and a 1h write at 2 x that table's input", { skip }, () => {
	const models = nestedPiAi("models.js");
	const fn = models.match(/export function calculateCost\(model, usage\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.match(fn, /const inputTokens = usage\.input \+ usage\.cacheRead \+ usage\.cacheWrite;/, "tiers select on input + cache read + cache write");
	assert.match(fn, /if \(inputTokens > tier\.inputTokensAbove && tier\.inputTokensAbove > matchedThreshold\) \{\s*rates = tier;/, "strictly above a threshold, and ONE table");
	assert.match(fn, /usage\.cost\.cacheWrite = \(rates\.cacheWrite \* shortWrite \+ rates\.input \* 2 \* longWrite\) \/ 1000000;/, "the 1h write rate is 2 x the table's input");
	assert.match(fn, /usage\.cost\.output = \(rates\.output \/ 1000000\) \* usage\.output;/, "rates are dollars per million tokens, so tokens x rate is micro-dollars");
	// Only the two Anthropic apis report a 1h write; the bound's 2 x input applies to exactly them.
	const apiDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "api");
	const reporting = readdirSync(apiDir).filter((name) => name.endsWith(".js") && !name.endsWith(".lazy.js") && readFileSync(join(apiDir, name), "utf8").includes("cacheWrite1h")).sort();
	assert.deepEqual(reporting, ["anthropic-messages.js", "bedrock-converse-stream.js"]);
	// Retention resolves as callCostBound resolves it: the option, else the env (scoped, then the process).
	for (const file of ["anthropic-messages.js", "bedrock-converse-stream.js"]) {
		assert.match(nestedPiAi("api", file), /function resolveCacheRetention\(cacheRetention, env\) \{\s*if \(cacheRetention\) \{\s*return cacheRetention;\s*\}\s*if \(getProviderEnvValue\("PI_CACHE_RETENTION", env\) === "long"\) \{\s*return "long";/, file);
	}
	assert.match(nestedPiAi("utils", "provider-env.js"), /return \(env\?\.\[name\] \|\|\s*\(typeof process !== "undefined" \? process\.env\[name\] : undefined\) \|\|/, "a scoped env value wins over the process env");
	// A fallback answer is priced at the fallback's table (its own tiers included), and only anthropic-messages has fallbacks.
	const anthropic = nestedPiAi("api", "anthropic-messages.js");
	assert.match(anthropic, /model\.compat\?\.allowedFallbackModels\?\.find\(\(fallback\) => fallback\.provider === model\.provider && fallback\.model === responseModel\)\?\.cost;/);
	assert.match(anthropic, /usageModel = fallbackCost \? \{ \.\.\.model, id: responseModel, cost: fallbackCost \} : model;/);
	const withFallbacks = readdirSync(apiDir).filter((name) => name.endsWith(".js") && readFileSync(join(apiDir, name), "utf8").includes("allowedFallbackModels"));
	assert.deepEqual(withFallbacks, ["anthropic-messages.js"]);
});

test("a server-side fallback is a responseModel from the requested model's allowedFallbackModels; a completions responseModel is an alias (issue #502)", { skip }, () => {
	// The model guard's model_fallback line (createModelGuard's bind) matches a settled message's responseModel against
	// the REQUESTED model's compat.allowedFallbackModels, by provider and id, exactly as pi prices a fallback answer.
	assert.match(nestedPiAi("types.d.ts"), /export interface AssistantMessage \{[^}]*\n\s*responseModel\?: string;/, "AssistantMessage.responseModel moved");
	const anthropic = nestedPiAi("api", "anthropic-messages.js");
	assert.match(anthropic, /const responseModel = event\.message\.model;\s*if \(responseModel !== model\.id\)\s*output\.responseModel = responseModel;/, "anthropic-messages names a fallback answer in responseModel");
	assert.match(anthropic, /model\.compat\?\.allowedFallbackModels\?\.find\(\(fallback\) => fallback\.provider === model\.provider && fallback\.model === responseModel\)/, "a fallback is matched by provider and model, as fallbackOf matches it");
	// openai-completions sets responseModel for ANY chunk model other than the requested id: a provider's alias for the
	// model asked for (a dated snapshot), which is why the guard does not log every responseModel as a fallback.
	assert.match(nestedPiAi("api", "openai-completions.js"), /if \(typeof chunk\.model === "string" && chunk\.model\.length > 0 && chunk\.model !== model\.id\) \{\s*output\.responseModel \|\|= chunk\.model;/, "openai-completions' alias rule moved");
	// Exactly these two api modules write responseModel; a third would need the same reading.
	const apiDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "api");
	const writing = readdirSync(apiDir).filter((name) => name.endsWith(".js") && !name.endsWith(".lazy.js") && /\.responseModel (?:\|\|)?= /.test(readFileSync(join(apiDir, name), "utf8"))).sort();
	assert.deepEqual(writing, ["anthropic-messages.js", "openai-completions.js"]);
});

test("what else picks the model that answers, as the model guard reads it (issue #502, PR #538's review)", { skip }, () => {
	const apiDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "api");
	const modules = readdirSync(apiDir).filter((name) => name.endsWith(".js") && !name.endsWith(".lazy.js"));
	// onPayload: every module that sends a request hands the built payload to options.onPayload and uses what it
	// returns, so the guard's wrapper sees the final routing fields. A new module without it is a payload the guard
	// cannot read, and fails here.
	const hooked = modules.filter((name) => /await options\??\.onPayload\?\.\((?:params|payload|commandInput|body), model\)/.test(readFileSync(join(apiDir, name), "utf8"))).sort();
	assert.deepEqual(hooked, ["anthropic-messages.js", "azure-openai-responses.js", "bedrock-converse-stream.js", "google-generative-ai.js", "google-vertex.js", "llama-cpp-classify.js", "mistral-conversations.js", "openai-codex-responses.js", "openai-completions.js", "openai-responses.js", "openrouter-images.js", "pi-messages.js", "system-one-shared.js"]);
	assert.match(nestedPiAi("api", "simple-options.js"), /onPayload: options\?\.onPayload,/, "streamSimple's options keep the caller's onPayload");
	assert.match(agentDistFile("core", "model-runtime.js"), /const \{ transformHeaders, \.\.\.rawProviderOptions \} = options \?\? \{\};[\s\S]*?options: \{\s*\.\.\.providerOptions,/, "prepareRequest passes the caller's options, onPayload included, to the provider");
	// The session's before_provider_request hooks reach the provider through that same option.
	assert.match(agentDistFile("core", "sdk.js"), /onPayload: transformProviderPayload,/);
	assert.match(agentDistFile("core", "sdk.js"), /return runner\.emitBeforeProviderRequest\(payload\);/);
	assert.match(readFileSync(join(piOwnPackageDir("pi-agent-core"), "dist", "agent.js"), "utf8"), /onPayload: this\.onPayload,/, "the agent loop hands its onPayload to each request");
	// The routing fields PAYLOAD_ROUTING_KEYS compares: `model` everywhere, `modelId` on bedrock, `fallbacks` on anthropic.
	assert.match(nestedPiAi("api", "bedrock-converse-stream.js"), /modelId: model\.id,/);
	assert.match(nestedPiAi("api", "anthropic-messages.js"), /params\.fallbacks = allowedFallbackModels\.map\(\(fallback\) => \(\{ model: fallback\.model \}\)\);/, "pi sends fallback ids only, so the guard pairs them with the model's provider");
	// Sampling parameters are merged after the request is built, so a `model` key there replaces the requested one.
	// Since pi 1.0.2 the merged object is resolveSamplingParams' (the model's, the thinking level's, the call's), and
	// the guards read every layer of it (samplingLayers); the merge itself is pinned in the #534 test below.
	for (const file of ["openai-completions.js", "openai-responses.js", "azure-openai-responses.js"]) {
		assert.match(nestedPiAi("api", file), /const samplingParams = resolveSamplingParams\(model, [^;]*?, options\?\.samplingParams\);\s*if \(samplingParams\) \{\s*Object\.assign\(params, samplingParams\);/, file);
	}
	// azure picks its deployment from the call before model.id, in one function since pi 1.0.3 (issue #587)...
	assert.match(nestedPiAi("api", "azure-openai-config.js"), /export function resolveDeploymentName\(model, options\) \{\s*if \(options\?\.azureDeploymentName\) \{\s*return options\.azureDeploymentName;\s*\}\s*const mappedDeployment = parseDeploymentNameMap\(getProviderEnvValue\("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options\?\.env\)\)\.get\(model\.id\);/);
	// ...which the azure-openai-responses api calls for any provider, and the `azure` provider calls for EVERY api it
	// serves, rewriting payload.model in its own onPayload wrapper (so the guard's payload check never sees it). That
	// is why the model guard keys the deployment check on the api OR the provider. Exactly these two callers.
	const callers = [...modules.map((name) => `api/${name}`), ...readdirSync(join(apiDir, "..", "providers")).filter((name) => name.endsWith(".js")).map((name) => `providers/${name}`)].filter((file) => file !== "api/azure-openai-config.js" && /\bresolveDeploymentName\(/.test(nestedPiAi(...file.split("/")))).sort();
	assert.deepEqual(callers, ["api/azure-openai-responses.js", "providers/azure.js"]);
	const azureProvider = nestedPiAi("providers", "azure.js");
	assert.match(azureProvider, /id: "azure",/, "the azure provider id moved: the model guard's AZURE_PROVIDER must follow it");
	assert.match(azureProvider, /const deploymentName = resolveDeploymentName\(model, options\);[\s\S]*?const params = \{ \.\.\.payload, model: deploymentName \};/, "the provider's deployment rewrite moved");
	assert.match(azureProvider, /"openai-completions": azureStreams\(openAICompletionsApi\(\)\),/, "the azure provider no longer rewrites the deployment on openai-completions");
	// A caller's own fetch sends the request after every hook: the guard refuses it, and pi passes none itself.
	assert.doesNotMatch(agentDistFile("core", "sdk.js"), /\bfetch: /, "pi's session now passes a fetch of its own: the guard's fetch refusal would stop every listed job");
	// ...nor does the agent loop's per-request config, nor the cache warmer's call (the other two places that build the
	// options a session call carries).
	const agentCore = readFileSync(join(piOwnPackageDir("pi-agent-core"), "dist", "agent.js"), "utf8");
	const loopConfig = agentCore.match(/\n {4}createLoopConfig\(options = \{\}\) \{([\s\S]*?)\n {4}\}\n/)?.[1];
	assert.ok(loopConfig, "createLoopConfig moved: re-check what options the agent loop passes");
	assert.doesNotMatch(loopConfig, /\bfetch\b/, "the agent loop now passes a fetch");
	const warm = agentDistFile("core", "cache-warmer.js").match(/\.streamSimple\(run\.model, run\.context, \{([\s\S]*?)\}\)/)?.[1];
	assert.ok(warm, "the cache warmer's call moved");
	assert.doesNotMatch(warm, /\bfetch\b/, "the cache warmer now passes a fetch");
});

test("the service-tier multipliers the bound assumes, and azure applying none (issue #501)", { skip }, () => {
	// The worst tier is what the bound multiplies by: pi prices the tier the RESPONSE reports.
	const responses = nestedPiAi("api", "openai-responses.js").match(/function getServiceTierCostMultiplier\(model, serviceTier\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.match(responses, /case "flex":\s*return 0\.5;\s*case "priority":\s*case "fast":\s*return model\.id === "gpt-5\.5" \? 2\.5 : 2;\s*default:\s*return 1;/);
	const codex = nestedPiAi("api", "openai-codex-responses.js").match(/function getServiceTierCostMultiplier\(model, serviceTier\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.match(codex, /case "flex":\s*return 0\.5;\s*case "priority":\s*return model\.id === "gpt-5\.5" \? 2\.5 : 2;\s*default:\s*return 1;/);
	const azure = nestedPiAi("api", "azure-openai-responses.js");
	assert.doesNotMatch(azure, /ServiceTier/, "azure gained a service-tier price: callCostBound's multiplier must cover it");
	assert.match(nestedPiAi("api", "openai-responses-shared.js"), /if \(options\?\.applyServiceTierPricing\) \{/, "the shared stream applies a tier only when its caller hands one");
	// Exactly these two modules apply a tier at all.
	const apiDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "api");
	const tiered = readdirSync(apiDir).filter((name) => name.endsWith(".js") && /function applyServiceTierPricing/.test(readFileSync(join(apiDir, name), "utf8"))).sort();
	assert.deepEqual(tiered, ["openai-codex-responses.js", "openai-responses.js"]);
});

test("the output-bound rules: who sends maxTokens, the 16 floor, the reasoning ceiling, the context clamp (issue #501)", { skip }, () => {
	const simple = nestedPiAi("api", "simple-options.js");
	assert.match(simple, /return Math\.min\(maxTokens, Math\.max\(MIN_MAX_TOKENS, available\)\);/, "the context clamp only ever LOWERS the output cap");
	assert.match(simple, /const maxTokens = baseMaxTokens === undefined \? modelMaxTokens : Math\.min\(baseMaxTokens \+ thinkingBudget, modelMaxTokens\);/, "a thinking budget lifts the cap no higher than model.maxTokens");
	for (const file of ["openai-responses.js", "azure-openai-responses.js"]) {
		const src = nestedPiAi("api", file);
		assert.match(src, /const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;/, file);
		assert.match(src, /params\.max_output_tokens = Math\.max\(options\.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS\);/, file);
	}
	const responses = nestedPiAi("api", "openai-responses.js");
	assert.match(responses, /if \(options\?\.maxTokens && compat\.supportsMaxOutputTokens && !omitUnsupportedFields\) \{/, "when openai-responses drops the caller's cap");
	assert.match(responses, /const omitUnsupportedFields = isChatGPTSignIn\(model, options\?\.apiKey\);/);
	assert.match(responses, /return \(model\.provider === "openai" &&\s*model\.baseUrl === "https:\/\/api\.openai\.com\/v1" &&\s*apiKey !== undefined &&\s*!apiKey\.startsWith\("sk-"\)\);/);
	// The three that never put the caller's cap on the request: no maxTokens anywhere in their source.
	for (const file of ["openai-codex-responses.js", "cloudflare-workers-ai-system-one.js", "typesafe-system-one.js", "system-one-shared.js"]) {
		assert.doesNotMatch(nestedPiAi("api", file), /maxTokens|max_output_tokens|max_tokens/, `${file} now sends an output cap -- callCostBound may use the caller's maxTokens there`);
	}
	// openai-completions drops a falsy cap; the bound reads only a positive one as asked.
	assert.match(nestedPiAi("api", "openai-completions.js"), /if \(options\?\.maxTokens\) \{/);
});

test("COMPLETIONS_CATALOG_HOSTS is exactly the hosts the pinned catalog serves openai-completions on, and pi picks the cap's field from compat (issue #507)", { skip }, () => {
	const dataDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "providers", "data");
	const hosts = new Set();
	const empty = [];
	for (const file of readdirSync(dataDir).filter((name) => name.endsWith(".json"))) {
		for (const row of Object.values(JSON.parse(readFileSync(join(dataDir, file), "utf8"))["openai-completions"] ?? {})) {
			// An empty baseUrl names no host: the server is whatever the operator configures (pi 1.0.3's azure rows,
			// azure/deepseek-v4-pro on openai-completions among them; issue #587). It is never trusted, so it is skipped
			// here and completionsOwnServer counts it as the operator's own server (asserted below).
			if (row.baseUrl === "") empty.push(`${row.provider}/${row.id}`);
			else hosts.add(new URL(row.baseUrl).hostname);
		}
	}
	assert.deepEqual([...COMPLETIONS_CATALOG_HOSTS], [...hosts].sort(), "a catalog host came or went: re-check which field pi sends there before trusting it");
	assert.ok(empty.includes("azure/deepseek-v4-pro"), "the premise: the pinned catalog serves an openai-completions model with no baseUrl");
	for (const ref of empty) {
		const [provider, id] = ref.split("/");
		const model = { api: "openai-completions", provider, id, baseUrl: "" };
		assert.equal(completionsOwnServer(model), true, `${ref}: an empty baseUrl must count as the operator's own server (fail closed)`);
		assert.equal(callCostBound("streamSimple", { ...model, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1000 }, "", {}, {}), Infinity, `${ref}: unbounded unless its compat sends max_tokens`);
		assert.notEqual(callCostBound("streamSimple", { ...model, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } }, "", {}, {}), Infinity, `${ref}: the documented way out (compat.maxTokensField) bounds it`);
	}
	const src = nestedPiAi("api", "openai-completions.js");
	// The one host trusted beside the catalog's, for its own reason: not a catalog openai-completions host, and pi's
	// detection sends it max_completion_tokens (no rule names it), which OpenAI reads.
	assert.deepEqual([...COMPLETIONS_EXTRA_HOSTS], ["api.openai.com"]);
	assert.ok(!hosts.has("api.openai.com"), "api.openai.com became a catalog openai-completions host: drop it from the extra list");
	assert.doesNotMatch(src.slice(src.indexOf("const useMaxTokens"), src.indexOf("const isGrok")), /openai\.com/, "pi now picks the field for api.openai.com itself");
	assert.match(src, /if \(compat\.maxTokensField === "max_tokens"\) \{[^}]*params\.max_tokens = options\.maxTokens;\s*\}\s*else \{\s*params\.max_completion_tokens = options\.maxTokens;/, "max_tokens only when compat says so");
	assert.match(src, /maxTokensField: model\.compat\.maxTokensField \?\? detected\.maxTokensField,/, "the model's compat wins over detection");
	assert.match(src, /maxTokensField: useMaxTokens \? "max_tokens" : "max_completion_tokens",/, "detection's default is max_completion_tokens");
});

test("the catalog rows the bound tests price against are the pinned catalog's (issue #501)", { skip }, () => {
	const dataDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "providers", "data");
	// Every row of every catalog file, found by what it IS (provider, api, id), never by the file it sits in: pi 1.0.3
	// renamed azure-openai-responses.json to azure.json along with the provider (issue #587).
	const rows = readdirSync(dataDir).filter((name) => name.endsWith(".json") && !name.startsWith(".")).flatMap((file) => Object.values(JSON.parse(readFileSync(join(dataDir, file), "utf8"))).flatMap((byKey) => Object.values(byKey)));
	for (const [name, [provider, api, id]] of Object.entries(catalogModels.CATALOG_ROWS)) {
		const found = rows.filter((row) => row.provider === provider && row.api === api && row.id === id);
		assert.equal(found.length, 1, `${name}: ${provider} ${api} ${id} is ${found.length === 0 ? "gone" : "ambiguous"}`);
		const row = found[0];
		const fixture = catalogModels[name];
		for (const field of ["id", "api", "provider", "baseUrl", "cost", "contextWindow", "maxTokens"]) {
			assert.deepEqual(fixture[field], row[field], `${name}.${field} drifted from the pinned catalog`);
		}
		assert.deepEqual(fixture.compat?.allowedFallbackModels, row.compat?.allowedFallbackModels, `${name}'s fallbacks drifted`);
	}
	// The default model's bound, end to end on the pinned row: the issue's "about $1 per call" made exact.
	const sonnet = catalogModels.SONNET_4_5;
	assert.equal(callCostBound("streamSimple", sonnet, "", {}, {}), Math.ceil((2 + BOUND_OVERHEAD_TOKENS) * 3.75 + 64_000 * 15));
});

test("review of #534: the samplingParams merge comes after the output cap, and pi's image resize box (issue #501)", { skip }, () => {
	// PR #534's review: on exactly these three apis a samplingParams key overrides the cap the request was built with, so
	// callCostBound reads the merged keys (samplingOutput). Placed AFTER the cap is the whole point of the needle.
	const apiDir = join(dirname(fileURLToPath(resolvePiAiCompat()[0].url)), "api");
	const MERGE = "Object.assign(params, samplingParams);";
	const merging = readdirSync(apiDir).filter((name) => name.endsWith(".js") && readFileSync(join(apiDir, name), "utf8").includes(MERGE)).sort();
	assert.deepEqual(merging, ["azure-openai-responses.js", "openai-completions.js", "openai-responses.js"]);
	for (const [file, cap] of [["openai-completions.js", "params.max_completion_tokens = options.maxTokens;"], ["openai-responses.js", "params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);"], ["azure-openai-responses.js", "params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);"]]) {
		const src = nestedPiAi("api", file);
		assert.ok(src.indexOf(cap) > 0 && src.indexOf(cap) < src.indexOf(MERGE), `${file}: samplingParams no longer merge after the cap`);
	}
	// Issue #587: what is merged is resolveSamplingParams' object, the model's params, then the thinking level's, then
	// the call's, with the level clamped per model. streamSimple resolves once in buildBaseOptions and the api again, so
	// two levels can meet in one request. callCostBound and the model guard read every level (samplingLayers).
	const simple = nestedPiAi("api", "simple-options.js");
	assert.match(simple, /export function resolveSamplingParams\(model, thinkingLevel, requestParams\) \{\s*const effectiveThinkingLevel = clampThinkingLevel\(model, thinkingLevel\);\s*const thinkingLevelParams = model\.samplingParamsByThinkingLevel\?\.\[effectiveThinkingLevel\];\s*return model\.samplingParams \|\| thinkingLevelParams \|\| requestParams\s*\? \{ \.\.\.model\.samplingParams, \.\.\.thinkingLevelParams, \.\.\.requestParams \}\s*: undefined;\s*\}/, "resolveSamplingParams' merge moved");
	assert.match(simple, /export function buildBaseOptions\(model, context, options, apiKey\) \{\s*const samplingParams = resolveSamplingParams\(model, options\?\.reasoning \?\? "off", options\?\.samplingParams\);/, "streamSimple's first resolution moved");
	// The model fields any of pi-ai reads sampling parameters from: exactly the two the guards read as layers.
	const fields = new Set();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.name.endsWith(".js")) for (const match of readFileSync(join(dir, entry.name), "utf8").matchAll(/\bmodel\??\.(sampling\w*)/g)) fields.add(match[1]);
		}
	};
	walk(join(apiDir, ".."));
	assert.deepEqual([...fields].sort(), ["samplingParams", "samplingParamsByThinkingLevel"], "a new model field feeds the request's sampling parameters: samplingLayers must read it");
	// PR #534's review: the box pi fits an image into before it enters the conversation, the per-image ceiling's input.
	const resize = agentDistFile("utils", "image-resize-core.js");
	assert.match(resize, new RegExp(`maxWidth: ${IMAGE_RESIZE_MAX.width},\\s*maxHeight: ${IMAGE_RESIZE_MAX.height},`), "pi's default image resize box moved -- IMAGE_RESIZE_MAX must follow it");
	// And a model may declare its own box, which callCostBound reads off the model object.
	assert.match(nestedPiAi("types.d.ts"), /export interface ModelImageResizeOptions \{\s*maxWidth\?: number;\s*maxHeight\?: number;/);
});

// ── Issue #500: the seams subprocess metering needs ──────────────────────────────────────────────────────────
//
// A pi CHILD process has its own ModelRuntime and its own pi-ai, so the runner's meter never sees its calls (OQ-011).
// The design that closes that rests on the facts below, each measured at 0.99.1 and recorded in OQ-011. They are
// pinned here first, before any of the design is built, so a pin bump that moves one fails here and not in a job.

/** The pinned pi-coding-agent package root. */
function agentPackageDir() {
	return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

test("compaction and branch summaries reuse the session's streamFunction, under a fresh session id (issue #500)", { skip }, () => {
	// Why compaction lands in otherTotal (REQ-TOKEN-ACCOUNTING-AND-CAPS). The behavioural proof is the compaction test in
	// usage-meter.integration.test.mjs; these are the three source facts it rests on.
	const session = agentDistFile("core", "agent-session.js");
	// 1. pi's own compaction hands compact() the session's streamFunction (it ends in modelRuntime.streamSimple, which
	//    the meter wraps) and passes NO session id: the last argument is a literal undefined.
	assert.match(session, /\n {8}return compact\(preparation, request\.model, [^;]*?, this\.agent\.streamFunction, request\.env, [^;]*?, undefined\);/, "compaction no longer gets the session's streamFunction, or now gets a session id");
	// 2. A branch summary gets the same streamFunction and no session id either.
	const branch = session.match(/const result = await generateBranchSummary\(entriesToSummarize, \{([\s\S]*?)\n {16}\}\);/);
	assert.ok(branch, "the branch summary call moved");
	assert.match(branch[1], /\n\s*streamFn: this\.agent\.streamFunction,/, "branch summaries no longer reuse the session's streamFunction");
	assert.doesNotMatch(branch[1], /sessionId/, "branch summaries now carry a session id -- re-check where their spend lands");
	// The call site alone cannot see an id that arrives through the auth spread, so pin the receiving side: the branch
	// summary builds its request options from five named fields (no session id) and hands its streamFn on.
	const branchSummary = agentDistFile("core", "compaction", "branch-summarization.js");
	assert.match(branchSummary, /\n {4}const requestOptions = \{ apiKey, headers, env, signal, maxTokens \};\n {4}const response = await completeSummarization\(model, context, requestOptions, streamFn, retry, callbacks\);/, "a branch summary now sends a session id or drops the session's streamFn");
	// 3. The one summarisation choke point: a missing id becomes a fresh uuidv7 (one new `sessions` id per call), and
	//    pi-ai's compat completeSimple is reached only when no streamFn is given at all.
	const compaction = agentDistFile("core", "compaction", "compaction.js");
	assert.match(compaction, /\n {8}sessionId: options\.sessionId \?\? uuidv7\(\),/, "a summary call no longer gets a fresh session id");
	assert.match(compaction, /const produce = async \(\) => streamFn\n\s*\? \(await streamFn\(model, context, requestOptions\)\)\.result\(\)\n\s*: completeSimple\(model, context, requestOptions\);/, "the summary call's streamFn and completeSimple fallback moved");
});

test("the pi CLI a child runs: the bin is the bundle, dist/cli.js still ships, main is exported, setupCli sets process.title, and the two rpc entries (issue #500)", { skip }, () => {
	const root = agentPackageDir();
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	// pi-subagents resolves the CLI from this field, so this is the file a background child runs.
	assert.deepEqual(manifest.bin, { pi: "dist/bundle/cli.js" }, "the package bin moved -- the child preload matches it by realpath");
	assert.match(readFileSync(join(root, "dist", "bundle", "cli.js"), "utf8"), /createRequire\(import\.meta\.url\)\("\.\/cli-runtime\.js"\);/, "the bundle bin no longer loads cli-runtime.js");
	// The bundle's own setupCli, then main: process.title becomes "pi", which rewrites /proc/<pid>/cmdline on Linux,
	// so a detector must match argv[0] "pi" as well as the cli paths.
	const runtime = readFileSync(join(root, "dist", "bundle", "cli-runtime.js"), "utf8");
	assert.match(runtime, /function setupCli\(\)\{process\.title=APP_NAME,/, "the bundle's setupCli no longer sets process.title");
	assert.match(runtime, /setupCli\(\);main\(process\.argv\.slice\(2\)\);\s*$/, "the bundle no longer runs main on process.argv after setupCli");
	// The unbundled CLI: the file a nested runner can import to become a pi CLI.
	assert.match(agentDistFile("cli.js"), /\nsetupCli\(\);\nmain\(process\.argv\.slice\(2\)\);\n/, "dist/cli.js no longer calls setupCli() then main(process.argv.slice(2))");
	assert.match(agentDistFile("cli", "setup.js"), /\n {4}process\.title = APP_NAME;\n/, "dist/cli/setup.js no longer sets process.title");
	assert.match(agentDistFile("config.js"), /export const APP_NAME = piConfigName \|\| "pi";/, "APP_NAME is no longer \"pi\" by default");
	assert.equal(manifest.piConfig?.name, undefined, "the package names its app now -- process.title is no longer \"pi\"");
	assert.equal(typeof mod.main, "function", "main is no longer exported from dist/index.js");
	// Two more entry points run a full session: the package export "./rpc-entry" (the bundle's) and the unbundled
	// dist/rpc-entry.js. Both set process.title to "pi-rpc", not "pi", and call main in rpc mode. A preload that
	// recognises only the two CLIs, or a detector that matches only argv[0] "pi", misses both.
	assert.deepEqual(manifest.exports["./rpc-entry"], { import: "./dist/bundle/rpc-entry.js" }, "the rpc-entry export moved");
	assert.match(readFileSync(join(root, "dist", "bundle", "rpc-entry.js"), "utf8"), /process\.title=`\$\{APP_NAME\}-rpc`;[\s\S]*main\(\["--mode","rpc",\.\.\.process\.argv\.slice\(2\)\]\);\s*$/, "the bundle's rpc entry no longer sets pi-rpc and runs main in rpc mode");
	assert.match(agentDistFile("rpc-entry.js"), /\nprocess\.title = `\$\{APP_NAME\}-rpc`;\n[\s\S]*\nmain\(\["--mode", "rpc", \.\.\.process\.argv\.slice\(2\)\]\);\n/, "dist/rpc-entry.js no longer sets pi-rpc and runs main in rpc mode");
});

test("-ne keeps explicit -e paths, \"--\" ends option parsing, and the subcommand set a preload must skip (issue #500)", { skip }, async () => {
	const { parseArgs } = await import(pathToFileURL(join(agentPackageDir(), "dist", "cli", "args.js")).href);
	// An -e after "--" is a MESSAGE: a preload that appended its -e at the end would turn it into a paid prompt.
	const parsed = parseArgs(["-ne", "-e", "first.mjs", "--model", "p/m", "--", "-e", "second.mjs"]);
	assert.equal(parsed.noExtensions, true);
	assert.deepEqual(parsed.extensions, ["first.mjs"]);
	assert.deepEqual(parsed.messages, ["-e", "second.mjs"]);
	// -ne drops discovery and the built-ins but keeps the explicit -e paths, in both places the loader builds the set.
	const loader = agentDistFile("core", "resource-loader.js");
	assert.match(loader, /const extensionPaths = this\.noExtensions\n\s*\? cliEnabledExtensions\n\s*: this\.mergePaths\(cliEnabledExtensions, enabledExtensions\);/, "-ne no longer keeps the explicit -e paths (final set)");
	assert.match(loader, /const extensionPaths = \(this\.noExtensions \? cliEnabledExtensions : this\.mergePaths\(cliEnabledExtensions, enabledExtensions\)\)\.filter\(/, "-ne no longer keeps the explicit -e paths (current set)");
	assert.match(agentDistFile("cli", "args.js"), /--no-extensions, -ne {11}Disable extension discovery and built-in extensions \(explicit -e paths still work\)/);
	// The subcommands main() dispatches on args[0] before it parses any option. An injected -e in front of one turns it
	// into a prompt (measured: `pi -e x list` runs a chat turn), so the preload must leave these alone.
	// main() from its start to parseArgs: the dispatches in it, exactly. A new `args[0]` branch here (a ninth
	// subcommand) fails this even when the help text does not list it.
	const mainSource = agentDistFile("main.js");
	const start = mainSource.indexOf("export async function main(args, options) {");
	const end = mainSource.indexOf("const parsed = parseArgs(args);", start);
	assert.ok(start >= 0 && end > start, "main() or its parseArgs call moved");
	// The bundle's main() is the one a child runs, so the same dispatch is read from both copies.
	const chunkDir = join(agentPackageDir(), "dist", "bundle", "chunks");
	const bundleMain = readdirSync(chunkDir).map((name) => readFileSync(join(chunkDir, name), "utf8")).filter((text) => text.includes("async function main(args,options){"));
	assert.equal(bundleMain.length, 1, "expected one bundle chunk that defines main()");
	const bundleStart = bundleMain[0].indexOf("async function main(args,options){");
	const bundleEnd = bundleMain[0].indexOf("parseArgs(args)", bundleStart);
	assert.ok(bundleEnd > bundleStart, "the bundle's main() no longer calls parseArgs(args)");
	for (const [copy, dispatch] of [["dist/main.js", mainSource.slice(start, end)], ["the bundle", bundleMain[0].slice(bundleStart, bundleEnd)]]) {
		// Every call that hands args to a command handler (the minified bundle uses comma expressions, not `if`).
		assert.deepEqual([...dispatch.matchAll(/await (\w+)\(args\b/g)].map((match) => match[1]), ["runAuthCommand", "handlePackageCommand", "handleConfigCommand", "runMcpCommand"], `${copy}: main() dispatches a different set of command handlers before parseArgs`);
		// "update" here is not a subcommand branch: it is the Windows exit quirk inside the package-command branch. If
		// pi drops that quirk this fails harmlessly; re-read main() and update the list.
		assert.deepEqual([...dispatch.matchAll(/args\[0\]\s*===\s*"([a-z-]+)"/g)].map((match) => match[1]), ["update", "mcp"], `${copy}: main() reads args[0] for a different set of words before parseArgs ("update" is the Windows exit quirk, "mcp" the only direct dispatch)`);
		assert.equal([...dispatch.matchAll(/args\[0\]/g)].length, 2, `${copy}: main() reads args[0] somewhere new before parseArgs`);
	}
	assert.match(agentDistFile("cli", "auth-command.js"), /if \(args\[0\] !== "auth"\)\n\s*return undefined;/);
	const packages = agentDistFile("package-manager-cli.js");
	// The package-manager words, exactly: parsePackageCommand from its start to its "no command" return.
	const parseStart = packages.indexOf("function parsePackageCommand(args) {");
	const parseEnd = packages.indexOf("if (!command) {", parseStart);
	assert.ok(parseStart >= 0 && parseEnd > parseStart, "parsePackageCommand moved");
	assert.deepEqual([...packages.slice(parseStart, parseEnd).matchAll(/rawCommand === "([a-z-]+)"/g)].map((match) => match[1]), ["uninstall", "install", "remove", "update", "list"], "pi's package-manager command words changed");
	assert.match(packages, /const \[command, \.\.\.rest\] = args;\n\s*if \(command !== "config"\) \{/);
	// And the help text lists exactly that set, so a new subcommand shows up here as well as in main().
	const help = agentDistFile("cli", "args.js").match(/\$\{chalk\.bold\("Commands:"\)\}\n([\s\S]*?)\n\n/);
	const listed = [...new Set([...help[1].matchAll(/\$\{APP_NAME\} ([a-z]+) /g)].map((match) => match[1]))].sort();
	assert.deepEqual(listed, ["auth", "config", "install", "list", "mcp", "remove", "uninstall", "update"], "pi's subcommand set changed");
	// And the preload's own copy of the set is that set (issue #500 part C).
	assert.deepEqual([...PI_SUBCOMMANDS].sort(), listed, "child-preload.mjs PI_SUBCOMMANDS no longer matches pi's subcommands");
});

test("the child route's own files: the preload imports no pi module, the child meter imports only the child's own copies, and the library hook's line is at the pin (issue #500)", { skip }, () => {
	// The preload runs in every Node child the job starts: Node built-ins only up front (usage-meter.mjs is imported
	// only in a pi process), and node:module only as a namespace (registerHooks is newer than some Node 22 releases, and
	// a static named import of a missing export is a SyntaxError that would kill every Node child).
	const preloadSrc = readFileSync(fileURLToPath(new URL("../src/child-preload.mjs", import.meta.url)), "utf8");
	assert.deepEqual([...preloadSrc.matchAll(/^import\s[^\n]*?from\s+"([^"]+)";$/gm)].map((match) => match[0]), [
		'import { existsSync, readFileSync, realpathSync } from "node:fs";',
		'import * as nodeModule from "node:module";',
		'import { basename, dirname, join, sep } from "node:path";',
		'import { fileURLToPath, pathToFileURL } from "node:url";',
		'import { isMainThread } from "node:worker_threads";',
		'import { CHILD_METER_PATH, injectChildMeter, ledgerDirProblem, nestedRunnerKind, PI_ENTRIES, PI_SUBCOMMANDS } from "./child-route.mjs";',
	], "child-preload.mjs imports changed: no pi module, and node:module only as a namespace");
	// The parent's children hook (issue #500 part E) runs in the job runner: no static pi import (it resolves pi's package
	// root by specifier only to name the entry files), and not the preload, which runs on import.
	const watchSrc = readFileSync(fileURLToPath(new URL("../src/child-watch.mjs", import.meta.url)), "utf8");
	assert.deepEqual([...watchSrc.matchAll(/^import\s[^\n]*?from\s+"([^"]+)";$/gm)].map((match) => match[1]), ["node:fs", "node:path", "node:url", "./child-route.mjs", "./outcome.mjs", "./usage-meter.mjs"], "child-watch.mjs imports changed");
	// child-route.mjs is loaded by the preload in every Node child too (issue #500 part D): built-ins only, and its one
	// dynamic import, pi's dist/cli.js, happens only in a nested runner.
	const routeSrc = readFileSync(fileURLToPath(new URL("../src/child-route.mjs", import.meta.url)), "utf8");
	assert.deepEqual([...routeSrc.matchAll(/^import\s[^\n]*?from\s+"([^"]+)";$/gm)].map((match) => match[1]), ["node:fs", "node:path", "node:url"], "child-route.mjs imports changed: built-ins only");
	assert.match(preloadSrc, /registerHooks\(\{ resolve: makeLibraryResolveHook\(/, "a resolve hook only: a load hook breaks `node --import tsx`");
	// Every pinned session entry ships, including the bundle's cli-runtime.js, which the bin loads and which runs the CLI
	// on its own.
	for (const { path } of PI_ENTRIES) assert.ok(existsSync(join(agentPackageDir(), path)), `${path} no longer ships`);
	assert.deepEqual(PI_ENTRIES.map((entry) => entry.path), ["dist/bundle/cli.js", "dist/bundle/cli-runtime.js", "dist/cli.js", "dist/bundle/rpc-entry.js", "dist/rpc-entry.js"]);
	// The child meter: exactly the three bare specifiers pi's loader maps to the child's own copies, and no static
	// usage-meter.mjs (the preload hands it over). Never pi's dist/index.js by path: in a bundled child that is a second
	// copy of the class no session uses.
	const meterSrc = readFileSync(fileURLToPath(new URL("../src/child-meter.ts", import.meta.url)), "utf8");
	assert.deepEqual([...meterSrc.matchAll(/^import\s[^\n]*?from\s+"([^"]+)";$/gm)].map((match) => match[1]), ["@earendil-works/pi-ai", "@earendil-works/pi-ai/providers/all", "@earendil-works/pi-coding-agent"]);
	assert.deepEqual([...meterSrc.matchAll(/\bimport\(([^)]*\))/g)].map((match) => match[1]), ['new URL("./usage-meter.mjs", import.meta.url)'], "the child meter's one dynamic import is usage-meter.mjs, the fallback when no preload handed it over");
	// The library hook's wrapper hands over the module's `ModelRuntime` export, and the compat copy and catalog its own
	// pi-ai resolves; the file must still sit where the hook looks for it.
	const runtimePath = join(agentPackageDir(), "dist", "core", "model-runtime.js");
	assert.ok(pathToFileURL(runtimePath).href.endsWith(MODEL_RUNTIME_SUFFIX), "model-runtime.js moved -- the library hook watches the old path");
	const runtimeSrc = readFileSync(runtimePath, "utf8");
	assert.match(runtimeSrc, /^export class ModelRuntime \{/m, "model-runtime.js no longer declares the class the hook hands over");
	const runtimeUrl = pathToFileURL(runtimePath).href;
	// pi's own pi-ai copy, as model-runtime.js resolves it (piOwnPackageDir; its exports map gives both subpaths).
	const nestedAi = piOwnPackageDir("pi-ai");
	const aiExports = JSON.parse(readFileSync(join(nestedAi, "package.json"), "utf8")).exports;
	assert.ok(aiExports["./compat"] && aiExports["./providers/*"], "model-runtime.js's pi-ai no longer exports ./compat and ./providers/*");
	const next = (specifier) => ({ url: specifier === "@earendil-works/pi-ai/compat" ? pathToFileURL(join(nestedAi, "dist", "compat.js")).href : specifier === "@earendil-works/pi-ai/providers/all" ? pathToFileURL(join(nestedAi, "dist", "providers", "all.js")).href : specifier, format: "module" });
	const wrapped = makeLibraryResolveHook({ packageDir: () => agentPackageDir() })(runtimeUrl, {}, next);
	assert.match(decodeURIComponent(wrapped.url), /library\?\.\(\{ ModelRuntime: __piDispatchReal\.ModelRuntime, compat: __piDispatchCompat,/, "the hook would hand over no class at this pin: model-runtime.js's pi-ai no longer resolves ./compat and ./providers/all");
});

test("a child extension reaches its OWN ModelRuntime through ctx.modelRegistry.runtime, and the bundle's is not dist/index.js's (issue #500)", { skip }, () => {
	// The facade keeps its runtime as a plain property (private only in the type file). A child meter takes the class
	// off that instance, because the bundle carries a second copy of the class that dist/index.js does not export.
	assert.match(agentDistFile("core", "model-registry.js"), /export class ModelRegistry \{\n {4}runtime;\n {4}constructor\(runtime\) \{\n {8}this\.runtime = runtime;\n/, "ModelRegistry no longer keeps its runtime on a plain property");
	assert.match(agentDistFile("core", "extensions", "types.d.ts"), /\n {4}modelRegistry: ModelRegistry;/, "ExtensionContext.modelRegistry moved");
	// A child started from the bundle runs the bundle's copies, so the two facts the child route reads are pinned there
	// too: the facade's runtime is a public field, and -ne keeps the explicit -e paths (both loader sites).
	const chunksDir = join(agentPackageDir(), "dist", "bundle", "chunks");
	const bundled = readdirSync(chunksDir).filter((name) => name.endsWith(".js")).map((name) => readFileSync(join(chunksDir, name), "utf8"));
	assert.equal(bundled.filter((text) => text.includes("var ModelRegistry=class{runtime;constructor(runtime){this.runtime=runtime}")).length, 1, "the bundle's ModelRegistry no longer keeps its runtime on a public field");
	assert.equal(bundled.reduce((count, text) => count + text.split("this.noExtensions?cliEnabledExtensions:this.mergePaths(cliEnabledExtensions,enabledExtensions)").length - 1, 0), 2, "the bundle's -ne no longer keeps the explicit -e paths at both loader sites");
	// The bundle's own virtual modules, read in a child process so its second copy of pi never loads into this one.
	const chunks = join(agentPackageDir(), "dist", "bundle", "chunks");
	const virtual = readdirSync(chunks).filter((name) => /^virtual-modules-[A-Z0-9]+\.js$/.test(name));
	assert.equal(virtual.length, 1, `expected one virtual-modules chunk in the bundle, found ${JSON.stringify(virtual)}`);
	const probe = `const { VIRTUAL_MODULES: v } = await import(${JSON.stringify(pathToFileURL(join(chunks, virtual[0])).href)});
const host = await import("@earendil-works/pi-coding-agent");
process.stdout.write(JSON.stringify({ stream: typeof v["@earendil-works/pi-ai"].createAssistantMessageEventStream, runtime: typeof v["@earendil-works/pi-coding-agent"].ModelRuntime, same: v["@earendil-works/pi-coding-agent"].ModelRuntime === host.ModelRuntime }));`;
	const seen = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }));
	// An extension in a bundled child gets the bundle's own event-stream factory through a bare pi-ai specifier, so a
	// child meter's brake needs no compat copy resolved from disk.
	assert.equal(seen.stream, "function", "the bundle's virtual pi-ai no longer carries createAssistantMessageEventStream");
	assert.equal(seen.runtime, "function", "the bundle's virtual pi-coding-agent no longer exports ModelRuntime");
	assert.equal(seen.same, false, "the bundle's ModelRuntime IS dist/index.js's now -- the child route can be simplified");
});
