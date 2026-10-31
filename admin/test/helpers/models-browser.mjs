import { consoleSubscriptionFixture } from "./subscription-auth-fixture.mjs";
import { readConnections } from "../../src/connections-view.mjs";
/** Real Models file/read/write/session integration. Only bounded fixture observations are synthetic (#773). */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { findToken } from "@edgehero/pi-dispatch/console-tokens";
import { makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { buildDoctorRecord, publishDoctorRecord, readDoctorResults } from "@edgehero/pi-dispatch/doctor-results";
import { markModelCooldown } from "../../../worker/src/model-failover.mjs";
import { makeReadModelRoles } from "../../../worker/src/model-roles-file.mjs";
import { resolveModelRoles } from "@edgehero/pi-dispatch/model-roles";
import { parseScopedLimits } from "@edgehero/pi-dispatch/scoped-limits";
import { dollarWindowSpecs } from "../../src/dollar-windows.mjs";
import { readModelsView } from "../../src/models-view.mjs";
import { createModelRoleActions } from "../../src/model-role-plans.mjs";
import * as cookies from "../../src/console/sessions.mjs";
import { makeConfirmTickets } from "../../src/console/confirm.mjs";
import { makeLoginLimiter } from "../../src/console/guards.mjs";
import { createConsoleServer } from "../../src/console/server.mjs";
import * as pages from "../../src/console/pages.mjs";
import * as rm from "../../src/read-model.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";

export const MODELS_BROWSER_TOKENS = Object.freeze({ operator: `pdc_${"o".repeat(43)}`, viewer: `pdc_${"v".repeat(43)}`, agent: `pdc_${"a".repeat(43)}` });
export const MODEL_REFS = Object.freeze({ primary: "anthropic/claude-sonnet-5-5", fallback: "anthropic/claude-haiku-5-5", candidate: "openai/gpt-4o" });

export async function startModelsBrowserFixture(dir, { url = process.env.VALKEY_TEST_URL, readOnly = false, empty = false, longNames = false } = {}) {
  if (!url) throw new Error("The Models browser requires VALKEY_TEST_URL.");
  // Database 14 retains the transcript suite's observations; 11 is empty after its reader tests close.
  const address = new URL(url); address.pathname = "/11";
  const redis = makeRedisClient(address.href); redis.on("error", () => {});
  if ((await redis.keys("*")).length) { redis.disconnect(); throw new Error("Models browser requires empty database 11; nothing was changed."); }
  let server = null;
  try {
    let clock = NOW;
    const now = () => clock;
    const paths = { valkeyUrl: address.href, triggersPath: join(dir, "triggers.json"), projectsFile: join(dir, "projects.json"), settingsFile: join(dir, "settings.json"), scopedLimitsPath: join(dir, "limits.json"), logsDir: join(dir, "logs"), globalPiDir: join(dir, "overlay") };
    mkdirSync(paths.logsDir, { recursive: true }); mkdirSync(paths.globalPiDir, { recursive: true });
    const editorRole = longNames ? "e".repeat(32) : "editor";
    const doc = empty ? { triggers: [] } : {
      modelRoles: { default: { [editorRole]: { model: MODEL_REFS.primary, fallbackModels: [MODEL_REFS.fallback] }, reviewer: MODEL_REFS.primary, explorer: MODEL_REFS.primary }, web: { [editorRole]: MODEL_REFS.candidate } },
      triggers: [
        { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", model: `role:${editorRole}` } },
        { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "review", model: "role:reviewer" } },
        { on: { type: "label", any: ["triage"] }, run: { kind: "github", flow: "triage", model: "role:explorer", models: [MODEL_REFS.primary, MODEL_REFS.fallback], fallbackModels: [MODEL_REFS.fallback] } },
      ],
    };
    const save = value => writeFileSync(paths.triggersPath, `${JSON.stringify(value, null, 2)}\n`);
    save(doc);
    writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
    writeFileSync(paths.settingsFile, '{"maxCostUsd":"1","provider":"anthropic","model":"claude-sonnet-5-5"}');
    const limitDoc = { version: 2, limits: empty ? [] : [{ scope: `model:${MODEL_REFS.primary}`, weekUsd: "80" }] };
    writeFileSync(paths.scopedLimitsPath, JSON.stringify(limitDoc));
    const env = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", PI_MAX_COST_USD: "1", PI_GLOBAL_PI_DIR: paths.globalPiDir };
    const records = new Map();
    const record = (jobId, model, cost, turns, total, extra = {}) => {
      const slash = model.indexOf("/");
      return { jobId, kind: "github", target: "acme/api#42", modelRole: editorRole, flow: "fix", provider: model.slice(0, slash), model: model.slice(slash + 1), host: "models-host", outcome: "completed", startedAt: new Date(NOW - 600000).toISOString(), endedAt: new Date(NOW - 300000).toISOString(), turns, tokens: { metered: true, cost, total }, ...extra };
    };
    if (!empty) {
      const sourceId = longNames ? `gh-${"source".repeat(30)}` : "gh-model-source";
      const canaryId = longNames ? `canary-${"candidate".repeat(20)}` : "canary-models";
      records.set(sourceId, record(sourceId, MODEL_REFS.primary, 0.24, 8, 120000));
      records.set(canaryId, record(canaryId, MODEL_REFS.candidate, 0.06, 10, 140000, { canary: { sourceJobId: sourceId, role: editorRole, candidate: MODEL_REFS.candidate } }));
      records.set("gh-fell-back", record("gh-fell-back", MODEL_REFS.fallback, 0.02, 5, 70000, { modelWhy: "fallback-cooldown", providerFailure: { kind: "rate-limited", resetAt: NOW + 600000 } }));
      for (const value of records.values()) writeFileSync(join(paths.logsDir, `${value.jobId}.json`), JSON.stringify(value));
      await markModelCooldown(redis, MODEL_REFS.primary, { kind: "rate-limited", resetAt: NOW + 600000 }, { now });
      for (const window of dollarWindowSpecs({ caps: {}, limits: parseScopedLimits(JSON.stringify(limitDoc), paths.scopedLimitsPath), now: new Date(NOW) })) await redis.set(window.key, "32460000");
      const doctor = buildDoctorRecord({ checks: [{ ok: true, label: "A newer reviewed candidate is available.", proposal: { kind: "newer-sibling", scope: "default", role: "editor", model: MODEL_REFS.primary, candidate: MODEL_REFS.candidate } }], ids: ["models.1"], at: NOW, version: "4.3.1" });
      await publishDoctorRecord(redis, "models-host", doctor);
    }
    const state = { unavailable: false, partial: false, subscriptionAuth: consoleSubscriptionFixture(NOW) };
    const fleet = {
      async snapshot() {
        return { at: clock, subscriptionAuth: state.subscriptionAuth, queue: { counts: { active: 0, waiting: 0, delayed: empty ? 0 : 1 }, pausedState: false }, queueCounts: [], hostBudgets: [], failed: { rows: [], more: 0 }, parked: [],
          settings: { overlay: JSON.parse(readFileSync(paths.settingsFile, "utf8")) },
          triggers: rm.readTriggers({ triggersPath: paths.triggersPath }),
          recordDetails: new Map(records),
          doctor: await readDoctorResults(redis, { names: ["models-host"], prune: false, now }),
          waiting: { rows: empty ? [] : [{ jobId: "gh-model-wait", queue: "pi-jobs", why: "model-cooldown", known: true }], truncated: false },
        };
      },
      parkedCount: async () => 0,
      runsPage: async () => ({ runs: [...records.values()], next: null, mirror: "off" }),
      runById: async id => records.has(id) ? { source: "local", record: records.get(id) } : { missing: true },
      async dispose() {},
    };
    const modelsView = async snapshot => {
      if (state.unavailable) throw Error("synthetic model observation failure");
      const view = await readModelsView({ paths, env, deploymentDir: dir, now, snapshot, fleet, redis });
      return state.partial ? { ...view, partial: true } : view;
    };
    const modelRoles = createModelRoleActions({ paths, env, now, canarySample: async tuple => (await modelsView()).canaries.find(sample => sample.role === tuple.role && sample.candidate === tuple.candidate && sample.flow === tuple.flow) ?? null });
    const tokens = { version: 1, generation: 0, tokens: Object.entries(MODELS_BROWSER_TOKENS).map(([role, token]) => ({ name: role === "operator" ? "ops" : role, role, sha256: createHash("sha256").update(token).digest("hex"), createdAt: new Date(NOW).toISOString() })) };
    const config = { dir, allowedHosts: [], readOnly, maxMs: 43200000, idleMs: 3600000, maxStreams: 4, logsDir: paths.logsDir };
    const sessions = cookies.makeSessionStore({ now });
    const audit = makeConsoleAudit({ logsDir: paths.logsDir, now });
    const connections = async snapshot => readConnections({ paths, env, deploymentDir: dir, now: now(), snapshot, redis, reads: { environment: () => ({ env: {} }), allowlist: () => [], endpoints: () => [] } });
    const pageDeps = { now, fleet, modelsView, connections, env };
    server = createConsoleServer({ config, now, sessions, cookies, tickets: makeConfirmTickets({ now }), limiter: makeLoginLimiter({ now }), audit, readTokens: () => ({ file: tokens }), findToken, pageDeps, actionDeps: { modelRoles, rm, paths, fleet, env }, log: () => {} });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { origin: `http://127.0.0.1:${server.address().port}`, paths, redis, state, records, tokens, modelsView,
      document: () => JSON.parse(readFileSync(paths.triggersPath, "utf8")), saveDocument: save,
      pickup: (role, project = null) => resolveModelRoles({ provider: "anthropic", model: `role:${role}` }, makeReadModelRoles({ triggersPath: paths.triggersPath })(), project),
      audit: () => readConsoleAudit({ logsDir: paths.logsDir, positions: true }), verifyAudit: () => verifyConsoleAudit({ logsDir: paths.logsDir, withLast: true }),
      advance: ms => { clock += ms; },
      async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); const keys = await redis.keys("*"); if (keys.length) await redis.del(...keys); redis.disconnect(); },
    };
  } catch (error) {
    server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
    const keys = await redis.keys("*").catch(() => []); if (keys.length) await redis.del(...keys); redis.disconnect(); throw error;
  }
}
