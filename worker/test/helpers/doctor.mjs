// The doctor entry points as every test calls them (issue #504 part B). `doctor` reads the applied budget split
// (`alloc:plan`) off the deployment's Valkey whenever it may talk to one, and a test that omits the seam would read the
// DEVELOPER'S real Valkey on 127.0.0.1:6379, so a governed split there turned a hundred unrelated tests red. Here the
// seam defaults to "no split"; a test that wants one passes its own `readAppliedSplit`. A bolt in doctor.test.mjs
// refuses a test file that imports `runDoctor` or `collectChecks` from the source module instead of from here.
import { collectChecks as realCollectChecks, forbidDefaultCapacityRead, runDoctor as realRunDoctor } from "../../src/doctor.mjs";

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
export const NO_CAPACITY = async () => ({ records: [], coverage: { source: "local", reason: null, localHost: null, localHosts: [], local: null, mirror: null } });

export function runDoctor(shellVars, deps = {}) {
	return realRunDoctor(shellVars, { readAppliedSplit: NO_SPLIT, readRunRecords: NO_RECORDS, readCapacity: NO_CAPACITY, ...deps });
}

export function collectChecks(shellVars, seams = {}) {
	return realCollectChecks(shellVars, { readAppliedSplit: NO_SPLIT, readRunRecords: NO_RECORDS, readCapacity: NO_CAPACITY, ...seams });
}
