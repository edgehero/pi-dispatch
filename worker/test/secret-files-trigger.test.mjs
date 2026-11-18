import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggersDocument, triggersFileVersionFor } from "../src/triggers.mjs";
import { jobDataNewer, withJobDataVersion } from "../src/job-data-version.mjs";
import { jobNeeds } from "../src/capabilities.mjs";
import { buildLocalEventJob } from "../src/local-event.mjs";
import { recoveryDataOf } from "../src/recovery-queue.mjs";
import { secretFileNameAllowed } from "../src/secret-file-names.mjs";
import { makeCheckWaitSkew } from "../src/triggers-file.mjs";

const FILES = { DEVICE_KEY: "device/key" };
const LABEL = { on: { type: "label", any: ["hil"] }, run: { kind: "github", flow: "test-device" } };
const document = (run = {}, extra = {}) => ({ version: 8, triggers: [{ ...LABEL, run: { ...LABEL.run, ...run } }], ...extra });
const load = (run = {}, extra = {}, versions) => parseTriggersDocument(JSON.stringify(document(run, extra)), "/triggers.json", versions);
const bundle = (files) => ({ secretBundles: { lab: { profile: "devices", ref: "lab", project: "lab", files } } });

test("file secret schema preserves references, supports a file-only profile, and versions only jobs that need it", () => {
	const [entry] = load({ secretFiles: FILES, secretsProfile: "devices" }).triggers;
	assert.deepEqual(entry.run.secretFiles, FILES);
	assert.equal(entry.run.secretsProfile, "devices");
	assert.equal("secrets" in entry.run, false);
	assert.deepEqual(jobNeeds({ secretFiles: FILES }), ["s:default"]);
	assert.deepEqual(jobNeeds({ secretFiles: FILES, secretsProfile: "devices" }), ["s:devices"]);
	assert.equal(triggersFileVersionFor(document({ secretFiles: FILES })), 8);
	assert.equal(triggersFileVersionFor(document()), 1);
	assert.throws(() => load({ secretFiles: FILES }, { version: 7 }), /run\.secretFiles needs triggers file version 8/);
	assert.throws(() => load({ secretFiles: FILES }, {}, { supported: 7 }), (error) => error.newer === true);
	const data = withJobDataVersion({ kind: "github", secretFiles: FILES });
	assert.equal(data.dataVersion, 9);
	assert.deepEqual(jobDataNewer(data, { supported: 8 }), { version: 9 });
	assert.equal("dataVersion" in withJobDataVersion({ kind: "github" }), false);
});

test("file secret validation refuses ambiguous delivery, filesystem aliases and invalid references without printing them", () => {
	for (const bad of [null, [], {}, "reference-canary", { DEVICE_KEY: { value: "reference-canary" } }, { DEVICE_KEY: " reference-canary" }, { DEVICE_KEY: "-reference-canary" }, { DEVICE_KEY: "reference-canary\0suffix" }]) {
		assert.throws(() => load({ secretFiles: bad }), (error) => /secretFiles/.test(error.message) && !error.message.includes("reference-canary"));
	}
	for (const name of ["../key", "/key", "A=B", "1KEY", "PI_JOB_ID", "PATH".repeat(33), "__proto__", "CON", "nul", "COM1", "lpt9"]) {
		assert.throws(() => load({ secretFiles: Object.fromEntries([[name, "reference-canary"]]) }), /secretFiles/);
	}
	assert.throws(() => load({ secretFiles: { KEY: "a", key: "b" } }), /distinct ignoring case/);
	assert.throws(() => load({ secrets: FILES, secretFiles: FILES }), /must not name the same variable/);
	const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`TOKEN_${i}`, "ref"]));
	assert.throws(() => load({ secrets: sixteen, secretFiles: FILES }), /together exceed the 16/);
	assert.throws(() => load({ secretFiles: FILES, resume: true }), /secretFiles and run.resume cannot be combined/);
	for (const key of ["secretFile", "secret_files", "SecretFiles", "secret-files", "secretf\u0456les"]) assert.throws(() => load({ [key]: FILES }), /did you mean run.secretFiles/);
});

test("bundle file selection is reviewed, versioned, closed and separate from endpoint placeholders", () => {
	const parsed = load({}, bundle(["DEVICE_KEY"]));
	assert.deepEqual(parsed.secretBundles.lab.files, ["DEVICE_KEY"]);
	assert.equal(triggersFileVersionFor(document({}, bundle(["DEVICE_KEY"]))), 8);
	assert.throws(() => load({}, { ...bundle(["DEVICE_KEY"]), version: 7 }), /secretBundles.*holds a value that needs triggers file version 8/);
	for (const files of [null, [], "DEVICE_KEY", ["KEY", "key"], ["../KEY"], ["PI_JOB_ID"], ["__proto__"], ["A".repeat(129)], ["CON"], ["Lpt1"], Array.from({ length: 65 }, (_, i) => `KEY_${i}`)]) {
		assert.throws(() => load({}, bundle(files)), /files/);
	}
	assert.throws(() => load({}, { secretBundles: { lab: { ...bundle(["DEVICE_KEY"]).secretBundles.lab, endpoints: { device_key: { host: "lab.example", auth: "bearer" } } } } }), /files and endpoints/);
});

test("local event commands and recovery carry references, while stale forge producers are caught before execution", async () => {
	const local = { on: { type: "label", any: ["hil"], id: "device-test", forge: "github" }, run: { kind: "local", folder: "/srv/device-tests", command: "test-device", worker: "lab", secretFiles: FILES } };
	const [entry] = load({}, { triggers: [local] }).triggers;
	const data = buildLocalEventJob(entry, "a".repeat(32));
	assert.deepEqual(data.secretFiles, FILES);
	assert.equal(data.dataVersion, 9);
	assert.deepEqual(recoveryDataOf({ kind: "github", secretFiles: FILES }, { runId: "gh-test", n: 1, recoverBy: 100 }).secretFiles, FILES);
	const text = JSON.stringify(document({ secretFiles: FILES }));
	const check = makeCheckWaitSkew({ triggersPath: "/t", fs: { statSync: () => ({ mtimeMs: 1, size: text.length }), readFileSync: () => text } });
	const job = { kind: "github", flow: "test-device", trigger: { matched: { index: 0, type: "label", label: "hil" } } };
	assert.equal((await check(job)).field, "secretFiles");
	assert.deepEqual(await check({ ...job, secretFiles: FILES }), { ok: true });
});


test("portable file names keep ordinary environment names and reject Windows device files", () => {
	for (const name of ["DEVICE_SSH_KEY", "_key", "A".repeat(128), "COM0", "COM10", "CON_KEY", "toString"]) assert.equal(secretFileNameAllowed(name), true, name);
	for (const name of ["", "1KEY", "../key", "CON", "con", "PRN", "AUX", "nul", "COM1", "COM9", "LPT1", "lpt9", "A".repeat(129), "__proto__"]) assert.equal(secretFileNameAllowed(name), false, name);
});

test("watch file references reach the investigated job but cannot authenticate reviewed log queries", () => {
	const watch = { on: { type: "watch", id: "device", source: "prod", fingerprint: ["service"], minCount: 5, window: "10m", cooldown: "6h", maxPerDay: 4 }, run: { kind: "local", folder: "/srv/device-tests", flow: "triage", task: "Investigate", maxCostUsd: "0.40", secretFiles: FILES } };
	const extra = { watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_PROD_SECRET" } }, triggers: [watch] };
	assert.deepEqual(load({}, extra).triggers[0].run.secretFiles, FILES);
	watch.run.queryLogs = { errors: { endpoint: "https://logs.example/query", query: "reviewed", credentialEnv: "DEVICE_KEY" } };
	assert.throws(() => load({}, extra), /credentialEnv requires an environment secret/);
	delete watch.run.secretFiles;
	watch.run.secrets = FILES;
	assert.equal(load({}, extra).triggers[0].run.queryLogs.errors.credentialEnv, "DEVICE_KEY");
});
