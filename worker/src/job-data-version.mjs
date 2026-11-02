/**
 * The version of a queued job's data (issue #761, `DES-STORE-VERSION-WHEN-NEEDED`). A LEAF apart from the shared rule,
 * so the receiver can stamp the jobs it stores for later (`fallbackJobOf`) with the same rule the worker's builders use.
 *
 * Jobs outlive an upgrade: a forge job is kept 31 days, a recovery may wait up to 7, held and parked runs wait as long
 * as their conditions do. A field a newer release adds to job data is DROPPED by an older worker's builders and IGNORED
 * by its processor, which for a field that narrows a job (a model list, a cost cap) is a wider job, run and paid for.
 * `trigger-skew` catches that only for the fields it lists, and only for forge jobs. So a field whose absence an older
 * worker would misread declares the version that introduced it here, the builders stamp `dataVersion` with the lowest
 * version the data needs, and a worker that meets a version above its own DEFERS the job (`newer-release`) rather than
 * run it: the job waits, with its reason shown, for a worker that can read it, and nothing is spent or lost.
 *
 * Unversioned on purpose: answer-draft, watch and question-grouping jobs carry only references their runtime resolves at
 * pickup, and sandbox prepare requests live 30 minutes on their own host's queue.
 */
import { neededVersion, valueNeededVersion } from "./store-version.mjs";

/** The highest job data version this build reads. */
export const JOB_DATA_VERSION = 1;

/** Each job data field that needs a version above 1, with the version that introduced it. Empty until one does. */
export const JOB_DATA_FIELD_VERSIONS = Object.freeze({});

/**
 * Each EXISTING top-level field whose range a later release widens, as `field -> (value) => version` (the shared rule,
 * `valueNeededVersion`): a new condition kind in `waitFor`, say, or a new `kind` (a forge this build has no credentials
 * for, refused `config-refused` at the mint). An older worker meeting the wider value would refuse the job (a comment, a
 * record, a disarmed one-shot) where a stamp makes it defer. Empty until one does.
 */
export const JOB_DATA_VALUE_VERSIONS = Object.freeze({});

/** The field that carries the version. */
export const JOB_DATA_VERSION_FIELD = "dataVersion";

/** The lowest version `data` needs, from its top-level fields and their values: 1 while nothing in it needs more. */
export function jobDataVersionFor(data, { table = JOB_DATA_FIELD_VERSIONS, valueTable = JOB_DATA_VALUE_VERSIONS } = {}) {
	if (data === null || typeof data !== "object") return 1;
	const { [JOB_DATA_VERSION_FIELD]: _version, ...fields } = data;
	return Math.max(neededVersion(Object.keys(fields), table), valueNeededVersion(fields, valueTable));
}

/**
 * Whether `data` carries a `dataVersion` this build cannot read, as `{ version }`, else null: a version newer than
 * `supported` (a newer worker's job: `{ version: N }`), or a value that is not a whole number of 1 or more (`null`,
 * `"1"`, `1.5`, `0`: `{ version: null }`), which no release writes.
 * A missing `dataVersion` is version 1. The caller defers such a job, malformed included: the hold spends nothing and
 * an operator can cancel it, while running it would guess at data nothing here wrote. It never reads the rest first.
 */
export function jobDataNewer(data, { supported = JOB_DATA_VERSION } = {}) {
	if (data === null || typeof data !== "object" || !Object.hasOwn(data, JOB_DATA_VERSION_FIELD)) return null;
	const version = data[JOB_DATA_VERSION_FIELD];
	if (Number.isSafeInteger(version) && version >= 1 && version <= supported) return null;
	return { version: Number.isSafeInteger(version) && version >= 1 ? version : null };
}

/**
 * `data` with `dataVersion` set to the version it needs: the higher of the version it arrived with (a job a newer
 * release stored, re-enqueued here) and the one its fields and values need, and no field at all while that is 1. Throws
 * a RangeError when the data arrived with a version this build cannot read (`jobDataNewer`: newer, or malformed), so a
 * builder never re-enqueues a newer job under a lower version and erases the evidence its fields were dropped.
 */
export function withJobDataVersion(data, { table = JOB_DATA_FIELD_VERSIONS, valueTable = JOB_DATA_VALUE_VERSIONS, supported = JOB_DATA_VERSION } = {}) {
	if (jobDataNewer(data, { supported })) throw new RangeError(`job data carries a ${JOB_DATA_VERSION_FIELD} this build cannot read (newer than ${supported}, or not a whole number of 1 or more), so it cannot rebuild it`);
	const declared = data?.[JOB_DATA_VERSION_FIELD];
	const needed = Math.max(Number.isSafeInteger(declared) ? declared : 1, jobDataVersionFor(data, { table, valueTable }));
	const { [JOB_DATA_VERSION_FIELD]: _drop, ...rest } = data ?? {};
	return needed > 1 ? { ...rest, [JOB_DATA_VERSION_FIELD]: needed } : rest;
}
