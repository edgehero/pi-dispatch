import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { ARTIFACTS_CHUNK_BYTES, ARTIFACTS_READ_MS } from "@edgehero/pi-dispatch/artifacts-channel";
import { ARTIFACT_CSP, ARTIFACT_INLINE_TYPES, HOST_ARTIFACT_REFUSALS, artifactHeaders, getArtifact } from "../src/console/artifact-api.mjs";
import { ROUTES } from "../src/console/server.mjs";
import { RUN_VIEWER_PANELS, loadPageData, pagePanels } from "../src/console/pages.mjs";
import { ARTIFACT_STATES, artifactHref } from "../src/console/panels/run.mjs";
import { createFleetReader, HOST_ARTIFACT_BUSY_WAITS_MS, HOST_ARTIFACT_SLOT_WAIT_MS, HOST_ARTIFACT_SLOT_WAITERS_MAX, HOST_ARTIFACT_TRANSFERS_MAX } from "../src/read-model.mjs";
import { handTime } from "./helpers/hand-time.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * A response as the route uses one: headers, the bytes written and how it ended. `full` makes `write` say the buffer is
 * full that many times, so the route waits for `drain` (which this emits on the next turn).
 */
function response({ full = 0 } = {}) {
  const res = new EventEmitter();
  let blocked = false;
  Object.assign(res, {
    headersSent: false, destroyed: false, ended: false, status: null, headers: null, body: null, chunks: [], fullAnswers: 0, writtenWhileFull: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    write(bytes) {
      if (blocked) this.writtenWhileFull += 1;
      this.chunks.push(Buffer.from(bytes));
      if (full <= 0) return true;
      full -= 1;
      this.fullAnswers += 1;
      blocked = true;
      setImmediate(() => { blocked = false; this.emit("drain"); });
      return false;
    },
    end(body) { if (blocked) this.writtenWhileFull += 1; if (body !== undefined) this.chunks.push(Buffer.from(body)); this.body = body; this.ended = true; this.emit("close"); },
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  return res;
}

function ctx(query, fleet, role = "viewer", res = response()) {
  const replies = [];
  return { replies, res, session: { name: "ana", role }, searchParams: new URLSearchParams(query), deps: { pageDeps: { fleet } }, json(status, body) { replies.push({ status, body }); } };
}

/** All the bytes a response sent. */
const sent = (res) => Buffer.concat(res.chunks);

test("the route is a viewer's, read-only, under /api, and the run page shows its panel to viewers", () => {
  const route = ROUTES.find((r) => r.path === "/api/artifact");
  assert.equal(route.auth, "viewer");
  assert.equal(route.write, false);
  assert.ok(RUN_VIEWER_PANELS.includes("p-artifacts"));
  assert.deepEqual(ARTIFACT_STATES, ["kept", "dropped", "expired", "elsewhere", "unreadable"]);
  assert.equal(artifactHref("gh-1:r2", "a.png"), "/api/artifact?id=gh-1%3Ar2&name=a.png");
  // Issue #942: a file another host keeps names that host, so the route asks it; one of this host's never does.
  assert.equal(artifactHref("gh-1:r2", "a.png", "mini2"), "/api/artifact?id=gh-1%3Ar2&name=a.png&host=mini2");
  assert.equal(artifactHref("gh-1:r2", "a.png", null), "/api/artifact?id=gh-1%3Ar2&name=a.png");
  // The console's own bounds on another host's files, each its number.
  assert.equal(HOST_ARTIFACT_TRANSFERS_MAX, 4);
  assert.equal(HOST_ARTIFACT_SLOT_WAIT_MS, 15_000);
  assert.equal(HOST_ARTIFACT_SLOT_WAITERS_MAX, 32);
  assert.deepEqual(HOST_ARTIFACT_BUSY_WAITS_MS, [100, 200, 400]);
});

test("an agent token, a malformed query, an unknown name and an unreadable file are refused without bytes", async () => {
  const never = { artifactFile: () => assert.fail("not read"), hostArtifactFile: () => assert.fail("not asked") };
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

const entryOf = (name, bytes, type) => ({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), type, scrubbed: false });
const manifestOf = (jobId, entries) => ({ v: 1, jobId, createdAt: "2026-11-18T09:00:00.000Z", keepUntil: "2026-12-02T09:00:00.000Z", files: entries, dropped: {} });

/**
 * Another host's artifacts channel, as the reader's seams take it (issue #942): `manifest` answers each manifest
 * request (a value, or a function of the call), `chunk` each chunk request. `calls` records every request in order, and
 * `closed` counts each transfer's `close()`.
 */
function hostChannel({ manifest = { missing: true }, chunk = () => ({ error: "host-unavailable" }), open = null } = {}) {
  const calls = [];
  const state = { closed: 0, opened: 0 };
  return {
    calls, state,
    readHostArtifactsManifestFn: async (args) => {
      calls.push(["manifest", args.host, args.jobId, args.timeoutMs ?? null]);
      return typeof manifest === "function" ? manifest(args) : manifest;
    },
    openHostArtifactTransferFn: async (args) => {
      calls.push(["open", args.host, args.jobId]);
      if (open) return open;
      state.opened += 1;
      let pending = null;
      let asked = 0;
      return {
        chunk: (req) => {
          calls.push(["chunk", req.name, req.offset]);
          // A host stops answering a transfer that asks without end, so a route that never stops still ends here.
          if ((asked += 1) > 64) return Promise.resolve({ error: "host-unavailable" });
          return new Promise((resolve) => {
            pending = resolve;
            Promise.resolve(chunk(req)).then(resolve);
          });
        },
        // The channel's own close settles a request in flight as unanswered.
        close: () => { state.closed += 1; pending?.({ error: "host-unavailable" }); },
      };
    },
  };
}

/** This host's store and a real fleet reader on it, named mini1, with `live` the registry's hosts and `channel` theirs. */
function store({ live = [], channel = hostChannel(), slotWaitMs } = {}) {
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
  // No connection is ever dialled: this host's store is its disk, and another host's channel is `channel`.
  const queue = { name: "pi-jobs", getJob: async () => null, close: async () => {} };
  const redis = { on() {}, disconnect() {}, quit: async () => {} };
  const waits = [];
  const reader = createFleetReader({ artifactsDir: dir, logsDir: join(root, "logs"), valkeyUrl: "redis://unused" }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: live.map((name) => ({ name })) }),
    discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), dollarEnvFn: () => ({ PI_WORKER_NAME: "mini1" }),
    readHostArtifactsManifestFn: channel.readHostArtifactsManifestFn, openHostArtifactTransferFn: channel.openHostArtifactTransferFn,
    artifactsWaitFn: async (ms) => { waits.push(ms); },
    ...(slotWaitMs === undefined ? {} : { artifactsSlotWaitMs: slotWaitMs }),
  });
  return { root, dir, put, reader, channel, waits };
}

test("the reader answers each state from this host's store, the manifest only, and serves only a listed file", async () => {
  const s = store();
  const counts = { kept: 1, bytes: 5, dropped: {} };
  const rec = (extra = {}) => ({ jobId: "gh-1", host: "mini1", artifacts: counts, ...extra });
  assert.equal(await s.reader.artifacts("gh-1", { jobId: "gh-1" }), null, "a run that kept nothing has no panel");
  assert.deepEqual(await s.reader.artifacts("gh-1", rec({ artifacts: { kept: 0, bytes: 0, dropped: { size: 2 } } })), { state: "dropped", counts: { kept: 0, bytes: 0, dropped: { size: 2 } } });
  assert.deepEqual(await s.reader.artifacts("gh-1", rec()), { state: "expired", counts }, "this host's own run: no host is asked");
  assert.deepEqual(await s.reader.artifacts("gh-1", rec({ host: "mini2" })), { state: "elsewhere", counts, host: "mini2", why: "not-running" });
  const run = s.put("gh-1", [["a.txt", "hello", "text/plain"]]);
  const kept = await s.reader.artifacts("gh-1", rec());
  assert.equal(kept.state, "kept");
  assert.equal(kept.host, undefined, "a file of this host's names no host");
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
  assert.equal((await s.reader.artifacts("gh-1", rec())).state, "unreadable", "never read as none");
  assert.deepEqual(s.channel.calls, [], "no host was asked for any of it");
});

test("the card's read of a run another host kept (issue #942): asked of that host only while it runs, each answer its state, this host's store first", async () => {
  const counts = { kept: 2, bytes: 11, dropped: { size: 1 } };
  const rec = { jobId: "gh-3", host: "mini2", artifacts: counts };
  const listed = manifestOf("gh-3", [entryOf("a.png", Buffer.from("png bytes"), "image/png"), entryOf("b.txt", Buffer.from("hi"), "text/plain")]);
  const read = async (manifest, { live = ["mini2"], within } = {}) => {
    const s = store({ live, channel: hostChannel({ manifest }) });
    const got = await s.reader.artifacts("gh-3", rec, within ? { within } : {});
    return { got, calls: s.channel.calls, waits: s.waits };
  };
  // A host the registry does not list is not asked, and nothing waits for it.
  const stopped = await read(() => assert.fail("a host that is not running is never asked"), { live: [] });
  assert.deepEqual(stopped.got, { state: "elsewhere", counts, host: "mini2", why: "not-running" });
  assert.deepEqual(stopped.calls, []);
  // Its manifest: kept, with the host the files are on.
  const kept = await read({ manifest: listed });
  assert.deepEqual(kept.got, { state: "kept", counts, files: listed.files, dropped: {}, keepUntil: "2026-12-02T09:00:00.000Z", host: "mini2" });
  assert.deepEqual(kept.calls, [["manifest", "mini2", "gh-3", null]]);
  // Another job's manifest is never shown as this run's.
  assert.deepEqual((await read({ manifest: { ...listed, jobId: "gh-4" } })).got, { state: "unreadable", counts, host: "mini2" });
  assert.deepEqual((await read({ missing: true })).got, { state: "expired", counts, host: "mini2" });
  for (const error of ["artifacts-unreadable", "invalid-request"]) assert.deepEqual((await read({ error })).got, { state: "unreadable", counts, host: "mini2" }, error);
  assert.deepEqual((await read({ error: "host-unavailable" })).got, { state: "elsewhere", counts, host: "mini2", why: "no-answer" });
  assert.deepEqual((await read(() => { throw new Error("a reader that throws"); })).got, { state: "elsewhere", counts, host: "mini2", why: "no-answer" });
  // Busy: asked once more after the first wait, and busy again is said so.
  const busy = await read({ error: "host-busy" });
  assert.deepEqual(busy.got, { state: "elsewhere", counts, host: "mini2", why: "busy" });
  assert.deepEqual([busy.calls.length, busy.waits], [2, [100]]);
  let asked = 0;
  const thenFree = await read(() => (++asked === 1 ? { error: "host-busy" } : { manifest: listed }));
  assert.equal(thenFree.got.state, "kept");
  // Under a page's deadline: the host is given what the page has left, and a busy host is not asked again past it.
  const pressed = await read({ error: "host-busy" }, { within: (own) => Math.min(own, 60) });
  assert.deepEqual([pressed.calls, pressed.waits], [[["manifest", "mini2", "gh-3", 60]], []]);
  const roomy = await read({ manifest: listed }, { within: (own) => Math.min(own, 4_000) });
  assert.deepEqual(roomy.calls, [["manifest", "mini2", "gh-3", 4_000]]);
  assert.equal(ARTIFACTS_READ_MS, 5_000, "the host's own bound, which a page with more time left hands it whole");
  // This host's store wins whatever the record's host says: the host is not asked.
  const s = store({ live: ["mini2"], channel: hostChannel({ manifest: () => assert.fail("not asked") }) });
  s.put("gh-3", [["a.png", "local", "image/png"]]);
  const local = await s.reader.artifacts("gh-3", rec);
  assert.deepEqual([local.state, local.host, s.channel.calls], ["kept", undefined, []]);
});

/** A file of `size` random bytes kept on mini2 for run gh-3, and its channel answering each chunk from it. */
function remoteFile(size, { type = "application/octet-stream", name = "big.bin", alter = (reply) => reply, manifest = null, slotWaitMs } = {}) {
  const bytes = randomBytes(size);
  const entry = entryOf(name, bytes, type);
  const chunk = (req) => {
    if (req.name !== entry.name || req.sha256 !== entry.sha256) return { missing: true };
    const data = bytes.subarray(req.offset, Math.min(req.offset + ARTIFACTS_CHUNK_BYTES, size));
    return alter({ offset: req.offset, data: Buffer.from(data), last: req.offset + data.length === size }, req);
  };
  const channel = hostChannel({ manifest: manifest ?? { manifest: manifestOf("gh-3", [entry]) }, chunk });
  return { bytes, entry, channel, s: store({ live: ["mini2"], channel, slotWaitMs }) };
}

test("another host's file is streamed chunk by chunk with the headers of this host's, its bytes exactly the manifest's (issue #942)", { timeout: 30_000 }, async () => {
  const size = 2 * ARTIFACTS_CHUNK_BYTES + 1000;
  const f = remoteFile(size);
  const c = ctx("id=gh-3&name=big.bin&host=mini2", f.s.reader, "viewer", response({ full: 1 }));
  await getArtifact(c);
  assert.deepEqual(c.replies, []);
  assert.equal(c.res.status, 200);
  assert.deepEqual(c.res.headers, { "content-type": "application/octet-stream", "content-length": String(size), "content-disposition": 'attachment; filename="big.bin"', "content-security-policy": ARTIFACT_CSP });
  assert.ok(sent(c.res).equals(f.bytes), "byte for byte");
  assert.equal(c.res.ended, true);
  assert.deepEqual([c.res.fullAnswers, c.res.writtenWhileFull], [1, 0], "a full buffer is waited for, not written past");
  assert.deepEqual(f.channel.calls, [["manifest", "mini2", "gh-3", null], ["open", "mini2", "gh-3"], ["chunk", "big.bin", 0], ["chunk", "big.bin", ARTIFACTS_CHUNK_BYTES], ["chunk", "big.bin", 2 * ARTIFACTS_CHUNK_BYTES]]);
  assert.equal(f.channel.state.closed, 1);
  // An image inline and text as text, as this host's are; an empty file is one empty chunk.
  for (const [type, disposition, sentType, n] of [["image/png", "inline", "image/png", 10], ["text/plain", "inline", "text/plain; charset=utf-8", 3], ["text/plain", "inline", "text/plain; charset=utf-8", 0]]) {
    const one = remoteFile(n, { type, name: "a.txt" });
    const got = ctx("id=gh-3&name=a.txt&host=mini2", one.s.reader);
    await getArtifact(got);
    assert.deepEqual([got.res.status, got.res.headers["content-type"], got.res.headers["content-disposition"], got.res.headers["content-length"], got.res.headers["content-security-policy"]], [200, sentType, `${disposition}; filename="a.txt"`, String(n), ARTIFACT_CSP]);
    assert.ok(sent(got.res).equals(one.bytes));
  }
  // A host that is busy for a moment is asked again, and the file still arrives whole.
  let busyOnce = true;
  const flaky = remoteFile(ARTIFACTS_CHUNK_BYTES + 5, { alter: (reply, req) => (req.offset > 0 && busyOnce ? ((busyOnce = false), { error: "host-busy" }) : reply) });
  const retried = ctx("id=gh-3&name=big.bin&host=mini2", flaky.s.reader);
  await getArtifact(retried);
  assert.ok(sent(retried.res).equals(flaky.bytes));
  assert.deepEqual(flaky.s.waits, [100]);
});

test("a chunk that is not the manifest's never completes the answer: short, long, at the wrong offset, or bytes of another digest (issue #942)", { timeout: 30_000 }, async () => {
  const size = 2 * ARTIFACTS_CHUNK_BYTES + 1000;
  const cases = [
    ["a short chunk in the middle", (reply, req) => (req.offset === ARTIFACTS_CHUNK_BYTES ? { ...reply, data: reply.data.subarray(1) } : reply)],
    ["a long last chunk", (reply) => (reply.last ? { ...reply, data: Buffer.concat([reply.data, Buffer.from("x")]) } : reply)],
    ["a chunk at another offset", (reply, req) => (req.offset === ARTIFACTS_CHUNK_BYTES ? { ...reply, offset: 0 } : reply)],
    ["a last chunk that says it is not", (reply) => (reply.last ? { ...reply, last: false } : reply)],
    ["a middle chunk of other bytes", (reply, req) => (req.offset === ARTIFACTS_CHUNK_BYTES ? { ...reply, data: Buffer.alloc(reply.data.length, 7) } : reply)],
    ["a last chunk of other bytes", (reply) => (reply.last ? { ...reply, data: Buffer.alloc(reply.data.length, 7) } : reply)],
    ["a host that says the file changed", (reply, req) => (req.offset > 0 ? { changed: true } : reply)],
    ["a host that stops answering", (reply, req) => (req.offset > 0 ? { error: "host-unavailable" } : reply)],
  ];
  for (const [what, alter] of cases) {
    const f = remoteFile(size, { alter });
    const c = ctx("id=gh-3&name=big.bin&host=mini2", f.s.reader);
    await getArtifact(c);
    assert.equal(c.res.status, 200, `${what}: the headers went with the first chunk`);
    assert.equal(c.res.destroyed, true, `${what}: the connection is destroyed`);
    assert.equal(c.res.ended, false, `${what}: the answer never ends`);
    assert.ok(sent(c.res).length < size, `${what}: fewer bytes than the length said`);
    assert.equal(f.channel.state.closed, 1, `${what}: the transfer is closed`);
    assert.ok(f.channel.calls.every(([op, , offset]) => op !== "chunk" || offset < size), `${what}: nothing is asked for past the end`);
  }
  // A one-chunk file whose bytes are not the manifest's: the headers, and not one byte.
  const one = remoteFile(10, { alter: (reply) => ({ ...reply, data: Buffer.alloc(10, 1) }) });
  const c = ctx("id=gh-3&name=big.bin&host=mini2", one.s.reader);
  await getArtifact(c);
  assert.deepEqual([c.res.status, c.res.destroyed, sent(c.res).length], [200, true, 0]);
});

test("another host's file is refused before any byte, in fixed words, and the transfer is closed on every path (issue #942)", { timeout: 30_000 }, async () => {
  const size = ARTIFACTS_CHUNK_BYTES + 1;
  const refusedAs = async (f, query = "id=gh-3&name=big.bin&host=mini2") => {
    const c = ctx(query, f.s.reader);
    await getArtifact(c);
    assert.equal(c.res.status, null, "no header was written");
    assert.deepEqual(c.res.chunks, []);
    const [{ status, body }] = c.replies;
    assert.ok(!/mini2|gh-3|big\.bin/.test(body.error), "the sentence names nothing from the request");
    assert.equal(f.channel.state.closed, f.channel.state.opened, "every transfer opened was closed");
    return [status, body.error];
  };
  const { missing, busy, changed, unreadable } = HOST_ARTIFACT_REFUSALS;
  const said = (word) => [HOST_ARTIFACT_REFUSALS[word][0], HOST_ARTIFACT_REFUSALS[word][1]];
  assert.deepEqual(await refusedAs(remoteFile(size, { manifest: { missing: true } })), [...missing]);
  assert.deepEqual(await refusedAs(remoteFile(size), "id=gh-3&name=other.bin&host=mini2"), [...missing], "a name the host's manifest does not list");
  assert.deepEqual(await refusedAs(remoteFile(size, { manifest: { error: "host-unavailable" } })), said("no-answer"));
  assert.deepEqual(await refusedAs(remoteFile(size, { manifest: { error: "artifacts-unreadable" } })), [...unreadable]);
  assert.deepEqual(await refusedAs(remoteFile(size, { manifest: { manifest: manifestOf("gh-4", []) } })), [...unreadable], "another job's manifest");
  assert.deepEqual(await refusedAs(remoteFile(size, { alter: () => ({ missing: true }) })), [...missing], "the file is gone from the host");
  assert.deepEqual(await refusedAs(remoteFile(size, { alter: () => ({ changed: true }) })), [...changed]);
  assert.deepEqual(await refusedAs(remoteFile(size, { alter: (reply) => ({ ...reply, data: reply.data.subarray(1) }) })), [...unreadable], "a first chunk that is not the entry's");
  // A host that stays busy: asked three more times, after 100, 200 and 400 ms, then refused.
  const stuck = remoteFile(size, { alter: () => ({ error: "host-busy" }) });
  assert.deepEqual(await refusedAs(stuck), [...busy]);
  assert.deepEqual([stuck.channel.calls.filter(([op]) => op === "chunk").length, stuck.s.waits], [4, [100, 200, 400]]);
  // A transfer that cannot be opened.
  const closedChannel = hostChannel({ manifest: { manifest: manifestOf("gh-3", [entryOf("big.bin", Buffer.from("x"), "text/plain")]) }, open: { error: "host-unavailable" } });
  assert.deepEqual(await refusedAs({ channel: closedChannel, s: store({ live: ["mini2"], channel: closedChannel }) }), said("no-answer"));
});

test("the host a request names: a worker's name, given once, live, and never this host's own (issue #942)", { timeout: 30_000 }, async () => {
  const f = remoteFile(10);
  for (const query of ["id=gh-3&name=big.bin&host=-mini2", "id=gh-3&name=big.bin&host=mini2/..", "id=gh-3&name=big.bin&host=", `id=gh-3&name=big.bin&host=${"m".repeat(65)}`, "id=gh-3&name=big.bin&host=mini2&host=mini3", "id=gh-3&name=big.bin&host=mini2&via=mini3"]) {
    const c = ctx(query, f.s.reader);
    await getArtifact(c);
    assert.equal(c.replies[0]?.status, 400, query);
  }
  // This host's own name: its store was read, and holds no such file.
  const own = ctx("id=gh-3&name=big.bin&host=mini1", f.s.reader);
  await getArtifact(own);
  assert.equal(own.replies[0].status, 404);
  // A host the registry does not list is not asked.
  const gone = ctx("id=gh-3&name=big.bin&host=mini3", f.s.reader);
  await getArtifact(gone);
  assert.deepEqual(gone.replies[0], { status: 503, body: { error: HOST_ARTIFACT_REFUSALS["not-running"][1] } });
  assert.deepEqual(f.channel.calls, [], "no host was asked");
  // An agent: refused before this host's store is read or any host is asked.
  const agent = ctx("id=gh-3&name=big.bin&host=mini2", f.s.reader, "agent");
  await getArtifact(agent);
  assert.equal(agent.replies[0].status, 403);
  assert.deepEqual(f.channel.calls, []);
  // This host's store first: a file it holds is never asked of the host the request names.
  f.s.put("gh-3", [["big.bin", "local", "text/plain"]]);
  const local = ctx("id=gh-3&name=big.bin&host=mini2", f.s.reader);
  await getArtifact(local);
  assert.deepEqual([local.res.status, String(local.res.body)], [200, "local"]);
  assert.deepEqual(f.channel.calls, []);
});

/** Let the requests run until `ready()`, for a bounded number of turns, so a route that stops early fails rather than waits. */
async function heldUntil(ready) {
  for (let turn = 0; turn < 2000 && !ready(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ready(), "the requests reached the chunk they wait at");
}

test("at most four files from other hosts at once per console, a fifth waits its turn, and a browser that goes away stops the requests (issue #942)", { timeout: 30_000 }, async () => {
  const size = 2 * ARTIFACTS_CHUNK_BYTES + 10;
  const held = [];
  const f = remoteFile(size, { alter: (reply, req) => (req.offset === ARTIFACTS_CHUNK_BYTES ? new Promise((resolve) => held.push(() => resolve(reply))) : reply) });
  const query = "id=gh-3&name=big.bin&host=mini2";
  const running = Array.from({ length: 4 }, () => ctx(query, f.s.reader));
  const answers = running.map((c) => getArtifact(c));
  await heldUntil(() => held.length === 4);
  // A fifth (a page's fifth image, which a browser asks for beside the others) waits for a place, asking no host.
  const fifth = ctx(query, f.s.reader);
  const asked = f.channel.calls.length;
  const fifthAnswer = getArtifact(fifth);
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([fifth.replies, fifth.res.headersSent, f.channel.calls.length], [[], false, asked], "the fifth waits, unanswered and asking no host");
  // The first browser goes away: its transfer is closed at once, nothing more is asked for it, and its place goes to
  // the fifth, which then asks its host and reaches the chunk the others wait at.
  running[0].res.emit("close");
  assert.equal(f.channel.state.closed, 1, "closed at once, its chunk in flight with it");
  await heldUntil(() => held.length === 5);
  for (const release of held) release();
  await Promise.all([...answers, fifthAnswer]);
  assert.equal(running[0].res.ended, false);
  for (const c of [...running.slice(1), fifth]) assert.ok(sent(c.res).equals(f.bytes));
  const chunks = f.channel.calls.filter(([op]) => op === "chunk").map(([, , offset]) => offset);
  assert.deepEqual([chunks.filter((o) => o === 0).length, chunks.filter((o) => o === ARTIFACTS_CHUNK_BYTES).length, chunks.filter((o) => o === 2 * ARTIFACTS_CHUNK_BYTES).length], [5, 5, 4], "the browser that left was sent no third chunk");
  assert.equal(f.channel.state.closed, 5);
  // Each finished transfer gave its place back.
  const after = ctx(query, f.s.reader);
  const next = getArtifact(after);
  await heldUntil(() => held.length === 6);
  held[5]();
  await next;
  assert.ok(sent(after.res).equals(f.bytes));
  assert.equal(f.channel.state.closed, 6);
  // A browser that goes away while its answer waits for room: nothing more is asked for it.
  const waiting = remoteFile(size);
  const leaving = ctx(query, waiting.s.reader, "viewer", response({ full: 1 }));
  leaving.res.write = function write(bytes) {
    this.chunks.push(Buffer.from(bytes));
    setImmediate(() => this.emit("close"));
    return false;
  };
  await getArtifact(leaving);
  assert.deepEqual(waiting.channel.calls.filter(([op]) => op === "chunk").map(([, , offset]) => offset), [0], "no chunk after the browser left");
  assert.equal(waiting.channel.state.closed, 1);
});

test("a request that waits for a place is refused once its wait is over, and at once when the line of waiters is full (issue #942)", { timeout: 30_000 }, async () => {
  const size = 2 * ARTIFACTS_CHUNK_BYTES + 10;
  const held = [];
  const f = remoteFile(size, { slotWaitMs: 30, alter: (reply, req) => (req.offset === ARTIFACTS_CHUNK_BYTES ? new Promise((resolve) => held.push(() => resolve(reply))) : reply) });
  const query = "id=gh-3&name=big.bin&host=mini2";
  const running = Array.from({ length: HOST_ARTIFACT_TRANSFERS_MAX }, () => ctx(query, f.s.reader));
  const answers = running.map((c) => getArtifact(c));
  await heldUntil(() => held.length === HOST_ARTIFACT_TRANSFERS_MAX);
  const asked = f.channel.calls.length;
  // No place comes free within the wait: refused in the fixed words, no host asked.
  const late = ctx(query, f.s.reader);
  await getArtifact(late);
  assert.deepEqual(late.replies[0], { status: 503, body: { error: HOST_ARTIFACT_REFUSALS.full[1] } });
  // The line holds at most HOST_ARTIFACT_SLOT_WAITERS_MAX: the next is refused without waiting at all.
  const slow = remoteFile(size, { slotWaitMs: 60_000, alter: (reply, req) => (req.offset === ARTIFACTS_CHUNK_BYTES ? new Promise((resolve) => held.push(() => resolve(reply))) : reply) });
  const busy = Array.from({ length: HOST_ARTIFACT_TRANSFERS_MAX }, () => ctx(query, slow.s.reader));
  const busyAnswers = busy.map((c) => getArtifact(c));
  await heldUntil(() => held.length === 2 * HOST_ARTIFACT_TRANSFERS_MAX);
  const line = Array.from({ length: HOST_ARTIFACT_SLOT_WAITERS_MAX }, () => ctx(query, slow.s.reader));
  const lineAnswers = line.map((c) => getArtifact(c));
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const over = ctx(query, slow.s.reader);
  await getArtifact(over);
  assert.deepEqual(over.replies[0], { status: 503, body: { error: HOST_ARTIFACT_REFUSALS.full[1] } });
  assert.ok(line.every((c) => c.replies.length === 0 && !c.res.headersSent), "the line still waits");
  assert.equal(f.channel.calls.length, asked, "the refused requests asked no host");
  // Every transfer ends, and the line is served in turn.
  for (const c of line) c.res.emit("close");
  for (const release of held) release();
  await Promise.all([...answers, ...busyAnswers, ...lineAnswers]);
  for (const c of running) assert.ok(sent(c.res).equals(f.bytes));
  for (const c of busy) assert.ok(sent(c.res).equals(slow.bytes));
});

test("a live tick never asks another host for the card: the page keeps the card it drew, and this host's store is read as before (issue #942)", { timeout: 30_000 }, async () => {
  const bytes = Buffer.from("kept here\n");
  const channel = hostChannel({ manifest: { manifest: manifestOf("gh-9", [entryOf("notes.txt", bytes, "text/plain")]) } });
  const s = store({ live: ["mini2"], channel });
  const record = { jobId: "gh-9", host: "mini2", artifacts: { kept: 1, bytes: bytes.length, dropped: {} } };
  assert.deepEqual(await s.reader.artifacts("gh-9", record, { ask: false }), { unasked: true });
  assert.deepEqual(channel.calls, [], "not asked on a live tick");
  assert.equal((await s.reader.artifacts("gh-9", record)).state, "kept");
  assert.equal(channel.calls.length, 1, "asked when the page is drawn");
  // This host's own store is still read on a live tick, so a run kept here keeps its card current.
  s.put("gh-8", [["a.txt", "a", "text/plain"]]);
  assert.equal((await s.reader.artifacts("gh-8", { jobId: "gh-8", host: "mini1", artifacts: { kept: 1, bytes: 1, dropped: {} } }, { ask: false })).state, "kept");
  // The page: a draw asks, a live tick passes ask: false and leaves the card out of its swap.
  const asks = [];
  const fleet = { runById: async () => ({ record, source: "local" }), runsPage: async () => ({ runs: [], next: null }), artifacts: async (id, rec, opts) => { asks.push(opts.ask); return opts.ask === false ? { unasked: true } : { state: "kept", counts: rec.artifacts, files: [], dropped: {}, keepUntil: null, host: "mini2" }; } };
  const drawn = await loadPageData("run", { id: "gh-9" }, { fleet, now: Date.now() });
  const live = await loadPageData("run", { id: "gh-9" }, { fleet, now: Date.now() }, { live: true });
  assert.deepEqual(asks, [true, false]);
  assert.equal(drawn.artifacts.state, "kept");
  assert.deepEqual([live.artifacts, live.artifactsKept], [null, true]);
  const drawnPanels = await pagePanels("run", { query: { id: "gh-9" }, data: drawn, session: { role: "viewer" } });
  const livePanels = await pagePanels("run", { query: { id: "gh-9" }, data: live, session: { role: "viewer" } });
  assert.ok(drawnPanels.some((panel) => panel.id === "p-artifacts"));
  assert.ok(!livePanels.some((panel) => panel.id === "p-artifacts"), "the card is left as it was drawn");
  assert.ok(livePanels.some((panel) => panel.id === "p-run"), "the other panels are swapped as before");
});

test("the run page waits for the artifacts read under its deadline, handing it the deadline, and draws none for a read that fails (issue #942)", { timeout: 30_000 }, async () => {
  const record = { jobId: "gh-3", kind: "github", target: "acme/web#12", outcome: "completed", host: "mini2", artifacts: { kept: 1, bytes: 2, dropped: {} } };
  const fleet = (artifacts) => ({ runById: async () => ({ record, source: "local" }), runsPage: async () => ({ runs: [], next: null }), artifacts });
  const handed = [];
  const kept = await loadPageData("run", { id: "gh-3" }, { fleet: fleet(async (id, rec, opts) => { handed.push([id, rec === record, typeof opts?.within, opts.within(Infinity) > 0]); return { state: "kept", counts: rec.artifacts, files: [], dropped: {}, keepUntil: null, host: "mini2" }; }), now: Date.now() });
  assert.deepEqual(handed, [["gh-3", true, "function", true]]);
  assert.equal(kept.artifacts.state, "kept");
  const failed = await loadPageData("run", { id: "gh-3" }, { fleet: fleet(async () => { throw new Error("a read that fails"); }), now: Date.now() });
  assert.equal(failed.artifacts, null);
  // A read that never answers is cut once the page's deadline and its grace have passed: the page is drawn without it.
  const time = handTime();
  const loading = loadPageData("run", { id: "gh-3" }, { fleet: fleet(() => new Promise(() => {})), now: Date.now(), deadline: { ms: 100, clock: time.clock, timers: time.timers } });
  await time.advance(5_000);
  const cut = await loading;
  assert.deepEqual([cut.artifacts, cut.deadlineSpent], [null, true]);
});
