/** #774: actual application HTTP, authentication, audit and confirmation; only local host execution is injected. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { readTokensFile, findToken } from "@edgehero/pi-dispatch/console-tokens";
import * as cookies from "../../src/console/sessions.mjs";
import { makeConfirmTickets } from "../../src/console/confirm.mjs";
import { makeLoginLimiter } from "../../src/console/guards.mjs";
import { consumeLoginCode, loginCodesDir } from "../../src/console/login-codes.mjs";
import { makeLiveHub } from "../../src/console/live.mjs";
import * as pages from "../../src/console/pages.mjs";
import { createConsoleServer } from "../../src/console/server.mjs";
import { makeSetupActions } from "../../src/setup-actions.mjs";
import * as rm from "../../src/read-model.mjs";
import * as plans from "../../src/write-plans.mjs";
import { setupFixture, SETUP_AT } from "./setup-goldens.mjs";

export const SETUP_BROWSER_TOKENS = Object.freeze({ operator: `pdc_${"o".repeat(43)}`, viewer: `pdc_${"v".repeat(43)}`, agent: `pdc_${"a".repeat(43)}` });
export async function startSetupBrowserFixture(dir, { readOnly = false, enabled = true } = {}) {
  let at = SETUP_AT, ticks = true;
  const now = () => at;
  const paths = { triggersPath: join(dir, "triggers.json"), tokensPath: join(dir, "console-tokens.json"), logsDir: join(dir, "logs") };
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [] }), { mode: 0o600 });
  writeFileSync(join(dir, ".env"), "PI_PROVIDER=anthropic\n", { mode: 0o600 });
  writeFileSync(paths.tokensPath, JSON.stringify({ version: 1, generation: 0, tokens: Object.entries(SETUP_BROWSER_TOKENS).map(([role, token]) => ({ name: role, role, sha256: createHash("sha256").update(token).digest("hex"), createdAt: new Date(at).toISOString() })) }), { mode: 0o600 });
  const snapshot = setupFixture(), effects = [], logs = [];
  const sessions = cookies.makeSessionStore({ now });
  const readTokens = () => readTokensFile({ path: paths.tokensPath });
  const digest = () => createHash("sha256").update(readFileSync(join(dir, ".env"))).digest("hex");
  const readyWorker = () => { snapshot.hostBudgets = [{ name: "build3", ttlAgeMs: 1000 }]; };
  const broker = {
    async preview(action) {
      const component = action.includes("worker") ? "worker" : action.includes("receiver") ? "receiver" : action === "setup-egress-start" ? "egress" : action === "setup-provider-key" ? "provider" : "doctor";
      return { state: "planned", reason: "ready", plan: { component, digest: digest(), manager: "systemd", host: "build3", account: "deployment-account", effects: [component === "provider" ? "write-provider-key" : component === "doctor" ? "publish-doctor" : component === "egress" ? "start-proxy" : `${action.endsWith("stop") ? "stop" : action.endsWith("restart") ? "restart" : "start"}-${component}`], ...(component === "provider" ? { provider: "anthropic", key: "ANTHROPIC_API_KEY" } : {}) } };
    },
    async apply(action, request) {
      if (request.expected !== digest()) return { state: "refused", reason: "plan-stale" };
      effects.push(action);
      if (action === "setup-provider-key") writeFileSync(join(dir, ".env"), `PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=${request.input.value}\n`, { mode: 0o600 });
      if (action === "setup-doctor") snapshot.doctor.hosts[0].checks.forEach(check => { check.level = "ok"; });
      return { state: "applied", reason: "ready" };
    },
  };
  const setup = makeSetupActions({ deployment: dir, enabled, broker, provider: "anthropic", tokensPath: paths.tokensPath, sessions, readTokens, now, readExposure: async () => ({ complete: true, at, identity: "fixture-empty", lines: ["Observed now: zero manual queued jobs, zero armed schedules. Future arrivals still pass normal job admission.", "Estimated reserve: 0 USD for jobs currently in line; future work may spend."] }) });
  const fleet = { snapshot: async () => { snapshot.hostsReadAt = at; return snapshot; }, parkedCount: async () => 0 };
  const pageDeps = { fleet, now, paths, deployment: { folder: "pi-dispatch" }, setup: ({ role, snapshot }) => ({ ...setup.state(role ?? "operator", snapshot), allowlistCount: 12 }), triggerEditor: () => ({ forges: ["github"], defaults: { backend: "local" }, backends: [], flows: ["fix", "tidy"] }) };
  const config = { dir, tokensPath: paths.tokensPath, allowedHosts: [], readOnly, maxMs: 43200000, idleMs: 3600000, maxStreams: 4, logsDir: paths.logsDir };
  const hub = makeLiveHub({ timers: { setInterval: (fn, ms) => setInterval(() => { if (ticks) fn(); }, ms), clearInterval }, now, loadPageData: (page, query, who) => pages.loadPageData(page, query, pageDeps, who), pagePanels: pages.pagePanels, queryKeyOf: pages.pageQueryString, dataQueryOf: pages.dataQueryOf, peekSession: (id, file) => sessions.peek(id, file), endedReason: (id, file) => sessions.verdict(id, file).ended ?? null, readTokens, readOnly });
  const server = createConsoleServer({ config, now, sessions, cookies, tickets: makeConfirmTickets({ now }), limiter: makeLoginLimiter({ now }), audit: makeConsoleAudit({ logsDir: paths.logsDir, now }), readTokens, findToken,
    consumeLoginCode: code => consumeLoginCode({ dir: loginCodesDir(paths.tokensPath), code, now }), hub, pageDeps, actionDeps: { setup, paths, rm, plans, env: { PI_BACKENDS: "local" } }, log: line => logs.push(line) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, config, paths, snapshot, setup, effects, logs, readyWorker, keyFile: () => readFileSync(join(dir, ".env"), "utf8"), document: () => JSON.parse(readFileSync(paths.triggersPath, "utf8")),
    async refresh(ms = 3000) { at += ms; await hub.tick(); }, pauseTicks() { ticks = false; },
    async close() { hub.close(); setup.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
