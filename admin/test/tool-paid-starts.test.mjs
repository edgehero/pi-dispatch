import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tempDir } from "./helpers/temp-dir.mjs";
import { executeToolAction } from "../src/tool-actions.mjs";
import { planTriggerFire, enqueueTriggerFire } from "../src/trigger-fire.mjs";
import * as rm from "../src/read-model.mjs";

const NOW = Date.UTC(2026, 9, 31, 12);
function fixture() {
  const dir = tempDir("pd-766-paid-tools-");
  const folder = join(dir, "repo");
  mkdirSync(join(folder, ".pi", "skills", "fix"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: folder, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  const skill = join(folder, ".pi", "skills", "fix", "SKILL.md");
  const commitGate = (gate) => { writeFileSync(skill, `---\nname: fix\ndescription: fixture\nai-trigger: ${gate}\n---\nRead only fixture.\n`); git("add", "."); git("commit", "-qm", `gate ${gate}`); };
  commitGate("allow");
  const paths = { triggersPath: join(dir, "triggers.json"), logsDir: dir, valkeyUrl: "redis://unit.invalid", settingsFile: join(dir, "settings.json") };
  writeFileSync(paths.settingsFile, "{}");
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder, flow: "fix", task: "PRIVATE_OPERATOR_TASK" } }] }));
  const rows = [], queued = [], calls = [];
  let count = 0;
  const redisFn = () => ({ get: async () => count, incr: async () => ++count, expire: async () => {}, disconnect() {} });
  const admissionFn = (args) => { calls.push(args.consumeRate); return rm.checkDispatchRun({ ...args, redisFn }); };
  const jobs = new Map();
  const queueFn = () => ({ getJobScheduler: async () => ({ key: "daily" }), close: async () => {}, add: async (_name, data, opts) => { queued.push(data); jobs.set(opts.jobId, { data, timestamp: NOW, getState: async () => "waiting" }); }, getJob: async (id) => jobs.get(id) });
  const fireOptions = { queueFn, parseConnectionFn: () => ({}), admissionFn, redisFn: () => ({ set: async () => "OK", disconnect() {} }) };
  const readModel = { ...rm, checkDispatchRun: admissionFn, planTriggerFire: (args) => planTriggerFire({ ...args, ...fireOptions }), enqueueTriggerFire: (plan, args) => enqueueTriggerFire(plan, { ...args, ...fireOptions }),
    planRerun: async () => ({ plan: { kind: "local", queue: "pi-jobs@host1", sourceRunId: "old", job: { folder, flow: "fix", task: "PRIVATE_OPERATOR_TASK" }, runFields: {}, reserve: null } }),
    enqueueRerun: async (plan) => { queued.push(plan.job); return { ok: true, jobId: "new-local", queue: plan.queue }; },
  };
  const options = { paths, env: { PI_WORKER_NAME: "host1", PI_DISPATCH_RUN_ROOTS: dir, PI_DISPATCH_RUN_PER_HOUR: "100" }, grantsEnv: { PI_DISPATCH_RUN_ROOTS: dir, PI_DISPATCH_RUN_PER_HOUR: "1" }, granted: true, now: () => NOW, readModel, audit: { append: (r) => rows.push(r) }, actor: { name: "fixture", role: "agent", session: null } };
  return { folder, paths, options, rows, queued, calls, commitGate, dirty: () => writeFileSync(join(folder, "untracked"), "changed"), setCount: (n) => { count = n; } };
}
const params = (name) => name === "dispatch_trigger_fire" ? { index: 0 } : { jobId: "old" };
const context = (interactive, beforeConfirm = () => {}) => interactive ? { hasUI: true, ui: { confirm: async () => { beforeConfirm(); return true; } } } : { hasUI: false };

for (const name of ["dispatch_trigger_fire", "dispatch_rerun"]) {
  for (const interactive of [false, true]) {
    test(`${name}: ${interactive ? "interactive" : "headless"} path uses committed HEAD and actual roots, clean-tree and shared hourly gates`, async () => {
      for (const condition of ["outside", "deny", "dirty", "hourly", "missing-hourly", "invalid-hourly"]) {
        const f = fixture();
        const options = { ...f.options, grantsEnv: { ...f.options.grantsEnv } };
        if (condition === "outside") options.grantsEnv.PI_DISPATCH_RUN_ROOTS = tempDir("pd-766-other-root-");
        if (condition === "deny") f.commitGate("deny");
        if (condition === "dirty") f.dirty();
        if (condition === "hourly") f.setCount(1);
        if (condition === "missing-hourly") delete options.grantsEnv.PI_DISPATCH_RUN_PER_HOUR;
        if (condition === "invalid-hourly") options.grantsEnv.PI_DISPATCH_RUN_PER_HOUR = "oops";
        await assert.rejects(executeToolAction(name, params(name), context(interactive), options), condition === "outside" ? /folder not under/ : condition === "deny" ? /not AI-triggerable/ : condition === "dirty" ? /uncommitted changes/ : condition === "hourly" ? /hourly limit/ : /explicit PI_DISPATCH_RUN_ROOTS and PI_DISPATCH_RUN_PER_HOUR/);
        assert.deepEqual(f.queued, [], condition);
        assert.deepEqual(f.rows, [], "free admission refusal precedes write intent");
      }
      const f = fixture();
      const out = await executeToolAction(name, params(name), context(interactive), f.options);
      assert.equal(out.applied, true); assert.equal(out.queue, "pi-jobs@host1");
      assert.equal(f.queued.length, 1); assert.equal(f.calls.filter(Boolean).length, 1, "exactly one paid-start allowance is consumed");
      assert.ok(!JSON.stringify(out).includes("PRIVATE_OPERATOR_TASK"));
      assert.deepEqual(f.rows.map((r) => [r.action, r.actor.role]), [["write", "agent"], ["write-applied", "agent"]]);
    });
  }
  test(`${name}: confirmation cannot authorize a new dirty tree or a newly denied HEAD`, async () => {
    for (const change of [(f) => f.dirty(), (f) => f.commitGate("deny")]) {
      const f = fixture();
      await assert.rejects(executeToolAction(name, params(name), context(true, () => change(f)), f.options), /changed since its preview/);
      assert.deepEqual(f.queued, []); assert.deepEqual(f.rows, []);
    }
  });
}

// The same admission facts through the actual server, real session store and single-use tickets.
import { request } from "node:http";
import { createHash } from "node:crypto";
import { createConsoleServer } from "../src/console/server.mjs";
import { makeSessionStore } from "../src/console/sessions.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { makeConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import * as plans from "../src/write-plans.mjs";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
async function httpAgent(f, t, options = f.options) {
  const token = `pdc_${"a".repeat(43)}`;
  const file = { version: 1, generation: 0, tokens: [{ name: "automation", role: "agent", sha256: sha256(token), createdAt: "2026-10-01T00:00:00.000Z" }] };
  const realAudit = makeConsoleAudit({ logsDir: f.paths.logsDir, now: () => NOW });
  const server = createConsoleServer({ config: { allowedHosts: [], readOnly: false, maxMs: 12 * 3600000, dir: null }, now: () => NOW,
    sessions: makeSessionStore({ now: () => NOW }), tickets: makeConfirmTickets({ now: () => NOW }),
    cookies: { sessionCookie: (id) => `pdc_session=${id}; HttpOnly; SameSite=Strict; Path=/`, clearSessionCookie: () => "pdc_session=; Max-Age=0", readSessionCookie: (header) => /(?:^|;\s*)pdc_session=([A-Za-z0-9_-]{43})/.exec(header ?? "")?.[1] ?? null, sessionDigest: (id) => sha256(id).slice(0, 12) },
    audit: { append: (row) => { f.rows.push(row); return realAudit.append(row); } },
    readTokens: () => ({ file }), findToken: (declared, presented) => declared.tokens.find((row) => row.sha256 === sha256(presented)) ?? null, consumeLoginCode: () => ({ refusal: "unknown" }),
    actionDeps: { rm: options.readModel, plans, paths: options.paths, env: options.env, grantsEnv: options.grantsEnv, host: "host1", builtinModel: () => null }, pageDeps: { fleet: { snapshot: async () => ({}) } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port, host = `127.0.0.1:${port}`;
  let cookie;
  const post = (path, value) => new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(cookie ? { cookie } : {}) } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
    });
    req.on("error", reject); req.end(body);
  });
  const login = await post("/login", { token });
  assert.equal(login.status, 200);
  cookie = login.headers["set-cookie"][0].split(";")[0];
  f.rows.length = 0;
  return { post };
}
for (const [tool, action] of [["dispatch_trigger_fire", "trigger-fire"], ["dispatch_rerun", "rerun"]]) {
  test(`agent token HTTP ${action} enforces real roots, committed HEAD, clean tree, hourly and explicit grants`, async (t) => {
    for (const condition of ["outside", "deny", "dirty", "hourly", "missing-hourly", "invalid-hourly", "allowed"]) {
      const f = fixture(), options = { ...f.options, grantsEnv: { ...f.options.grantsEnv } };
      if (condition === "outside") options.grantsEnv.PI_DISPATCH_RUN_ROOTS = tempDir("pd-766-http-other-root-");
      if (condition === "deny") f.commitGate("deny");
      if (condition === "dirty") f.dirty();
      if (condition === "hourly") f.setCount(1);
      if (condition === "missing-hourly") delete options.grantsEnv.PI_DISPATCH_RUN_PER_HOUR;
      if (condition === "invalid-hourly") options.grantsEnv.PI_DISPATCH_RUN_PER_HOUR = "oops";
      const c = await httpAgent(f, t, options);
      const preview = await c.post(`/api/act/${action}/preview`, params(tool));
      if (condition !== "allowed") {
        assert.equal(preview.status, 400, `${condition}: ${preview.text}`);
        assert.equal(typeof preview.json().ticket, "undefined");
        assert.deepEqual(f.queued, []);
        assert.ok(!f.rows.some((r) => r.action === "write" || r.action === "write-applied"), "free gate precedes mutation intent");
      } else {
        assert.equal(preview.status, 200, preview.text);
        const result = await c.post(`/api/act/${action}/confirm`, { ticket: preview.json().ticket });
        assert.equal(result.status, 200, result.text);
        assert.equal(f.queued.length, 1); assert.equal(f.calls.filter(Boolean).length, 1);
        const replay = await c.post(`/api/act/${action}/confirm`, { ticket: preview.json().ticket });
        assert.equal(replay.status, 409); assert.equal(f.queued.length, 1, "ticket is single-use");
        assert.equal(f.rows.filter((r) => r.action === "write-applied" && r.actor.role === "agent").length, 1);
      }
      assert.ok(!preview.text.includes("PRIVATE_OPERATOR_TASK"), "private task never enters agent preview");
    }
  });
  test(`agent token HTTP ${action} rechecks clean tree and fresh HEAD after the ticket was issued`, async (t) => {
    for (const change of [(f) => f.dirty(), (f) => f.commitGate("deny")]) {
      const f = fixture(), c = await httpAgent(f, t);
      const preview = await c.post(`/api/act/${action}/preview`, params(tool));
      assert.equal(preview.status, 200, preview.text);
      change(f);
      const result = await c.post(`/api/act/${action}/confirm`, { ticket: preview.json().ticket });
      assert.equal(result.status, 409, result.text); assert.deepEqual(f.queued, []);
      assert.equal(f.rows.filter((r) => r.action === "write-applied").length, 0);
    }
  });
}
