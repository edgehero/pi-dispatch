/** Actual console HTTP/CSP/session/action fixture; only the host work is injected, and every effect is observable. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { findToken } from "@edgehero/pi-dispatch/console-tokens";
import * as cookies from "../../src/console/sessions.mjs";
import { makeConfirmTickets } from "../../src/console/confirm.mjs";
import { makeLoginLimiter } from "../../src/console/guards.mjs";
import { makeLiveHub } from "../../src/console/live.mjs";
import * as pages from "../../src/console/pages.mjs";
import { createConsoleServer } from "../../src/console/server.mjs";
import { makeSandboxService } from "../../src/sandbox-data.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { sandboxFixture, SANDBOX_HOSTS_FIXTURE } from "./sandbox-goldens.mjs";
import { FLEET_CARD_SNAPSHOT } from "./fleet-goldens.mjs";
export const SANDBOX_BROWSER_TOKENS = Object.freeze({ operator: `pdc_${"o".repeat(43)}`, viewer: `pdc_${"v".repeat(43)}` });
export async function startSandboxBrowserFixture(dir, { readOnly = false } = {}) {
  let clock = NOW;
  let automaticTicks = true;
  const now = () => clock, logsDir = join(dir, "logs"); mkdirSync(logsDir, { recursive: true });
  const paths = { triggersPath: join(dir, "triggers.json"), projectsPath: join(dir, "projects.json"), scopedLimitsPath: join(dir, "limits.json"), logsDir };
  const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  json(paths.triggersPath, { triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }] });
  json(paths.projectsPath, { version: 1, projects: [] }); json(paths.scopedLimitsPath, { version: 1, limits: [] });
  json(join(dir, "sandbox-hosts.json"), SANDBOX_HOSTS_FIXTURE);
  const effects = { queued: [], ended: [], logs: [] }, inventory = sandboxFixture(NOW), requests = new Map();
  const fleet = {
    snapshot: async () => FLEET_CARD_SNAPSHOT(), parkedCount: async () => 1, runsPage: async () => ({ runs: [], next: null }),
    runById: async (jobId) => ({ source: "local", record: { jobId, host: "mini1", backend: "local", kind: "github", target: "acme/web#490", flow: "fix", outcome: "completed", startedAt: new Date(NOW - 3600000).toISOString(), endedAt: new Date(NOW - 1800000).toISOString() } }),
    sandboxInventory: async () => ({ hosts: structuredClone(inventory.hosts), more: inventory.more ?? 0 }),
    sandboxSessions: async () => structuredClone({ sessions: inventory.sessions, notices: inventory.notices, noticesUnavailable: inventory.noticesUnavailable, more: inventory.sessionsMore, unreadable: inventory.sessionsUnreadable }),
    sandboxPrepare: async (request) => {
      const id = request.id ?? `sb-${String(effects.queued.length + 1).padStart(32, "0")}`;
      effects.queued.push({ ...request, id });
      requests.set(id, { id, host: request.host, state: "ready", result: { id: request.op === "pin" ? request.runId : id, host: request.host, until: NOW + 24 * 3600000, pinned: Boolean(request.pin), backend: "local" } });
      return { id, state: "pending" };
    },
    sandboxPreparationStatus: async (host, id) => requests.get(id) ?? { host, id, state: "unknown" },
    sandboxEnd: async (request) => { effects.ended.push(request); clock += 6000; inventory.sessions = inventory.sessions.filter((s) => s.nonce !== request.nonce); return { ended: true }; },
  };
  const service = makeSandboxService({ paths, deploymentDir: dir, fleet, now });
  const file = { version: 1, generation: 0, tokens: Object.entries(SANDBOX_BROWSER_TOKENS).map(([role, token]) => ({ name: role === "operator" ? "ops" : "watcher", role, sha256: createHash("sha256").update(token).digest("hex"), createdAt: new Date(NOW).toISOString() })) };
  const config = { dir, allowedHosts: [], readOnly, maxMs: 43200000, idleMs: 3600000, maxStreams: 4, logsDir };
  const sessions = cookies.makeSessionStore({ now });
  const pageDeps = { now, fleet, sandboxes: service };
  const timers = { setInterval: (fn, ms) => setInterval(() => { if (automaticTicks) fn(); }, ms), clearInterval };
  const hub = makeLiveHub({ timers, loadPageData: (page, query, who) => pages.loadPageData(page, query, pageDeps, who), pagePanels: (page, ctx) => pages.pagePanels(page, ctx), queryKeyOf: pages.pageQueryString, dataQueryOf: pages.dataQueryOf, peekSession: (id, file) => sessions.peek(id, file), endedReason: (id, file) => sessions.verdict(id, file).ended ?? null, readTokens: () => ({ file }), readOnly, now });
  const server = createConsoleServer({ config, now, sessions, cookies, tickets: makeConfirmTickets({ now }), limiter: makeLoginLimiter({ now }), audit: makeConsoleAudit({ logsDir, now }), readTokens: () => ({ file }), findToken,
    hub, pageDeps, actionDeps: { sandboxes: service }, log: (line) => effects.logs.push(line) });
  const responseGates = new Set();
  // A native navigation commits its URL before its document has parsed the panels. Keep the actual response
  // bytes and headers, but expose that interval deterministically instead of relying on the runner's speed.
  const holdWorkspaceDocument = (id) => {
    let releaseBody, released = false, startedResolve, startedReject;
    const started = new Promise((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
    started.catch(() => {}); // The DOM wait comes first; the original promise still rejects when awaited.
    const release = () => {
      released = true; server.removeListener("request", hold);
      releaseBody?.(); responseGates.delete(release);
    };
    const hold = (req, res) => {
      const url = new URL(req.url, "http://console.invalid");
      if (req.method !== "GET" || url.pathname !== "/runs/sandboxes" || url.searchParams.get("id") !== id) return;
      server.removeListener("request", hold);
      const end = res.end.bind(res);
      res.end = (body, ...args) => {
        res.end = end;
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const bodyAt = bytes.indexOf(Buffer.from("<body"));
        const split = bytes.indexOf(Buffer.from(">"), bodyAt) + 1;
        if (bodyAt < 0 || split <= bodyAt) {
          startedReject(new Error("workspace response has no document body"));
          end(bytes, ...args); return res;
        }
        releaseBody = () => { releaseBody = null; end(bytes.subarray(split), ...args); };
        res.write(bytes.subarray(0, split));
        startedResolve({ status: res.statusCode, csp: res.getHeader("content-security-policy") });
        if (released) releaseBody();
        return res;
      };
    };
    responseGates.add(release); server.prependListener("request", hold);
    return { started, release };
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, config, service, effects, inventory, requests, holdWorkspaceDocument, advance: () => { clock += 6000; }, liveSize: hub.size, refresh: async () => { clock += 6000; await hub.tick(); }, pauseTicks: async () => { automaticTicks = false; await hub.tick(); }, origin: `http://127.0.0.1:${server.address().port}`, async close() { for (const release of responseGates) release(); hub.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
