import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectionsProviderKeys } from "../src/console/panels/provider-keys.mjs";
import { connectionsSubscriptionAuth } from "../src/console/panels/subscription-auth.mjs";
import { setupStart } from "../src/console/panels/setup.mjs";
import { PROVIDER_KEYS_CSS } from "../src/console/provider-keys-css.mjs";
import { PRIMARY_PROVIDER_HELP, providerHelp } from "../src/provider-help.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";

const inventory = () => ({ state: "ready", defaultProvider: "anthropic", rows: [
  { provider: "anthropic", key: "ANTHROPIC_API_KEY", providers: ["anthropic"], usage: ["default", "configured"], present: true, source: "deployment-env", status: "configured", mode: "replace", reason: null },
  { provider: "openai", key: "OPENAI_API_KEY", providers: ["openai"], usage: ["configured"], present: true, source: "deployment-env", status: "configured", mode: "replace", reason: null },
  { provider: "google", key: "GEMINI_API_KEY", providers: ["google"], usage: ["trigger"], present: false, source: "missing", status: "missing", mode: "add", reason: null },
  { provider: "cloudflare-ai-gateway", key: "CLOUDFLARE_API_KEY", providers: ["cloudflare-ai-gateway", "cloudflare-workers-ai"], usage: ["configured"], present: true, source: "deployment-env", status: "configured", mode: "replace", reason: null },
], choices: ["anthropic", "openai", "google", "cloudflare-ai-gateway", "cloudflare-workers-ai"].map(provider => ({ provider, key: provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "google" ? "GEMINI_API_KEY" : "CLOUDFLARE_API_KEY", providers: provider.startsWith("cloudflare") ? ["cloudflare-ai-gateway", "cloudflare-workers-ai"] : [provider], mode: "add", supported: true })) });
const context = (extra = {}) => ({ role: "operator", data: { setup: { enabled: true, actions: ["setup-provider-key", "setup-provider-key-replace"] }, connections: { providerKeys: inventory() } }, ...extra });
const draw = extra => parseDocument(`<html><body>${connectionsProviderKeys(context(extra))}</body></html>`);

test("one permanent key editor preserves several provider sources and discloses shared slots without changing the default", () => {
  const doc = draw();
  assert.equal(doc.querySelectorAll("[data-provider-key-form]").length, 1);
  const rows = doc.querySelectorAll("[data-provider]");
  assert.equal(rows.length, 4);
  assert.match(rows.find(row => row.getAttribute("data-provider") === "anthropic").textContent, /Default.*Set in deployment.*ANTHROPIC_API_KEY/);
  assert.match(rows.find(row => row.getAttribute("data-provider") === "openai").textContent, /OPENAI_API_KEY/);
  const shared = rows.find(row => row.getAttribute("data-provider") === "cloudflare-ai-gateway");
  assert.match(shared.textContent, /Shared by cloudflare-ai-gateway, cloudflare-workers-ai; a change affects all/);
  assert.equal(shared.querySelector("button[data-provider-mode]").getAttribute("data-provider-mode"), "replace");
  const form = doc.querySelector("form");
  assert.equal(form.querySelector("select[name=provider]").value, "anthropic");
  assert.equal(form.querySelector("[data-provider-key-mode]").value, "add");
  assert.equal(form.querySelector("[data-provider-key-mode]").getAttribute("name"), null, "mode chooses the operation locally; only provider and value reach HTTP");
  assert.equal(form.querySelector("input[name=value]").value, "");
  assert.equal(form.querySelectorAll("[name=key], [name=PI_PROVIDER], [name=model]").length, 0);
  assert.match(form.textContent, /default provider stays the same/);
  assert.equal(doc.querySelector('[data-provider-context="anthropic"]').hidden, false);
  assert.equal(doc.querySelector('[data-provider-context="google"]').hidden, true);
});

test("guides are native readable disclosures outside mutation controls, and official destinations are exact safe outbound links", () => {
  const doc = draw();
  for (const provider of PRIMARY_PROVIDER_HELP) {
    const guide = doc.querySelector(`[data-provider-help="${provider}"]`);
    assert.equal(guide.tagName, "DETAILS");
    assert.equal(guide.closest("form"), null);
    assert.equal(guide.closest("fieldset"), null);
    const help = providerHelp(provider), links = guide.querySelectorAll("a");
    assert.ok(links.some(link => link.getAttribute("href") === help.url));
    for (const link of links) { assert.equal(link.getAttribute("rel"), "noreferrer noopener"); assert.equal(link.getAttribute("target"), "_blank"); }
    assert.equal(guide.querySelectorAll("ol li").length, help.steps.length);
  }
  for (const fieldset of doc.querySelectorAll("[data-config-controls]")) assert.equal(fieldset.disabled, true, "no-script actions, including shortcuts, begin disabled");
  assert.ok(doc.querySelector("noscript"));
});

test("viewer, agent, read-only and absent-grant states retain acquisition guidance while withholding key mutations", () => {
  for (const extra of [{ role: "viewer" }, { role: "agent" }, { readOnly: true }, { data: { setup: { enabled: false, actions: [] }, connections: { providerKeys: inventory() } } }]) {
    const doc = draw(extra);
    assert.equal(doc.querySelectorAll("form,input[type=password],[data-provider-pick]").length, 0);
    assert.equal(doc.querySelectorAll("details[data-provider-help]").length >= 5, true);
    assert.match(doc.body.textContent, /operator|read-only|host setup grant/);
  }
});

test("known managed or shadowed slots are disabled and unknown sources withhold the editor", () => {
  for (const status of ["managed", "shadowed"]) {
    const value = inventory();
    Object.assign(value.rows[0], { source: status, status, mode: null });
    const doc = draw({ data: { setup: { enabled: true, actions: ["setup-provider-key", "setup-provider-key-replace"] }, connections: { providerKeys: value } } });
    assert.equal(doc.querySelector('option[value="anthropic"]').disabled, true);
    assert.equal(doc.querySelector('[data-provider="anthropic"] [data-provider-pick]'), null);
    assert.equal(doc.querySelector('select[name="provider"]').value, "openai");
  }
  const value = inventory(); value.state = "unknown";
  const doc = draw({ data: { setup: { enabled: true, actions: ["setup-provider-key", "setup-provider-key-replace"] }, connections: { providerKeys: value } } });
  assert.equal(doc.querySelector("form"), null);
  assert.match(doc.body.textContent, /Key changes are unavailable while credential sources are unknown/);
});

test("intentionally withheld agent metadata is neutral while an operator's unreadable source stays actionable", () => {
  const agent = draw({ role: "agent", data: { connections: null, setup: null } });
  assert.match(agent.body.textContent, /Provider key inventory is not published in this agent view/);
  assert.doesNotMatch(agent.body.textContent, /Provider key sources unavailable|Missing or unreadable declarations|Check the deployment on its host/);
  assert.equal(agent.querySelector(".banner.tone-attention"), null);
  assert.equal(agent.querySelector("form, input[type=password], [data-provider-pick]"), null);
  assert.equal(agent.querySelectorAll("[data-provider-help]").length, PRIMARY_PROVIDER_HELP.length);
  const value = inventory(); value.state = "unknown";
  const operator = draw({ data: { connections: { providerKeys: value }, setup: null } });
  assert.ok(operator.querySelector(".banner.tone-attention"));
  assert.match(operator.body.textContent, /Provider key sources unavailable.*Check the deployment on its host/s);
  assert.doesNotMatch(operator.body.textContent, /not published in this agent view/);
});

test("the management destination survives an entirely Ready setup and subscription help offers no raw-token paste", () => {
  for (const role of ["operator", "viewer", "agent"]) {
    const doc = parseDocument(`<html><body>${setupStart({ role, data: {} })}</body></html>`);
    assert.ok(doc.querySelector('a[href="/config/connections#p-provider-keys"]'));
  }
  const subscription = String(connectionsSubscriptionAuth({ role: "viewer", data: {} }));
  assert.match(subscription, /community adapters.*Official claude setup-token.*not an API key/s);
  const sub = parseDocument(`<html><body>${subscription}</body></html>`);
  for (const provider of ["openai", "anthropic"]) {
    const guide = sub.querySelector(`[data-subscription-help="${provider}"]`);
    assert.ok(guide.querySelector('a[href="https://github.com/edgehero/pi-dispatch/blob/main/docs/subscription-auth.md"]'));
    assert.ok(guide.querySelector("ol li"));
    assert.equal(guide.querySelector(".cmd"), null, "a viewer reads help without host command controls");
  }
  assert.doesNotMatch(subscription, /type="password"|<input|data-action=/);
});

test("provider-key layout is the exact CSS built into the reference card", () => {
  const generator = readFileSync(new URL("../../design/tools/provider_keys.py", import.meta.url), "utf8");
  assert.equal(PROVIDER_KEYS_CSS, generator.match(/PROVIDER_KEYS_CSS = """([\s\S]*?)"""/)[1]);
});
