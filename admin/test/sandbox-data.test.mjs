import assert from "node:assert/strict";
import { test } from "node:test";
import * as nodeFs from "node:fs";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeSandboxService } from "../src/sandbox-data.mjs";
import { parsePageQuery, loadPageData, renderPage } from "../src/console/pages.mjs";
import { sandboxFixture } from "./helpers/sandbox-goldens.mjs";
import { NOW } from "../../launch/fixture-deployment.mjs";
import { makeSandboxTelemetry } from "@edgehero/pi-dispatch/host-telemetry";
import { makeSandboxInventory, readSandboxInventories } from "@edgehero/pi-dispatch/sandbox-inventory";

function setup() {
  const dir = tempDir("pd-sandbox-console-");
  const paths = Object.fromEntries(["triggersPath", "projectsPath", "scopedLimitsPath"].map((k) => [k, join(dir, `${k}.json`)]));
  const triggers = { triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }] };
  writeFileSync(paths.triggersPath, JSON.stringify(triggers));
  writeFileSync(paths.projectsPath, JSON.stringify({ version: 1, projects: [] }));
  writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 1, limits: [] }));
  const inventory = sandboxFixture(), queued = [], ended = [];
  const fleet = {
    sandboxInventory: async () => ({ hosts: structuredClone(inventory.hosts) }),
    sandboxSessions: async () => ({ sessions: structuredClone(inventory.sessions) }),
    sandboxPrepare: async (request) => { queued.push(request); return { id: request.id ?? `sb-${"f".repeat(32)}`, state: "pending" }; },
    sandboxEnd: async (request) => { ended.push(request); return { ended: true }; },
    sandboxPreparationStatus: async (host, id) => ({ id, host, state: "pending" }),
  };
  const service = makeSandboxService({ paths, env: {}, deploymentDir: dir, fleet, now: () => NOW, random: () => Buffer.alloc(16, 1) });
  return { dir, paths, triggers, inventory, fleet, service, queued, ended };
}

test("a preparation preview resolves this trigger against the selected host, and only Confirm enqueues a bound no-agent request", async () => {
  const s = setup();
  const params = { repo: "acme/web", index: 0, ref: "pr:42", host: "build3", pin: true };
  const view = await s.service.read(params);
  assert.equal(view.plan.backend, "podman");
  assert.equal(view.plan.retentionHours, 72);
  assert.equal(view.plan.pinDays, 14);
  assert.equal(view.plan.image, "pi-job:4.3.1");
  const preview = await s.service.preview("sandbox-prepare", params);
  assert.equal(s.queued.length, 0);
  assert.match(preview.payload.request.triggerDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.payload.request.planDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.payload.request.id, /^sb-[a-f0-9]{32}$/);
  const out = await s.service.apply("sandbox-prepare", preview, "ops");
  assert.equal(out.ok, true);
  assert.deepEqual(s.queued, [{ ...preview.payload.request, by: "ops" }]);
  for (const k of ["image", "env", "token", "secrets", "command", "agent", "maxCostUsd"]) assert.equal(Object.hasOwn(s.queued[0], k), false, `${k} cannot become request authority`);
});

test("changed trigger or host image invalidates confirmation before enqueue, and stale/unsupported hosts cannot preview", async () => {
  for (const change of [
    (s) => { s.triggers.triggers[0].run.instructions = "Changed since review"; writeFileSync(s.paths.triggersPath, JSON.stringify(s.triggers)); },
    (s) => { s.inventory.hosts[0].settings.image = "pi-job:changed"; },
  ]) {
    const s = setup(), params = { repo: "acme/web", index: 0, ref: "HEAD", host: "mini1", pin: false };
    const preview = await s.service.preview("sandbox-prepare", params); change(s);
    const result = await s.service.apply("sandbox-prepare", preview, "ops");
    assert.equal(typeof result.invalid, "string");
    assert.equal(s.queued.length, 0);
  }
  const s = setup(); s.inventory.hosts[0].stale = true;
  assert.match((await s.service.preview("sandbox-prepare", { repo: "acme/web", index: 0, ref: "HEAD", host: "mini1", pin: false })).refusal, /published/);
  s.inventory.hosts[0].stale = false; s.inventory.hosts[0].settings.defaultBackend = "openshell-bind"; s.inventory.hosts[0].settings.backends = ["openshell-bind"];
  assert.match((await s.service.preview("sandbox-prepare", { repo: "acme/web", index: 0, ref: "HEAD", host: "mini1", pin: false })).refusal, /no sandbox shell/);
});

test("pin requests bind the manifest incarnation and deadline; replacement or old unversioned publication refuses", async () => {
  const s = setup(), params = { host: "mini1", id: "gh-9575" };
  const preview = await s.service.preview("sandbox-pin", params);
  assert.deepEqual(preview.payload.request.expect, { generation: "a".repeat(64), until: NOW + 23 * 3600000, pin: false });
  s.inventory.hosts[0].rows[0].generation = "f".repeat(64);
  assert.match((await s.service.apply("sandbox-pin", preview, "ops")).invalid, /changed/);
  assert.equal(s.queued.length, 0);
  delete s.inventory.hosts[0].rows[0].generation;
  assert.match((await s.service.preview("sandbox-pin", params)).refusal, /generation/);
});

test("End requires the exact registered shell and sends only its incarnation; timeout is explicitly ambiguous", async () => {
  const s = setup(), shell = s.inventory.sessions[0];
  const params = Object.fromEntries(["host", "id", "nonce", "containerId"].map((k) => [k, shell[k]]));
  assert.match((await s.service.preview("sandbox-end", { ...params, nonce: "9".repeat(32) })).refusal, /different shell/);
  const preview = await s.service.preview("sandbox-end", params);
  assert.equal(s.ended.length, 0);
  assert.equal((await s.service.apply("sandbox-end", preview, "ops")).ok, true);
  assert.deepEqual(s.ended, [params]);
  s.fleet.sandboxEnd = async () => ({ timeout: true });
  const ambiguous = await s.service.apply("sandbox-end", preview, "ops");
  assert.equal(ambiguous.partial, true);
  assert.match(ambiguous.invalid, /may still take effect/);
});

test("terminal-target previews are read-only; confirmation writes the checked credential-free mapping and rejects a stale file", async () => {
  const s = setup(), params = { host: "mini1", target: "ops@mini1", deployment: "/srv/pi", nodePath: "/usr/bin/node", cliPath: "/srv/pi/cli.mjs", shell: "posix" };
  const preview = await s.service.preview("sandbox-host-set", params);
  assert.equal(existsSync(join(s.dir, "sandbox-hosts.json")), false);
  assert.equal((await s.service.apply("sandbox-host-set", preview, "ops")).ok, true);
  const config = s.service.hosts().config;
  assert.deepEqual(config.hosts.mini1, { target: params.target, deployment: params.deployment, nodePath: params.nodePath, cliPath: params.cliPath, shell: "posix" });
  const stale = await s.service.apply("sandbox-host-set", preview, "ops");
  assert.match(stale.invalid, /changed/);
  assert.match((await s.service.preview("sandbox-host-set", { ...params, target: "-oProxyCommand=bad" })).refusal, /SSH target/);
});

test("viewer loads never call private sandbox reads, while operator reads stay out of snapshot", async () => {
  let reads = 0;
  const query = parsePageQuery("sandboxes", "repo=acme/web&index=0&host=mini1&ref=HEAD").query;
  const deps = { now: () => NOW, fleet: { parkedCount: async () => 0, snapshot: async () => { throw new Error("not a sandbox read"); } }, sandboxes: { hosts: () => { reads++; return { config: { version: 1, hosts: {} } }; }, read: async () => { reads++; return sandboxFixture(); } } };
  const viewer = await loadPageData("sandboxes", query, deps, { role: "viewer" });
  assert.equal(reads, 0);
  const denied = await renderPage("sandboxes", { data: viewer, query, session: { role: "viewer", name: "watcher" } });
  assert.equal(denied.status, 403);
  assert.doesNotMatch(String(denied.html), /gh-9575|pi-dispatch-open|sandbox-hosts/);
  const op = await loadPageData("sandboxes", query, deps, { role: "operator" });
  assert.equal(reads, 2); assert.equal(op.sandboxes.hosts.length, 2);
  assert.equal(op.snapshot, undefined);
  const live = await loadPageData("sandboxes", query, deps, { live: true });
  assert.equal(live.sandboxes.hosts.length, 2, "a hub load with an operator subscriber has no role field");
  const before = reads; await loadPageData("sandboxes", query, deps, { live: true, role: "viewer" }); assert.equal(reads, before, "a viewer-only live load reads no sandbox data");
});

test("sandbox query refuses duplicate, hostile host/id/ref and unknown fields before reading", () => {
  for (const query of ["host=mini1&host=mini2", "id=../../escape", "host=-oops", "ref=-c", "ref=line%0Ainjection", "repo=../escape", "command=sh", "request=gh-1", "pin=true"]) assert.equal(typeof parsePageQuery("sandboxes", query).refusal, "string", query);
  const valid = parsePageQuery("sandboxes", "repo=group/sub/repo&index=0&host=build3&ref=pr:42&pin=1").query;
  assert.equal(valid.ref, "pr:42"); assert.equal(valid.pin, true); assert.equal(valid.index, 0);
});

test("preparation reads refuse inaccessible limits and a configured missing projects file, while an unconfigured absent optional limit remains optional", async () => {
  const s = setup(), params = { repo: "acme/web", index: 0, ref: "HEAD", host: "mini1", pin: false };
  const fs = { ...nodeFs, readFileSync(path, ...args) { if (path === s.paths.scopedLimitsPath) throw Object.assign(new Error("not for the log"), { code: "EACCES" }); return nodeFs.readFileSync(path, ...args); } };
  const inaccessible = makeSandboxService({ paths: s.paths, env: {}, deploymentDir: s.dir, fleet: s.fleet, fs, now: () => NOW });
  assert.match((await inaccessible.preview("sandbox-prepare", params)).refusal, /could not be read/);
  s.paths.projectsFile = s.paths.projectsPath; unlinkSync(s.paths.projectsFile);
  assert.match((await s.service.preview("sandbox-prepare", params)).refusal, /could not be read/);
  s.paths.projectsFile = null; unlinkSync(s.paths.scopedLimitsPath);
  assert.ok((await s.service.preview("sandbox-prepare", params)).payload);
});

test("the selected raw trigger index stays bound across differently imaged sibling triggers", async () => {
  const s = setup(); s.triggers.triggers.push({ on: { type: "label", any: ["other"] }, run: { kind: "github", flow: "fix", image: "pi-job:sibling" } });
  writeFileSync(s.paths.triggersPath, JSON.stringify(s.triggers));
  const p = await s.service.preview("sandbox-prepare", { repo: "acme/web", index: 1, ref: "HEAD", host: "mini1", pin: false });
  assert.equal(p.payload.request.triggerIndex, 1); assert.ok(p.summary.some((l) => l.includes("pi-job:sibling")));
});

test("incomplete shell registration and cleanup notices survive the service projection", async () => {
  const s = setup(); s.fleet.sandboxSessions = async () => ({ sessions: [], more: 12, unreadable: 2, notices: [{ host: "mini1", id: "gh-1", at: NOW, reason: "network-kept" }], noticesUnavailable: true });
  const read = await s.service.read();
  assert.equal(read.sessionsMore, 12); assert.equal(read.sessionsUnreadable, 2); assert.equal(read.notices[0].reason, "network-kept"); assert.equal(read.noticesUnavailable, true);
});

test("real manifest telemetry survives durable inventory and the service: per-workspace image and local folder facts cannot come from illustrative fixtures", async () => {
  const s = setup(), values = new Map(), until = NOW + 3600000;
  const manifests = [
    { jobId: "gh-forge", image: "pi-job:forge", kind: "github", workspace: "/private/clone", backend: "local", createdAt: new Date(NOW).toISOString(), project: "invented-project" },
    { jobId: "local-folder", image: "pi-job:folder", kind: "local", workspace: "/private/original", backend: "local", createdAt: new Date(NOW).toISOString() },
    { jobId: "gh-legacy", workspace: "/private/legacy", backend: "local", createdAt: new Date(NOW).toISOString() },
  ];
  const telemetry = makeSandboxTelemetry({ list: () => manifests, deadline: () => ({ until, source: "retention" }), retentionHours: 24, now: () => NOW });
  const redis = { set: async (key, value) => { values.set(key, value); }, sadd: async () => 1, smembers: async () => ["mini1"], mget: async (...keys) => keys.map((key) => values.get(key)) };
  const publisher = makeSandboxInventory({ redis, host: "mini1", read: telemetry, settings: s.inventory.hosts[0].settings, now: () => NOW });
  assert.equal((await publisher.publish()).published, true);
  s.fleet.sandboxInventory = () => readSandboxInventories(redis, { now: () => NOW });
  for (const [id, image, workspace] of [["gh-forge", "pi-job:forge", "Its retained clone"], ["local-folder", "pi-job:folder", "Its original host folder"], ["gh-legacy", "As recorded in its kept manifest", "The workspace recorded in its kept manifest"]]) {
    const query = { id, host: "mini1" };
    const data = await loadPageData("sandboxes", query, { now: () => NOW, fleet: s.fleet, sandboxes: s.service }, { role: "operator" });
    const page = String((await renderPage("sandboxes", { data, query, session: { role: "operator", name: "ops" } })).html);
    const section = page.split('id="p-sb-run" data-panel>')[1].split("</section>")[0];
    assert.ok(section.includes(image), `${id}: selected image survives the real writer and reader`);
    assert.ok(section.includes(workspace), `${id}: selected workspace kind determines the facts`);
    assert.equal(section.includes(id === "local-folder" ? "Its retained clone" : "Its original host folder"), false);
    assert.doesNotMatch(page, /invented-project|\/private\/clone|\/private\/original|\/private\/legacy/);
  }
  await publisher.close();
});
