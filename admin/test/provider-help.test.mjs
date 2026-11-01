import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_KEY_NAMES } from "../src/provider-key-names.mjs";
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
