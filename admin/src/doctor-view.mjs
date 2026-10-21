/**
 * The published doctor results as the console and the `/dispatch` panel read them (issue #712, `INT-DOCTOR-RESULTS-KEY`).
 *
 * Pure: the snapshot's `doctor` field (`readDoctorResults`, already through the worker's allowlist) in, words and rows
 * out. Both surfaces share these so they cannot disagree about when a result is stale or which check a sentence quotes.
 * Every label here is another host's text, redacted at the source; each surface still escapes it as untrusted.
 */

const HOUR = 3_600_000;

/**
 * A result is STALE once it is older than this many of its host's own doctor intervals: one missed daily run is a
 * worker that was down for a while, two is a host whose results no longer describe it. A host whose interval is 0 (the
 * worker runs no doctor) or unknown is never called stale: only an operator's run publishes there, and its age is shown.
 */
export const DOCTOR_STALE_INTERVALS = 2;

/** How many warn and fail checks a host's block lists before it counts the rest. */
export const DOCTOR_CHECKS_SHOWN = 8;

/**
 * The checks the console's "does not load" sentences quote, by the file each sentence names: the worker's
 * `NAMED_CHECK_IDS` for the service's verdict on that file. Pinned against the worker's list by a test.
 */
export const DOCTOR_FILE_CHECKS = Object.freeze({
  "triggers file": "triggers.file",
  "pause-windows file": "pause-windows.file",
  "scoped-limits file": "scoped-limits.file",
  "projects file": "projects.file",
  "settings overlay": "settings.overlay",
});

/** The snapshot's doctor rows, readable ones first by name; `[]` when nothing was published or read. */
export function doctorHostsOf(snapshot) {
  const rows = Array.isArray(snapshot?.doctor?.hosts) ? snapshot.doctor.hosts : [];
  return rows.filter((r) => r && typeof r.name === "string");
}

/** Whether a row is older than `DOCTOR_STALE_INTERVALS` of its own interval. */
export function doctorStale(row) {
  return Number.isSafeInteger(row?.every) && row.every > 0 && Number.isSafeInteger(row?.ageMs) && row.ageMs > DOCTOR_STALE_INTERVALS * row.every * HOUR;
}

/** A row's counts in words: `2 failing, 1 warning, 40 passing`, the failing first. */
export function doctorCountsText(row) {
  const c = row?.counts ?? {};
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return `${n(c.fail)} failing, ${n(c.warn)} warning${n(c.warn) === 1 ? "" : "s"}, ${n(c.ok)} passing`;
}

/** A row's warn and fail checks, failing first, each `{ id, level, label, fix }`; ok checks are never listed. */
export function doctorProblems(row) {
  const list = Array.isArray(row?.checks) ? row.checks.filter((c) => c && c.level !== "ok") : [];
  return [...list.filter((c) => c.level === "fail"), ...list.filter((c) => c.level === "warn")];
}

/** This console's own host name as the worker names it (`doctorSelf`, the fleet reader's), or null. */
function selfOf(snapshot) {
  return typeof snapshot?.doctorSelf === "string" && snapshot.doctorSelf !== "" ? snapshot.doctorSelf : null;
}

/**
 * The published check a sentence quotes, `{ host, own, ageMs, level, label, fix }`, or null. The files are per host, so
 * THIS host's record decides first (`doctorSelf`, named by the worker's rule): its warn or fail for `id` is quoted as
 * its own; its ok result for `id` quotes nothing (the run that saw the file load is newer evidence than another host's
 * failure, and the sentence then falls back to "run pi-dispatch doctor"). Only where this host's record does not judge
 * that file at all is another host's newest warn or fail quoted, marked `own: false` so the sentence says it is that
 * host's own copy.
 */
export function doctorQuote(snapshot, id) {
  const rows = doctorHostsOf(snapshot).filter((r) => !r.unreadable);
  const pick = (row) => (Array.isArray(row?.checks) ? row.checks : []).find((c) => c?.id === id) ?? null;
  const quote = (row, hit, own) => ({ host: row.name, own, ageMs: Number.isSafeInteger(row.ageMs) ? row.ageMs : Number.MAX_SAFE_INTEGER, level: hit.level, label: hit.label, fix: typeof hit.fix === "string" ? hit.fix : null });
  const usable = (hit) => hit && hit.level !== "ok" && typeof hit.label === "string" && hit.label !== "";
  const self = selfOf(snapshot);
  const mine = self === null ? null : rows.find((r) => r.name === self);
  const myHit = pick(mine);
  if (myHit) return usable(myHit) ? quote(mine, myHit, true) : null;
  let best = null;
  for (const row of rows) {
    if (row.name === self) continue;
    const hit = pick(row);
    if (!usable(hit)) continue;
    const q = quote(row, hit, false);
    if (best === null || q.ageMs < best.ageMs) best = q;
  }
  return best;
}

/** Who ran a result, in words: the worker, or an operator's account (with its uid where the platform has one). */
export function doctorByText(row) {
  if (row?.by?.worker === true) return "run by the worker";
  return Number.isSafeInteger(row?.by?.uid) ? `run by hand (uid ${row.by.uid})` : "run by hand";
}
