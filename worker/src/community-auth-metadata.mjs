/**
 * Data-only reviewed adapter identities; no credential reader or provider SDK. `usage` says whether the adapter can read
 * the subscription's usage windows (`pi-dispatch auth usage`): the console offers that command only where it is true
 * (issue #1046), and community-auth-adapters.test.mjs holds it to the real adapters.
 */
export const COMMUNITY_AUTH_ADAPTERS = Object.freeze({
	"openai-chatgpt": { provider: "openai", community: false, usage: false },
	"pi-anthropic-oauth@0.3.6": { provider: "anthropic", community: true, package: "pi-anthropic-oauth", version: "0.3.6", usage: true },
	"pi-anthropic-oauth@0.3.11": { provider: "anthropic", community: true, package: "pi-anthropic-oauth", version: "0.3.11", usage: true },
	"@gotgenes/pi-anthropic-auth@3.4.3": { provider: "anthropic", community: true, package: "@gotgenes/pi-anthropic-auth", version: "3.4.3", usage: true },
});
