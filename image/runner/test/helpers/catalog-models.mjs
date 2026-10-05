/**
 * Catalog rows the cost-bound tests price against (issue #501). Copied from the pinned pi-ai catalog
 * (`dist/providers/data/*.json`) and NOT trusted: pinned-api.test.mjs finds each row named in CATALOG_ROWS in the
 * pinned copy by its (provider, api, id), whatever file holds it, and requires these fields to match it, so a pin
 * bump that reprices or renames one of these models fails there rather than leaving cost-guard.test.mjs asserting
 * yesterday's prices. Keyed by identity rather than by file name since pi 1.0.3 renamed the Azure provider from
 * `azure-openai-responses` to `azure` and its file with it (issue #587). Only the fields callCostBound reads are kept.
 */
/** openai.json openai-responses chat:gpt-5.4 */
export const GPT_5_4 = Object.freeze({"id":"gpt-5.4","api":"openai-responses","provider":"openai","baseUrl":"https://api.openai.com/v1","cost":{"input":2.5,"output":15,"cacheRead":0.25,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":5,"output":22.5,"cacheRead":0.5,"cacheWrite":0}]},"contextWindow":272000,"maxTokens":128000});
/** openai.json openai-responses chat:gpt-5.5 */
export const GPT_5_5 = Object.freeze({"id":"gpt-5.5","api":"openai-responses","provider":"openai","baseUrl":"https://api.openai.com/v1","cost":{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":10,"output":45,"cacheRead":1,"cacheWrite":0}]},"contextWindow":272000,"maxTokens":128000});
/** openai-codex.json openai-codex-responses chat:gpt-5.5 */
export const GPT_5_5_CODEX = Object.freeze({"id":"gpt-5.5","api":"openai-codex-responses","provider":"openai-codex","baseUrl":"https://chatgpt.com/backend-api","cost":{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0,"tiers":[{"inputTokensAbove":272000,"input":10,"output":45,"cacheRead":1,"cacheWrite":0}]},"contextWindow":272000,"maxTokens":128000});
/** openai-codex.json openai-codex-responses chat:gpt-5.3-codex-spark */
export const CODEX_SPARK = Object.freeze({"id":"gpt-5.3-codex-spark","api":"openai-codex-responses","provider":"openai-codex","baseUrl":"https://chatgpt.com/backend-api","cost":{"input":1.75,"output":14,"cacheRead":0.175,"cacheWrite":0},"contextWindow":128000,"maxTokens":128000});
/** azure.json azure-openai-responses chat:gpt-5.4 */
export const AZURE_GPT_5_4 = Object.freeze({"id":"gpt-5.4","api":"azure-openai-responses","provider":"azure","baseUrl":"","cost":{"input":2.5,"output":15,"cacheRead":0.25,"cacheWrite":0},"contextWindow":1050000,"maxTokens":128000});
/** anthropic.json anthropic-messages chat:claude-sonnet-4-5-20250929 */
export const SONNET_4_5 = Object.freeze({"id":"claude-sonnet-4-5-20250929","api":"anthropic-messages","provider":"anthropic","baseUrl":"https://api.anthropic.com","cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75},"contextWindow":1000000,"maxTokens":64000});
/** anthropic.json anthropic-messages chat:claude-fable-5 */
export const FABLE_5 = Object.freeze({"id":"claude-fable-5","api":"anthropic-messages","provider":"anthropic","baseUrl":"https://api.anthropic.com","cost":{"input":10,"output":50,"cacheRead":1,"cacheWrite":12.5},"contextWindow":1000000,"maxTokens":128000,"compat":{"allowedFallbackModels":[{"provider":"anthropic","model":"claude-opus-4-8","cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}},{"provider":"anthropic","model":"claude-opus-5","cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}}]}});
/** Each fixture's row in the pinned catalog, as [provider, api, id]. */
export const CATALOG_ROWS = Object.freeze({
	GPT_5_4: ["openai", "openai-responses", "gpt-5.4"],
	GPT_5_5: ["openai", "openai-responses", "gpt-5.5"],
	GPT_5_5_CODEX: ["openai-codex", "openai-codex-responses", "gpt-5.5"],
	CODEX_SPARK: ["openai-codex", "openai-codex-responses", "gpt-5.3-codex-spark"],
	AZURE_GPT_5_4: ["azure", "azure-openai-responses", "gpt-5.4"],
	SONNET_4_5: ["anthropic", "anthropic-messages", "claude-sonnet-4-5-20250929"],
	FABLE_5: ["anthropic", "anthropic-messages", "claude-fable-5"],
});
