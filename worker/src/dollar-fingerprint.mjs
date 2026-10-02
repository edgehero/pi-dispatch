/**
 * The fingerprint of a host's dollar caps (issue #501, part 6), published on its host registry row as `fpUsd`.
 *
 * WHY THE FLEET NEEDS IT. The dollar counters are shared keys (`budget:usd:*`), as the job-count windows are, but
 * each host reads its CAPS from its own env, its own settings overlay and its own scoped-limits file. Two hosts
 * on one Valkey can therefore judge one counter against two different caps, and the host with the larger cap
 * admits a job the other would refuse. Nothing on the paid path can see that, so `doctor` compares the hosts'
 * fingerprints and warns when they differ, the way it treats the image digest and the timezone.
 *
 * WHAT IT COVERS, which is exactly what decides a dollar admission on a host:
 *   - the four dollar settings (`maxCostUsd` and the three windows): the overlay over env, as a job resolves them.
 *     When the overlay is invalid, or the merged values break the dollar rule, it hashes the env values; such a host
 *     refuses every job (`settings-overlay-invalid`), and env is what it will run under once the file is fixed or
 *     removed (`start.mjs`, the fallback its slot count and its scoped-limits warning take);
 *   - every scoped-limits row that carries a dollar window: the COUNTER it reserves in and its three caps;
 *   - the model rows a job with no list of its own reserves in (PR #551's review): `PI_ALLOWED_MODELS` decides
 *     them (`modelDollarRows`), so two hosts with equal caps and different env lists admit differently. Their
 *     counter prefixes, sorted. With no env list that is every model row; listed as the counters themselves, so
 *     two hosts that reserve in the same counters agree whatever their lists say about models with no row.
 *
 * NUMBERS AND HASHES ONLY, the registry's content rule (`INT-HOST-REGISTRY-CONTRACT`). An amount is hashed as its integer
 * micro-dollars and never appears in clear. A row is named by its dollar key prefix (`budget:usd:s:<hash16>` or `budget:usd:mdl:<hash16>`,
 * `dollarKeyPrefixFor`), never by its scope string: a folder scope is a host path and a repo scope a repository
 * name, and neither may reach a Valkey value even inside a digest's input. The prefix is also the right identity
 * for the comparison, because it is the counter two hosts share: two rows that spell one scope differently but
 * reserve in one counter are one row here.
 *
 * Pure apart from the hash, and it never throws: an amount that does not parse (a value the worker refuses at
 * boot or per job) hashes as the word `invalid`, so a host still publishes a fingerprint and a peer still sees
 * that it differs.
 */

import { fingerprint } from "./fingerprint.mjs";
import { DOLLAR_SETTING_KEYS, optionalUsdMicros } from "./money.mjs";
import { USD_LIMIT_FIELDS, dollarKeyPrefixFor, modelDollarRows } from "./scoped-limits.mjs";

/** An amount as integer micro-dollars, `null` when unset, or `"invalid"`: never the value as written. */
function amount(value, key) {
	try {
		return optionalUsdMicros(value, key);
	} catch {
		return "invalid";
	}
}

/**
 * What the fingerprint hashes, exported so a test can read it: `{ settings, rows, untargeted }`, where `settings` maps
 * each dollar key to micro-dollars or null, `rows` lists every dollar-carrying row as `{ counter, dayUsd, weekUsd,
 * monthUsd }`, sorted by counter, and `untargeted` is the sorted counter prefixes of the model rows a job with no list
 * of its own reserves in under `envList` (the parsed `PI_ALLOWED_MODELS`, or null). Row order in the file is not a
 * cap, so two hosts listing the same rows in a different order agree.
 */
export function usdFingerprintInput(settings, limits, envList = null) {
	const caps = {};
	for (const key of DOLLAR_SETTING_KEYS) caps[key] = amount(settings?.[key], key);
	const rows = [];
	for (const row of Array.isArray(limits) ? limits : []) {
		if (!USD_LIMIT_FIELDS.some((field) => row?.[field] !== null && row?.[field] !== undefined)) continue;
		const windows = {};
		for (const field of USD_LIMIT_FIELDS) windows[field] = amount(row[field], field);
		rows.push({ counter: dollarKeyPrefixFor(row), ...windows });
	}
	rows.sort((a, b) => (a.counter < b.counter ? -1 : a.counter > b.counter ? 1 : 0));
	let untargeted;
	try {
		untargeted = modelDollarRows(Array.isArray(limits) ? limits : [], Array.isArray(envList) ? envList : null).map((row) => row.keyPrefix).sort();
	} catch {
		untargeted = "invalid"; // a row whose amount does not parse: the rows above already say so
	}
	return { settings: caps, rows, untargeted };
}

/** The 16-hex fingerprint `fpUsd` (`fingerprint.mjs`) of a host's dollar settings, scoped-limits rows and env list. */
export function usdFingerprint(settings, limits, envList = null) {
	return fingerprint(usdFingerprintInput(settings, limits, envList));
}

/**
 * The fingerprint of a host with no dollar setting and no dollar row. A peer that publishes no `fpUsd` (it
 * predates this field) is worth a warning only when dollar caps are in use somewhere on the fleet, and this is
 * how a reader tells.
 */
export const EMPTY_USD_FINGERPRINT = usdFingerprint({}, []);
