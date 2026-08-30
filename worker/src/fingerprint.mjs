/**
 * Canonical fingerprints of configuration, so two hosts can find out whether they agree (issue #57).
 *
 * Pure, and importing nothing but `node:crypto`: a fingerprint must be computable in a tier-1 test with
 * no queue, no Valkey and no filesystem, exactly as `parseTriggers` is.
 *
 * WHY A HASH RATHER THAN THE VALUE. Two of these travel through the host registry, whose content rule
 * refuses paths outright (`INT-HOST-REGISTRY-CONTRACT`) -- and a cron schedule set legitimately contains
 * `run.folder`, `run.task` and secret NAMES. Hashing is what makes them admissible: the registry carries
 * proof of agreement rather than the thing agreed on. This is the inverse of `scopeKeyPrefix`'s argument,
 * which hashes a scope because it may contain `:` and `/`; here the reason is disclosure, not syntax.
 */

import { createHash } from "node:crypto";

/**
 * A stable 16-hex digest of any JSON-able value.
 *
 * Object keys are sorted RECURSIVELY, and that is load-bearing rather than tidy. `normalizeCronSchedule`
 * builds its `data` object as a literal, so its key ORDER is a property of the worker's source: two hosts
 * mid-upgrade would otherwise canonicalise the same file differently and refuse each other for the whole
 * rollout. Sorting removes the spurious disagreement while leaving the real one -- a genuinely new field
 * still changes the hash, which is correct, because the stored repeatable's data really did change.
 *
 * Sixteen hex, the `scopeKeyPrefix` and `localJobId` idiom, because this is compared and displayed rather
 * than used as a security boundary.
 */
export function fingerprint(value) {
	return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

function canonical(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/**
 * The fingerprint of a worker's cron schedule set, or `null` when this worker has no opinion.
 *
 * ABSTAIN VERSUS OPINE IS THE SUBTLE PART, and conflating the two would leave the bug this gate exists to
 * close. `loadSchedules` returns `[]` for two different states:
 *
 *   - `PI_TRIGGERS_FILE` unset, which means CRON IS DISABLED on this host. Such a worker has no view of
 *     what should be scheduled, so it must never be able to disagree with one that does. It ABSTAINS.
 *   - a triggers file that is present and declares zero cron entries. That is an OPINION -- "there should
 *     be no schedulers" -- and it is this bug's purest form: today, deleting the last cron trigger on one
 *     host prunes the whole fleet's schedulers through the file-watch path.
 *
 * So `null` in means abstain (`null` out); an empty ARRAY is a real fingerprint.
 *
 * The `tz` rides the hash because a cron PATTERN carries no timezone: `triggers.json` has no `tz` field on
 * a cron entry, and BullMQ hands the pattern to cron-parser with no zone, so it resolves in each worker's
 * LOCAL system time. On one host that is exactly what an operator means; on two hosts in different zones
 * the same pattern is two different instants, with nothing anywhere saying so. Including the zone makes
 * that a disagreement the gate can see. (`pause-windows.json` has carried an explicit `tz` since it
 * shipped and is already fleet-correct; the asymmetry is why this one needs stating.)
 *
 * Fingerprinted over the NORMALIZED schedules rather than the file's bytes, deliberately. Bytes diverge on
 * whitespace, on key order, and on every webhook trigger the worker does not own -- so two hosts differing
 * only in a `label` rule would freeze cron forever over a difference that cannot affect it. The normalized
 * set diverges exactly when the reconcile INPUTS diverge, which is the property that makes reconcile
 * idempotent in the first place.
 */
export function cronFingerprint(schedules, { tz } = {}) {
	if (schedules === null || schedules === undefined) return null;
	return fingerprint({
		tz: tz ?? "",
		schedules: schedules.map((s) => ({ schedulerId: s.schedulerId, name: s.name, pattern: s.pattern, data: s.data, opts: s.opts })),
	});
}
