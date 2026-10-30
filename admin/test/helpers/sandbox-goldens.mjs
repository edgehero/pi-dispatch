import { NOW } from "../../../launch/fixture-deployment.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
const HOUR = 3600000;
export const SANDBOX_HOSTS_FIXTURE = { version: 1, hosts: {
  mini1: { target: "ops@mini1", deployment: "/srv/pi", nodePath: "/usr/bin/node", cliPath: "/srv/pi/node_modules/@edgehero/pi-dispatch/src/cli.mjs" },
  build3: { target: "pdjob@build3", deployment: "/home/pdjob/pi", nodePath: "/usr/bin/node", cliPath: "/home/pdjob/pi/node_modules/@edgehero/pi-dispatch/src/cli.mjs" },
} };
export function sandboxFixture(now = NOW) {
  const settings = { image: "pi-job:4.3.1", defaultBackend: "local", backends: ["local"], egress: true, egressProxy: "pi-dispatch-egress-proxy", sandboxRetentionHours: 24, sandboxPinDays: 7 };
  return { hosts: [
    { name: "mini1", at: now, ageMs: 0, stale: false, unreadable: false, more: 0, retentionHours: 24, settings, rows: [
      { id: "gh-9575", v: "local", until: now + 23 * HOUR, pin: false, generation: "a".repeat(64), kind: "github", image: "pi-job:4.3.1", canOpen: true },
      { id: "sb-" + "c".repeat(32), v: "local", until: now + 24 * HOUR, pin: false, generation: "b".repeat(64), prepared: true, kind: "github", canOpen: true },
    ] },
    { name: "build3", at: now, ageMs: 0, stale: false, unreadable: false, more: 0, retentionHours: 72, settings: { ...settings, defaultBackend: "podman", backends: ["podman"], sandboxRetentionHours: 72, sandboxPinDays: 14 }, rows: [{ id: "gh-ebd7", v: "podman", until: now + 13 * 24 * HOUR, pin: true, generation: "d".repeat(64), kind: "github", canOpen: true }] },
  ], sessions: [{ host: "mini1", id: "gh-9575", nonce: "1".repeat(32), containerId: "2".repeat(64), venue: "local", by: "ops", since: now - 19 * 60000, at: now }], sessionsUnavailable: false,
    options: [{ index: 2, repository: null, label: "trigger 3, comment, github, flow fix" }, { index: 1, repository: null, label: "trigger 2, label, github, flow triage" }],
    selected: { repo: "acme/web", index: 2, ref: "HEAD", host: "mini1", pin: false },
    plan: { host: "mini1", repo: "acme/web", ref: "HEAD", triggerIndex: 2, image: "pi-job:4.3.1", backend: "local", size: { memMiB: 2048, cpuCenti: 100, source: "default" }, egress: { armed: true, proxy: "pi-dispatch-egress-proxy" }, retentionHours: 24, pin: false, pinDays: 7, project: "web" },
  };
}
async function draw({ role = "operator", readOnly = false, change = () => {}, unavailable = false, query = "id=gh-9575&host=mini1" } = {}) {
  const parsed = parsePageQuery("sandboxes", query);
  if (parsed.refusal) throw new Error(parsed.refusal);
  const report = sandboxFixture(); change(report);
  const deps = { now: () => NOW, fleet: { parkedCount: async () => 1 }, sandboxes: { hosts: () => ({ config: SANDBOX_HOSTS_FIXTURE }), read: async () => unavailable ? null : report } };
  const data = await loadPageData("sandboxes", parsed.query, deps, { role, readOnly });
  return String((await renderPage("sandboxes", { data, query: parsed.query, session: { role, name: role === "operator" ? "ops" : "watcher" }, readOnly })).html);
}
export const SANDBOX_DRAW = Object.freeze({
  "sandboxes-populated.operator": () => draw(),
  "sandboxes-denied.viewer": () => draw({ role: "viewer" }),
  "sandboxes-readonly.operator": () => draw({ readOnly: true }),
  "sandboxes-empty.operator": () => draw({ change: (r) => { r.hosts = []; r.sessions = []; r.plan = null; } }),
  "sandboxes-unavailable.operator": () => draw({ unavailable: true }),
  "sandboxes-stale.operator": () => draw({ change: (r) => { r.hosts[1].stale = true; r.hosts[1].more = 128; r.hosts[0].unreadable = true; r.sessionsUnavailable = true; } }),
  "sandboxes-cleanup-notices.operator": () => draw({ change: (r) => { r.notices = ["network-kept", "network-cleanup-failed", "runtime-unreadable"].map((reason, i) => ({ host: "mini1", id: `gh-cleanup-${i}`, at: NOW, reason })); r.noticesUnavailable = true; r.sessionsMore = 12; r.sessionsUnreadable = 2; r.more = 3; } }),
  "sandboxes-unsupported.operator": () => draw({ change: (r) => { r.hosts[0].rows[0].v = "openshell-bind"; r.hosts[0].rows[0].canOpen = false; r.plan = null; r.refusal = "The trigger's venue has no sandbox shell. Choose a local or podman trigger."; } }),
  "sandboxes-past-window.operator": () => draw({ change: (r) => { r.hosts[0].rows[0].until = NOW - HOUR; } }),
  ...Object.fromEntries(["pending", "preparing", "ready", "refused", "failed", "unknown"].map((state) => [`sandboxes-request-${state}.operator`, () => draw({ change: (r) => { r.request = { id: "sb-" + "c".repeat(32), host: "mini1", state, ...(state === "ready" ? { result: { id: "sb-" + "c".repeat(32), host: "mini1", backend: "local", until: NOW + 24 * HOUR, pinned: false } } : state === "refused" ? { message: "The host's image, size, venue, egress or retention changed; preview the sandbox again." } : {}) }; } })])),
  "sandboxes-long-names.operator": () => draw({ change: (r) => { r.selected.repo = "owner/" + "repository-with-a-long-name-".repeat(5); r.options[0].label = "trigger 3, a long trigger description that should wrap without hiding the action"; r.hosts[0].rows[0].id = "gh-" + "a".repeat(190); } }),
});
export const SANDBOX_PANEL_STATES = Object.freeze(Object.keys(SANDBOX_DRAW));
