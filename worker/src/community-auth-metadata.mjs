/** Data-only reviewed adapter identities; no credential reader or provider SDK. */
export const COMMUNITY_AUTH_ADAPTERS = Object.freeze({
	"openai-chatgpt": { provider: "openai", community: false },
	"pi-anthropic-oauth@0.3.6": { provider: "anthropic", community: true, package: "pi-anthropic-oauth", version: "0.3.6" },
	"@gotgenes/pi-anthropic-auth@3.4.3": { provider: "anthropic", community: true, package: "@gotgenes/pi-anthropic-auth", version: "3.4.3" },
});
