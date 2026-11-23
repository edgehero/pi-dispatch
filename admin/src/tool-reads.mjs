/** Safe operational reads for models (#766); source objects never pass through by spread. */
import * as rm from "./read-model.mjs";
import { beatAgeOf, doctorHostsOf, firstRunState, FIRST_RUN_COMMANDS } from "./doctor-view.mjs";
import { hostsUnread } from "./console/panels/common.mjs";
import { servesOf, declarationOf, PROPERTIES, BACKEND_NAMES } from "@edgehero/pi-dispatch/backends";
import { heldMoneyOf } from "./insights-assembly.mjs";
import { queueErrorsOf, recordReason } from "./words.mjs";
import { agentReadProjection, agentReasonToken } from "./agent-read.mjs";

let testReads = {};
/** TEST ONLY: process-local I/O injection, never a model tool parameter. */
export function setToolReadDepsForTest(reads = {}) { testReads = reads; }

const id = (x, max = 200) => typeof x === "string" && new RegExp(`^[A-Za-z0-9._:@/-]{1,${max}}$`).test(x) ? x : null;
const n = (x) => (typeof x === "number" || typeof x === "string" && /^\d+$/.test(x)) && Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null;
const fields = (value, names) => Object.fromEntries(names.flatMap((name) => n(value?.[name]) !== null ? [[name, n(value[name])]] : []));

// Unread is not empty (issue #963, the rule of issue #844): each read below answers `null` where a list was not read, and
// `complete` only where the read is known to be whole, so an agent never takes a read that failed for "there is none".
// Each key read here is one the fleet reader sets (`createFleetReader`'s snapshot, `readWaiting`, `readHeldJobs`).

/**
 * The failed jobs (`snapshot({ switchQueues: true }).failed`: `{ rows, more }` or `{ unreachable }`). `whole`: the queues
 * read were every queue the kill switch reaches, so a failed job in a queue the registry no longer names is read too.
 * `complete` only then and with no failed job past the rows (`more` 0).
 */
export function failedForAgent(read, { whole = false } = {}) {
  const rows = !read?.unreachable && Array.isArray(read?.rows) ? read.rows : null;
  const more = n(read?.more);
  return { unavailable: rows === null, more, complete: rows !== null && whole === true && more === 0,
    jobs: rows === null ? null : rows.map((r) => ({ jobId: id(r.jobId), queue: id(r.queue), attempts: n(r.attemptsMade), reason: agentReasonToken(recordReason(r)), supersededBy: id(r.supersededBy) })) };
}

/**
 * The waiting jobs (`readWaiting`'s shape, with the fleet reader's `queuesShort`) or the held ones (`readHeldJobs`':
 * `more`, no `queuesCut`). `complete` only over a read that cut nothing: no list truncated, no row past the listing
 * (`more`), no queue past the bound (`queuesCut`); and, for the waiting jobs, over a set of queues that is whole
 * (`queuesShort` is set when the registry or the keyspace scan behind it was not read).
 */
export function waitingForAgent(read) {
  const rows = !read?.unreachable && Array.isArray(read?.rows) ? read.rows : null;
  const more = n(read?.more);
  const queuesCut = n(read?.queuesCut);
  return { unavailable: rows === null, more, queuesCut,
    complete: rows !== null && read.truncated === false && (more ?? 0) === 0 && (queuesCut ?? 0) === 0 && read.queuesShort !== true,
    jobs: rows === null ? null : rows.map((r) => ({ jobId: id(r.jobId), queue: id(r.queue), reason: agentReasonToken(r.why), due: n(r.dueAt), bucket: id(r.bucket), known: r.known === true, holder: id(r.holder), state: id(r.state) })) };
}

/**
 * The hosts (`snapshot.hostBudgets`, `hostRowOf`'s rows), in four states. Read now: `{ unavailable: false, readAt,
 * hosts }`. Read in part now (issue #1062): the same with `readInPart: true`, a host whose row did not answer marked
 * `notRead` with its last row and no beat. The registry unread now after a good read, which only a reader kept across
 * reads can see (the registered tool builds one per call): the rows as last seen, `unavailable` true and `readAt` the
 * old read's instant. Never read: `{ unavailable: true, readAt: null, hosts: null }`, never `[]`, which says no host
 * exists. A row carries no beat instant, so `beat` is the read's instant less the row's age at it (`beatAgeOf`), or
 * null. A host's `jobs` and `kept` are null where its row says the list is not known, never `[]`.
 *
 * A read in part also NAMES the hosts it did not read (issue #1036): `unreadHosts`, their names, at most the
 * snapshot's (`unreadHostsMore` counts the rest, when there is one), and `hostErrors`, `{ <host>: <code> }` for those
 * whose row Valkey answered with an error, present only when not empty. Such a host may have no row in `hosts` at all
 * (this reader never read it). Whether a later call reads the row is the code's class's to say (`replyErrorClass`,
 * which the tool's description spells out): a key of another type or a missing permission lasts, a busy Valkey passes.
 */
export function hostsForAgent(snapshot) {
  if (hostsUnread(snapshot) || !Array.isArray(snapshot.hostBudgets)) return { unavailable: true, readAt: null, hosts: null };
  const doctors = doctorHostsOf(snapshot);
  const readAt = n(snapshot.hostsReadAt);
  // A registry read in part (issue #1062) is read, not unavailable: `readInPart` says some rows did not answer, and
  // each of those rows (`notRead`, its last one read) has no beat, since `readAt` is not the instant it was read.
  const part = Boolean(snapshot.queue?.fleetDegraded) && snapshot.queue?.registryReadInPart === true;
  const unread = part && Array.isArray(snapshot.queue?.unreadHosts) ? snapshot.queue.unreadHosts.filter((u) => typeof u?.name === "string").map((u) => ({ name: id(u.name, 64), error: rm.replyCodeOf(u.error) })) : [];
  const hostErrors = Object.fromEntries(unread.filter((u) => u.error !== null).map((u) => [u.name, u.error]));
  const more = n(snapshot.queue?.unreadHostsMore);
  return { unavailable: Boolean(snapshot.queue?.fleetDegraded) && !part, ...(part ? { readInPart: true, unreadHosts: unread.map((u) => u.name), ...(more ? { unreadHostsMore: more } : {}), ...(Object.keys(hostErrors).length > 0 ? { hostErrors } : {}) } : {}), readAt, hosts: snapshot.hostBudgets.map((h) => ({
    name: id(h.name, 64), version: id(h.version, 64), ...(h.notRead === true ? { notRead: true } : {}), beat: readAt !== null && h.notRead !== true && beatAgeOf(h) !== null ? readAt - beatAgeOf(h) : null, beatAgeMs: beatAgeOf(h), noExpiry: h.noExpiry === true, skewMs: Number.isFinite(h.skewMs) ? h.skewMs : null,
    capacity: fields(h, ["concurrency", "budgetMemMiB", "budgetCpuCenti", "budgetRunning", "usedMemMiB", "usedCpuCenti", "heldMemMiB", "heldCpuCenti", "waiters", "jobsMore"]),
    // A live job row names its venue as `v` (the worker's `liveJobsOf`, an orphan's alone), a known venue name or nothing.
    jobs: Array.isArray(h.jobs) ? h.jobs.map((j) => ({ jobId: id(j.id), backend: BACKEND_NAMES.includes(j.v) ? j.v : null, orphan: j.o === true, ...fields(j, ["m", "c", "h", "ha", "s"]) })) : null,
    doctor: (() => { const d = doctors.find((row) => row.name === h.name); return { available: Boolean(d && !d.unreadable), at: n(d?.at), ageMs: n(d?.ageMs), ...fields(d?.counts, ["ok", "warn", "fail", "more"]) }; })(),
    budgetFrom: h.budgetFrom ? { memMode: ["auto", "value", "off"].includes(h.budgetFrom.memMode) ? h.budgetFrom.memMode : null, cpuMode: ["auto", "value", "off"].includes(h.budgetFrom.cpuMode) ? h.budgetFrom.cpuMode : null, ...fields(h.budgetFrom, ["memTotalMiB", "memReserveMiB", "cpuTotalCenti", "cpuReserveCenti"]), memFloored: h.budgetFrom.memFloored === true, cpuFloored: h.budgetFrom.cpuFloored === true } : null,
    cpuReserve: Array.isArray(h.cpuReserve) ? h.cpuReserve.map((row) => ({ venue: BACKEND_NAMES.includes(row.venue) ? row.venue : null, status: ["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"].includes(row.status) ? row.status : null, wantCenti: n(row.wantCenti), quotaCenti: n(row.quotaCenti) })) : null,
    venues: (h.backends?.blessed ?? []).filter((name) => BACKEND_NAMES.includes(name)).map((name) => ({ name, serves: servesOf(name), declarations: Object.keys(PROPERTIES).map((property) => {
      const row = declarationOf(name, property);
      return { property: row.property, word: row.word, armedBy: row.armedBy, assertedBy: row.assertedBy, observedBy: row.observedBy };
    }) })),
    // A kept sandbox as `parseSandboxes` gives it: `id`, `v` (its venue), `until`, `pin`.
    kept: Array.isArray(h.sandboxes) ? h.sandboxes.map((r) => ({ id: id(r.id), backend: BACKEND_NAMES.includes(r.v) ? r.v : null, until: n(r.until), pinned: r.pin === true })) : null,
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

/**
 * THE RULE for a read tool whose answer rests on the queues' own reads, over a queue Valkey answered with an error
 * (issue #1064): the answer names the queue and says it is not whole. `queueErrors`, the snapshot's map as a model's
 * copy carries it (`agentReadProjection`'s rule: a name that passes as an id to a code of one word), is added, present
 * only when a queue was left out, and `complete` is false. Before, the snapshot failed whole over such a queue and
 * these tools threw; once it answered, an answer without this would be a queue silently missing: unread drawn as read.
 *
 * Which tools rest on those reads: `dispatch_failed`, whose count past the list is the queues' failed counts, and
 * `dispatch_waiting`, where why a job in the wait list or the prioritized set waits depends on whether its queue is
 * paused, which is not known for such a queue (the waiting read's own look at the flag counts too: `pausedUnread`). `dispatch_status` says the same of its own read (`readQueueState`:
 * `partial`, `unavailableQueues`, `queueErrors`). The other read tools that build a reader answer from the host
 * registry's rows, the files, the run records and Valkey's own counters, none of which a queue's paused state or
 * counts enters, so they answer as over any other fleet and add nothing (a test holds the list to the registered
 * read tools, each against a live key of the wrong type).
 */
function overQueueErrors(answer, snapshot, pausedUnread = []) {
  // The waiting read's own (`readWaiting`'s `pausedUnread`, issue #1036): the queues whose paused flag it could not
  // read, a stopped host's among them, which no other read asks. One answered with an error joins the map by its code;
  // one that got no answer has no code, and the answer is not complete over it either.
  const unread = (Array.isArray(pausedUnread) ? pausedUnread : []).filter((u) => typeof u?.queue === "string");
  const errored = [...queueErrorsOf(snapshot), ...queueErrorsOf({ queueErrors: Object.fromEntries(unread.filter((u) => typeof u.error === "string").map((u) => [u.queue, u.error])) })];
  if (errored.length === 0 && unread.length === 0) return answer;
  return { ...answer, complete: false, queueErrors: agentReadProjection({ queueErrors: Object.fromEntries(errored.map((e) => [e.queue, e.error])) }).queueErrors };
}

export async function readOperationalTool(kind, { paths, env = {}, now = Date.now, fleet: provided, reads = {} } = {}) {
  reads = { ...testReads, ...reads };
  if (kind === "failed" && reads.failed) return failedForAgent(await reads.failed({ url: paths.valkeyUrl }));
  const fleet = provided ?? (reads.fleet ?? rm.createFleetReader)(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: now });
  try {
    // The failed jobs are read over the kill switch's queues (`switchQueues`: the registry's and every queue the keyspace
    // scan finds), so a failed job on a stopped host's queue is listed, within the by-id lookup's bound
    // (`switchLookupBound`: the registry's and as many others as fit beside them in WAITING_QUEUES_MAX), since this runs
    // on every call and a SCAN finds any meta key a writer plants. The set is whole when the registry was read, the scan
    // finished and the bound cut nothing.
    const snapshot = await fleet.snapshot(kind === "waiting" ? { waiting: true } : kind === "failed" ? { switchQueues: true, switchLookupBound: true } : {});
    // A queue that read's paused state or counts Valkey answered with an error (issue #1053; the snapshot's
    // `queueErrors` since issue #1064) is in no count, so the failed total leaves its failed jobs out: how many more
    // there are is not known, and the set is not whole, though its failed list may still be among the rows.
    const errored = queueErrorsOf(snapshot).length > 0;
    if (kind === "failed") return overQueueErrors(failedForAgent(errored && snapshot.failed && !snapshot.failed.unreachable ? { ...snapshot.failed, more: null } : snapshot.failed, { whole: !errored && !snapshot.queue?.fleetDegraded && snapshot.switchTruncated === false && snapshot.switchIncomplete === null }), snapshot);
    if (kind === "waiting") return overQueueErrors(waitingForAgent(snapshot.waiting), snapshot, snapshot.waiting?.pausedUnread);
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


/**
 * The money the live jobs hold today. A registry this read could not read is `unknown`, never $0 held (issue #963):
 * its reader is new, so a degraded read is one that never read the hosts, and their rows are not there to sum.
 */
export async function readHeldForAgent({ paths, env = {}, nowMs, project = null, reads = {} } = {}) {
  reads = { ...testReads, ...reads };
  if (typeof reads.held === "function") return reads.held({ paths, env, nowMs, project });
  const fleet = (reads.fleet ?? rm.createFleetReader)(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: () => nowMs });
  try {
    const snapshot = await fleet.snapshot();
    if (snapshot.queue?.fleetDegraded) return { heldMicros: null, heldJobs: null, unknown: true };
    return heldMoneyOf(snapshot.hostBudgets, { nowMs, project });
  } catch { return { heldMicros: null, heldJobs: null, unknown: true }; }
  finally { await fleet.dispose(); }
}
