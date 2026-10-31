/** Safe operational reads for models (#766); source objects never pass through by spread. */
import * as rm from "./read-model.mjs";
import { doctorHostsOf, firstRunState, FIRST_RUN_COMMANDS } from "./doctor-view.mjs";
import { servesOf, declarationOf, PROPERTIES, BACKEND_NAMES } from "@edgehero/pi-dispatch/backends";
import { heldMoneyOf } from "./insights-assembly.mjs";
import { recordReason } from "./words.mjs";
import { agentReasonToken } from "./agent-read.mjs";

let testReads = {};
/** TEST ONLY: process-local I/O injection, never a model tool parameter. */
export function setToolReadDepsForTest(reads = {}) { testReads = reads; }

const id = (x, max = 200) => typeof x === "string" && new RegExp(`^[A-Za-z0-9._:@/-]{1,${max}}$`).test(x) ? x : null;
const n = (x) => (typeof x === "number" || typeof x === "string" && /^\d+$/.test(x)) && Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null;
const fields = (value, names) => Object.fromEntries(names.flatMap((name) => n(value?.[name]) !== null ? [[name, n(value[name])]] : []));

export function failedForAgent(read) {
  return { unavailable: Boolean(read?.unreachable || read?.invalid), more: n(read?.more), complete: read?.examinedAll === true,
    jobs: (read?.jobs ?? read?.rows ?? []).map((r) => ({ jobId: id(r.jobId), queue: id(r.queue), attempts: n(r.attemptsMade), reason: agentReasonToken(recordReason(r)) })) };
}

export function waitingForAgent(read) {
  return { unavailable: Boolean(read?.unreachable), more: n(read?.more), complete: read?.truncated === false && !read?.unreachable,
    jobs: (read?.rows ?? []).map((r) => ({ jobId: id(r.jobId), queue: id(r.queue), reason: agentReasonToken(r.why ?? r.reason), due: n(r.dueAt ?? r.dueMs ?? r.due), bucket: id(r.bucket), known: r.known === true, holder: id(r.holder), state: id(r.state) })) };
}

export function hostsForAgent(snapshot) {
  const doctors = doctorHostsOf(snapshot);
  return { unavailable: Boolean(snapshot?.fleetDegraded), hosts: (snapshot?.hostBudgets ?? []).map((h) => ({
    name: id(h.name, 64), version: id(h.version, 64), beat: n(h.beat ?? h.lastBeat), beatAgeMs: n(h.ttlAgeMs ?? h.staleMs), noExpiry: h.noExpiry === true, skewMs: Number.isFinite(h.skewMs) ? h.skewMs : null,
    capacity: fields(h, ["concurrency", "budgetMemMiB", "budgetCpuCenti", "budgetRunning", "usedMemMiB", "usedCpuCenti", "heldMemMiB", "heldCpuCenti", "waiters", "jobsMore"]),
    jobs: (h.jobs ?? []).map((j) => ({ jobId: id(j.id), backend: id(j.b), orphan: j.o === true, ...fields(j, ["m", "c", "h", "ha", "s"]) })),
    doctor: (() => { const d = doctors.find((row) => row.name === h.name); return { available: Boolean(d && !d.unreadable), at: n(d?.at), ageMs: n(d?.ageMs), ...fields(d?.counts, ["ok", "warn", "fail", "more"]) }; })(),
    budgetFrom: h.budgetFrom ? { memMode: ["auto", "value", "off"].includes(h.budgetFrom.memMode) ? h.budgetFrom.memMode : null, cpuMode: ["auto", "value", "off"].includes(h.budgetFrom.cpuMode) ? h.budgetFrom.cpuMode : null, ...fields(h.budgetFrom, ["memTotalMiB", "memReserveMiB", "cpuTotalCenti", "cpuReserveCenti"]), memFloored: h.budgetFrom.memFloored === true, cpuFloored: h.budgetFrom.cpuFloored === true } : null,
    cpuReserve: Array.isArray(h.cpuReserve) ? h.cpuReserve.map((row) => ({ venue: BACKEND_NAMES.includes(row.venue) ? row.venue : null, status: ["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"].includes(row.status) ? row.status : null, wantCenti: n(row.wantCenti), quotaCenti: n(row.quotaCenti) })) : null,
    venues: (h.backends?.blessed ?? []).filter((name) => BACKEND_NAMES.includes(name)).map((name) => ({ name, serves: servesOf(name), declarations: Object.keys(PROPERTIES).map((property) => {
      const row = declarationOf(name, property);
      return { property: row.property, word: row.word, armedBy: row.armedBy, assertedBy: row.assertedBy, observedBy: row.observedBy };
    }) })),
    kept: (h.sandboxes ?? []).map((r) => ({ id: id(r.id ?? r.jobId), backend: id(r.v ?? r.backend), until: n(r.until), pinned: r.pin === true || r.pinned === true })),
    keptMore: n(h.sandboxesMore), retentionHours: n(h.sandboxRetentionHours), jobsUnreadable: h.jobsUnreadable === true,
  })) };
}

export function setupForAgent(snapshot, { deployment = null } = {}) {
  const view = firstRunState(snapshot, { session: { role: "viewer" }, deployment });
  return { applies: view.applies === true, ready: n(view.ready), total: n(view.total), steps: (view.steps ?? []).map((step) => ({
    id: id(step.id), state: id(step.state),
    // Catalogue identity, not doctor text or a payload-shaped arbitrary argv.
    commands: (step.commands ?? []).filter((argv) => Object.values(FIRST_RUN_COMMANDS).some((known) => known === argv)).map((argv) => [...argv]),
  })) };
}

export async function readOperationalTool(kind, { paths, env = {}, now = Date.now, fleet: provided, reads = {} } = {}) {
  reads = { ...testReads, ...reads };
  if (kind === "failed" && reads.failed) return failedForAgent(await reads.failed({ url: paths.valkeyUrl }));
  const fleet = provided ?? (reads.fleet ?? rm.createFleetReader)(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: now });
  try {
    const snapshot = await fleet.snapshot(kind === "waiting" ? { waiting: true } : {});
    if (kind === "failed") return failedForAgent(snapshot.failed);
    if (kind === "waiting") return waitingForAgent(snapshot.waiting);
    if (kind === "hosts") return hostsForAgent(snapshot);
    if (kind === "setup") return setupForAgent(snapshot);
    throw new RangeError("unknown operational tool");
  } finally { if (!provided) await fleet.dispose(); }
}

/** Local retention is reported only by this host's manifest reader; a foreign host is never guessed. */
export function runForAgent(record, { retention = null, self = null } = {}) {
  const projected = rm.modelRunRecord(record);
  if (!projected || typeof projected !== "object") return projected;
  const out = { ...projected };
  if (retention && (record.host === null || record.host === undefined || record.host === self)) {
    const retained = retention(record.jobId);
    if (retained?.retained === true) out.keptUntil = retained.until;
  }
  return out;
}


export async function readHeldForAgent({ paths, env = {}, nowMs, project = null } = {}) {
  if (typeof testReads.held === "function") return testReads.held({ paths, env, nowMs, project });
  const fleet = rm.createFleetReader(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: () => nowMs });
  try {
    const snapshot = await fleet.snapshot();
    return heldMoneyOf(snapshot.hostBudgets, { nowMs, project });
  } catch { return { heldMicros: null, heldJobs: null, unknown: true }; }
  finally { await fleet.dispose(); }
}
