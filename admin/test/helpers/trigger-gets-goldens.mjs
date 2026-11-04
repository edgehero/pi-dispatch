/**
 * The goldens for what a trigger's jobs get (issue #800, the TriggerEnvironment card): each state drawn by the real page, over the real
 * triggers file read through its one read and records built the way the worker builds them. The shared fixture deployment
 * (`launch/fixture-deployment.mjs`) sets `"packages": false` on every trigger and has no `run.progress` on trigger 3, so it cannot
 * produce this card's story; the file here is its own, and a golden of the state the script makes is the server's page with exactly
 * that done, each step asserted to apply once (`panel-goldens.mjs`' rule), which `console-client-states.test.mjs` holds to the script.
 */
import assert from "node:assert/strict";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { HOST_LOADS, LOADED_SAMPLES as S, LONG_LOADED, longNamesRecord } from "./loaded-samples.mjs";

const OPERATOR = Object.freeze({ name: "ops", role: "operator" });
const VIEWER = Object.freeze({ name: "watcher", role: "viewer" });
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Where the file is, as the page and the planner read it. Fixed, because a diff in a golden names it by its last part. */
export const TRIGGER_GETS_PATH = "/deployment/triggers.json";

/** Trigger 3 as the card tells it: the comment trigger that runs fix, with nothing narrowed and `run.progress` on. */
export const GETS_ENTRY = Object.freeze({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", progress: true, statusComment: true, resume: true } });

/** A triggers file holding `entry` as row 3, with two rows above it, in the bytes the writer writes. */
export function getsFile(entry = GETS_ENTRY) {
  const doc = { triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } }, { on: { type: "label", any: ["frontend"] }, run: { kind: "github", flow: "frontend-fix" } }, entry] };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A real watch rule as row 3 of a file the worker loads, with the source it needs. */
export const watchRuleFile = (run) => `${JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } }, triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } }, { on: { type: "label", any: ["frontend"] }, run: { kind: "github", flow: "frontend-fix" } }, { on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service", "error.type"], window: "10m", cooldown: "6h", maxPerDay: 4 }, run }] }, null, 2)}\n`;
/** A real investigating rule, and what a host publishes that no job of it loads. */
export const WATCH_INVESTIGATE = Object.freeze({ kind: "local", folder: "/srv/web", flow: "triage", task: "Look at it.", maxCostUsd: "1", image: "pi-job:4.3.1" });

/** A file system holding one file, with what a read of it and the dry run need. */
export function fileOnlyFs(text, { path = TRIGGER_GETS_PATH } = {}) {
  return { readFileSync: (asked) => { if (asked !== path) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return text; }, existsSync: (asked) => asked === path };
}

/**
 * What the worker's pickup check reads on the host the planner runs on, for a preview that adds linear: the overlay's `mcp.json`, and a host
 * that forwards the key it uses. Without them the check refuses the change, as it would refuse every job.
 */
export const GETS_MCP_JSON = Object.freeze({ mcpServers: { linear: { url: "https://mcp.example.com/mcp", description: "Linear", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } } } });
export const GETS_HOST_ENV = Object.freeze({ PI_EGRESS: "0", PI_FORWARD_ENV: "LINEAR_API_KEY", LINEAR_API_KEY: "a value" });

const HOSTS_BEATING = Object.freeze([{ name: "build3" }, { name: "mini1" }, { name: "mini2" }]);
const LINEAR = Object.freeze({ name: "linear", transport: "http", where: "mcp.example.com", exposure: "codemode", enabled: true, keys: ["LINEAR_API_KEY"] });
const DOCS_OFF = Object.freeze({ name: "docs", transport: "stdio", where: "docs-mcp", exposure: "deferred", enabled: false, keys: [] });

/** What each host published, as `readHostLoadsView` hands it, each row laid over `HOST_LOADS`' own. */
function hostLoads(over = {}) {
  return { more: 0, hosts: HOST_LOADS.hosts.map((row) => ({ ...row, ...(over[row.name] ?? {}) })) };
}
const SERVERS = Object.freeze({ mini1: { mcp: [LINEAR, DOCS_OFF] }, build3: { mcp: [LINEAR] } });
const FLOW_ROW = (tier) => ({ flows: [{ trigger: 2, flow: "fix", tier, package: null, repo: "unknown" }] });
/** What the hosts published in the card's story: both servers on mini1, one on build3, and each doctor's answer for the flow. */
export const getsHostLoads = () => hostLoads({ mini1: { ...SERVERS.mini1, ...FLOW_ROW("unknown") }, build3: { ...SERVERS.build3, ...FLOW_ROW("unknown") } });
/** What the card quotes: gh-9575 on mini1, with the refused gh-e9a0 after it. Newest first. */
const RUNS = () => [S.refused(), S.everything()];

const EDITOR = Object.freeze({ backends: [{ name: "local", serves: { liveTranscript: "yes", steering: "yes", recovery: "yes", sandboxShell: "yes" } }], forges: ["github"], flows: [{ name: "fix", tier: "repository" }, { name: "review", tier: "overlay" }, { name: "run-tests", tier: "packages" }], defaults: { backend: "local", maxTurns: 30, provider: "anthropic", model: "claude-sonnet-5-5", maxCostUsd: "2", models: "unrestricted" } });
const PRICED = Object.freeze(["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5", "kimi-coding/kimi-for-coding"]);

/**
 * The page. `records` are the trigger's runs in any order, each its own. Everything else the page reads is what `cli.mjs` wires, over
 * a file of one trigger and a snapshot that holds the same file's display: the card reads the file, and the rest of the page the snapshot.
 */
export async function triggerGetsPage({ role = "operator", readOnly = false, entry = GETS_ENTRY, records = RUNS(), loads = getsHostLoads(), live = HOSTS_BEATING, deps = {}, text = null } = {}) {
  const file = text ?? getsFile(entry);
  const fs = fileOnlyFs(file);
  const { readTriggers } = await import("../../src/read-model.mjs");
  const triggers = readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs });
  const snapshot = { readAt: NOW, triggers, runs: records, waiting: { rows: [] }, schedulers: [], settings: { overlay: {} }, hostBudgets: live, overlayMcp: { servers: [], refused: [], unreadable: null } };
  const parsed = parsePageQuery("trigger", "index=2");
  const data = await loadPageData("trigger", parsed.query, { now: () => NOW, env: {}, paths: { triggersPath: TRIGGER_GETS_PATH }, fs, fleet: { snapshot: async () => snapshot, parkedCount: async () => 0 }, hostLoads: async () => loads, triggerEditor: () => EDITOR, pricedModels: () => PRICED, ...deps }, { role, readOnly });
  return String((await renderPage("trigger", { query: parsed.query, session: role === "viewer" ? VIEWER : OPERATOR, data, readOnly, theme: null })).html);
}

/** `page` with the one `from` replaced by `to`: a `from` found any other number of times fails the golden. */
function once(page, from, to, what) {
  const n = page.split(from).length - 1;
  assert.equal(n, 1, `${what}: the page holds ${JSON.stringify(from.slice(0, 100))} exactly once (it holds it ${n} times)`);
  return page.replace(from, () => to);
}

/**
 * What the script leaves after a person changes these (`script.mjs` `getsRefresh`): each switch moved and marked, and the bar shown with its
 * count and words, the server's own, from the control's `data-gets-*`. A checkbox a browser shows moved is drawn moved.
 */
export function asChanged(page, changes) {
  let out = page;
  const words = [];
  for (const { value, list = null, flag = null, on } of changes) {
    const attr = flag === null ? `data-gets-list="${list}" data-gets-value="${value}"` : `data-gets-flag="${flag}"`;
    const tag = new RegExp(`<input type="checkbox"( checked)? ${attr}([^>]*)>`).exec(out);
    assert.ok(tag, `the page draws ${attr}`);
    const word = new RegExp(`data-gets-${on ? "on" : "off"}="([^"]*)"`).exec(tag[0])[1];
    words.push(word);
    const moved = on ? tag[0].replace('type="checkbox"', 'type="checkbox" checked') : tag[0].replace(" checked", "");
    out = once(out, tag[0], moved, attr);
    // A switch in a row shows the row marked. A chip says so only in the bar.
    const before = out.slice(0, out.indexOf(moved));
    const label = before.lastIndexOf("<label ");
    if (before.slice(label).startsWith('<label class="te-item" data-gets-item>')) {
      const head = out.slice(0, label);
      let tail = out.slice(label);
      tail = tail.replace('<label class="te-item" data-gets-item>', '<label class="te-item te-changed" data-gets-item>').replace('<span class="te-pend" hidden>', '<span class="te-pend">');
      out = head + tail;
    }
  }
  const one = words.length === 1;
  out = once(out, '<div class="te-bar" role="status" data-gets-bar hidden>', '<div class="te-bar" role="status" data-gets-bar>', "the bar");
  out = once(out, 'data-many="{n} changes, not written yet:"></b>', `data-many="{n} changes, not written yet:">${one ? "1 change, not written yet:" : `${words.length} changes, not written yet:`}</b>`, "the bar's count");
  out = once(out, "<span data-gets-words></span>", `<span data-gets-words>${words.join(", ")}.</span>`, "the bar's words");
  return out;
}

/** The changes the card's bar draws: linear on, and bash off. */
export const GETS_CHANGES = Object.freeze([{ list: "mcp", value: "linear", on: true }, { list: "excludeTools", value: "bash", on: false }]);
/** One extension left out, and one of an extension's tools removed, each alone. */
export const GETS_EXTENSION_OFF = Object.freeze([{ list: "excludeExtensions", value: "pi-lint", on: false }]);
export const GETS_TOOL_OFF = Object.freeze([{ list: "excludeExtensionTools", value: "lint_file", on: false }]);

/** The longest names the card draws, for the width check, which can only see a name a golden holds. */
function longNames() {
  const { host, overlay, package: pkg, image } = LONG_LOADED;
  const row = { state: "current", at: NOW - HOUR, ageMs: HOUR, every: 24, by: { uid: 1000, worker: true }, overlayExtensionsAllowed: true, skills: [overlay], flows: [{ trigger: 2, flow: "fix", tier: "package", package: pkg, repo: "unknown" }], unread: [], more: {}, image, piVersion: "1.5.0" };
  // Each name the longest the loader takes, so what the card draws of it is also what the worker reads.
  const server = { name: `${"linear-".repeat(4)}abcd`, transport: "http", where: `${"mcp.".repeat(12)}example.com`, exposure: "codemode", enabled: true, keys: [`${"LINEAR_".repeat(7)}KEY`] };
  const loads = { more: 0, hosts: [{ ...row, name: host, extensions: [{ name: overlay, kind: "file" }], packages: [{ name: pkg, version: "1.4.2" }], mcp: [server] }, { ...row, name: "mini1", extensions: [], packages: [], mcp: [], flows: [] }] };
  const entry = { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", provider: "anthropic", model: `${"claude-sonnet-".repeat(4)}5`, models: [`anthropic/${"claude-sonnet-".repeat(4)}5`, `kimi-coding/${"kimi-for-coding-".repeat(3)}kimi-for-coding1`], fallbackModels: [`kimi-coding/${"kimi-for-coding-".repeat(3)}kimi-for-coding1`], maxCostUsd: "1.5", mcp: [server.name], image } };
  const records = [longNamesRecord()];
  return { loads, entry, records, live: [{ name: host }, { name: "mini1" }] };
}

const UNKNOWN_ALL = Object.freeze({ more: 0, hosts: [{ name: "build3", state: "unknown", why: "absent" }, { name: "mini1", state: "unknown", why: "unreadable" }, { name: "mini2", state: "old", at: NOW - 30 * 24 * HOUR, ageMs: 30 * 24 * HOUR, every: 24, by: { uid: 1000, worker: true }, overlayExtensionsAllowed: true, extensions: [], skills: [], mcp: [], packages: [], flows: [], unread: [], more: {} }] });

/** A schedule whose folder is on each host and holds no such flow: what doctor publishes when no tier does, before any run has paid to show it. */
const FLOW_ABSENT = Object.freeze({
  entry: { on: { type: "cron", id: "web-fix", pattern: "0 9 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "fix", task: "Run it." } },
  records: [],
  loads: hostLoads({ mini1: { flows: [{ trigger: 2, flow: "fix", tier: "none", package: null, repo: "absent" }] }, build3: { flows: [{ trigger: 2, flow: "fix", tier: "none", package: null, repo: "absent" }] } }),
});

export const TRIGGER_GETS_DRAW = Object.freeze({
  "trigger-gets.operator": () => triggerGetsPage(),
  "trigger-gets.viewer": () => triggerGetsPage({ role: "viewer" }),
  "trigger-gets-changed.operator": async () => asChanged(await triggerGetsPage(), GETS_CHANGES),
  "trigger-gets-one-extension-off.operator": async () => asChanged(await triggerGetsPage(), GETS_EXTENSION_OFF),
  "trigger-gets-extension-tool-off.operator": async () => asChanged(await triggerGetsPage(), GETS_TOOL_OFF),
  "trigger-gets-host-lacks.operator": () => triggerGetsPage({ entry: { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, mcp: ["docs"] } } }),
  "trigger-gets-no-flow.operator": () => triggerGetsPage({ records: [S.noFlow()], loads: hostLoads({ mini1: { ...FLOW_ROW("unknown") }, build3: { ...FLOW_ROW("unknown") } }) }),
  "trigger-gets-no-run.operator": () => triggerGetsPage({ records: [] }),
  "trigger-gets-flow-absent.operator": () => triggerGetsPage(FLOW_ABSENT),
  "trigger-gets-unknown-host.operator": () => triggerGetsPage({ loads: UNKNOWN_ALL }),
  "trigger-gets-read-only.operator": () => triggerGetsPage({ readOnly: true }),
  "trigger-gets-long-names.operator": () => triggerGetsPage(longNames()),
  "trigger-gets-watch.operator": () => triggerGetsPage({ text: watchRuleFile(WATCH_INVESTIGATE), records: [] }),
  "trigger-gets-file-refused.operator": () => triggerGetsPage({ text: getsFile({ ...GETS_ENTRY, run: { ...GETS_ENTRY.run, excludeExtensions: ["pi-lint"] } }), records: [] }),
});
export const TRIGGER_GETS_PANEL_STATES = Object.freeze(Object.keys(TRIGGER_GETS_DRAW));
