import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_KEY_NAMES, providerKeyNames } from "../src/provider-key-names.mjs";
import { HOST_AUTH_PROVIDERS, needsHostAuthentication } from "@edgehero/pi-dispatch/provider-key";
import { PROVIDER_HELP, PRIMARY_PROVIDER_HELP, SPECIAL_AUTH_PROVIDERS, providerHelp, providerHelpCatalogMatchesPin } from "../src/provider-help.mjs";

test("the reviewed help catalog covers exactly the pinned providers and only fixed safe HTTPS origins", () => {
  assert.equal(providerHelpCatalogMatchesPin(), true);
  assert.deepEqual(Object.keys(PROVIDER_HELP).sort(), Object.keys(PROVIDER_KEY_NAMES).sort());
  assert.strictEqual(SPECIAL_AUTH_PROVIDERS, HOST_AUTH_PROVIDERS);
  const origins = new Set(["https://github.com", "https://platform.claude.com", "https://platform.openai.com", "https://developers.openai.com", "https://aistudio.google.com", "https://ai.google.dev", "https://openrouter.ai", "https://platform.deepseek.com", "https://api-docs.deepseek.com"]);
  for (const [provider, help] of Object.entries(PROVIDER_HELP)) {
    for (const value of [help.url, help.docsUrl].filter(Boolean)) { const url = new URL(value); assert.equal(url.protocol, "https:"); assert.ok(origins.has(url.origin), provider); assert.equal(url.username + url.password + url.hash, ""); assert.equal(url.search, ""); }
    assert.ok(help.steps.length >= 2 && help.steps.length <= 3);
    assert.equal(help.kind, needsHostAuthentication(provider) ? "special" : "api-key");
  }
  assert.deepEqual(PRIMARY_PROVIDER_HELP, ["anthropic", "openai", "google", "openrouter", "deepseek"]);
});
test("direct create-key links are limited to reviewed manual API flows; special and unknown providers never invite token pasting", () => {
  for (const provider of PRIMARY_PROVIDER_HELP) assert.ok(providerHelp(provider).url);
  for (const provider of [...SPECIAL_AUTH_PROVIDERS, "unknown-custom", "__proto__", "constructor"]) {
    const help = providerHelp(provider);
    assert.equal(help.kind, "special");
    assert.equal(help.url, null);
    assert.doesNotMatch(help.steps.join(" "), /Paste only|Create an API key|personal access token/);
  }
  assert.match(providerHelp("github-copilot").notice, /personal access token is not a substitute/);
  assert.match(providerHelp("openai").notice, /different credential and billing routes/);
});

test("special-provider guidance matches the actual worker credential boundary and pinned pi capabilities", async () => {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const { resolveProviderCredential } = await import("../../worker/src/env-allowlist.mjs");
  const providers = new Map(builtinProviders().map(provider => [provider.id, provider]));
  const signal = new AbortController().signal;
  const hostCases = [
    { provider: "amazon-bedrock", env: { AWS_ACCESS_KEY_ID: "offline-id", AWS_SECRET_ACCESS_KEY: "offline-secret" } },
    { provider: "google-vertex", env: { GOOGLE_CLOUD_PROJECT: "offline-project", GOOGLE_CLOUD_LOCATION: "offline-location", GOOGLE_APPLICATION_CREDENTIALS: "/offline/credentials.json" } },
  ];
  for (const { provider, env } of hostCases) {
    const resolved = await providers.get(provider).auth.apiKey.resolve({ ctx: { env: async name => env[name], fileExists: async () => true }, signal });
    assert.ok(resolved, `${provider}: pinned pi supports this host authentication mode`);
    assert.throws(() => resolveProviderCredential({ provider, hostEnv: env, authFromPi: false }), error => error.piDispatchConfig === true, `${provider}: pi support alone does not establish a worker credential route`);
  }
  assert.ok(providers.get("openai-codex").auth.oauth, "pinned pi has the separate Codex OAuth mode");
  assert.throws(() => resolveProviderCredential({ provider: "openai-codex", hostEnv: { OPENAI_API_KEY: "offline-key" }, authFromPi: false }), error => error.piDispatchConfig === true);
  for (const provider of ["amazon-bedrock", "openai-codex"]) assert.match(providerHelp(provider).notice, /worker.*does not support/);
  assert.match(providerHelp("amazon-bedrock").steps.join(" "), /Configuring AWS credentials.*does not enable/);
  assert.match(providerHelp("openai-codex").steps.join(" "), /provider openai.*explicit binding.*owning host/);

  const vertexKey = providerKeyNames("google-vertex");
  assert.deepEqual(vertexKey, ["GOOGLE_CLOUD_API_KEY"]);
  assert.deepEqual(resolveProviderCredential({ provider: "google-vertex", hostEnv: { [vertexKey[0]]: "offline-key" }, authFromPi: false }), { GOOGLE_CLOUD_API_KEY: "offline-key" });
  assert.match(providerHelp("google-vertex").steps.join(" "), /GOOGLE_CLOUD_API_KEY.*owning host/);
  assert.match(providerHelp("google-vertex").notice, /ADC-only.*not supported/);

  const copilotKey = providerKeyNames("github-copilot");
  assert.deepEqual(copilotKey, ["COPILOT_GITHUB_TOKEN"]);
  assert.deepEqual(resolveProviderCredential({ provider: "github-copilot", hostEnv: { [copilotKey[0]]: "offline-copilot-token" }, authFromPi: false }), { COPILOT_GITHUB_TOKEN: "offline-copilot-token" });
  assert.match(providerHelp("github-copilot").steps.join(" "), /COPILOT_GITHUB_TOKEN.*outside this form.*does not perform Copilot sign-in or refresh/);

  assert.throws(() => resolveProviderCredential({ provider: "custom-keyed", hostEnv: { CUSTOM_PROVIDER_KEY: "offline-key" }, authFromPi: false, forwardEnv: ["CUSTOM_PROVIDER_KEY"] }), error => error.piDispatchConfig === true);
  assert.match(providerHelp("custom-keyed").notice, /Custom keyed main providers.*not enabled/);
  assert.match(providerHelp("custom-keyed").steps.join(" "), /custom main provider requires.*declared keyless local endpoint/);
});

test("host-auth guides distinguish API keys, official SIWC and Claude Code from pinned community compatibility", async () => {
  const { PROVIDER_AUTH_GUIDES } = await import("../src/provider-help.mjs");
  for (const guide of Object.values(PROVIDER_AUTH_GUIDES)) for (const value of [guide.docsUrl, guide.officialUrl]) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.ok(["https://github.com", "https://developers.openai.com", "https://code.claude.com"].includes(url.origin));
    assert.equal(url.username + url.password + url.search + url.hash, "");
  }
  assert.match(PROVIDER_AUTH_GUIDES.openai.officialUrl, /^https:\/\/developers\.openai\.com\/siwc\//);
  assert.equal(PROVIDER_AUTH_GUIDES.openai.command, "pi-dispatch auth login <connection-id>");
  assert.match(PROVIDER_AUTH_GUIDES.openai.steps.join(" "), /owning host.*Valkey.*1455/);
  assert.match(PROVIDER_AUTH_GUIDES.anthropic.officialUrl, /legal-and-compliance$/);
  assert.equal(PROVIDER_AUTH_GUIDES.anthropic.command, null);
  assert.match(PROVIDER_AUTH_GUIDES.anthropic.notice, /not vendor endorsement/);
});
