import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readProviderInventory, providerInventoryView, providerCanonicalKey, providerKeyOrder, providerKeyReasonParts, PROVIDER_KEY_REASONS, PROVIDER_SLOT_ALIASES, declaredKeyTriggers, declaredKeysView, DECLARED_KEY_TRIGGERS_MAX, DECLARED_KEY_VIA } from "../src/provider-inventory.mjs";
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

test("a triggers file that does not exist names no provider, which is a read's answer; one that is there and does not load leaves the list partial", () => {
  // Issue #988: an absent file was "Some provider references could not be read." (the list `partial`), on a deployment
  // that simply has no triggers yet.
  const f = fixture({ document: { triggers: [], modelRoles: { default: { code: "openai/gpt-5" } } } });
  assert.ok(f.read().rows.some(row => row.provider === "openai"), "the control: the file names a provider");
  fs.rmSync(join(f.dir, "triggers.json"));
  const absent = f.read();
  assert.equal(absent.state, "ready");
  assert.ok(!absent.rows.some(row => row.provider === "openai"), "and no provider is listed from a file that is not there");
  fs.writeFileSync(join(f.dir, "triggers.json"), "{ not json");
  assert.equal(f.read().state, "partial", "a file that is there and does not load: the list may be short");
});

test("random pool providers are inventoried even when no primary or allowed list names them", () => {
  const f = fixture({ document: { version: 6, triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", modelSelection: { strategy: "random", candidates: ["openai/gpt-5", "mistral/m"] } } }] } });
  const inventory = f.read();
  for (const provider of ["openai", "mistral"]) assert.ok(inventory.rows.some(row => row.provider === provider && row.usage.includes("trigger")), provider);
});

const cron = (id, run, folder = "/repo") => ({ on: { type: "cron", id, pattern: "0 1 * * *" }, run: { kind: "local", flow: "tidy", folder, task: "t", ...run } });
const slot = (key, rows, extra = {}) => ({ key, triggers: rows.map(([index, name = null]) => ({ index, cron: name })), more: 0, forwarded: false, ...extra });

test("a trigger whose run.secrets binds the slot of a provider it runs on is listed under that slot, from the file alone", () => {
  const document = { version: 8, modelRoles: { default: { code: "groq/llama" }, team: { code: "cerebras/big" } }, triggers: [
    cron("own", { provider: "openrouter", model: "vendor/model", secrets: { OPENROUTER_API_KEY: SECRET } }),
    cron("inherits", { secrets: { ANTHROPIC_API_KEY: SECRET } }),
    { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", modelSelection: { strategy: "random", candidates: ["openai/gpt-5", "mistral/m"] }, secrets: { MISTRAL_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET } } },
    cron("fallback", { provider: "openai", model: "gpt-x", models: ["openai/gpt-x", "deepseek/one"], fallbackModels: ["deepseek/one"], secrets: { DEEPSEEK_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET } }),
    cron("role", { model: "role:code", secrets: { GROQ_API_KEY: SECRET, CEREBRAS_API_KEY: SECRET } }),
    cron("oauth", { provider: "anthropic", model: "m", secrets: { ANTHROPIC_OAUTH_TOKEN: SECRET } }),
    cron("file", { provider: "openrouter", model: "vendor/model", secretFiles: { OPENROUTER_API_KEY: SECRET } }),
    cron("copilot", { provider: "github-copilot", model: "m", secrets: { COPILOT_GITHUB_TOKEN: SECRET } }),
  ] };
  const f = fixture({ document });
  const view = f.read();
  assert.equal(view.state, "ready");
  // Main model, inherited default, random candidate (and never the default a pool would otherwise inherit), a fallback the
  // walk tries, and a role in the scope its job lands in: no projects file, so the default scope, never `team`. Never
  // another provider's key, an OAuth variable, a file secret or a provider that needs host authentication.
  assert.deepEqual(view.declaredKeys, [
    slot("ANTHROPIC_API_KEY", [[1, "inherits"]]),
    slot("DEEPSEEK_API_KEY", [[3, "fallback"]]),
    slot("GROQ_API_KEY", [[4, "role"]]),
    slot("MISTRAL_API_KEY", [[2]]),
    slot("OPENROUTER_API_KEY", [[0, "own"]]),
  ]);
  assert.deepEqual(view.declaredNotes, []);
  assert.ok(!JSON.stringify(view).includes(SECRET), "a binding is named by its variable, never its reference or value");
  assert.deepEqual(providerInventoryView(view), providerInventoryView({ ...view, declaredKeys: undefined, declaredNotes: undefined }), "the shared projection behind Setup and the agent read carries none of it");
  assert.deepEqual(f.read({ reads: { environment: () => ({ unreadable: true }) } }).declaredKeys, [], "with PI_TRIGGERS_FILE unknown, the default file is not the one to claim a key from");
});

test("a model role names the provider of the project its job lands in, and every scope only when the projects file is unread", () => {
  const team = fs.realpathSync(tempDir("pd-provider-team-")), solo = fs.realpathSync(tempDir("pd-provider-solo-"));
  const secrets = { XAI_API_KEY: SECRET, CEREBRAS_API_KEY: SECRET };
  const document = { version: 8, modelRoles: { default: { code: "xai/grok-4" }, team: { code: "cerebras/big" } }, triggers: [
    cron("team-role", { model: "role:code", secrets }, team),
    cron("solo-role", { model: "role:code", secrets }, solo),
    { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "deploy", model: "role:code", secrets } },
  ] };
  const f = fixture({ env: "PI_PROJECTS_FILE=projects.json\n", document });
  fs.writeFileSync(join(f.dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "team", name: "Team", members: [team] }] }), { mode: 0o600 });
  // The worker's rule and doctor: the team folder's cron on the team role, the other cron and the label trigger (no
  // project has a GitHub member) on the default one.
  const known = f.read();
  assert.deepEqual(known.declaredKeys, [slot("CEREBRAS_API_KEY", [[0, "team-role"]]), slot("XAI_API_KEY", [[1, "solo-role"], [2]])]);
  assert.deepEqual(known.declaredNotes, []);
  fs.rmSync(join(f.dir, "projects.json"));
  const unread = f.read();
  assert.equal(unread.state, "ready", "the projects file decides only the own-key lines");
  assert.deepEqual(unread.declaredKeys, [slot("CEREBRAS_API_KEY", [[0, "team-role"], [1, "solo-role"], [2]]), slot("XAI_API_KEY", [[0, "team-role"], [1, "solo-role"], [2]])]);
  assert.deepEqual(unread.declaredNotes, ["projects-unread"], "every scope is wider than the workers' answer, and the card says so");
});

test("PI_MODEL, PI_ALLOWED_MODELS and PI_FORWARD_ENV decide their part, and an unread line of one never blanks the card", () => {
  const document = { version: 8, modelRoles: { default: { code: "groq/llama" } }, triggers: [
    cron("inherits", { secrets: { GROQ_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET } }),
    cron("named", { provider: "openrouter", model: "vendor/model", secrets: { OPENROUTER_API_KEY: SECRET } }),
  ] };
  // A default model that is a role runs a trigger naming no model on the role's provider.
  assert.deepEqual(fixture({ env: "PI_MODEL=role:code\n", document }).read().declaredKeys, [slot("GROQ_API_KEY", [[0, "inherits"]]), slot("OPENROUTER_API_KEY", [[1, "named"]])]);
  // A line the service's loader may read apart from this reader: only the default model is unknown, so the trigger on it
  // is not judged, the one naming its own model still is, and every row keeps its source.
  const unread = fixture({ env: 'ANTHROPIC_API_KEY=x\nPI_MODEL="claude-sonnet-4-5"$SUFFIX\nPI_FORWARD_ENV="OPENROUTER_API_KEY"$SUFFIX\n', document }).read();
  assert.equal(unread.state, "ready");
  assert.equal(unread.rows.find(row => row.provider === "anthropic").status, "configured");
  assert.deepEqual(unread.declaredKeys, [slot("OPENROUTER_API_KEY", [[1, "named"]], { forwarded: null })]);
  assert.deepEqual(unread.declaredNotes, ["default-model-unread", "forward-unread"], "an unread forward list is said, not read as none");
  // This host's PI_FORWARD_ENV naming the variable makes this host refuse those jobs.
  assert.deepEqual(fixture({ env: "PI_FORWARD_ENV=FOO,OPENROUTER_API_KEY\n", document }).read().declaredKeys.map(row => [row.key, row.forwarded]), [["ANTHROPIC_API_KEY", false], ["OPENROUTER_API_KEY", true]]);
  // A fallback only PI_ALLOWED_MODELS admits is an attempt the walk tries.
  const allowed = fixture({ env: "PI_ALLOWED_MODELS=openai/gpt-x,deepseek/one\n", document: { version: 8, triggers: [cron("fallback", { provider: "openai", model: "gpt-x", fallbackModels: ["deepseek/one"], secrets: { DEEPSEEK_API_KEY: SECRET } })] } }).read();
  assert.deepEqual(allowed.declaredKeys, [slot("DEEPSEEK_API_KEY", [[0, "fallback"]])]);
});

test("doctor's placement of an unresolvable folder, its fallback fence, and the inputs that read no roles", () => {
  // A folder this host cannot resolve keeps its spelling, so the project that names it decides its role, as in doctor.
  const gone = join(fs.realpathSync(tempDir("pd-provider-remote-")), "remote-team");
  const roles = { default: { code: "xai/grok-4" }, team: { code: "cerebras/big" } };
  const remote = fixture({ env: "PI_PROJECTS_FILE=projects.json\n", document: { version: 8, modelRoles: roles, triggers: [cron("remote-role", { model: "role:code", secrets: { XAI_API_KEY: SECRET, CEREBRAS_API_KEY: SECRET } }, gone)] } });
  fs.writeFileSync(join(remote.dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "team", name: "Team", members: [gone] }] }), { mode: 0o600 });
  assert.deepEqual(remote.read().declaredKeys, [slot("CEREBRAS_API_KEY", [[0, "remote-role"]])]);
  // An empty PI_PROJECTS_FILE is a file the worker refuses to start on, never "no projects".
  const empty = fixture({ env: "PI_PROJECTS_FILE=\n", document: { version: 8, modelRoles: roles, triggers: [cron("role", { model: "role:code", secrets: { XAI_API_KEY: SECRET, CEREBRAS_API_KEY: SECRET } })] } }).read();
  assert.deepEqual(empty.declaredNotes, ["projects-unread"]);
  assert.deepEqual(empty.declaredKeys.map(row => row.key), ["CEREBRAS_API_KEY", "XAI_API_KEY"]);
  // Behind a primary this host binds to a subscription, the walk skips a fallback it does not bind.
  const fenced = fixture({ env: "PI_AUTH_CONNECTIONS_FILE=auth.json\n", document: { version: 8, triggers: [cron("fallback", { provider: "openai", model: "gpt-x", models: ["openai/gpt-x", "deepseek/one"], fallbackModels: ["deepseek/one"], secrets: { DEEPSEEK_API_KEY: SECRET } })] } });
  fs.writeFileSync(join(fenced.dir, "auth.json"), JSON.stringify({ version: 1, connections: [{ id: "account", provider: "openai", adapter: "openai-chatgpt", ownerHost: "worker" }], bindings: { openai: "account" } }), { mode: 0o600 });
  assert.deepEqual(fenced.read().declaredKeys, []);
  fs.writeFileSync(join(fenced.dir, ".env"), "PI_SETTINGS_FILE=settings.json\n", { mode: 0o600 });
  assert.deepEqual(fenced.read().declaredKeys, [slot("DEEPSEEK_API_KEY", [[0, "fallback"]])], "the same fallback with no binding is an attempt");
  // With no model roles, a trigger naming no provider runs on the default whatever PI_MODEL's line says, and a forward list
  // is read as doctor reads it, each name trimmed.
  const plain = { version: 8, triggers: [cron("inherits", { secrets: { ANTHROPIC_API_KEY: SECRET } })] };
  const noRoles = fixture({ env: 'PI_MODEL="claude-sonnet-4-5"$SUFFIX\nPI_FORWARD_ENV="FOO, ANTHROPIC_API_KEY"\n', document: plain }).read();
  assert.deepEqual(noRoles.declaredKeys, [slot("ANTHROPIC_API_KEY", [[0, "inherits"]], { forwarded: true })]);
  assert.deepEqual(noRoles.declaredNotes, []);
});

test("a fallback the walk never tries and a role the worker refuses bring no key, and the rebuild keeps its bounds", () => {
  const triggers = [
    { on: { type: "watch" }, run: { provider: "openrouter", secrets: { DEEPSEEK_API_KEY: "ref" } } },
    { on: { type: "cron" }, run: { provider: "openrouter", model: "a", fallbackModels: ["deepseek/one"], secrets: { DEEPSEEK_API_KEY: "ref" } } },
    { on: { type: "cron" }, run: { provider: "openrouter", model: "role:code", secrets: { GROQ_API_KEY: "ref", OPENROUTER_API_KEY: "ref" } } },
    { on: { type: "cron" }, run: { provider: "groq", model: "role:missing", secrets: { GROQ_API_KEY: "ref" } } },
    { on: { type: "cron" }, run: { provider: "openrouter", model: "a", models: ["openrouter/a", "deepseek/one"], fallbackModels: ["deepseek/one"], secrets: { DEEPSEEK_API_KEY: "ref" } } },
  ];
  const declared = declaredKeyTriggers(triggers, { defaultProvider: "anthropic", defaultModel: "m", modelRoles: { default: { code: "groq/llama" } } });
  // Another provider's key on a watch rule is no declared key; a failover list no allowed-model list admits refuses every
  // job before an attempt, and so do a role run.provider contradicts and one the file does not declare. A list that admits
  // the fallback makes it an attempt the walk tries, on the key the trigger binds.
  assert.deepEqual([...declared.slots], [["DEEPSEEK_API_KEY", [{ index: 4, cron: null }]]]);
  assert.deepEqual([...declaredKeyTriggers([{ on: { type: "cron" }, run: { secrets: { ANTHROPIC_API_KEY: "ref" } } }], { defaultProvider: null }).slots], [], "an unknown default provider judges no inheriting trigger");
  assert.equal(DECLARED_KEY_TRIGGERS_MAX, 16);
  const rows = Array.from({ length: DECLARED_KEY_TRIGGERS_MAX + 3 }, (_, index) => ({ index, cron: index === 0 ? "nightly" : index === 1 ? "bad:id" : null }));
  const many = declaredKeysView({ declaredKeys: [{ key: "GROQ_API_KEY", triggers: rows, more: 2, forwarded: true }, { key: "GROQ_API_KEY", triggers: [{ index: 40 }] }, { key: "PATH", triggers: [{ index: 1 }] }, { key: "constructor", triggers: [{ index: 1 }] }, { key: "OPENAI_API_KEY", triggers: [{ index: -1 }, { index: 1.5 }, { index: "2" }, 3] }, { key: "MISTRAL_API_KEY", triggers: [{ index: 5 }], more: -4, forwarded: "yes" }], declaredNotes: ["projects-unread", "projects-unread", "__proto__", 7] });
  assert.deepEqual([...many.slots.keys()], ["GROQ_API_KEY", "MISTRAL_API_KEY"], "only a provider slot with a real position survives, the first row of a slot only");
  const groq = many.slots.get("GROQ_API_KEY");
  assert.equal(groq.triggers.length, DECLARED_KEY_TRIGGERS_MAX);
  assert.deepEqual(groq.triggers.slice(0, 3), [{ index: 0, cron: "nightly" }, { index: 1, cron: null }, { index: 2, cron: null }], "a cron name the loader would refuse is dropped, its position kept");
  assert.equal(groq.more, 5);
  assert.equal(groq.forwarded, true);
  assert.deepEqual(many.slots.get("MISTRAL_API_KEY"), { triggers: [{ index: 5, cron: null }], more: 0, forwarded: null }, "a negative count and a non-boolean answer are not taken");
  assert.deepEqual(many.notes, ["projects-unread"]);
  const bounded = declaredKeysView({ declaredKeys: [...Array.from({ length: Object.keys(PROVIDER_SLOT_ALIASES).length }, () => ({ key: "PATH", triggers: [{ index: 1 }] })), { key: "GROQ_API_KEY", triggers: [{ index: 1 }] }] });
  assert.equal(bounded.slots.size, 0, "no more rows are read than there are slots");
  // Issue #1029: a role model is kept only by its closed name, and a position keeps its place without one.
  const via = declaredKeysView({ declaredKeys: [{ key: "GROQ_API_KEY", triggers: [{ index: 1, via: "decide" }, { index: 2, via: "auxiliary" }, { index: 3, via: "main" }, { index: 4, via: ["decide"] }, { index: 5, via: "__proto__" }] }] });
  assert.deepEqual(via.slots.get("GROQ_API_KEY").triggers, [{ index: 1, cron: null, via: "decide" }, { index: 2, cron: null, via: "auxiliary" }, { index: 3, cron: null }, { index: 4, cron: null }, { index: 5, cron: null }]);
  assert.deepEqual(DECLARED_KEY_VIA, ["decide", "auxiliary"]);
});

const byKey = slots => [...slots].sort(([a], [b]) => a.localeCompare(b));
const watchDecide = { model: "openrouter/typesafe/jev-1.13", maxCostUsd: "0.001", fields: ["service"], questions: { act: { type: "choice", criteria: { investigate: "failure", ignore: "noise", file_issue: "ask person" } } }, act: { investigate: 0.7, ignore: 0.9, otherwise: "file_issue" } };
const watchRule = (id, run, decide) => ({ on: { type: "watch", id, source: "prod", fingerprint: ["service"], window: "10m", cooldown: "6h", maxPerDay: 4 }, run: { kind: "local", mode: "investigate", folder: "/srv/app", flow: "triage", task: "t", maxCostUsd: "1", ...(decide ? { issue: { kind: "github", repo: "acme/shop" } } : {}), ...run }, ...(decide ? { decide } : {}) });

test("issue #1029: a watch rule's main and decide models and an auxiliary model are listed under their providers' slots, by the worker's rule", () => {
  const label = run => ({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "review", maxCostUsd: "1", ...run } });
  const triggers = [
    watchRule("errors", { secrets: { OPENROUTER_API_KEY: SECRET } }, watchDecide),
    watchRule("latency", { provider: "deepseek", model: "deepseek-chat", secrets: { DEEPSEEK_API_KEY: SECRET } }),
    watchRule("both", { provider: "openrouter", model: "vendor/model", secrets: { OPENROUTER_API_KEY: SECRET } }, watchDecide),
    label({ provider: "anthropic", model: "m", models: ["anthropic/m", "openai/gpt-5"], auxiliaryModels: ["openai/gpt-5"], secrets: { OPENAI_API_KEY: SECRET } }),
    label({ provider: "openai", model: "gpt-5", models: ["openai/gpt-5", "openai/gpt-4o"], auxiliaryModels: ["openai/gpt-4o"], secrets: { OPENAI_API_KEY: SECRET } }),
    label({ provider: "anthropic", model: "m", models: ["anthropic/m", "openai/gpt-5"], auxiliaryModels: ["openai/gpt-5"], secrets: { STRIPE_KEY: SECRET }, secretFiles: { OPENAI_API_KEY: SECRET } }),
    label({ provider: "anthropic", model: "m", models: ["anthropic/m", "github-copilot/gpt-4o"], auxiliaryModels: ["github-copilot/gpt-4o"], secrets: { COPILOT_GITHUB_TOKEN: SECRET } }),
    label({ models: ["opencode/a", "anthropic/m", "opencode-go/b"], modelSelection: { strategy: "random", candidates: ["opencode/a", "anthropic/m"] }, auxiliaryModels: ["opencode-go/b"], secrets: { OPENCODE_API_KEY: SECRET } }),
    watchRule("oauth", { secrets: { ANTHROPIC_OAUTH_TOKEN: SECRET } }, { ...watchDecide, model: "anthropic/claude-haiku-4-5" }),
  ];
  const { slots, notes } = declaredKeyTriggers(triggers, { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" });
  // The classifier alone reaches openrouter for rule 1 ("for its decide model"), the rule's own model for rule 3, which
  // its classifier shares; rule 2's own model is a watch rule's main model like any trigger's. The auxiliary model alone
  // reaches openai for trigger 4; trigger 5 runs on openai, so its auxiliary model shares the main key. A file secret,
  // a provider that needs host authentication and an OAuth variable stay out, and a pool candidate and an auxiliary
  // model sharing one slot name the trigger once, as the candidate's main model.
  assert.deepEqual(byKey(slots), [
    ["DEEPSEEK_API_KEY", [{ index: 1, cron: null }]],
    ["OPENAI_API_KEY", [{ index: 3, cron: null, via: "auxiliary" }, { index: 4, cron: null }]],
    ["OPENCODE_API_KEY", [{ index: 7, cron: null }]],
    ["OPENROUTER_API_KEY", [{ index: 0, cron: null, via: "decide" }, { index: 2, cron: null }]],
  ]);
  assert.deepEqual(notes, []);
  // A provider this host binds to a subscription is listed for a classifier or an auxiliary model as for a main one: the
  // card's managed row says the worker refuses those jobs.
  assert.deepEqual(byKey(declaredKeyTriggers([triggers[0], triggers[3]], { defaultProvider: "anthropic", defaultModel: "m", managed: provider => provider !== "anthropic" }).slots).map(([key]) => key), ["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
  // With the projects file unread a role resolves in every scope: where one scope runs the job on the auxiliary model's
  // provider, the trigger is that provider's main model there, and the line says no more than that.
  const scoped = declaredKeyTriggers([{ on: { type: "cron", id: "role" }, run: { kind: "local", model: "role:code", auxiliaryModels: ["cerebras/big"], secrets: { CEREBRAS_API_KEY: SECRET } } }], { defaultProvider: "anthropic", defaultModel: "m", modelRoles: { default: { code: "groq/llama" }, team: { code: "cerebras/big" } }, projects: null });
  assert.deepEqual(byKey(scoped.slots), [["CEREBRAS_API_KEY", [{ index: 0, cron: "role" }]]]);
  assert.deepEqual(scoped.notes, ["projects-unread"]);
});

test("issue #1029: a watch rule reads no model role, so a default that is a role refuses it and a role never moves its slot", () => {
  const roles = { default: { code: "groq/llama" } };
  const triggers = [
    watchRule("inherits", { secrets: { ANTHROPIC_API_KEY: SECRET, GROQ_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET } }, watchDecide),
    watchRule("named", { provider: "deepseek", model: "deepseek-chat", secrets: { DEEPSEEK_API_KEY: SECRET, GROQ_API_KEY: SECRET } }),
    { on: { type: "cron", id: "cron-role" }, run: { kind: "local", secrets: { GROQ_API_KEY: SECRET } } },
  ];
  // With PI_MODEL a role, a watch rule naming no model is refused before any attempt (model-role-unknown, since the worker
  // gives a watch job no roles), its classifier with it; one naming its model runs on it, never on the role's provider.
  // A cron trigger naming no model runs on the role, as before.
  const role = declaredKeyTriggers(triggers, { defaultProvider: "anthropic", defaultModel: "role:code", modelRoles: roles });
  assert.deepEqual(byKey(role.slots), [["DEEPSEEK_API_KEY", [{ index: 1, cron: null }]], ["GROQ_API_KEY", [{ index: 2, cron: "cron-role" }]]]);
  // A plain default: the inheriting rule runs on it whatever roles the file declares, and its classifier on openrouter;
  // the cron trigger runs on it too, and binds no key of it.
  const plain = declaredKeyTriggers(triggers, { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", modelRoles: roles });
  assert.deepEqual(byKey(plain.slots).map(([key, rows]) => [key, rows.map(t => t.index)]), [["ANTHROPIC_API_KEY", [0]], ["DEEPSEEK_API_KEY", [1]], ["OPENROUTER_API_KEY", [0]]]);
  // An unread PI_MODEL with roles declared leaves a rule naming no model unjudged, as any trigger, and says so.
  const unread = declaredKeyTriggers(triggers, { defaultProvider: "anthropic", defaultModel: null, modelRoles: roles });
  assert.deepEqual(byKey(unread.slots).map(([key]) => key), ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(unread.notes, ["default-model-unread"]);
});

test("issue #1029: a watch rule's classifier is a provider the inventory lists, so its own key has a row to be named under", () => {
  const document = { version: 9, watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } }, triggers: [watchRule("errors", { secrets: { OPENROUTER_API_KEY: SECRET } }, watchDecide)] };
  const view = fixture({ document }).read();
  assert.equal(view.state, "ready");
  assert.deepEqual(view.rows.map(row => [row.provider, row.usage]), [["anthropic", ["default"]], ["openrouter", ["trigger"]]]);
  assert.deepEqual(view.declaredKeys, [{ key: "OPENROUTER_API_KEY", triggers: [{ index: 0, cron: null, via: "decide" }], more: 0, forwarded: false }]);
  assert.ok(!JSON.stringify(view).includes(SECRET));
});

test("issue #1013: an answer rule and the zeroTouch block that declare a slot's variable are named under it, by their models' providers, and each model's provider has a row", () => {
  const rule = (id, model, decisionModel, secrets) => ({ id, projects: [id], categories: ["how-to"], confidence: 0.9, mode: "draft", flow: "answer", model, decisionModel, maxCostUsd: "0.10", secrets });
  const document = { version: 12, triggers: [cron("own", { provider: "openai", model: "gpt-5", secrets: { OPENAI_API_KEY: SECRET } })], answerRules: [
    rule("help", "openai/gpt-5-mini", "openrouter/typesafe/jev-1.13", { OPENAI_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET, GROQ_API_KEY: SECRET }),
    rule("same", "deepseek/one", "deepseek/two", { DEEPSEEK_API_KEY: SECRET }),
    rule("plain", "mistral/m", "mistral/m", undefined),
  ], zeroTouch: { capture: true, model: "openrouter/typesafe/jev-1.13", maxCostUsd: "0.05", secrets: { ANTHROPIC_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET } } };
  const view = fixture({ document }).read();
  assert.equal(view.state, "ready");
  // The default provider (anthropic) is the grouping job's main model; a rule whose two models share a slot is named once,
  // as its main model's; a key no model of the block runs on (GROQ) and a rule with no declaration are named nowhere.
  assert.deepEqual(view.declaredKeys, [
    { key: "ANTHROPIC_API_KEY", triggers: [], more: 0, forwarded: false, holders: [{ zeroTouch: true }] },
    { key: "DEEPSEEK_API_KEY", triggers: [], more: 0, forwarded: false, holders: [{ rule: "same" }] },
    { key: "OPENAI_API_KEY", triggers: [{ index: 0, cron: "own" }], more: 0, forwarded: false, holders: [{ rule: "help" }] },
    { key: "OPENROUTER_API_KEY", triggers: [], more: 0, forwarded: false, holders: [{ rule: "help", via: "decision" }, { zeroTouch: true, via: "grouping" }] },
  ]);
  assert.ok(view.rows.some(row => row.provider === "openrouter") && view.rows.some(row => row.provider === "deepseek"), "each declaring model's provider has a row to be named under");
  assert.equal(view.rows.some(row => row.provider === "mistral"), false, "a rule that declares nothing adds no row");
  assert.ok(!JSON.stringify(view).includes(SECRET));
  // The rebuild keeps only well formed holders, each once.
  assert.deepEqual(declaredKeysView({ declaredKeys: [{ key: "OPENAI_API_KEY", triggers: [], holders: [{ rule: "help" }, { rule: "help", via: "decision" }, { rule: "Bad Id" }, { zeroTouch: true, via: "decide" }, { zeroTouch: true }, {}] }] }).slots.get("OPENAI_API_KEY").holders, [{ rule: "help" }, { zeroTouch: true }]);
});

// Issue #1068: since pi 1.6.0 each Qwen Token Plan provider reads its own variable first, then the region variable both
// plans shared. The four ids, their slot and that shared variable, from pi's generated table.
const QWEN = Object.freeze(["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "qwen-token-plan-individual-cn"]);
const qwenRow = (provider, { file = {}, env = {}, document } = {}) => {
  const lines = Object.entries({ PI_PROVIDER: provider, ...file }).map(([name, value]) => `${name}=${value}\n`).join("");
  return fixture({ env: lines, ...(document ? { document } : {}) }).read({ env }).rows.find(row => row.provider === provider);
};
const outcome = row => ({ status: row.status, source: row.source, reason: row.reason, mode: row.mode, present: row.present, fallbackKey: row.fallbackKey });

test("issue #1068: pi's order splits a provider's variables around its slot, and only the four Qwen Token Plan ids read one after it, a variable other providers read too", () => {
  const behind = Object.keys(PROVIDER_KEY_NAMES).filter(provider => providerKeyOrder(provider).behind.length > 0);
  assert.deepEqual(behind, [...QWEN], "a pi release that adds a fallback variable is a decision this table has to see");
  for (const provider of QWEN) {
    const { ahead, behind: after } = providerKeyOrder(provider);
    assert.deepEqual(ahead, [], provider);
    assert.deepEqual([...ahead, providerCanonicalKey(provider), ...after], PROVIDER_KEY_NAMES[provider], `${provider}: the split keeps pi's whole list in its order`);
    // "shared" and "the other providers that read it" in the row's words are true only of a variable two providers read.
    for (const name of after) assert.ok(Object.values(PROVIDER_KEY_NAMES).filter(names => names.includes(name)).length >= 2, `${provider}: ${name} is read by another provider too`);
  }
  assert.deepEqual(providerKeyOrder("anthropic"), { ahead: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"], behind: [] }, "Anthropic's slot is its last candidate");
  // docs/provider-keys.md restates the table for operators: held to it both ways, row for row.
  const doc = fs.readFileSync(new URL("../../docs/provider-keys.md", import.meta.url), "utf8");
  const table = doc.slice(doc.indexOf("| Provider | Slot | Fallback |")).split("\n\n")[0].split("\n").slice(2);
  const tick = cell => cell.trim().replace(/^`|`$/g, "");
  assert.deepEqual(table.map(line => line.split("|").slice(1, 4).map(tick)).sort(), behind.flatMap(provider => providerKeyOrder(provider).behind.map(name => [provider, providerCanonicalKey(provider), name])).sort());
  assert.deepEqual(providerKeyOrder("amazon-bedrock"), { ahead: [], behind: [] });
  assert.deepEqual(providerKeyOrder("custom-provider"), { ahead: [], behind: [] });
});

test("issue #1068: a Qwen Token Plan provider on the shared variable alone reads as configured by it, with Add offered; its own key makes the shared one irrelevant", () => {
  for (const provider of QWEN) {
    const slot = providerCanonicalKey(provider);
    const [shared] = providerKeyOrder(provider).behind;
    const configuredBy = { status: "configured", source: "fallback-key", reason: "fallback-key", mode: "add", present: false, fallbackKey: shared };
    const own = { status: "configured", source: "deployment-env", reason: null, mode: "replace", present: true, fallbackKey: undefined };
    // The table: where each variable is set (the deployment's .env, or this console's own environment) and what the row reads.
    for (const [label, input, expected] of [
      ["the shared variable alone, in the .env", { file: { [shared]: SECRET } }, configuredBy],
      ["the shared variable alone, in this console's environment", { env: { [shared]: SECRET } }, configuredBy],
      ["its own variable alone", { file: { [slot]: SECRET } }, own],
      ["both, in the .env", { file: { [slot]: SECRET, [shared]: SECRET } }, own],
      ["its own in the .env, the shared one in this console's environment", { file: { [slot]: SECRET }, env: { [shared]: SECRET } }, own],
      ["its own in this console's environment, which outranks the .env line", { env: { [slot]: SECRET } }, { status: "shadowed", source: "shadowed", reason: "source-shadowed", mode: null, present: false, fallbackKey: undefined }],
      ["neither", {}, { status: "missing", source: "missing", reason: "pi-fallback-possible", mode: "add", present: false, fallbackKey: undefined }],
    ]) {
      const row = qwenRow(provider, input);
      assert.deepEqual(outcome(row), expected, `${provider}, ${label}`);
      assert.ok(!JSON.stringify(row).includes(SECRET), `${provider}, ${label}: names only`);
    }
    const sentence = providerKeyReasonParts(qwenRow(provider, { file: { [shared]: SECRET } })).join("");
    assert.equal(sentence, `pi reads ${shared} for this provider, and prefers ${slot} once it is set. Adding a key here leaves ${shared} in place for the other providers that read it.`);
  }
  // A fallback in the environment is what the worker forwards, so the pi login is not what the row waits on.
  assert.equal(qwenRow("qwen-token-plan", { file: { PI_AUTH_FROM_PI: "0", QWEN_TOKEN_PLAN_API_KEY: SECRET } }).reason, "fallback-key");
  // The other plan's own variable is nobody's fallback here.
  assert.equal(qwenRow("qwen-token-plan", { file: { QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY: SECRET } }).status, "missing");
});

test("issue #1068: Anthropic's outcomes are as they were for every variable in each place, its slot being last in pi's order", () => {
  const names = PROVIDER_KEY_NAMES.anthropic;
  const f = fixture();
  // Every assignment of the three variables to the .env and this console's environment, judged by the rule before issue
  // #1068: any of them in the environment, or a variable other than the slot in the .env, shadowed the row.
  for (let mask = 0; mask < 64; mask += 1) {
    const file = names.filter((_, n) => mask & (1 << n));
    const env = Object.fromEntries(names.filter((_, n) => mask & (8 << n)).map(name => [name, SECRET]));
    fs.writeFileSync(join(f.dir, ".env"), `PI_SETTINGS_FILE=settings.json\n${file.map(name => `${name}=${SECRET}\n`).join("")}`, { mode: 0o600 });
    const row = f.read({ env }).rows.find(r => r.provider === "anthropic");
    const shadowed = Object.keys(env).length > 0 || file.some(name => name !== "ANTHROPIC_API_KEY");
    const hasKey = file.includes("ANTHROPIC_API_KEY");
    const expected = shadowed ? { status: "shadowed", source: "shadowed", reason: "source-shadowed", mode: null, present: hasKey, fallbackKey: undefined }
      : hasKey ? { status: "configured", source: "deployment-env", reason: null, mode: "replace", present: true, fallbackKey: undefined }
        : { status: "missing", source: "missing", reason: "pi-fallback-possible", mode: "add", present: false, fallbackKey: undefined };
    assert.deepEqual(outcome(row), expected, `file: ${file.join(",") || "none"}; environment: ${Object.keys(env).join(",") || "none"}`);
    assert.equal(Object.hasOwn(row, "fallbackKey"), false);
  }
});

test("issue #1068: the projection keeps a fallback only as a variable pi reads after that row's slot, and Add on a configured row only with one", () => {
  const row = { provider: "qwen-token-plan", usage: ["default"], present: false, source: "fallback-key", status: "configured", mode: "add", reason: "fallback-key", fallbackKey: "QWEN_TOKEN_PLAN_API_KEY" };
  const view = rows => providerInventoryView({ state: "ready", defaultProvider: "qwen-token-plan", rows, choices: [] }).rows;
  assert.deepEqual(view([row]), [{ provider: "qwen-token-plan", key: "QWEN_TOKEN_PLAN_TEAM_API_KEY", providers: ["qwen-token-plan"], usage: ["default"], present: false, source: "fallback-key", status: "configured", mode: "add", reason: "fallback-key", fallbackKey: "QWEN_TOKEN_PLAN_API_KEY" }]);
  for (const [label, forged] of [
    ["the slot itself", { fallbackKey: "QWEN_TOKEN_PLAN_TEAM_API_KEY" }],
    ["another provider's variable", { fallbackKey: "QWEN_TOKEN_PLAN_CN_API_KEY" }],
    ["a name pi never reads", { fallbackKey: "PATH" }],
    ["a value in the name's place", { fallbackKey: SECRET }],
    ["no name", { fallbackKey: undefined }],
    ["a provider pi reads no fallback for", { provider: "anthropic", fallbackKey: "ANTHROPIC_AUTH_TOKEN" }],
  ]) {
    const [got] = view([{ ...row, ...forged }]);
    assert.equal(got.source, "unknown", label);
    assert.equal(got.mode, null, `${label}: a configured row offers Add only where pi reads a fallback in the slot's place`);
    assert.equal(Object.hasOwn(got, "fallbackKey"), false, label);
    assert.equal(got.reason, null, `${label}: no sentence about a shared variable pi does not read here`);
  }
  const [other] = view([{ ...row, source: "deployment-env" }]);
  assert.equal(Object.hasOwn(other, "fallbackKey"), false, "a fallback name rides only on a fallback row");
  assert.equal(other.reason, null, "and so does its reason");
  const [anthropic] = view([{ provider: "anthropic", usage: ["default"], present: true, source: "deployment-env", status: "configured", mode: "replace", reason: "fallback-key" }]);
  assert.equal(anthropic.reason, null, "an Anthropic row never says a shared variable stands in for its slot");
  assert.equal(providerKeyReasonParts(anthropic), null);
  assert.equal(view([{ ...row, present: true }])[0].mode, null, "a present slot is never Add");
  assert.deepEqual(providerKeyReasonParts({ ...row, fallbackKey: undefined }), [PROVIDER_KEY_REASONS["fallback-key"]], "without the names the sentence is the vocabulary's own");
  assert.deepEqual(providerKeyReasonParts({ reason: "source-shadowed" }), [PROVIDER_KEY_REASONS["source-shadowed"]]);
  assert.deepEqual(providerKeyReasonParts(view([row])[0], name => `<${name}>`).filter((_, n) => n % 2 === 1), ["<QWEN_TOKEN_PLAN_API_KEY>", "<QWEN_TOKEN_PLAN_TEAM_API_KEY>", "<QWEN_TOKEN_PLAN_API_KEY>"], "each name, and only a name, goes through the caller's setting");
  assert.equal(providerKeyReasonParts({ reason: "invented" }), null);
});
