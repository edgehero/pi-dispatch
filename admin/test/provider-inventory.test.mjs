import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readProviderInventory, providerInventoryView, providerCanonicalKey, PROVIDER_SLOT_ALIASES } from "../src/provider-inventory.mjs";
import { PROVIDER_KEY_NAMES } from "../src/provider-key-names.mjs";
import { apiKeyVariable, nonApiKeyKind } from "@edgehero/pi-dispatch/provider-key";

const SECRET = "saved-provider-secret-canary-fd431";
function fixture({ env = "", document = { triggers: [] }, overlay = {} } = {}) {
  const dir = tempDir("pd-provider-inventory-");
  fs.writeFileSync(join(dir, ".env"), `PI_SETTINGS_FILE=settings.json\n${env}`, { mode: 0o600 });
  fs.writeFileSync(join(dir, "settings.json"), JSON.stringify(overlay), { mode: 0o600 });
  fs.writeFileSync(join(dir, "triggers.json"), JSON.stringify(document));
  return { dir, read: extra => readProviderInventory({ deploymentDir: dir, paths: { triggersPath: join(dir, "triggers.json") }, ...extra }) };
}

test("provider inventory includes default, validated primary/allowed/fallback/role routes, managed bindings and configured unused slots", () => {
  const f = fixture({ env: `PI_ALLOWED_MODELS=groq/llama\nCEREBRAS_API_KEY=${SECRET}\nMOONSHOT_API_KEY=${SECRET}\nPI_AUTH_CONNECTIONS_FILE=auth.json\n`, document: { triggers: [{ on: { type: "cron", id: "tidy", pattern: "0 1 * * *" }, run: { kind: "local", flow: "tidy", folder: "/repo", task: SECRET, provider: "openai", models: ["openai/gpt-x", "mistral/m"], fallbackModels: ["mistral/m"] } }], modelRoles: { default: { code: "google/gemini" }, project: { review: { model: "openrouter/vendor/model", fallbackModels: ["deepseek/one"] } } } } });
  fs.writeFileSync(join(f.dir, "auth.json"), JSON.stringify({ version: 1, connections: [{ id: "account", provider: "openai", adapter: "openai-chatgpt", ownerHost: "worker" }], bindings: { openai: "account" } }), { mode: 0o600 });
  const view = f.read();
  assert.equal(view.state, "ready");
  assert.equal(view.defaultProvider, "anthropic");
  for (const provider of ["anthropic", "openai", "mistral", "google", "openrouter", "deepseek", "groq", "cerebras", "moonshotai"]) assert.ok(view.rows.some(row => row.providers.includes(provider)), provider);
  const moonshot = view.rows.filter(row => row.key === "MOONSHOT_API_KEY");
  assert.equal(moonshot.length, 1);
  assert.deepEqual(moonshot[0].providers, ["moonshotai", "moonshotai-cn"]);
  assert.equal(moonshot[0].present, true);
  assert.equal(moonshot[0].mode, "replace");
  for (const provider of moonshot[0].providers) assert.ok(view.choices.some(choice => choice.provider === provider && choice.key === "MOONSHOT_API_KEY"), "both shared-slot aliases remain selectable");
  const bound = view.rows.find(row => row.provider === "openai");
  assert.equal(bound.status, "managed");
  assert.equal(bound.mode, null);
  assert.ok(bound.usage.includes("binding"));
  assert.ok(view.rows.find(row => row.provider === "mistral").usage.includes("fallback"));
  assert.ok(view.rows.find(row => row.provider === "google").usage.includes("role"));
  assert.ok(view.rows.find(row => row.provider === "groq").usage.includes("allowed-model"));
  assert.ok(!JSON.stringify(view).includes(SECRET), "neither key nor task leaves the reader");
  assert.ok(!JSON.stringify(view).includes("ownerHost"), "policy owner details remain in the subscription view only");
});

test("configured presence is never validity, and source conflicts and unsupported flows cannot offer replacement", () => {
  const f = fixture({ env: `ANTHROPIC_API_KEY=${SECRET}\nCOPILOT_GITHUB_TOKEN=${SECRET}\n`, document: { triggers: [] } });
  const configured = f.read();
  const row = configured.rows.find(row => row.provider === "anthropic");
  assert.equal(row.status, "configured");
  assert.equal(row.mode, "replace");
  assert.ok(configured.choices.some(choice => choice.provider === "anthropic" && choice.key === "ANTHROPIC_API_KEY" && choice.supported), "the existing default remains selectable for replacement");
  assert.ok(configured.choices.some(choice => choice.provider === "github-copilot" && choice.supported === false), "configured special flows remain explicit choices with no generic editor");
  assert.ok(!JSON.stringify(configured).includes("valid"));
  const copilot = configured.rows.find(row => row.provider === "github-copilot");
  assert.equal(copilot.status, "unsupported");
  assert.equal(copilot.mode, null);
  const shadowed = f.read({ env: { ANTHROPIC_AUTH_TOKEN: SECRET } }).rows.find(row => row.provider === "anthropic");
  assert.equal(shadowed.status, "shadowed");
  assert.equal(shadowed.reason, "source-shadowed");
  assert.equal(shadowed.mode, null);
  const whitespace = f.read({ env: { ANTHROPIC_AUTH_TOKEN: " " } }).rows.find(row => row.provider === "anthropic");
  assert.equal(whitespace.status, "shadowed", "a nonempty inherited credential shadows even when its bytes are invalid whitespace");
  assert.equal(whitespace.mode, null);
  assert.ok(!JSON.stringify(shadowed).includes(SECRET));
});

test("unknown environment, policy or reference reads retain uncertainty and never invent an absent credential", () => {
  const f = fixture({ env: `ANTHROPIC_API_KEY=${SECRET}\n` });
  const unknown = f.read({ reads: { environment: () => ({ unreadable: true, env: { ANTHROPIC_API_KEY: SECRET } }) } });
  assert.equal(unknown.state, "unknown");
  assert.ok(unknown.rows.every(row => row.mode === null));
  fs.writeFileSync(join(f.dir, "triggers.json"), '{"triggers":[{"broken":true}]}');
  const partial = f.read();
  assert.equal(partial.state, "partial");
  assert.equal(partial.rows.find(row => row.provider === "anthropic").present, true);
  fs.appendFileSync(join(f.dir, ".env"), "PI_AUTH_CONNECTIONS_FILE=missing-policy.json\n");
  const policy = f.read();
  assert.equal(policy.state, "unknown");
  assert.ok(policy.rows.every(row => row.mode === null));
  assert.equal(policy.rows[0].reason, "policy-unreadable");
});

test("source selection follows selected shell/file/overlay configuration and changes are observed without changing the default", () => {
  const f = fixture({ env: "PI_PROVIDER=openai\n", overlay: { provider: "google" } });
  assert.equal(f.read({ env: { PI_PROVIDER: "deepseek" } }).defaultProvider, "google");
  fs.writeFileSync(join(f.dir, "settings.json"), "{}");
  assert.equal(f.read({ env: { PI_PROVIDER: "deepseek" } }).defaultProvider, "openai");
  fs.writeFileSync(join(f.dir, ".env"), "PI_SETTINGS_FILE=settings.json\n", { mode: 0o600 });
  assert.equal(f.read({ env: { PI_PROVIDER: "deepseek" } }).defaultProvider, "deepseek");
  const before = fs.readFileSync(join(f.dir, ".env"), "utf8");
  f.read();
  assert.equal(fs.readFileSync(join(f.dir, ".env"), "utf8"), before, "inventory is read only");
});

test("custom references remain explicit host-only rows and the public projector discards value/hash/url fields", () => {
  const f = fixture({ document: { triggers: [], modelRoles: { default: { code: "custom-provider/model" } } } });
  const custom = f.read().rows.find(row => row.provider === "custom-provider");
  assert.equal(custom.status, "unsupported");
  assert.equal(custom.key, null);
  assert.equal(custom.mode, null);
  const projected = providerInventoryView({ state: "ready", defaultProvider: "openai", rows: [{ provider: "openai", key: "PATH", providers: [SECRET], usage: ["default", SECRET], present: true, status: "unknown", mode: "replace", source: "arbitrary", reason: SECRET, value: SECRET, digest: SECRET, url: "javascript:alert(1)" }], choices: [{ provider: "__proto__" }, { provider: "openai", key: "PATH", url: SECRET }] });
  assert.equal(projected.rows[0].key, "OPENAI_API_KEY");
  assert.equal(projected.rows[0].mode, null);
  assert.equal(projected.rows[0].source, "unknown");
  assert.deepEqual(projected.rows[0].usage, ["default"]);
  assert.equal(projected.choices.length, 1);
  assert.ok(!JSON.stringify(projected).includes(SECRET));
  assert.ok(!JSON.stringify(projected).includes("javascript:"));
});

test("every canonical slot and alias group derives both ways from pinned worker selection", () => {
  for (const [provider, candidates] of Object.entries(PROVIDER_KEY_NAMES)) {
    const raw = apiKeyVariable(candidates);
    const key = raw && nonApiKeyKind(raw) === null ? raw : null;
    assert.equal(providerCanonicalKey(provider), key);
    if (key) assert.ok(PROVIDER_SLOT_ALIASES[key].includes(provider));
  }
  for (const [key, providers] of Object.entries(PROVIDER_SLOT_ALIASES)) assert.deepEqual(providers, Object.keys(PROVIDER_KEY_NAMES).filter(provider => providerCanonicalKey(provider) === key).sort());
  assert.equal(providerCanonicalKey("constructor"), null);
});


test("decoded-empty assignments stay Add while quoted whitespace requires explicit Replace", () => {
  for (const [value, expectedPresent, expectedMode] of [['""', false, "add"], ['" "', true, "replace"]]) {
    const f = fixture({ env: `ANTHROPIC_API_KEY=${value}\n` });
    const row = f.read().rows.find(row => row.provider === "anthropic");
    assert.equal(row.present, expectedPresent);
    assert.equal(row.mode, expectedMode);
  }
});


test("an invalid allowed-model list preserves a known default, while unsafe settings disable source-dependent edits", () => {
  const f = fixture({ env: `PI_PROVIDER=openai\nPI_ALLOWED_MODELS=invalid\nOPENAI_API_KEY=${SECRET}\n` });
  const partial = f.read();
  assert.equal(partial.defaultProvider, "openai");
  assert.equal(partial.state, "partial");
  fs.chmodSync(join(f.dir, "settings.json"), 0o666);
  const unknown = f.read();
  assert.equal(unknown.defaultProvider, null);
  assert.equal(unknown.state, "unknown");
  assert.ok(unknown.rows.every(row => row.mode === null));
  assert.equal(unknown.rows[0].reason, "settings-unreadable");
  fs.chmodSync(join(f.dir, "settings.json"), 0o600);
  assert.deepEqual(providerInventoryView({ rows: [{ provider: "openai", usage: { includes: "hostile" } }] }).rows[0].usage, []);
});

test("absent metadata in a writable or symlinked parent stays unknown instead of offering Add", () => {
  const f = fixture();
  const unsafe = join(f.dir, "unsafe");
  fs.mkdirSync(unsafe);
  fs.chmodSync(unsafe, 0o777);
  fs.writeFileSync(join(f.dir, ".env"), "PI_SETTINGS_FILE=unsafe/missing.json\n", { mode: 0o600 });
  const writable = f.read();
  assert.equal(writable.state, "unknown");
  assert.equal(writable.defaultProvider, null);
  assert.ok(writable.rows.every(row => row.mode === null));
  assert.equal(fs.existsSync(join(unsafe, "missing.json")), false);
  fs.chmodSync(unsafe, 0o700);
  assert.equal(f.read().state, "ready", "a safely absent settings file is the worker's empty overlay");
  fs.symlinkSync(unsafe, join(f.dir, "redirect"), "dir");
  fs.writeFileSync(join(f.dir, ".env"), "PI_SETTINGS_FILE=redirect/missing.json\n", { mode: 0o600 });
  assert.equal(f.read().state, "unknown", "a safe target does not make a symlinked source parent trusted");
});

test("current service trigger selection replaces startup paths and preserves explicit-empty uncertainty", () => {
  const f = fixture({ document: { triggers: [], modelRoles: { default: { code: "openai/old" } } } });
  const later = join(f.dir, "later.json");
  fs.writeFileSync(later, JSON.stringify({ triggers: [], modelRoles: { project: { code: "deepseek/new" } } }));
  const envPath = join(f.dir, ".env");
  fs.writeFileSync(envPath, "PI_SETTINGS_FILE=settings.json\nPI_TRIGGERS_FILE=later.json\n", { mode: 0o600 });
  const current = f.read({ env: { PI_TRIGGERS_FILE: "triggers.json" } });
  assert.equal(current.state, "ready");
  assert.ok(current.rows.some(row => row.provider === "deepseek" && row.usage.includes("role")));
  assert.ok(!current.rows.some(row => row.provider === "openai"), "stale paths and overridden shell selection do not add old roles");
  fs.writeFileSync(envPath, "PI_SETTINGS_FILE=settings.json\n", { mode: 0o600 });
  const removed = f.read({ paths: { triggersPath: later } });
  assert.ok(removed.rows.some(row => row.provider === "openai"));
  assert.ok(!removed.rows.some(row => row.provider === "deepseek"), "removing the declaration restores the deployment default, not a startup path");
  fs.writeFileSync(envPath, "PI_SETTINGS_FILE=settings.json\nPI_TRIGGERS_FILE=\n", { mode: 0o600 });
  const empty = f.read();
  assert.equal(empty.state, "partial");
  assert.ok(!empty.rows.some(row => row.provider === "openai"), "explicit empty never silently reads triggers.json");
});
