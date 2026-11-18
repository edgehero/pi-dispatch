import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ARTIFACT_CSP, ARTIFACT_INLINE_TYPES, artifactHeaders, getArtifact } from "../src/console/artifact-api.mjs";
import { ROUTES } from "../src/console/server.mjs";
import { RUN_VIEWER_PANELS } from "../src/console/pages.mjs";
import { ARTIFACT_STATES, artifactHref } from "../src/console/panels/run.mjs";
import { createFleetReader } from "../src/read-model.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

function ctx(query, fleet, role = "viewer") {
  const replies = [];
  const res = { headersSent: false, status: null, headers: null, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  return { replies, res, session: { name: "ana", role }, searchParams: new URLSearchParams(query), deps: { pageDeps: { fleet } }, json(status, body) { replies.push({ status, body }); } };
}

test("the route is a viewer's, read-only, under /api, and the run page shows its panel to viewers", () => {
  const route = ROUTES.find((r) => r.path === "/api/artifact");
  assert.equal(route.auth, "viewer");
  assert.equal(route.write, false);
  assert.ok(RUN_VIEWER_PANELS.includes("p-artifacts"));
  assert.deepEqual(ARTIFACT_STATES, ["kept", "dropped", "expired", "elsewhere", "unreadable"]);
  assert.equal(artifactHref("gh-1:r2", "a.png"), "/api/artifact?id=gh-1%3Ar2&name=a.png");
});

test("an agent token, a malformed query, an unknown name and an unreadable file are refused without bytes", async () => {
  const never = { artifactFile: () => assert.fail("not read") };
  const agent = ctx("id=gh-1&name=a.png", never, "agent");
  await getArtifact(agent);
  assert.equal(agent.replies[0].status, 403);
  for (const query of ["", "id=gh-1", "name=a.png", "id=gh-1&name=a&name=b", "id=gh-1&name=a&path=/etc"]) {
    const c = ctx(query, never);
    await getArtifact(c);
    assert.equal(c.replies[0].status, 400, query);
  }
  const missing = ctx("id=gh-1&name=b.png", { artifactFile: () => ({ missing: true }) });
  await getArtifact(missing);
  assert.equal(missing.replies[0].status, 404);
  const broken = ctx("id=gh-1&name=b.png", { artifactFile: () => ({ unreadable: true }) });
  await getArtifact(broken);
  assert.equal(broken.replies[0].status, 503);
  for (const c of [agent, missing, broken]) assert.equal(c.res.body, null);
});

test("a file is sent with its kept type: images and text inline, anything else an attachment, all under a sandbox policy", async () => {
  for (const [type, inline, sent] of [["image/png", true, "image/png"], ["text/plain", true, "text/plain; charset=utf-8"], ["application/octet-stream", false, "application/octet-stream"]]) {
    const bytes = Buffer.from("x");
    const c = ctx("id=gh-1&name=f.bin", { artifactFile: () => ({ bytes, type, name: "f.bin" }) });
    await getArtifact(c);
    assert.equal(c.res.status, 200);
    assert.equal(c.res.headers["content-type"], sent);
    assert.equal(c.res.headers["content-disposition"], `${inline ? "inline" : "attachment"}; filename="f.bin"`);
    assert.equal(c.res.headers["content-security-policy"], ARTIFACT_CSP);
    assert.equal(c.res.body, bytes);
  }
  assert.match(ARTIFACT_CSP, /^sandbox; default-src 'none'/);
  assert.ok(!ARTIFACT_INLINE_TYPES.some((t) => /svg|html|xml/.test(t)), "no type that can carry script is ever inline");
  assert.equal(artifactHeaders({ type: "image/svg+xml", name: "a", length: 1 })["content-type"], "application/octet-stream");
});

function store() {
  const root = tempDir("pi-console-artifacts-");
  const dir = join(root, "artifacts");
  const put = (jobId, files, extra = {}) => {
    const run = join(dir, jobId);
    mkdirSync(join(run, "files"), { recursive: true });
    const entries = files.map(([name, bytes, type]) => {
      writeFileSync(join(run, "files", name), bytes);
      return { name, size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex"), type, scrubbed: false };
    });
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ v: 1, jobId, createdAt: "2026-11-18T09:00:00.000Z", keepUntil: "2026-12-02T09:00:00.000Z", files: entries, dropped: {}, ...extra }));
    return run;
  };
  // No connection is ever dialled: the artifacts reads are this host's disk only (console-run-outcome.test.mjs's doubles).
  const queue = { name: "pi-jobs", getJob: async () => null, close: async () => {} };
  const redis = { on() {}, disconnect() {}, quit: async () => {} };
  const reader = createFleetReader({ artifactsDir: dir, logsDir: join(root, "logs"), valkeyUrl: "redis://unused" }, { makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), dollarEnvFn: () => ({ PI_WORKER_NAME: "mini1" }) });
  return { root, dir, put, reader };
}

test("the reader answers each state from this host's store, the manifest only, and serves only a listed file", () => {
  const s = store();
  const counts = { kept: 1, bytes: 5, dropped: {} };
  const rec = (extra = {}) => ({ jobId: "gh-1", host: "mini1", artifacts: counts, ...extra });
  assert.equal(s.reader.artifacts("gh-1", { jobId: "gh-1" }), null, "a run that kept nothing has no panel");
  assert.deepEqual(s.reader.artifacts("gh-1", rec({ artifacts: { kept: 0, bytes: 0, dropped: { size: 2 } } })), { state: "dropped", counts: { kept: 0, bytes: 0, dropped: { size: 2 } } });
  assert.equal(s.reader.artifacts("gh-1", rec()).state, "expired");
  assert.deepEqual(s.reader.artifacts("gh-1", rec({ host: "mini2" })), { state: "elsewhere", counts, host: "mini2" });
  const run = s.put("gh-1", [["a.txt", "hello", "text/plain"]]);
  const kept = s.reader.artifacts("gh-1", rec());
  assert.equal(kept.state, "kept");
  assert.deepEqual(kept.files.map((f) => f.name), ["a.txt"]);
  assert.deepEqual(s.reader.artifactFile("gh-1", "a.txt"), { bytes: Buffer.from("hello"), type: "text/plain", name: "a.txt" });
  assert.deepEqual(s.reader.artifactFile("gh-1", "b.txt"), { missing: true }, "a name the manifest does not list");
  assert.deepEqual(s.reader.artifactFile("gh-1", "../manifest.json"), { missing: true });
  assert.deepEqual(s.reader.artifactFile("..", "a.txt"), { missing: true });
  writeFileSync(join(run, "files", "a.txt"), "changed under the store");
  assert.deepEqual(s.reader.artifactFile("gh-1", "a.txt"), { unreadable: true }, "a size that is not the manifest's is never served");
  const linked = s.put("gh-2", [["b.txt", "x", "text/plain"]]);
  writeFileSync(join(s.root, "outside.txt"), "y");
  writeFileSync(join(linked, "files", "b.txt.tmp"), "");
  symlinkSync(join(s.root, "outside.txt"), join(linked, "files", "c.txt"));
  writeFileSync(join(linked, "manifest.json"), JSON.stringify({ v: 1, jobId: "gh-2", createdAt: "2026-11-18T09:00:00.000Z", keepUntil: null, files: [{ name: "c.txt", size: 1, sha256: "c".repeat(64), type: "text/plain", scrubbed: false }], dropped: {} }));
  assert.deepEqual(s.reader.artifactFile("gh-2", "c.txt"), { unreadable: true }, "a link in the store is never followed");
  writeFileSync(join(run, "manifest.json"), "{ not json");
  assert.equal(s.reader.artifacts("gh-1", rec()).state, "unreadable", "never read as none");
});
