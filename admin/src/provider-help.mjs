/** Reviewed navigation only. Credential support comes from pinned pi, never from these links. */
import { PROVIDER_KEY_NAMES } from "./provider-key-names.mjs";
import { HOST_AUTH_PROVIDERS, needsHostAuthentication } from "@edgehero/pi-dispatch/provider-key";
export const PROVIDER_HELP_REVIEWED_AT = "2026-11-01";
export const PROVIDER_KEY_GUIDE = "https://github.com/edgehero/pi-dispatch/blob/main/docs/provider-keys.md";
export const SUBSCRIPTION_AUTH_GUIDE = "https://github.com/edgehero/pi-dispatch/blob/main/docs/subscription-auth.md";
// A new pinned provider must be reviewed before it gains a browser credential workflow or help claim.
const REVIEWED = ["amazon-bedrock", "ant-ling", "anthropic", "azure", "baseten", "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot", "google", "google-vertex", "groq", "huggingface", "kimi-coding", "meta", "minimax", "minimax-cn", "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode", "opencode-go", "openrouter", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "radius", "together", "typesafe", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn"];
export const SPECIAL_AUTH_PROVIDERS = HOST_AUTH_PROVIDERS;
const core = {
  anthropic: { label: "Anthropic / Claude API", url: "https://platform.claude.com/settings/keys", docsUrl: "https://platform.claude.com/docs/en/get-api-key", steps: ["Sign in to Claude Console and open API keys.", "Create a key for the intended workspace or service account and copy it when shown.", "Paste the new API key into the write-only field here, then preview and confirm."], notice: "Claude subscription sign-in and Claude Code setup-token are separate from an Anthropic API key." },
  openai: { label: "OpenAI API", url: "https://platform.openai.com/api-keys", docsUrl: "https://developers.openai.com/api/docs/quickstart", steps: ["Sign in to OpenAI Platform and select the intended project.", "Create an API key and copy it when shown.", "Paste the new API key here, then preview and confirm. ChatGPT plan sign-in uses the separate host connection guide."], notice: "An API key and Sign in with ChatGPT use different credential and billing routes." },
  google: { label: "Google Gemini API", url: "https://aistudio.google.com/apikey", docsUrl: "https://ai.google.dev/gemini-api/docs/api-key", steps: ["Sign in to Google AI Studio and open API keys.", "Choose the intended Cloud project and create or copy a Gemini API key.", "Paste it here, then preview and confirm. Vertex credentials use a separate host setup."], notice: "Use the Gemini API key flow, not a Vertex or Google account login token." },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/workspaces/default/keys", docsUrl: "https://openrouter.ai/docs/api_reference/authentication", steps: ["Sign in to OpenRouter and open Keys.", "Create a named key and choose its credit limit.", "Copy the key into this write-only field, then preview and confirm."], notice: null },
  deepseek: { label: "DeepSeek", url: "https://platform.deepseek.com/api_keys", docsUrl: "https://api-docs.deepseek.com/", steps: ["Sign in to the DeepSeek API platform.", "Open API keys and create a key for this deployment.", "Copy it here, then preview and confirm."], notice: null },
};
const special = {
  "amazon-bedrock": "Configure the owning host's AWS credential chain and permitted Bedrock access. This is not an API-key creation form.",
  "google-vertex": "Configure the owning host's Google Cloud project and application credentials. A Gemini API key does not replace Vertex authentication.",
  "github-copilot": "Use the supported host authentication flow. A general GitHub personal access token is not a substitute for Copilot authentication.",
  "openai-codex": "Legacy openai-codex authentication is separate from the reviewed direct OpenAI managed connection. Follow the host guide rather than pasting an OAuth token here.",
};
export const PROVIDER_HELP = Object.freeze(Object.fromEntries(REVIEWED.map(provider => [provider, Object.freeze({
  label: core[provider]?.label ?? provider,
  kind: needsHostAuthentication(provider) ? "special" : "api-key",
  url: core[provider]?.url ?? null,
  docsUrl: core[provider]?.docsUrl ?? PROVIDER_KEY_GUIDE,
  steps: Object.freeze(needsHostAuthentication(provider) ? ["Follow the supported owning-host authentication guide.", "Keep login or refresh credentials in the private host store; do not paste them into the API-key form."] : core[provider]?.steps ?? ["Use the provider's own account and credential instructions.", "Create an API key only if the provider supports the canonical slot shown here.", "Paste only that API key here; preview the target and any shared-provider effect before confirming."]),
  notice: special[provider] ?? core[provider]?.notice ?? "Saving a key does not select this provider, validate a credential or change model routing.",
})])));
export function providerHelp(provider) {
  return typeof provider === "string" && Object.hasOwn(PROVIDER_HELP, provider) ? PROVIDER_HELP[provider] : { label: "Custom provider", kind: "special", url: null, docsUrl: PROVIDER_KEY_GUIDE, steps: ["Review the custom provider's host configuration and documented authentication flow."], notice: "This provider has no reviewed generic API-key creation flow." };
}
export const PRIMARY_PROVIDER_HELP = Object.freeze(["anthropic", "openai", "google", "openrouter", "deepseek"]);
// Tests compare both directions; do not silently add a newly generated provider to this reviewed catalog.
export const providerHelpCatalogMatchesPin = () => Object.keys(PROVIDER_HELP).sort().join("\n") === Object.keys(PROVIDER_KEY_NAMES).sort().join("\n");

export const PROVIDER_AUTH_GUIDES = Object.freeze({
  openai: Object.freeze({ label: "Sign in with ChatGPT on the owning host", docsUrl: SUBSCRIPTION_AUTH_GUIDE, officialUrl: "https://developers.openai.com/siwc/token-sharing-open-source", command: "pi-dispatch auth login <connection-id>", steps: Object.freeze(["Configure an openai-chatgpt connection and explicit openai binding in the reviewed policy.", "On its owning host, run the login command from this deployment with the worker's settings and Valkey context.", "Complete the provider browser authorization. A remote browser needs callback port 1455 forwarded to that host."]), notice: "The console never receives OAuth credentials. Complete the loopback authorization on the owning host; this page does not perform a sign-in." }),
  anthropic: Object.freeze({ label: "Claude subscription and community compatibility", docsUrl: SUBSCRIPTION_AUTH_GUIDE, officialUrl: "https://code.claude.com/docs/en/legal-and-compliance", command: null, steps: Object.freeze(["Read the vendor's current authentication restrictions before selecting a community route.", "The reviewed pi community adapters are pinned compatibility paths with their own host staging and login instructions.", "Official claude setup-token is for Claude Code; its token is not an API key to paste here."]), notice: "Compatibility with pinned community packages is not vendor endorsement. Follow the host guide rather than pasting a Claude login token." }),
});
