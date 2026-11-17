import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as TRIGGERS from "../src/triggers.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { makeCheckPrivateEndpoints } from "../src/triggers-file.mjs";
import { localRunData } from "../src/local-job.mjs";
import { buildLocalEventJob } from "../src/local-event.mjs";
import { JOB_DATA_VERSION, withJobDataVersion } from "../src/job-data-version.mjs";

// Issue #918: `run.privateEndpoints`, the private endpoints a trigger's jobs may reach, and the live recheck before each
// attempt (`makeCheckPrivateEndpoints`).

const doc = (triggers, version = TRIGGERS_FILE_VERSION) => JSON.stringify({ version, triggers });
const load = (entry, version) => parseTriggers(doc([entry], version), "/triggers.json")[0];
const LABEL = { on: { type: "label", any: ["hil"] }, run: { kind: "github", flow: "test-on-device", privateEndpoints: ["bench-device"] } };
const CRON = { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/app", flow: "test-on-device", task: "run the device suite", privateEndpoints: ["bench-device", "lab"] } };

test("run.privateEndpoints loads on forge and cron triggers, needs file version 7, and rides local job data", () => {
	assert.equal(TRIGGERS_FILE_VERSION, 7);
	assert.deepEqual(load(LABEL).run.privateEndpoints, ["bench-device"]);
	assert.deepEqual(load(CRON).run.privateEndpoints, ["bench-device", "lab"]);
	assert.throws(() => load(LABEL, 6), /run\.privateEndpoints needs triggers file version 7, and the file declares 6/);
	const data = withJobDataVersion({ ...localRunData(load(CRON).run), trigger: { id: "nightly" } });
	assert.deepEqual(data.privateEndpoints, ["bench-device", "lab"]);
	assert.equal(data.dataVersion, JOB_DATA_VERSION, "a job carrying it is stamped with the version that knows it");
	assert.equal(load({ on: LABEL.on, run: { kind: "github", flow: "x" } }).run.privateEndpoints, undefined, "absent means none");
});

test("run.privateEndpoints refuses anything but 1 to 8 unique ids, and a near miss is refused rather than dropped", () => {
	const at = (privateEndpoints) => () => load({ on: LABEL.on, run: { kind: "github", flow: "x", privateEndpoints } });
	assert.throws(at([]), /must be a non-empty array of ids from private-endpoints\.json/);
	assert.throws(at("bench-device"), /must be a non-empty array/);
	assert.throws(at(["Bench"]), /must be the id of an endpoint in private-endpoints\.json/);
	assert.throws(at(["a", "a"]), /names "a" twice/);
	assert.throws(at(Array.from({ length: 9 }, (_, i) => `d${i}`)), /names 9 endpoints, more than 8/);
	for (const key of ["endpoints", "privateEndpoint", "private_endpoints", "endpoint"]) {
		assert.throws(() => load({ on: LABEL.on, run: { kind: "github", flow: "x", [key]: ["bench-device"] } }), /did you mean run\.privateEndpoints\?/, key);
	}
	assert.throws(() => load({ on: { ...LABEL.on, privateEndpoints: ["x"] }, run: { kind: "github", flow: "x" } }), /on\.privateEndpoints is not a field/);
	// Outside plain ASCII: a lookalike spelling is refused, a short word in another script is not one.
	const { isPrivateEndpointsNearMiss } = TRIGGERS;
	assert.equal(isPrivateEndpointsNearMiss("\u0440rivateEndpoints"), true, "a Cyrillic er for the p");
	assert.equal(isPrivateEndpointsNearMiss("\u0435ndpoint"), true, "the shortest spelling, 8 characters");
	assert.equal(isPrivateEndpointsNearMiss("\u00e9t\u00e9"), false, "too short to be drawn like any spelling");
	assert.equal(isPrivateEndpointsNearMiss("privateEndpoints"), false, "the field itself");
	assert.equal(isPrivateEndpointsNearMiss("pr\u043evider"), false, "a lookalike of run.provider is the model keys' to name");
	assert.equal(isPrivateEndpointsNearMiss("\u0435ndpoitn"), false, "letters out of place");
	// An invisible character, or a separator the ASCII skeleton drops, cannot carry the field past the sweep.
	for (const key of ["private\u200bEndpoints", "privateEndpoints\u200b", "private\u00adEndpoints", "private\u2060Endpoints", "privateEndpoints\ufeff", "private:\u0415ndpoints", "private/\u0415ndpoints"]) {
		assert.equal(isPrivateEndpointsNearMiss(key), true, JSON.stringify(key));
		assert.throws(() => load({ on: LABEL.on, run: { kind: "github", flow: "x", [key]: ["bench-device"] } }), /privateEndpoints/, JSON.stringify(key));
	}
	// A watch trigger's run keys are a closed list that leaves it out, so a watch job reaches no device.
	const watchAllowed = /const allowed = new Set\((\[[^\]]*\])\);/.exec(readFileSync(new URL("../src/triggers.mjs", import.meta.url), "utf8"))?.[1];
	assert.ok(watchAllowed && !JSON.parse(watchAllowed).includes("privateEndpoints"));
});

/** A check over a fake triggers file the test can rewrite. */
function checkOver(entries, version = TRIGGERS_FILE_VERSION) {
	let text = doc(entries, version);
	let error = null;
	const fs = { readFileSync: () => { if (error) throw error; return text; } };
	const check = makeCheckPrivateEndpoints({ triggersPath: "/triggers.json", fs });
	return { check, set: (next) => { text = next; }, fail: (e) => { error = e; } };
}

// A forge job as the receiver queues it: its flow, and what it matched (index, type, label).
const forgeJob = (over = {}) => ({ kind: "github", flow: "test-on-device", privateEndpoints: ["bench-device"], target: { type: "issue", number: 7 }, trigger: { matched: { index: 0, type: "label", label: "hil" } }, ...over });

test("the live recheck grants a forge job what its matched entry still names, and withdraws what it stopped naming", () => {
	const job = forgeJob();
	const { check, set } = checkOver([LABEL]);
	assert.deepEqual(check(job), { ok: true, ids: ["bench-device"] });
	assert.deepEqual(check({ kind: "github" }), { ok: true, ids: [] }, "a job that carries none needs nothing");
	set(doc([{ ...LABEL, run: { ...LABEL.run, privateEndpoints: ["lab"] } }]));
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "named no more");
	set(doc([{ ...LABEL, run: { ...LABEL.run, privateEndpoints: ["bench-device", "lab"] } }]));
	assert.deepEqual(check(job), { ok: true, ids: ["bench-device"] }, "an id added since is not granted to a job queued before it");
	set(doc([{ ...LABEL, run: { kind: "gitlab", flow: "test-on-device", privateEndpoints: ["bench-device"] } }]));
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "another kind at that index is another trigger");
	set(doc([{ on: { type: "label", any: ["other"] }, run: LABEL.run }]));
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "the label it matched is gone from the entry");
	set(doc([]));
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "the entry is gone");
});

test("the grant follows the trigger, never its position: an entry deleted above moves another trigger to the index (#918 review)", () => {
	const job = forgeJob();
	const other = { on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "cleanup", privateEndpoints: ["bench-device"] } };
	const { check, set } = checkOver([LABEL, other]);
	assert.deepEqual(check(job), { ok: true, ids: ["bench-device"] });
	set(doc([other]));
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "another type and flow at index 0 is another trigger");
	set(doc([{ on: LABEL.on, run: { ...LABEL.run, flow: "cleanup" } }]));
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "the same type dispatching another flow is another trigger");
	// GitLab names a merge request rule matched by a changed label a label match: still that rule.
	const mr = { on: { type: "pull_request", action: ["update"], any: ["hil"] }, run: { kind: "gitlab", flow: "test-on-device", privateEndpoints: ["bench-device"] } };
	assert.deepEqual(checkOver([mr]).check(forgeJob({ kind: "gitlab", target: { type: "pull_request", number: 3 } })), { ok: true, ids: ["bench-device"] });
});

test("a one-shot's own retry keeps its grant after its first attempt spent the trigger, and any other disarm withdraws it (#918 review)", () => {
	const once = { on: { type: "issue", action: ["closed"], once: true, number: 7 }, run: { kind: "github", flow: "test-on-device", privateEndpoints: ["bench-device"] } };
	const job = forgeJob({ trigger: { matched: { index: 0, type: "issue", action: "closed" } } });
	const spent = (jobId) => doc([{ ...once, on: { ...once.on, disarmed: { at: "2026-11-16T10:00:00.000Z", jobId } } }]);
	const { check, set } = checkOver([once]);
	assert.deepEqual(check(job, { queueJobId: "gh-1" }), { ok: true, ids: ["bench-device"] });
	set(spent("gh-1"));
	assert.deepEqual(check(job, { queueJobId: "gh-1" }), { ok: true, ids: ["bench-device"] }, "its own retry");
	assert.deepEqual(check(job, { queueJobId: "gh-2" }), { refused: "private-endpoint-withdrawn" }, "spent by another job");
	assert.deepEqual(check(job), { refused: "private-endpoint-withdrawn" }, "no queue id: nothing to prove it was this job's");
	set(doc([{ ...once, on: { ...once.on, disarmed: { at: "2026-11-16T10:00:00.000Z" } } }]));
	assert.deepEqual(check(job, { queueJobId: "gh-1" }), { refused: "private-endpoint-withdrawn" }, "disarmed by hand");
});

test("a cron job is found among cron entries and a local event job by its id and forge, never across the two (#918 review)", () => {
	const cronJob = { kind: "local", folder: "/srv/app", flow: "test-on-device", task: "run the device suite", privateEndpoints: ["lab"], trigger: { id: "nightly", pattern: "0 3 * * *" } };
	const { check, set } = checkOver([CRON]);
	assert.deepEqual(check(cronJob), { ok: true, ids: ["lab"] });
	assert.deepEqual(check({ ...cronJob, trigger: { id: "weekly" } }), { refused: "private-endpoint-withdrawn" });
	assert.deepEqual(check({ ...cronJob, task: "something else" }), { refused: "private-endpoint-withdrawn" }, "another task under that id is another trigger");
	assert.deepEqual(check({ kind: "local", privateEndpoints: ["lab"] }), { refused: "private-endpoint-withdrawn" }, "a local job with no trigger is never granted one");
	assert.deepEqual(check({ ...cronJob, privateEndpoints: "lab" }), { refused: "private-endpoint-withdrawn" }, "a malformed list is no grant");
	// A local event named like the cron trigger: its own namespace.
	const event = { on: { type: "issue", forge: "github", id: "nightly", action: ["closed"], debounceSeconds: 0 }, run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker: "owner", privateEndpoints: ["bench-device"] } };
	const normalized = parseTriggers(doc([CRON, event]), "/triggers.json");
	const eventJob = buildLocalEventJob(normalized[1], "a".repeat(32));
	set(doc([CRON, event]));
	assert.deepEqual(check(cronJob), { ok: true, ids: ["lab"] }, "the cron job, beside a local event of the same id");
	assert.deepEqual(check(eventJob), { ok: true, ids: ["bench-device"] }, "the local event job, by its id and forge");
	set(doc([event]));
	assert.deepEqual(check(cronJob), { refused: "private-endpoint-withdrawn" }, "the cron trigger gone: a local event of its id grants it nothing");
});

test("the live recheck waits on a newer file, retries an unreadable one, and refuses a missing one", () => {
	const job = forgeJob();
	const newer = checkOver([LABEL], TRIGGERS_FILE_VERSION + 1);
	assert.deepEqual(newer.check(job), { newer: true });
	const broken = checkOver([LABEL]);
	broken.set("{ not json");
	assert.deepEqual(broken.check(job), { unreadable: true }, "a file that does not validate now is retried, never run on a grant nobody can confirm");
	broken.fail(Object.assign(new Error("EIO"), { code: "EIO" }));
	assert.deepEqual(broken.check(job), { unreadable: true });
	broken.fail(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
	assert.deepEqual(broken.check(job), { refused: "private-endpoint-withdrawn" });
	assert.deepEqual(makeCheckPrivateEndpoints({ triggersPath: "" })(job), { refused: "private-endpoint-withdrawn" }, "no triggers file configured");
});
