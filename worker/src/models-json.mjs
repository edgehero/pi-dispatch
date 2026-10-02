/**
 * The overlay `models.json`, read the way pi reads it (issue #502, PR #536's review): pi 0.99.1's
 * `ModelConfig.load` (`pi-coding-agent/dist/core/model-config.js`) strips a leading BOM, strips `//` comments and
 * trailing commas outside strings, parses, and then checks the whole document against its TypeBox schema. ANY
 * schema error drops the WHOLE file: pi then knows none of its providers or models.
 *
 * The worker must agree with that verdict in both directions, because it decides with it before any spend:
 *   - a file pi accepts (comments, a BOM, a trailing comma) must not be refused here, or a working overlay model
 *     reads as unknown;
 *   - a file pi drops (a `contextWindow: "big"` on some other provider) must not be accepted here, or the job is
 *     admitted, reserves, starts a container, and the runner exits 2 on a model pi never loaded.
 *
 * MIRRORED, not imported: the worker depends on pi-ai only and does not import pi-coding-agent, and the module is
 * not an exported path of that package. The mirror is held to pi by a DIFFERENTIAL test
 * (`worker/test/models-json.test.mjs`) that runs pi's own `ModelConfig.load` at the pin over a corpus of valid and
 * mutated files and requires the same verdict on every one, so a pi bump that moves the schema fails there.
 *
 * Pure: text in, `{ value }` or `{ error }` out. The fs read stays in `readOverlayModels` (model-endpoints.mjs).
 */

/** pi's `stripBom` (`utils/text.js`): one leading U+FEFF. */
export function stripBom(text) {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** pi's `stripJsonComments` (`utils/json.js`), verbatim: `//` line comments and trailing commas, strings untouched. */
export function stripJsonComments(input) {
	return input.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : "")).replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

// A minimal interpreter for the TypeBox kinds pi's schema uses. TypeBox's defaults, as compiled at the pin: an
// Object admits extra keys and refuses arrays and null; a Number is a finite number; a Record checks every own value
// whose key has no line terminator.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const T = {
	str: ({ minLength = 0 } = {}) => (v) => typeof v === "string" && v.length >= minLength,
	num: ({ exclusiveMinimum } = {}) => (v) => typeof v === "number" && Number.isFinite(v) && (exclusiveMinimum === undefined || v > exclusiveMinimum),
	int: ({ minimum, maximum } = {}) => (v) => Number.isInteger(v) && (minimum === undefined || v >= minimum) && (maximum === undefined || v <= maximum),
	bool: () => (v) => typeof v === "boolean",
	lit: (x) => (v) => v === x,
	nul: () => (v) => v === null,
	unknown: () => () => true,
	union: (...xs) => (v) => xs.some((x) => x(v)),
	arr: (x, { maxItems } = {}) => (v) => Array.isArray(v) && (maxItems === undefined || v.length <= maxItems) && v.every((e) => x(e)),
	// TypeBox compiles `Record(String, X)` to `patternProperties: { "^.*$": X }`, and `.` matches no line terminator, so a
	// key holding `\n`, `\r`, U+2028 or U+2029 matches no pattern and its value is never checked (PR #536's review,
	// measured against pi at the pin). Mirrored: such a key's value passes, as it does for pi.
	rec: (x) => (v) => isObj(v) && Object.entries(v).every(([k, e]) => !/^.*$/.test(k) || x(e)),
	// `props` maps a key to [check, optional]. A required key must be present.
	obj: (props) => (v) => isObj(v) && Object.entries(props).every(([k, [check, optional]]) => (Object.hasOwn(v, k) ? check(v[k]) : optional === true)),
};
const opt = (check) => [check, true];
const req = (check) => [check, false];

// The schema, transcribed from model-config.js at the 0.99.1 pin, in its order.
const PercentileCutoffs = T.obj({ p50: opt(T.num()), p75: opt(T.num()), p90: opt(T.num()), p99: opt(T.num()) });
const numOrStr = T.union(T.num(), T.str());
const OpenRouterRouting = T.obj({
	allow_fallbacks: opt(T.bool()),
	require_parameters: opt(T.bool()),
	data_collection: opt(T.union(T.lit("deny"), T.lit("allow"))),
	zdr: opt(T.bool()),
	enforce_distillable_text: opt(T.bool()),
	order: opt(T.arr(T.str())),
	only: opt(T.arr(T.str())),
	ignore: opt(T.arr(T.str())),
	quantizations: opt(T.arr(T.str())),
	sort: opt(T.union(T.str(), T.obj({ by: opt(T.str()), partition: opt(T.union(T.str(), T.nul())) }))),
	max_price: opt(T.obj({ prompt: opt(numOrStr), completion: opt(numOrStr), image: opt(numOrStr), audio: opt(numOrStr), request: opt(numOrStr) })),
	preferred_min_throughput: opt(T.union(T.num(), PercentileCutoffs)),
	preferred_max_latency: opt(T.union(T.num(), PercentileCutoffs)),
});
const VercelGatewayRouting = T.obj({ only: opt(T.arr(T.str())), order: opt(T.arr(T.str())) });
const ThinkingValue = T.union(T.str(), T.nul());
const ThinkingLevelMap = T.obj({ off: opt(ThinkingValue), minimal: opt(ThinkingValue), low: opt(ThinkingValue), medium: opt(ThinkingValue), high: opt(ThinkingValue), xhigh: opt(ThinkingValue), max: opt(ThinkingValue) });
const KwargScalar = T.union(T.str(), T.num(), T.bool(), T.nul());
const KwargVariable = T.obj({ $var: req(T.union(T.lit("thinking.enabled"), T.lit("thinking.effort"))), omitWhenOff: opt(T.bool()) });
const Kwarg = T.union(KwargScalar, KwargVariable);
const affinity = T.union(T.lit("openai"), T.lit("openai-nosession"), T.lit("openrouter"));
const OpenAICompletionsCompat = T.obj({
	supportsStore: opt(T.bool()),
	supportsDeveloperRole: opt(T.bool()),
	supportsReasoningEffort: opt(T.bool()),
	supportsUsageInStreaming: opt(T.bool()),
	supportsFinishReason: opt(T.bool()),
	maxTokensField: opt(T.union(T.lit("max_completion_tokens"), T.lit("max_tokens"))),
	requiresToolResultName: opt(T.bool()),
	requiresAssistantAfterToolResult: opt(T.bool()),
	requiresThinkingAsText: opt(T.bool()),
	requiresReasoningContentOnAssistantMessages: opt(T.bool()),
	thinkingFormat: opt(T.union(...["openai", "openrouter", "together", "baseten", "deepseek", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"].map((x) => T.lit(x)))),
	chatTemplateKwargs: opt(T.rec(Kwarg)),
	chatTemplateArgs: opt(T.rec(Kwarg)),
	cacheControlFormat: opt(T.lit("anthropic")),
	openRouterRouting: opt(OpenRouterRouting),
	vercelGatewayRouting: opt(VercelGatewayRouting),
	supportsOpenAIGrammarTools: opt(T.bool()),
	supportsStrictMode: opt(T.bool()),
	sendSessionAffinityHeaders: opt(T.bool()),
	sessionAffinityFormat: opt(affinity),
	supportsLongCacheRetention: opt(T.bool()),
	vllmPriority: opt(T.num()),
});
const OpenAIResponsesCompat = T.obj({
	supportsDeveloperRole: opt(T.bool()),
	sessionAffinityFormat: opt(affinity),
	supportsLongCacheRetention: opt(T.bool()),
	supportsStrictMode: opt(T.bool()),
	supportsOpenAIGrammarTools: opt(T.bool()),
	supportsMaxOutputTokens: opt(T.bool()),
});
const costRates = { input: req(T.num()), output: req(T.num()), cacheRead: req(T.num()), cacheWrite: req(T.num()) };
const ModelCostTier = T.obj({ inputTokensAbove: req(T.num()), ...costRates });
const ModelCost = T.obj({ ...costRates, tiers: opt(T.arr(ModelCostTier)) });
const ModelPromptCache = T.obj({ short: opt(T.num({ exclusiveMinimum: 0 })), long: opt(T.num({ exclusiveMinimum: 0 })) });
const posInt = T.int({ minimum: 1 });
const ImageResize = T.obj({ maxWidth: opt(posInt), maxHeight: opt(posInt), maxBytes: opt(posInt), jpegQuality: opt(T.int({ minimum: 1, maximum: 100 })) });
const ModelInputLimits = T.obj({ maxRequestBytes: opt(posInt), images: opt(T.obj({ resize: opt(ImageResize), maxPerMessage: opt(posInt), maxPerRequest: opt(posInt) })) });
const AnthropicMessagesCompat = T.obj({
	supportsEagerToolInputStreaming: opt(T.bool()),
	supportsLongCacheRetention: opt(T.bool()),
	sendSessionAffinityHeaders: opt(T.bool()),
	supportsCacheControlOnTools: opt(T.bool()),
	supportsTemperature: opt(T.bool()),
	forceAdaptiveThinking: opt(T.bool()),
	allowEmptySignature: opt(T.bool()),
	supportsStrictTools: opt(T.bool()),
	supportsMidConvoEffort: opt(T.bool()),
	allowedFallbackModels: opt(T.arr(T.obj({ provider: req(T.str({ minLength: 1 })), model: req(T.str({ minLength: 1 })), cost: req(ModelCost) }), { maxItems: 3 })),
});
const ProviderCompat = T.union(OpenAICompletionsCompat, OpenAIResponsesCompat, AnthropicMessagesCompat);
const nonEmpty = T.str({ minLength: 1 });
const inputKinds = T.arr(T.union(T.lit("text"), T.lit("image")));
const headers = T.rec(T.str());
const ModelDefinition = T.obj({
	id: req(nonEmpty),
	name: opt(nonEmpty),
	api: opt(nonEmpty),
	baseUrl: opt(nonEmpty),
	reasoning: opt(T.bool()),
	thinkingLevelMap: opt(ThinkingLevelMap),
	input: opt(inputKinds),
	inputLimits: opt(ModelInputLimits),
	cost: opt(ModelCost),
	promptCache: opt(ModelPromptCache),
	contextWindow: opt(T.num()),
	maxTokens: opt(T.num()),
	samplingParams: opt(T.rec(T.unknown())),
	headers: opt(headers),
	compat: opt(ProviderCompat),
});
const ModelOverride = T.obj({
	name: opt(nonEmpty),
	reasoning: opt(T.bool()),
	thinkingLevelMap: opt(ThinkingLevelMap),
	input: opt(inputKinds),
	inputLimits: opt(ModelInputLimits),
	cost: opt(T.obj({ input: opt(T.num()), output: opt(T.num()), cacheRead: opt(T.num()), cacheWrite: opt(T.num()), tiers: opt(T.arr(ModelCostTier)) })),
	promptCache: opt(ModelPromptCache),
	contextWindow: opt(T.num()),
	maxTokens: opt(T.num()),
	samplingParams: opt(T.rec(T.unknown())),
	headers: opt(headers),
	compat: opt(ProviderCompat),
});
const ProviderConfig = T.obj({
	name: opt(nonEmpty),
	baseUrl: opt(nonEmpty),
	apiKey: opt(nonEmpty),
	api: opt(nonEmpty),
	oauth: opt(T.lit("radius")),
	headers: opt(headers),
	compat: opt(ProviderCompat),
	authHeader: opt(T.bool()),
	models: opt(T.arr(ModelDefinition)),
	modelOverrides: opt(T.rec(ModelOverride)),
});
const ModelsConfig = T.obj({ providers: req(T.rec(ProviderConfig)) });

/**
 * Parse overlay `models.json` TEXT as pi does. `{ value }` when pi would load it, else `{ error }` with a fixed
 * phrase (never the file's text: models.json may hold keys, and a JSON.parse message quotes around the fault).
 */
export function parseModelsJson(text) {
	let parsed;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(String(text))));
	} catch {
		return { error: "is not valid JSON" };
	}
	if (!ModelsConfig(parsed)) return { error: "does not match pi's models.json schema, so pi would load none of it" };
	return { value: parsed };
}
