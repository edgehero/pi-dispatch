import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectionsProviderKeys } from "../src/console/panels/provider-keys.mjs";
import { modelConnections } from "../src/connections-view.mjs";
import { DECLARED_KEY_NOTES } from "../src/provider-inventory.mjs";
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

test("a slot names the triggers that bring their own key, by name and variable, and says where this host refuses them", () => {
  const t = (index, cron = null) => ({ index, cron });
  const value = { ...inventory(), declaredKeys: [
    { key: "GEMINI_API_KEY", triggers: [t(4), t(1, "nightly")], more: 0, forwarded: false },
    { key: "OPENAI_API_KEY", triggers: [t(0)], more: 2, forwarded: true },
    { key: "CLOUDFLARE_API_KEY", triggers: [t(6)], more: 0, forwarded: null },
    { key: "PATH", triggers: [t(3)] }, { key: "ANTHROPIC_API_KEY", triggers: [{ index: "7" }] },
  ], declaredNotes: ["projects-unread", "forward-unread"] };
  for (const role of ["operator", "viewer"]) {
    const doc = draw({ role, data: { setup: null, connections: { providerKeys: value } } });
    const line = provider => doc.querySelector(`[data-provider="${provider}"] [data-provider-declared]`);
    const text = node => node.textContent.replace(/\s+/g, " ");
    // A missing slot is exactly where a host-only reading misled: "Not set" while two triggers spend their own key.
    const google = line("google");
    assert.equal(google.getAttribute("data-provider-declared"), "spent");
    assert.equal(text(google), "cron nightly, trigger 5 bind GEMINI_API_KEY in run.secrets, so every call their jobs make to this provider spends that key, not this host's credential.");
    assert.deepEqual(google.querySelectorAll("a").map(a => a.getAttribute("href")), ["/config/trigger?index=1", "/config/trigger?index=4"]);
    assert.equal(google.querySelector("a .pk-key").textContent, "nightly", "a long cron id wraps as the slot's key does");
    // This host's PI_FORWARD_ENV names the variable: this host refuses, and the line does not say the key is spent.
    assert.equal(text(line("openai")), "trigger 1 and 2 more bind OPENAI_API_KEY in run.secrets, but this host's PI_FORWARD_ENV names it too, so it refuses their jobs before they spend.");
    // This host's forward list unread: the line does not say the key is spent where this host may refuse it.
    assert.equal(line("cloudflare-ai-gateway").getAttribute("data-provider-declared"), "unknown");
    assert.equal(text(line("cloudflare-ai-gateway")), "trigger 7 binds CLOUDFLARE_API_KEY in run.secrets, so every call its jobs make to this provider spends that key, not this host's credential, unless this host's PI_FORWARD_ENV names it.");
    assert.equal(line("anthropic"), null, "a position that is not an integer is dropped, and with it the line");
    assert.equal(doc.querySelectorAll("[data-provider-declared]").length, 3);
    // What no line can know is said once on the card, not on every row, with the reason a line may be too wide.
    const notes = doc.querySelectorAll("[data-provider-declared-note]").map(text);
    assert.equal(notes.length, 3);
    assert.match(notes[0], /^A trigger's own key is the triggers file's answer: another worker host refuses those jobs before they spend where its own PI_FORWARD_ENV names the variable or it binds the provider to a subscription\. This page reads only this host's\.$/);
    assert.equal(notes[1], DECLARED_KEY_NOTES["projects-unread"]);
    assert.equal(notes[2], DECLARED_KEY_NOTES["forward-unread"]);
  }
  const managed = inventory();
  Object.assign(managed.rows[2], { source: "managed", status: "managed", mode: null });
  const bound = draw({ data: { setup: null, connections: { providerKeys: { ...managed, declaredKeys: [{ key: "GEMINI_API_KEY", triggers: [t(0)], forwarded: false }] } } } });
  assert.equal(bound.querySelector("[data-provider-declared]").textContent.replace(/\s+/g, " "), "trigger 1 binds GEMINI_API_KEY in run.secrets, but this host binds the provider to a subscription, so it refuses its jobs before they spend.");
  assert.equal(bound.querySelector("[data-provider-declared-note]"), null, "no spent line, no caveat about other hosts");
  assert.equal(draw({ role: "agent", data: { connections: null, setup: null } }).querySelector("[data-provider-declared], [data-provider-declared-note]"), null, "the agent view is withheld as before");
  assert.equal(draw().querySelector("[data-provider-declared], [data-provider-declared-note]"), null, "an inventory without the facts draws the card as before");
  assert.equal(JSON.stringify(modelConnections({ providerKeys: value })).includes("declared"), false, "dispatch_connections keeps what it carried");
});

test("issue #1029: a trigger that reaches a slot only through its decide or auxiliary model says which, in every form of the line", () => {
  const t = (index, via) => ({ index, cron: null, ...(via ? { via } : {}) });
  const value = { ...inventory(), declaredKeys: [
    { key: "GEMINI_API_KEY", triggers: [t(1, "decide"), { index: 2, cron: "nightly" }, t(3, "auxiliary"), t(4, "main")], more: 0, forwarded: false },
    { key: "OPENAI_API_KEY", triggers: [t(0, "auxiliary")], more: 0, forwarded: true },
    { key: "CLOUDFLARE_API_KEY", triggers: [t(6, "decide")], more: 0, forwarded: null },
  ] };
  const doc = draw({ data: { setup: null, connections: { providerKeys: value } } });
  const text = provider => doc.querySelector(`[data-provider="${provider}"] [data-provider-declared]`).textContent.replace(/\s+/g, " ");
  assert.equal(text("google"), "trigger 2 (for its decide model), cron nightly, trigger 4 (for its auxiliary model), trigger 5 bind GEMINI_API_KEY in run.secrets, so every call their jobs make to this provider spends that key, not this host's credential.");
  assert.equal(text("openai"), "trigger 1 (for its auxiliary model) binds OPENAI_API_KEY in run.secrets, but this host's PI_FORWARD_ENV names it too, so it refuses its jobs before they spend.");
  assert.equal(text("cloudflare-ai-gateway"), "trigger 7 (for its decide model) binds CLOUDFLARE_API_KEY in run.secrets, so every call its jobs make to this provider spends that key, not this host's credential, unless this host's PI_FORWARD_ENV names it.");
  // The qualifier sits outside the link, which still opens the trigger.
  assert.deepEqual(doc.querySelectorAll('[data-provider="google"] [data-provider-declared] a').map(a => a.textContent.replace(/\s+/g, " ")), ["trigger 2", "cron nightly", "trigger 4", "trigger 5"]);
  const managed = inventory();
  Object.assign(managed.rows[2], { source: "managed", status: "managed", mode: null });
  const bound = draw({ data: { setup: null, connections: { providerKeys: { ...managed, declaredKeys: [{ key: "GEMINI_API_KEY", triggers: [t(0, "auxiliary")], forwarded: false }] } } } });
  assert.equal(bound.querySelector("[data-provider-declared]").textContent.replace(/\s+/g, " "), "trigger 1 (for its auxiliary model) binds GEMINI_API_KEY in run.secrets, but this host binds the provider to a subscription, so it refuses its jobs before they spend.");
});

test("provider-key layout is the exact CSS built into the reference card", () => {
  const generator = readFileSync(new URL("../../design/tools/provider_keys.py", import.meta.url), "utf8");
  assert.equal(PROVIDER_KEYS_CSS, generator.match(/PROVIDER_KEYS_CSS = """([\s\S]*?)"""/)[1]);
});
