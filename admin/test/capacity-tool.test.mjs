import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCapacity } from "@edgehero/pi-dispatch/capacity-cli";
import { RUNS_INDEX, runRecordKey } from "@edgehero/pi-dispatch/run-mirror";
import { readCapacity } from "../src/read-model.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// `dispatch_capacity` (issue #599, phase 2): the CLI's read and function behind a tool. Every collaborator injected, the
// clock too; the Valkey is a fake that holds a registry row and a run mirror and records every command it is sent.

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const H = 60 * 60 * 1000;
const CAP = { slots: 2, memMiB: 16384, cpuCenti: 800, cpus: 8 };
const run = (jobId, host, from, to) => ({ jobId, host, project: "web", startedAt: new Date(NOW - from * H).toISOString(), endedAt: new Date(NOW - to * H).toISOString(), queuedAt: new Date(NOW - from * H - 40_000).toISOString(), size: { memMiB: 4096, cpuCenti: 200, source: "env" }, capacity: CAP });

function fakeValkey(records, rows) {
  const calls = [];
  const index = records.map((r) => [r.jobId, Date.parse(r.endedAt)]).sort((a, b) => a[1] - b[1]);
  const kv = new Map(records.map((r) => [runRecordKey(r.jobId), JSON.stringify(r)]));
  const say = (name, v) => (calls.push(name), Promise.resolve(v));
  return {
    calls,
    on() {},
    disconnect: () => calls.push("disconnect"),
    smembers: () => say("smembers", [...rows.map((r) => r.name), "ghost"]), // a member whose row expired: a pruning reader would SREM it
    hgetall: (key) => say("hgetall", rows.find((r) => `host:h:${r.name}` === key) ?? {}),
    srem: () => say("WRITE srem"),
    zcard: (key) => say("zcard", key === RUNS_INDEX ? index.length : 0),
    zrange: () => say("zrange", index.length ? [index[0][0], String(index[0][1])] : []),
    zscore: () => say("zscore", null),
    zrevrangebyscore: (_k, _max, min) => say("zrevrangebyscore", index.filter(([, s]) => s > Number(min.slice(1))).reverse().flatMap(([id, s]) => [id, String(s)])),
    mget: (...keys) => say("mget", keys.map((k) => kv.get(k) ?? null)),
  };
}

function fixture() {
  const dir = tempDir("pi-cap-tool-");
  const local = run("l1", "mini1", 5, 4);
  const p = join(dir, "l1.json");
  writeFileSync(p, JSON.stringify(local));
  utimesSync(p, NOW / 1000, NOW / 1000);
  const rows = [
    { name: "mini1", routes: "true", concurrency: "2", beatAt: String(NOW - 1000), jobs: JSON.stringify([{ id: "gh-now", p: "web", m: 4096, c: 200, at: NOW - H }]), jobsMore: "0" },
    { name: "mini2", routes: "true", concurrency: "2", beatAt: String(NOW - 1000), jobs: "[]", jobsMore: "0" },
  ];
  const env = { PI_LOGS_DIR: dir, PI_WORKER_NAME: "mini1", PI_LOG_RETENTION_DAYS: "30" };
  return { env, records: [run("m1", "mini2", 3, 2), local], rows };
}

test("readCapacity: the same report the CLI prints, the running job counted, and nothing written", async () => {
  const { env, records, rows } = fixture();
  const valkey = fakeValkey(records, rows);
  const res = await readCapacity({ url: "redis://127.0.0.1:6399", env, window: "24h", now: () => NOW, redisFn: () => valkey });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.report.hosts.map((h) => [h.name, h.busyMs, h.coverage.live]), [["mini1", 2 * H, 1], ["mini2", H, 0]]);
  assert.match(res.text, /^Host mini1, last 24h\n/);
  assert.match(res.text, /1 job running now, counted as busy up to now/);
  assert.deepEqual(valkey.calls.filter((c) => c.startsWith("WRITE")), [], "read-only: no prune, no write");
  assert.equal(valkey.calls.at(-1), "disconnect");

  // The CLI over the same Valkey and files prints this very report.
  const out = [];
  const cli = fakeValkey(records, rows);
  const code = await runCapacity(["--since", "24h", "--json"], { env, write: (c) => out.push(c), errWrite: () => {}, now: () => NOW, pickUrls: () => ({ urls: ["redis://127.0.0.1:6399"], disagreement: null, note: null }), redisFn: () => cli });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.join("")), res.report);
});

test("readCapacity: one host, an unknown host, a window it does not offer, and an unreachable Valkey", async () => {
  const { env, records, rows } = fixture();
  const one = await readCapacity({ url: "redis://127.0.0.1:6399", env, window: "7d", host: "mini2", now: () => NOW, redisFn: () => fakeValkey(records, rows) });
  assert.deepEqual(one.report.hosts.map((h) => h.name), ["mini2"]);
  const unknown = await readCapacity({ url: "redis://127.0.0.1:6399", env, host: "mini9", now: () => NOW, redisFn: () => fakeValkey(records, rows) });
  assert.equal(unknown.error, 'no host named "mini9" in the last 7d (hosts: mini1, mini2)');
  assert.match((await readCapacity({ url: "redis://x", env, window: "1y" })).error, /^window must be one of 24h, 7d, 30d/);
  assert.match((await readCapacity({ url: "redis://x", env: { ...env, PI_LOG_RETENTION_DAYS: "soon" } })).error, /PI_LOG_RETENTION_DAYS/);
  // A URL that is not one: this host's files, and the reason.
  const local = await readCapacity({ url: "not a url", env, window: "24h", now: () => NOW });
  assert.equal(local.report.coverage.source, "local");
  assert.match(local.report.coverage.reason, /the Valkey URL is not usable/);
  assert.deepEqual(local.report.hosts.map((h) => h.name), ["mini1"]);
});
