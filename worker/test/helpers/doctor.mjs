// The doctor entry points as every test calls them (issue #504 part B). `doctor` reads the applied budget split
// (`alloc:plan`) off the deployment's Valkey whenever it may talk to one, and a test that omits the seam would read the
// DEVELOPER'S real Valkey on 127.0.0.1:6379, so a governed split there turned a hundred unrelated tests red. Here the
// seam defaults to "no split"; a test that wants one passes its own `readAppliedSplit`. A bolt in doctor.test.mjs
// refuses a test file that imports `runDoctor` or `collectChecks` from the source module instead of from here.
import { collectChecks as realCollectChecks, forbidDefaultCapacityRead, forbidDefaultDollarWindowRead, forbidDefaultSubscriptionQuotaRead, runDoctor as realRunDoctor } from "../../src/doctor.mjs";

const NO_SPLIT = async () => null;
// Issue #596, phase 3: the size suggestions read run records, and the default reader reads the logs directory the
// environment names, which with no PI_LOGS_DIR is the DEVELOPER'S real one. Here the seam defaults to "no runs"; a test
// that wants runs passes its own `readRunRecords`, and one that wants the real reader passes `readRunRecords: undefined`.
const NO_RECORDS = () => [];
// Issue #599, phase 2: the capacity line reads the run mirror on the deployment's Valkey and the logs directory, which
// without the seam are the DEVELOPER'S real ones. Here the seam defaults to "no runs, no source"; a test that wants a
// history passes its own `readCapacity`.
// And the default itself is refused in any process that loads this helper, so a test that drops the seam fails loudly.
forbidDefaultCapacityRead();
// Issue #708: the console's liveness probe sends a GET to 127.0.0.1:4790 (or the deployment's PI_CONSOLE_LISTEN), which
// on a developer's host may be a REAL console. Here the seam defaults to "nothing answers"; a test that wants another
// answer passes its own `consoleProbe`.
export const NO_CONSOLE = async () => ({ state: "not-running", target: "127.0.0.1:4790", reason: "nothing listens there" });
export const NO_CAPACITY = async () => ({ records: [], coverage: { source: "local", reason: null, localHost: null, localHosts: [], local: null, mirror: null } });
// Issue #761: the dollar window check reads this host's run records and then the counters on the deployment's Valkey,
// and the older-state lines read the folder's compose file, the account's Quadlet units and the Valkey container's image;
// without the seams those are the DEVELOPER'S real ones. Here they default to "no records" (so no counter is asked
// either) and "nothing older"; a test that wants either passes its own, and the dollar reads' defaults are refused.
forbidDefaultDollarWindowRead();
export const NO_DOLLAR_RECORDS = async () => ({ records: [] });
export const NO_DOLLAR_COUNTERS = async () => null;
export const NO_OLDER_STATE = async () => [];
// Issue #1008: the quota reserve's lines read a connection's quota off the deployment's Valkey, the DEVELOPER'S real one
// without the seam. Here it defaults to "could not be read"; a test that wants a reading passes its own, and the default
// read is refused.
forbidDefaultSubscriptionQuotaRead();
export const NO_SUBSCRIPTION_QUOTA = async () => null;
const QUIET = { readDollarRecords: NO_DOLLAR_RECORDS, readDollarCounters: NO_DOLLAR_COUNTERS, olderStateFindings: NO_OLDER_STATE, readSubscriptionQuota: NO_SUBSCRIPTION_QUOTA };
// Issue #1060: what else doctor sends to the deployment's Valkey, which for a test is the address its doctor env's
// VALKEY_URL names, and 127.0.0.1:6379 when that names none: CI's shared Valkey, or a developer's own Redis. Measured
// before these defaults: six test files opened about 470 connections there in one run, nearly all for the host
// registry, whose read also removes a `host:live` member whose row is gone, so it is not only a read. Here each seam
// defaults to an answer that contacts nothing: Valkey answers the probe, no host is registered, no dollar counter
// exists, no model is cooling down, and a published record goes nowhere. The probe's stand-in also turns off doctor's
// password and owner checks, whose defaults are real only where the probe's is (`runDoctor`). A test that wants
// another answer passes its own seam; one that wants a real read passes the seam as `undefined` and names its own
// Valkey in the doctor env. A test in doctor.test.mjs runs both entry points on these defaults against a listener that
// counts connections, and holds every function of doctor.mjs that opens a client to a seam named here.
export const VALKEY_ANSWERS = async () => true;
export const NO_HOSTS = async () => ({ hosts: [] });
export const NO_DOLLAR_KEYS = async () => false;
export const NO_COOLDOWNS = async () => [];
export const NO_PUBLISH = async () => {};
const NO_VALKEY = { probeValkey: VALKEY_ANSWERS, readHosts: NO_HOSTS, dollarKeysExist: NO_DOLLAR_KEYS, readModelCooldowns: NO_COOLDOWNS, readAppliedSplit: NO_SPLIT };

export function runDoctor(shellVars, deps = {}) {
	return realRunDoctor(shellVars, { ...NO_VALKEY, publishDoctor: NO_PUBLISH, readRunRecords: NO_RECORDS, readCapacity: NO_CAPACITY, consoleProbe: NO_CONSOLE, ...QUIET, ...deps });
}

export function collectChecks(shellVars, seams = {}) {
	return realCollectChecks(shellVars, { ...NO_VALKEY, readRunRecords: NO_RECORDS, readCapacity: NO_CAPACITY, consoleProbe: NO_CONSOLE, ...QUIET, ...seams });
}
