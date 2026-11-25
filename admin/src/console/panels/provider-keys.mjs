/** One person-only key editor; the shared inventory and help contain no credential values. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { field } from "./config-ui.mjs";
import { providerHelp, PRIMARY_PROVIDER_HELP } from "../../provider-help.mjs";
import { DECLARED_KEY_NOTES, declaredKeysView, providerInventoryView, PROVIDER_KEY_REASONS } from "../../provider-inventory.mjs";
import { setupFacts } from "../../setup-view.mjs";

const GUIDED = PRIMARY_PROVIDER_HELP;
const STATUS = Object.freeze({ configured: ["ok", "Set in deployment"], missing: ["idle", "Not set"], managed: ["idle", "Managed subscription"], shadowed: ["attention", "Other credential takes precedence"], unknown: ["attention", "Source unknown"], unsupported: ["idle", "Provider setup required"] });
const SOURCE = Object.freeze({ "deployment-env": "Present in the deployment's .env. Presence does not verify that a key works.", managed: "A managed subscription binding selects the credential. Review its host-owned connection below.", shadowed: "A different credential source takes precedence. Review it on the deployment host before changing this slot.", "pi-fallback": "No deployment key is set. The configured host pi-login fallback may supply a credential.", missing: "No key is declared for this slot.", unknown: "The credential source could not be established safely. Check the deployment on its host.", special: "This provider needs its own authentication setup instead of a general API-key paste." });
const name = provider => providerHelp(provider).label === "Custom provider" ? provider : providerHelp(provider).label;
const can = (view, action) => view.role === "operator" && !view.readOnly && setupFacts(view.data?.setup, { role: view.role }).actions.includes(action);
const actionFor = mode => mode === "replace" ? "setup-provider-key-replace" : "setup-provider-key";
const guideId = provider => `provider-help-${provider}`;
// A cron trigger by its id, the name doctor gives it; any other, a watch rule included, by its row. The id may be long
// and unbroken, so it wraps as the slot's own key does (`pk-key`). Issue #1029: a trigger that reaches the slot only
// through a role model says which, since its jobs run on another provider.
const VIA = Object.freeze({ decide: " (for its decide model)", auxiliary: " (for its auxiliary model)" });
const triggerLink = t => html`<a class="link" href="${`/config/trigger?index=${t.index}`}">${t.cron ? html`cron <span class="code pk-key">${t.cron}</span>` : `trigger ${t.index + 1}`}</a>${Object.hasOwn(VIA, t.via ?? "") ? VIA[t.via] : null}`;
// Issue #1013: an answer rule by its id, the zeroTouch block by name, each with the role model it reaches the slot by alone.
const HOLDER_VIA = Object.freeze({ decision: " (for its decision model)", grouping: " (for its grouping model)" });
const holderName = h => html`${h.zeroTouch ? "the zeroTouch block" : html`answer rule <span class="code pk-key">${h.rule}</span>`}${Object.hasOwn(HOLDER_VIA, h.via ?? "") ? HOLDER_VIA[h.via] : null}`;
// `listed`'s rule (words.mjs) over markup, so a link stays a link: "a", "a and b", "a, b and c".
const listedHtml = parts => parts.map((part, n) => html`${n === 0 ? null : n === parts.length - 1 ? " and " : ", "}${part}`);

/**
 * Issue #1000: the triggers that bring their own key for this slot (`declaredKeysView`), by name and the variable,
 * never a value. The row's badge and source sentence are this host's sources alone, so without this a slot can read
 * Not set while triggers spend on it with their own key, or name the deployment key while some of them use another.
 * Issue #1029: "every call their jobs make to this provider", not "their jobs on this provider", since a watch rule's
 * classifier and an auxiliary model spend the key from a job that runs on another provider.
 * Where this host is known to refuse those jobs, the line says so instead: a row this console shows as managed (its
 * subscription check comes first, so the declared name stays reserved) and a variable this host's PI_FORWARD_ENV names
 * (the operator's host value claims it); an unread forward list leaves that open, and the line says on what. Other
 * hosts decide that for themselves, which the card says once.
 * Issue #1013: the answer rules and the zeroTouch block that declare the variable in their own `secrets` follow the
 * triggers, the same way and on the same terms; a slot no trigger binds reads as before for them alone.
 */
function declaredLine(item, own) {
  if (!own) return null;
  const holders = own.holders ?? [];
  const bound = own.triggers.length + own.more;
  const one = bound + holders.length === 1;
  const binds = bound > 0 ? html`${listedHtml([...own.triggers.map(triggerLink), ...(own.more ? [`${own.more} more`] : [])])} ${bound === 1 ? "binds" : "bind"} <span class="code pk-key">${item.key}</span> in run.secrets` : null;
  const declares = holders.length > 0 ? html`${listedHtml(holders.map(holderName))} ${holders.length === 1 ? "declares" : "declare"} ${binds ? "it" : html`<span class="code pk-key">${item.key}</span>`} in ${holders.length === 1 ? "its" : "their"} secrets` : null;
  const who = binds && declares ? html`${binds}, and ${declares}` : binds ?? declares;
  const theirs = one ? "its" : "their";
  if (item.status === "managed") return html`<p class="pk-note" data-provider-declared="refused">${who}, but this host binds the provider to a subscription, so it refuses ${theirs} jobs before they spend.</p>`;
  if (own.forwarded === true) return html`<p class="pk-note" data-provider-declared="refused">${who}, but this host's PI_FORWARD_ENV names it too, so it refuses ${theirs} jobs before they spend.</p>`;
  // This host's forward list unread: the key is spent unless this host refuses, which the card's note says is not known.
  if (own.forwarded === null) return html`<p class="pk-note" data-provider-declared="unknown">${who}, so every call ${theirs} jobs make to this provider spends that key, not this host's credential, unless this host's PI_FORWARD_ENV names it.</p>`;
  return html`<p class="pk-note" data-provider-declared="spent">${who}, so every call ${theirs} jobs make to this provider spends that key, not this host's credential.</p>`;
}

/** Once per card: what a spent line cannot know, and why a line may be missing or too wide (`DECLARED_KEY_NOTES`). */
function declaredNotes(inventory, declared) {
  const spent = inventory.rows.some(item => item.key && declared.slots.has(item.key) && item.status !== "managed" && declared.slots.get(item.key).forwarded !== true);
  const notes = [...(spent ? ["A trigger's own key is the triggers file's answer: another worker host refuses those jobs before they spend where its own PI_FORWARD_ENV names the variable or it binds the provider to a subscription. This page reads only this host's."] : []), ...declared.notes.map(note => DECLARED_KEY_NOTES[note])];
  return notes.map(text => html`<p class="pk-note" data-provider-declared-note>${text}</p>`);
}

function guide(provider) {
  const help = providerHelp(provider);
  return html`<details class="pk-guide" id="${guideId(provider)}" data-provider-help="${provider}"><summary>${help.kind === "api-key" ? "Find or create an API key for" : "Set up"} ${name(provider)}</summary><div class="pk-links">${help.url ? ui.outLink({ href: help.url, label: help.kind === "api-key" ? `Get API key at ${help.label}` : `Open ${help.label} setup`, btn: "sm" }) : null}${ui.outLink({ href: help.docsUrl, label: GUIDED.includes(provider) ? "Official guide" : "Setup guide" })}</div><ol>${help.steps.map(step => html`<li>${step}</li>`)}</ol>${help.notice ? html`<p class="pk-note pk-notice">${help.notice}</p>` : null}</details>`;
}

function row(view, item, declared) {
  const shortcut = item.mode && can(view, actionFor(item.mode));
  return html`<li class="pk-row" data-provider="${item.provider}"><div class="pk-row__title">${ui.icon("key", { size: "sm" })}<b>${name(item.provider)}</b>${item.usage.includes("default") ? ui.chip("Default") : null}${ui.badge(...STATUS[item.status])}</div>${item.key ? html`<span class="code pk-key">${item.key}</span>` : null}<p class="pk-note">${SOURCE[item.source]}${item.providers.length > 1 ? ` Shared by ${item.providers.join(", ")}; a change affects all of them.` : null}</p>${declaredLine(item, item.key ? declared.slots.get(item.key) : undefined)}${item.reason && PROVIDER_KEY_REASONS[item.reason] ? html`<p class="pk-note">${PROVIDER_KEY_REASONS[item.reason]}</p>` : null}${shortcut ? html`<fieldset data-config-controls disabled><button class="btn btn--ghost btn--sm" type="button" data-provider-pick="${item.provider}" data-provider-mode="${item.mode}" aria-label="${`${item.mode === "replace" ? "Replace" : "Add"} key for ${name(item.provider)}`}">${item.mode === "replace" ? "Replace key" : "Add key"}</button></fieldset>` : null}</li>`;
}

function editor(view, inventory) {
  const add = can(view, "setup-provider-key"), replace = can(view, "setup-provider-key-replace");
  if (!add && !replace) return html`<p class="pk-note pk-notice">${view.readOnly ? "This console is read-only. Use the deployment host to change keys." : view.role !== "operator" ? "An operator can add or replace provider keys." : "Browser key changes need the host setup grant. Use the deployment host or enable its explicitly granted console setup service."}</p>`;
  if (inventory.state === "unknown") return html`<p class="pk-note pk-notice">Key changes are unavailable while credential sources are unknown. Inspect the deployment on its host, then reload.</p>`;
  const choices = inventory.choices.map(choice => ({ ...choice, available: choice.supported && !inventory.rows.some(item => item.providers.includes(choice.provider) && ["managed", "shadowed", "unknown", "unsupported"].includes(item.status)) }));
  const selected = choices.find(choice => choice.provider === inventory.defaultProvider && choice.available) ?? choices.find(choice => choice.available);
  if (!selected) return html`<p class="pk-note pk-notice">No supported API-key slot is available. Follow the provider's setup guide on the deployment host.</p>`;
  const mode = add ? "add" : "replace";
  return html`<div class="pk-editor" id="provider-key-editor"><h3>Add or replace a provider key</h3><form class="act config-form pk-form" data-action="${actionFor(mode)}" data-provider-key-form autocomplete="off"><fieldset data-config-controls disabled><div class="pk-picks"><div class="field"><label for="provider-key-provider">Provider</label><select class="select" id="provider-key-provider" name="provider" required>${choices.map(choice => html`<option value="${choice.provider}" ${choice.provider === selected.provider ? html`selected` : null} ${!choice.available ? html`disabled` : null}>${name(choice.provider)}${!choice.available ? " (host review required)" : ""}</option>`)}</select><p class="field__err" data-field-error="provider" hidden></p></div><div class="field"><label for="provider-key-mode">Change</label><select class="select" id="provider-key-mode" data-provider-key-mode><option value="add" ${mode === "add" ? html`selected` : null} ${!add ? html`disabled` : null}>Add a new key</option><option value="replace" ${mode === "replace" ? html`selected` : null} ${!replace ? html`disabled` : null}>Replace an existing key</option></select></div></div><div data-provider-key-context>${choices.map(choice => html`<p class="pk-note" data-provider-context="${choice.provider}" ${choice.provider !== selected.provider ? html`hidden` : null}>${choice.key ? html`The selected slot is <span class="code">${choice.key}</span>.` : "This provider has no general API-key slot."}${choice.providers.length > 1 ? ` Shared by ${choice.providers.join(", ")}; a change affects all of them.` : null} <a class="link" href="${`#${guideId(choice.provider)}`}">Find or create this provider's key</a></p>`)}</div>${field("value", "New API key", { id: "provider-key-value", input: "password", required: true, max: 4096 })}<p class="pk-note">Only the selected provider slot changes. The default provider stays the same. A running worker needs a separate restart. Replacement needs a new value; this page keeps no previous key.</p><button class="btn btn--primary btn--sm" type="submit" data-provider-key-submit>${mode === "replace" ? "Preview replacing key" : "Preview adding key"}</button></fieldset><noscript><p class="pk-note">Enable JavaScript to preview and confirm a change. Provider status, guides and external links work without it.</p></noscript><p class="field__err" data-form-error hidden role="alert"></p></form></div>`;
}

export function connectionsProviderKeys(view) {
  const inventory = providerInventoryView(view.data?.connections?.providerKeys);
  const declared = declaredKeysView(view.data?.connections?.providerKeys);
  const withheld = view.role === "agent" && !view.data?.connections;
  const other = [...new Set([...inventory.choices.map(choice => choice.provider), ...inventory.rows.map(item => item.provider)])].filter(provider => !GUIDED.includes(provider));
  return ui.card({ title: "Provider API keys", sub: "separate credentials, unchanged default", body: html`<p class="pk-intro">Store keys for several providers. Credentials are write-only; status describes local declarations, not a successful paid request.</p><p class="pk-default"><b>Default provider: ${inventory.defaultProvider ?? "not published"}</b><a class="link" href="/config#cf-settings">Change it separately in Configuration</a></p>${withheld ? html`<p class="pk-note">Provider key inventory is not published in this agent view. An operator can inspect the deployment's key sources on Connections.</p>` : inventory.state !== "ready" ? ui.banner({ status: "attention", title: inventory.state === "unknown" ? "Provider key sources unavailable" : "Partial provider key sources", body: "Missing or unreadable declarations stay unknown. Check the deployment on its host before changing credentials.", sm: true }) : null}<ul class="pk-list">${inventory.rows.map(item => row(view, item, declared))}</ul>${declaredNotes(inventory, declared)}${inventory.rows.length || withheld ? null : html`<p class="pk-note">No provider key declaration is published.</p>`}${editor(view, inventory)}<div class="pk-help"><h3>Find or create a key at the provider</h3>${GUIDED.map(guide)}${other.length ? html`<details class="pk-guide"><summary>Other provider setup guides</summary><div class="pk-help">${other.map(guide)}</div></details>` : null}</div><p class="pk-note pk-notice">Using a subscription? <a class="link" href="#p-subscription-auth">Review Subscription authentication</a>. Its host sign-in is separate from API keys.</p>` });
}

export function setupProviderKeys(view) {
  const inventory = providerInventoryView(view.data?.setup?.providerKeys);
  return html`<div class="pk-compact"><p>Keep API keys for several providers. Add or replace a write-only key on Connections; the default provider stays ${inventory.defaultProvider ?? "unchanged"}.</p><a class="link" href="/config/connections#p-provider-keys">Manage provider API keys</a><p>Official provider guides show where to find or create a key. Subscription sign-in uses its own host instructions.</p></div>`;
}
