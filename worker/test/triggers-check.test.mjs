import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.mjs";
import { TRIGGER_JOB_PATH_ENV_KEYS, TRIGGER_LOADER_ENV_KEYS, loadConfig, triggerJobPathConfig, triggerLoaderConfig } from "../src/config.mjs";
import { TRIGGERS_CHECK_ENV_KEYS, TRIGGERS_READERS, checkTriggersText, triggersCheckSecrets } from "../src/triggers-check.mjs";
import { runTriggers } from "../src/triggers-cli.mjs";
// Worker tests may read the receiver's source (worker/src may not): the parity table below holds the check to the
// loaders the receiver, the poller and the watch collector really run.
import { loadReceiverConfig } from "../../receiver/src/config.mjs";
import { loadPollerConfig } from "../../receiver/src/poller-config.mjs";
import { startWatchPuller } from "../../receiver/src/watch-puller.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #970: `pi-dispatch triggers check [file]` judges a candidate triggers file by its readers' own code, before it is
// moved over the file a worker, receiver, poller or watch collector runs.

// The instant every pattern's next run is computed from: a fixed clock, injected everywhere.
const NOW = Date.parse("2026-11-21T12:00:00Z");
const now = () => NOW;
const LABEL = { on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } };
const cron = (folder, run = {}, pattern = "0 4 * * *", id = "nightly") => ({ on: { type: "cron", id, pattern }, run: { kind: "local", folder, flow: "tidy", task: "tidy up", ...run } });
// #970's own entry: a cron trigger with neither run.flow nor run.command.
const NO_FLOW = { on: { type: "cron", id: "probe", pattern: "0 4 3 1 *" }, run: { kind: "local", folder: "/srv/never-read", task: "probe" } };
const source = (secretEnv, pull = true) => ({ verify: "hmac-sha256", secretEnv, maxPerDay: 10, ...(pull ? { pull: { kind: "journald", unit: "shop.service", fields: { service: "shop" } } } : {}) });
const WATCH_RULE = { on: { type: "watch", id: "w1", source: "prod", fingerprint: ["service"], window: "10m", cooldown: "1h", maxPerDay: 2 }, run: { kind: "local", mode: "issue", issue: { kind: "github", repo: "acme/shop" } } };
// The entries the receiver groups under github (`hasGithubRules`), and ones it does not.
const GITHUB_KINDS = {
	label: LABEL,
	comment: { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } },
	pullRequest: { on: { type: "pull_request", action: ["labeled"], any: ["pi:audit"] }, run: { kind: "github", flow: "audit" } },
	prClose: { on: { type: "pull_request", action: ["closed"] }, run: { kind: "github", flow: "after" } },
	issue: { on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "after" } },
	localListener: { version: 5, on: { type: "label", forge: "github", id: "event", any: ["wake"] }, run: { kind: "local", worker: "owner", folder: "/event-folder", command: "reconcile" } },
};
const NOT_GITHUB = {
	gitlab: { on: { type: "label", any: ["pi:fix"] }, run: { kind: "gitlab", flow: "fix" } },
	spent: { on: { type: "issue", action: ["closed"], number: 40, once: true, disarmed: { at: "2026-11-01T00:00:00Z", jobId: "gh-1" } }, run: { kind: "github", flow: "audit" } },
	cronOnly: cron("/srv/never-read"),
	watchOnly: WATCH_RULE,
};
const SECRET = "private-signing-value";
const POLL = "GITHUB_INGEST=poll\n";

/** A deployment folder holding `files` (name to text or document), for the CLI's `cwd`; its real path. */
function deployment(files) {
	const dir = realpathSync(tempDir("pd-970-deploy-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
	return dir;
}

/** The real `main`, with this folder as the deployment's, both streams captured, and the fixed clock. */
async function check(cwd, args = [], shell = {}, argv = ["triggers", "check"]) {
	let out = "";
	let err = "";
	const code = await main([...argv, ...args], shell, { cwd, now: () => new Date(NOW), write: (s) => ((out += s), true), writeErr: (s) => ((err += s), true) });
	return { code, out, err };
}

const judge = (doc, env, opts = {}) => checkTriggersText(typeof doc === "string" ? doc : JSON.stringify(doc), "/d/triggers.json", { env, now, ...opts });

test("a file every reader takes exits 0 with its counts, and says running services reload it themselves", async () => {
	const folder = tempDir("pd-970-folder-");
	const cwd = deployment({ "triggers.json": { triggers: [LABEL, cron(folder), NOT_GITHUB.spent] } });
	writeFileSync(join(cwd, ".env"), `PI_TRIGGERS_FILE=${join(cwd, "triggers.json")}\n${POLL}`);
	const r = await check(cwd);
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out, `${join(cwd, "triggers.json")}: 3 triggers (1 cron, 1 forge, 0 watch, 1 spent one-shot). The worker, the receiver and the poller take it, and running ones reload it themselves.\n`);
	assert.equal(r.err, "");
});

test("#970's cron trigger without run.flow is refused by every reader, naming run.flow and what a start on it does", async () => {
	const cwd = deployment({ "triggers.json": { triggers: [LABEL, NO_FLOW] } });
	writeFileSync(join(cwd, ".env"), `PI_TRIGGERS_FILE=${join(cwd, "triggers.json")}\n${POLL}`);
	const r = await check(cwd);
	assert.equal(r.code, 1);
	assert.equal(r.out, "");
	const [refusal, closing, extra] = r.err.split("\n");
	assert.match(refusal, /^error: the worker, the receiver and the poller refuse it: cron trigger "probe": run\.flow must be a non-empty string/);
	assert.equal(closing, `A worker, receiver or poller started on ${join(cwd, "triggers.json")} refuses to start (exit 2, not restarted); one already running keeps the last copy that loaded.`);
	assert.equal(extra, "");
	// Without PI_TRIGGERS_FILE the worker reads no file; the collector is named only where a pull source is known, which
	// a file that does not parse shows only through the deployment's current file.
	const unset = judge({ triggers: [NO_FLOW] }, {});
	assert.deepEqual(unset.refusals.map((x) => x.readers), [["receiver", "poller"]]);
	assert.equal(unset.counts, null);
	assert.deepEqual(judge({ triggers: [NO_FLOW] }, {}, { currentCollects: true }).refusals.map((x) => x.readers), [["receiver", "poller", "watch collector"]]);
});

test("a trigger's cap above the deployment's PI_MAX_COST_USD is the worker's refusal alone, read from the .env", async () => {
	const capped = { triggers: [{ ...LABEL, run: { ...LABEL.run, maxCostUsd: "2" } }] };
	const cwd = deployment({ "triggers.json": capped });
	writeFileSync(join(cwd, ".env"), `PI_TRIGGERS_FILE=${join(cwd, "triggers.json")}\nPI_MAX_COST_USD=1\n${POLL}`);
	const r = await check(cwd);
	assert.equal(r.code, 1);
	assert.match(r.err, /^error: the worker refuses it: trigger at index 0: run\.maxCostUsd is above this deployment's PI_MAX_COST_USD\./);
	assert.match(r.err, /\nA worker started on .* refuses to start \(exit 2, not restarted\); one already running keeps the last copy that loaded\.\n$/);
	// A deployment whose worker reads no triggers file (PI_TRIGGERS_FILE unset): nothing that loads this file refuses it.
	const other = deployment({ "candidate.json": capped, ".env": `PI_MAX_COST_USD=1\n${POLL}` });
	const unset = await check(other, ["candidate.json"]);
	assert.equal(unset.code, 0, unset.err);
	assert.match(unset.out, /The receiver and the poller take it/);
	// A setting the worker refuses to boot on is said as the deployment's, not the file's.
	const bad = judge({ triggers: [LABEL] }, { PI_TRIGGERS_FILE: "/d/t.json", PI_MAX_COST_USD: "lots", GITHUB_INGEST: "poll" });
	assert.deepEqual(bad.refusals.map((x) => x.readers), [["worker"]]);
	assert.match(bad.refusals[0].reason, /PI_MAX_COST_USD .*\(a setting of this deployment, whatever the file says\)$/);
});

test("a cron pattern BullMQ will not schedule refuses the worker, which only counted its fields; one with no next run is a note", () => {
	const folder = tempDir("pd-970-cron-");
	const env = { PI_TRIGGERS_FILE: "/d/triggers.json", GITHUB_INGEST: "poll" };
	for (const pattern of ["0 99 * * *", "61 * * * *", "0 0 31 2 *", "0 0 * * 8", "a b c d e"]) {
		const verdict = judge({ triggers: [cron(folder, {}, pattern)] }, env);
		assert.deepEqual(verdict.refusals.map((x) => x.readers), [["worker"]], pattern);
		assert.ok(verdict.refusals[0].reason.startsWith(`cron trigger "nightly": BullMQ refuses its pattern ${JSON.stringify(pattern)} (`), verdict.refusals[0].reason);
		assert.match(verdict.refusals[0].reason, /, so the worker's boot reconcile refuses to start$/);
	}
	for (const pattern of ["0 4 * * *", "* * * * * *", "0 0 L 2 *"]) assert.equal(judge({ triggers: [cron(folder, {}, pattern)] }, env).ok, true, pattern);
	// April and June have no 31st: BullMQ finds no next run and reports success writing nothing, so an existing schedule
	// keeps its old pattern and a new one is never made. The worker starts either way, so it is a note.
	const never = judge({ triggers: [cron(folder, {}, "0 0 31 4,6 *")] }, env);
	assert.equal(never.ok, true);
	assert.deepEqual(never.notes, ['cron trigger "nightly": its pattern "0 0 31 4,6 *" has no next run, which BullMQ takes without a word: where a schedule with this id already exists the worker leaves it on its old pattern, and where none exists nothing is installed and the trigger never fires']);
	// A trigger another host schedules is never asked: its pattern is that host's to install.
	const elsewhere = judge({ version: 5, triggers: [cron("/no/such/folder/on/this/host", { worker: "other-host" }, "0 99 * * *")] }, { ...env, PI_WORKER_NAME: "mini1" });
	assert.equal(elsewhere.ok, true);
	assert.deepEqual(elsewhere.notes, ['cron trigger "nightly" names another worker in run.worker, so the worker here does not schedule it']);
});

test("a job path holding the deployment's egress-private/ or the envelope file refuses the worker, the file's or the deployment's by whose path it is", () => {
	const cwd = deployment({});
	mkdirSync(join(cwd, "egress-private"));
	const env = { PI_TRIGGERS_FILE: join(cwd, "triggers.json"), GITHUB_INGEST: "poll" };
	const at = (doc, extra = {}, dir = cwd) => checkTriggersText(JSON.stringify(doc), join(dir, "t.json"), { env: { ...env, PI_TRIGGERS_FILE: join(dir, "t.json"), ...extra }, cwd: dir, now });
	const exposed = (kind, path) => `egress-private/ in the deployment folder lies inside a job path (${kind} ${JSON.stringify(path)}) that a job container can see, so a job could replace the grant helper the egress proxy runs; move the deployment folder, or that job path, so that neither holds the other`;
	assert.deepEqual(at({ triggers: [cron(cwd)] }).refusals.map((x) => [x.readers, x.reason]), [[["worker"], exposed("cron-folder", cwd)]]);
	// A run root is the deployment's: the same refusal for any file, said as a setting.
	assert.deepEqual(at({ triggers: [LABEL] }, { PI_DISPATCH_RUN_ROOTS: cwd }).refusals.map((x) => [x.readers, x.reason]), [[["worker"], `${exposed("run-root", cwd)} (a setting of this deployment, whatever the file says)`]]);
	// A job path the private rule cannot read (a link loop): the boot logs it and starts, so a note.
	symlinkSync(join(cwd, "loop-b"), join(cwd, "loop-a"));
	symlinkSync(join(cwd, "loop-a"), join(cwd, "loop-b"));
	const looped = { triggers: [{ ...LABEL, run: { ...LABEL.run, skillsDir: join(cwd, "loop-a") } }] };
	const unjudged = at(looped);
	assert.equal(unjudged.ok, true);
	assert.equal(unjudged.notes.length, 1);
	assert.match(unjudged.notes[0], /^whether a job path holds the private endpoint folders \(egress-private\/, egress-grants\/\) was not judged \(.*ELOOP.*\): the worker starts and logs it, and pi-dispatch doctor names the path$/);

	const jobs = realpathSync(tempDir("pd-970-jobs-"));
	const elsewhere = deployment({});
	mkdirSync(join(jobs, "bounds"));
	writeFileSync(join(jobs, "bounds", "envelope.json"), "{}");
	const envelope = join(jobs, "bounds", "envelope.json");
	const inside = at({ triggers: [cron(jobs)] }, { PI_ENVELOPE_FILE: envelope }, elsewhere);
	assert.deepEqual(inside.refusals.map((x) => x.readers), [["worker"]]);
	assert.ok(inside.refusals[0].reason.startsWith(`the envelope file ${JSON.stringify(envelope)} lies inside a job path (cron-folder ${JSON.stringify(jobs)})`), inside.refusals[0].reason);
	assert.ok(!inside.refusals[0].reason.endsWith("whatever the file says)"), "a cron folder is the file's");
	// Every throw of the envelope's rule refuses the boot (loadEnvelopeChecked lets it through). A job path of this file it
	// cannot read is the file's.
	symlinkSync(join(elsewhere, "loop-b"), join(elsewhere, "loop-a"));
	symlinkSync(join(elsewhere, "loop-a"), join(elsewhere, "loop-b"));
	const unread = at({ triggers: [{ ...LABEL, run: { ...LABEL.run, skillsDir: join(elsewhere, "loop-a") } }] }, { PI_ENVELOPE_FILE: envelope }, elsewhere);
	assert.deepEqual(unread.refusals.map((x) => x.readers), [["worker"]]);
	assert.match(unread.refusals[0].reason, /^a job path ".*loop-a" cannot be read \(ELOOP\), so the envelope's containment check cannot judge it$/);
	// An envelope path the rule cannot vouch for (a link), or a relative run root beside an envelope: the deployment's.
	symlinkSync(envelope, join(elsewhere, "envelope-link.json"));
	for (const extra of [{ PI_ENVELOPE_FILE: join(elsewhere, "envelope-link.json") }, { PI_ENVELOPE_FILE: "bounds/envelope.json" }, { PI_ENVELOPE_FILE: envelope, PI_DISPATCH_RUN_ROOTS: "runs" }]) {
		const refused = at({ triggers: [LABEL] }, extra, elsewhere);
		assert.deepEqual(refused.refusals.map((x) => x.readers), [["worker"]], JSON.stringify(extra));
		assert.match(refused.refusals[0].reason, /\(a setting of this deployment, whatever the file says\)$/, JSON.stringify(extra));
		assert.deepEqual(refused.notes, [], JSON.stringify(extra));
	}
	// The overlay's settings are the worker's: one it refuses to boot on is the deployment's, whatever the file holds.
	const overlay = at({ triggers: [LABEL] }, { PI_GLOBAL_PI_DIR: "relative/overlay" }, elsewhere);
	assert.deepEqual(overlay.refusals.map((x) => x.readers), [["worker"]]);
	assert.match(overlay.refusals[0].reason, /^PI_GLOBAL_PI_DIR must be an absolute path .*\(a setting of this deployment, whatever the file says\)$/);
});

test("the first GitHub rule makes serve need WEBHOOK_SECRET where nothing else says GitHub: the receiver's refusal alone, a secret of spaces included (issues #970, #1006)", async () => {
	const before = { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE] };
	const after = { ...before, triggers: [WATCH_RULE, LABEL] };
	const cwd = deployment({ "before.json": before, "after.json": after, ".env": `POLL_REPOS=o/r\nWATCH_SIGNING=${SECRET}\n` });
	assert.equal((await check(cwd, ["before.json"])).code, 0);
	const r = await check(cwd, ["after.json"]);
	assert.equal(r.code, 1);
	assert.match(r.err, /^error: the receiver refuses it: this file holds a GitHub rule, and with GITHUB_INGEST and GITHUB_AUTH_SOURCE unset that makes serve serve GitHub, which needs WEBHOOK_SECRET, unset or blank here: set it, or set GITHUB_INGEST=poll where the poller brings GitHub's events\n/);
	assert.match(r.err, /\nA receiver started on /);
	assert.equal((await check(cwd, ["after.json"], { WEBHOOK_SECRET: "w" })).code, 1, "a secret this shell alone sets is no secret the services have");
	writeFileSync(join(cwd, ".env"), `POLL_REPOS=o/r\nWATCH_SIGNING=${SECRET}\nWEBHOOK_SECRET=w\n`);
	assert.equal((await check(cwd, ["after.json"])).code, 0, "with the secret in the .env the services read");
	// What says GitHub may be the .env alone: the secret is then asked for by the settings the deployment resolves, never
	// by this shell's, which here would see no GitHub at all and leave WEBHOOK_SECRET unread.
	const fromFile = deployment({ "triggers.json": { triggers: [NOT_GITHUB.gitlab] }, ".env": "GITHUB_INGEST=both\nWEBHOOK_SECRET=w\nPOLL_REPOS=o/r\n" });
	const both = await check(fromFile);
	assert.equal(both.code, 0, both.err);
	assert.equal((await check(deployment({ "triggers.json": { triggers: [NOT_GITHUB.gitlab] }, ".env": "GITHUB_INGEST=both\nPOLL_REPOS=o/r\n" }))).code, 1, "and without it there");
	// The poller and the collector never read it (issue #1006), so a secret of spaces refuses the receiver alone too.
	assert.deepEqual(judge({ triggers: [LABEL] }, { WEBHOOK_SECRET: "" }).refusals.map((x) => x.readers), [["receiver"]]);
	assert.deepEqual(judge({ triggers: [LABEL] }, { WEBHOOK_SECRET: "  " }).refusals.map((x) => x.readers), [["receiver"]]);
	// The deployment alone says GitHub: the same refusal, named as the deployment's.
	const said = judge({ triggers: [NOT_GITHUB.gitlab] }, { GITHUB_AUTH_SOURCE: "pat" });
	assert.deepEqual(said.refusals.map((x) => [x.readers, x.reason]), [[["receiver"], "serve serves GitHub here (GITHUB_AUTH_SOURCE is set) and WEBHOOK_SECRET is unset or blank, so it refuses to start (a setting of this deployment, whatever the file says)"]]);
	assert.match(judge({ triggers: [] }, { GITHUB_INGEST: "both", WEBHOOK_SECRET: " " }).refusals[0].reason, /^serve serves GitHub here \(GITHUB_INGEST=both\)/);
	// A GITHUB_INGEST no receiver command takes refuses all three, as the deployment's.
	const garbled = judge({ triggers: [] }, { GITHUB_INGEST: "sometimes" });
	assert.deepEqual(garbled.refusals.map((x) => x.readers), [["receiver", "poller"]]);
	assert.match(garbled.refusals[0].reason, /^GITHUB_INGEST must be webhook, poll or both .*\(a setting of this deployment, whatever the file says\)$/);
});

test("the GitHub-rule test is the receiver's own: serve serves GitHub on exactly the files the real loader says it does", () => {
	const fs = (text) => ({ readFile: () => text, fileExists: () => true });
	for (const [name, entry] of [...Object.entries(GITHUB_KINDS).map(([n, e]) => [n, e, true]), ...Object.entries(NOT_GITHUB).map(([n, e]) => [n, e, false])].map(([n, e, want]) => [`${n}:${want}`, e])) {
		// `version` rides on a fixture whose fields need it (run.worker, 5), and is the file's, not the entry's.
		const { version, ...trigger } = entry;
		const doc = { ...(version ? { version } : {}), ...(entry.on.type === "watch" ? { watchSources: { prod: source("WATCH_SIGNING", false) } } : {}), triggers: [trigger] };
		const text = JSON.stringify(doc);
		const served = loadReceiverConfig({ WEBHOOK_SECRET: "w", WATCH_SIGNING: "s" }, fs(text)).servesGithub;
		assert.equal(served, name.endsWith(":true"), `${name}: the receiver's grouping`);
		assert.equal(triggersCheckSecrets(text, "/d/t.json", {}).includes("WEBHOOK_SECRET"), served, `${name}: the check's`);
	}
});

test("a watch source's secret: missing or blank refuses the receiver alone, set in the deployment .env alone is taken, and no value is printed (issues #970, #994)", async () => {
	const doc = { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE, LABEL] };
	const missing = await check(deployment({ "triggers.json": doc, ".env": POLL }));
	assert.equal(missing.code, 1);
	assert.equal(missing.err.split("\n")[0], 'error: the receiver refuses it: watch source "prod" needs its signing secret WATCH_SIGNING, which is unset or blank here', "serve verifies the source's pushes with it; the poller and the collector read no push");
	assert.match(missing.err, /\nA receiver started on /);

	const inEnvFile = await check(deployment({ "triggers.json": doc, ".env": `${POLL}WATCH_SIGNING=${SECRET}\n` }));
	assert.equal(inEnvFile.code, 0, inEnvFile.err);
	assert.match(inEnvFile.out, /: 2 triggers \(0 cron, 1 forge, 1 watch\)\. The receiver, the poller and the watch collector take it/);

	const blank = judge(doc, { GITHUB_INGEST: "poll", WATCH_SIGNING: "   " });
	assert.deepEqual(blank.refusals.map((x) => x.reason), ['watch source "prod" needs its signing secret WATCH_SIGNING, which is unset or blank here']);

	// Set in this shell and absent from the .env (issue #970): the services read the .env, where the real poller loader
	// refuses the file, so the check refuses to judge it rather than pass it on this shell's value.
	const shellOnlyCwd = deployment({ "triggers.json": doc, ".env": POLL });
	const shellOnly = await check(shellOnlyCwd, [], { WATCH_SIGNING: SECRET });
	assert.deepEqual([shellOnly.code, shellOnly.out], [1, ""]);
	assert.equal(shellOnly.err, `error: WATCH_SIGNING is set in this shell and not in ${join(shellOnlyCwd, ".env")} (no value is shown), and the services read the .env, so whether it is set for them cannot be told: add it to the .env, or unset it in this shell\n`);
	const onEnvFile = { GITHUB_INGEST: "poll", POLL_REPOS: "o/r", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "t" };
	const docFs = { readFile: () => JSON.stringify(doc), fileExists: () => true };
	assert.throws(() => loadReceiverConfig(onEnvFile, { ...docFs, command: "serve" }), /watch: a configured source secret is missing/, "the receiver on the .env alone refuses the file");
	assert.doesNotThrow(() => loadPollerConfig(onEnvFile, docFs), "and the poller takes it");
	// Blank here and absent there: missing to every reader alike, so judged as missing, never refused as set here alone.
	const blankHere = await check(shellOnlyCwd, [], { WATCH_SIGNING: "   " });
	assert.match(blankHere.err, /^error: the receiver refuses it: watch source "prod" needs its signing secret WATCH_SIGNING, which is unset or blank here\n/);
	// Empty in this shell and absent from the .env: unset to every reader, judged so.
	const emptyHere = await check(shellOnlyCwd, [], { WATCH_SIGNING: "" });
	assert.equal(emptyHere.code, 1);
	assert.match(emptyHere.err, /^error: the receiver refuses it: watch source "prod" needs its signing secret WATCH_SIGNING, which is unset or blank here\n/);

	// Set in one place and blank or empty in the other: which one a service runs on is not this command's to guess.
	for (const [shell, file, words] of [[" ", SECRET, "blank in this shell and set"], [SECRET, "", "set in this shell and empty"]]) {
		const cwd = deployment({ "triggers.json": doc, ".env": `${POLL}WATCH_SIGNING=${file}\n` });
		const split = await check(cwd, [], { WATCH_SIGNING: shell });
		assert.deepEqual([split.code, split.out], [1, ""]);
		assert.equal(split.err, `error: WATCH_SIGNING is ${words} in ${join(cwd, ".env")} (neither value is shown), so whether it is set cannot be told: make them agree (the service runs the file's)\n`);
	}
	// Empty in one place and blank in the other: missing to every reader alike (issue #1006), so judged, not refused.
	const missingBoth = await check(deployment({ "triggers.json": doc, ".env": `${POLL}WATCH_SIGNING=" "\n` }), [], { WATCH_SIGNING: "" });
	assert.match(missingBoth.err, /^error: the receiver refuses it: watch source "prod" needs its signing secret WATCH_SIGNING, which is unset or blank here\n/);
	// Two different values that are both set: presence is all this judges, so nothing is said.
	const both = await check(deployment({ "triggers.json": doc, ".env": `${POLL}WATCH_SIGNING=${SECRET}\n` }), [], { WATCH_SIGNING: "another-private-value" });
	assert.equal(both.code, 0, both.err);
	assert.doesNotMatch(both.out, /note:/);

	for (const r of [missing, inEnvFile, shellOnly, both]) assert.doesNotMatch(r.out + r.err, /private-signing-value|another-private-value/);
	// A source with no pull block: the same refusal, the receiver's alone.
	const pushOnly = judge({ watchSources: { prod: source("WATCH_SIGNING", false) }, triggers: [WATCH_RULE] }, {});
	assert.deepEqual(pushOnly.refusals.map((x) => x.readers), [["receiver"]]);
	assert.deepEqual(pushOnly.notes, []);
});

test("a .env the secrets cannot be read from is refused, naming the variable, and a source naming an empty WEBHOOK_SECRET refuses the receiver alone", async () => {
	const doc = { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE] };
	const unread = deployment({ "triggers.json": doc, ".env": `${POLL}WATCH_SIGNING="$OTHER"\n` });
	const r = await check(unread);
	assert.equal(r.code, 1);
	assert.equal(r.err, `error: ${join(unread, ".env")} has a line for WATCH_SIGNING that the service's loader may read differently, so whether it is set cannot be told (pi-dispatch doctor names the line)\n`);
	// A .env that is there and cannot be read, with every setting the check judges by in this shell: only the secret is unknown.
	const blocked = deployment({ "triggers.json": doc });
	mkdirSync(join(blocked, ".env"));
	const shell = { PI_TRIGGERS_FILE: join(blocked, "triggers.json"), PI_WORKER_NAME: "", PI_MAX_COST_USD: "", PI_DISPATCH_RUN_ROOTS: "", PI_GLOBAL_PI_DIR: "", PI_ENVELOPE_FILE: "", GITHUB_INGEST: "poll", GITHUB_AUTH_SOURCE: "" };
	assert.deepEqual(Object.keys(shell).sort(), [...TRIGGERS_CHECK_ENV_KEYS].sort());
	const denied = await check(blocked, [], shell);
	assert.equal(denied.code, 1);
	assert.equal(denied.err, `error: ${join(blocked, ".env")} could not be read (EISDIR), so whether WATCH_SIGNING is set cannot be told\n`);
	// `WEBHOOK_SECRET=` in the .env: empty, so serve refuses a source naming it, as any source missing its secret.
	const webhookNamed = { watchSources: { prod: source("WEBHOOK_SECRET", false) }, triggers: [WATCH_RULE] };
	const empty = await check(deployment({ "triggers.json": webhookNamed, ".env": `${POLL}WEBHOOK_SECRET=\n` }));
	assert.equal(empty.code, 1);
	assert.match(empty.err, /^error: the receiver refuses it: watch source "prod" needs its signing secret WEBHOOK_SECRET, which is unset or blank here\nA receiver started on /);
	// An empty PI_TRIGGERS_FILE names no file to judge.
	const named = await check(deployment({ ".env": "PI_TRIGGERS_FILE=\n" }));
	assert.deepEqual([named.code, named.err], [1, "error: PI_TRIGGERS_FILE is set to an empty value, so there is no file to judge, and every reader refuses to start on it: set it to the file, or delete the line\n"]);
});

test("a setting this shell sets and the .env has no line for is refused, naming it and no value; with no .env, this shell's settings are the deployment's (issue #970)", async () => {
	const cwd = deployment({ "triggers.json": { triggers: [LABEL] }, ".env": "POLL_REPOS=o/r\n" });
	const fileAlone = await check(cwd);
	assert.equal(fileAlone.code, 1);
	assert.match(fileAlone.err, /^error: the receiver refuses it: this file holds a GitHub rule, and with GITHUB_INGEST and GITHUB_AUTH_SOURCE unset that makes serve serve GitHub, which needs WEBHOOK_SECRET/);
	// GITHUB_INGEST=poll in this shell alone would excuse the secret, for a service that does not have it.
	const shellOnly = await check(cwd, [], { GITHUB_INGEST: "poll" });
	assert.deepEqual([shellOnly.code, shellOnly.out], [1, ""]);
	assert.equal(shellOnly.err, `error: GITHUB_INGEST is set in this shell and not in ${join(cwd, ".env")} (no value is shown), and the services read the .env, so the file cannot be judged as they load it: add it to the .env, or unset it in this shell\n`);
	const two = await check(cwd, [], { GITHUB_INGEST: "poll", GITHUB_AUTH_SOURCE: "pat" });
	assert.match(two.err, /^error: GITHUB_INGEST and GITHUB_AUTH_SOURCE are set in this shell and not in .* add them to the \.env, or unset them in this shell\n$/);
	assert.doesNotMatch(shellOnly.err + two.err, /=poll|=pat|"poll"|"pat"/);
	// The same setting in the .env is the deployment's, and the file is taken.
	writeFileSync(join(cwd, ".env"), "POLL_REPOS=o/r\nGITHUB_INGEST=poll\n");
	assert.equal((await check(cwd, [], { GITHUB_INGEST: "poll" })).code, 0);
	// A file missing where the services look, under a PI_TRIGGERS_FILE of this shell alone: the setting is the news.
	const elsewhere = deployment({ "elsewhere.json": { triggers: [LABEL] }, ".env": "POLL_REPOS=o/r\n" });
	const missing = await check(elsewhere, [], { PI_TRIGGERS_FILE: join(elsewhere, "elsewhere.json") });
	assert.equal(missing.err, `error: PI_TRIGGERS_FILE is set in this shell and not in ${join(elsewhere, ".env")} (no value is shown), and the services read the .env, so the file cannot be judged as they load it: add it to the .env, or unset it in this shell\n`);
	// Empty in this shell and absent from the .env is unset, as the services have it: not refused, and never judged as
	// empty (an empty PI_TRIGGERS_FILE would refuse every reader where the services read ./triggers.json).
	const polled = deployment({ "triggers.json": { triggers: [LABEL] }, ".env": "GITHUB_INGEST=poll\nPOLL_REPOS=o/r\n" });
	for (const shell of [{ PI_TRIGGERS_FILE: "" }, { PI_WORKER_NAME: "" }, { PI_TRIGGERS_FILE: "", GITHUB_AUTH_SOURCE: "" }]) {
		const r = await check(polled, [], shell);
		assert.equal(r.code, 0, `${JSON.stringify(shell)}: ${r.err}`);
	}
	// No .env at all: nothing to differ from, as before.
	const noEnv = deployment({ "triggers.json": { triggers: [LABEL] } });
	const bare = await check(noEnv, [], { GITHUB_INGEST: "poll", POLL_REPOS: "o/r" });
	assert.equal(bare.code, 0, bare.err);
});

test("what reaches the check is the judged settings and a mark per secret, never a secret's value", async () => {
	const doc = { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE, LABEL] };
	const cwd = deployment({ "triggers.json": doc, ".env": `WATCH_SIGNING=${SECRET}\nWEBHOOK_SECRET=${SECRET}\nPOLL_REPOS=o/r\n` });
	let seen = null;
	const code = await runTriggers(["check"], { env: { WEBHOOK_SECRET: "another-private-value", GITHUB_PAT: "a-token-value", HOME: "/home/x" }, cwd, now, out: () => {}, err: () => {}, check: (text, path, opts) => ((seen = opts.env), { ok: true, counts: { triggers: 2, cron: 0, forge: 1, watch: 1 }, readers: [], notes: [] }) });
	assert.equal(code, 0);
	assert.deepEqual(seen, { WATCH_SIGNING: "set", WEBHOOK_SECRET: "set" });
	assert.doesNotMatch(JSON.stringify(seen), /private|token|home/);
});

test("the check reads only the settings the CLI resolves from the deployment, and each secret it asks about", () => {
	const folder = tempDir("pd-970-reads-");
	const text = JSON.stringify({ watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE, LABEL, cron(folder)] });
	const read = new Set();
	const values = { PI_TRIGGERS_FILE: "/d/triggers.json" };
	const env = new Proxy({}, { get: (_t, k) => (typeof k === "string" && read.add(k), values[k]), has: (_t, k) => (read.add(String(k)), Object.hasOwn(values, k)) });
	checkTriggersText(text, "/d/triggers.json", { env, now, cwd: folder });
	const secrets = triggersCheckSecrets(text, "/d/triggers.json", values);
	assert.deepEqual(secrets.sort(), ["WATCH_SIGNING", "WEBHOOK_SECRET"]);
	assert.deepEqual([...read].filter((k) => !TRIGGERS_CHECK_ENV_KEYS.includes(k) && !secrets.includes(k)), [], "a key read here that the CLI does not resolve would be judged from this shell alone");
	for (const k of TRIGGERS_CHECK_ENV_KEYS) assert.ok(read.has(k), `${k} is resolved by the CLI and read by the check`);
});

test("parity: the check refuses for the receiver, the poller and the watch collector exactly where their real loaders throw (issues #970, #994, #1006)", async () => {
	const docs = {
		plain: { triggers: [LABEL, cron("/srv/never-read")] },
		gitlabOnly: { triggers: [NOT_GITHUB.gitlab] },
		watched: { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE] },
		watchedGithub: { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE, LABEL] },
		webhookNamed: { watchSources: { prod: source("WEBHOOK_SECRET", false) }, triggers: [WATCH_RULE] },
		both: { watchSources: { prod: source("WATCH_SIGNING", false), alt: source("WEBHOOK_SECRET") }, triggers: [WATCH_RULE] },
		unparsed: { triggers: [NO_FLOW] },
	};
	const values = [undefined, "", "   ", "set"];
	// No base satisfies serve's WEBHOOK_SECRET by itself: that rule is judged too. Each keeps the rules the check leaves
	// to doctor satisfied (POLL_REPOS, a parseable GITHUB_AUTH_SOURCE), so a throw below is one the check owns.
	const bases = [{ GITHUB_INGEST: "poll", POLL_REPOS: "o/r" }, { POLL_REPOS: "o/r" }, { GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "p", POLL_REPOS: "o/r" }];
	const dir = tempDir("pd-1006-parity-");
	const owned = /^watch: a configured source secret is missing$|run\.flow must be a non-empty string|^WEBHOOK_SECRET is required/;
	// Each reader by its own entry, on the file at `env.PI_TRIGGERS_FILE`: `serve`'s loader as start.mjs calls it
	// (`command: "serve"`, the loader's default), the poller's, and the collector's start with its own default loader, which goes on
	// to judge Valkey only once its loader took the file, so that is refused here and nothing connects anywhere.
	const loaders = {
		serve: async (env) => loadReceiverConfig(env, { command: "serve" }),
		poll: async (env) => loadPollerConfig(env),
		collector: (env) => startWatchPuller(env, { judgeValkey: async () => { throw new Error("collector started"); }, signals: false, out: () => {} }),
	};
	const outcomes = async (env) => {
		const result = {};
		for (const [reader, load] of Object.entries(loaders)) {
			try {
				await load(env);
				result[reader] = "takes";
			} catch (error) {
				result[reader] = error.message === "collector started" ? "takes" : error.piDispatchConfig === true ? error.message : assert.fail(error);
			}
		}
		return result;
	};
	let rows = 0;
	const seen = new Set();
	for (const [name, doc] of Object.entries(docs)) {
		const text = JSON.stringify(doc);
		const path = join(dir, `${name}.json`);
		writeFileSync(path, text);
		for (const base of bases) {
			for (const signing of values) {
				for (const webhook of values) {
					const env = { ...base, ...(signing === undefined ? {} : { WATCH_SIGNING: signing }), ...(webhook === undefined ? {} : { WEBHOOK_SECRET: webhook }) };
					const verdict = checkTriggersText(text, path, { env, now });
					const refuses = (reader) => verdict.refusals.some((x) => x.readers.includes(reader));
					const takes = (reader) => verdict.readers.includes(reader) && !refuses(reader);
					const label = `${name} ${JSON.stringify(env)}`;
					const got = await outcomes({ ...env, PI_TRIGGERS_FILE: path });
					for (const reader of ["serve", "poll"]) if (got[reader] !== "takes") assert.match(got[reader], owned, `${reader} ${label}: only a refusal the check owns`);
					assert.equal(refuses("receiver"), got.serve !== "takes", `receiver: ${label}`);
					assert.equal(refuses("poller"), got.poll !== "takes", `poller: ${label}`);
					// Without a pull source the collector refuses every file before any Valkey, and the check names it nowhere.
					assert.equal(takes("watch collector"), got.collector === "takes", `watch collector: ${label}`);
					seen.add(`serve ${got.serve === "takes" ? "takes" : "refuses"}, poll ${got.poll === "takes" ? "takes" : "refuses"}, collector ${got.collector === "takes" ? "starts" : "refuses"}`);
					rows++;
				}
			}
		}
	}
	assert.ok(rows >= 300, `${rows} rows`);
	// The table reaches every outcome the readers can give, the splits included: a watch secret or WEBHOOK_SECRET missing
	// or blank refuses serve and neither the poller nor the collector (issues #994, #1006), and a file that does not parse
	// refuses all three.
	assert.deepEqual([...seen].sort(), ["serve refuses, poll refuses, collector refuses", "serve refuses, poll takes, collector refuses", "serve refuses, poll takes, collector starts", "serve takes, poll takes, collector refuses", "serve takes, poll takes, collector starts"]);
	// A secret of spaces is missing to the receiver itself, not only to this check: the loaders' trim is the rule.
	const watched = JSON.stringify(docs.watched);
	assert.throws(() => loadReceiverConfig({ GITHUB_INGEST: "poll", WATCH_SIGNING: "   " }, { readFile: () => watched, fileExists: () => true }), /^Error: watch: a configured source secret is missing$/);
	// A source naming WEBHOOK_SECRET, unset or blank: serve's refusal alone.
	for (const env of [{ GITHUB_INGEST: "poll" }, { GITHUB_INGEST: "poll", WEBHOOK_SECRET: "  " }]) {
		const split = judge(docs.webhookNamed, env);
		assert.deepEqual(split.refusals.map((x) => x.readers), [["receiver"]], JSON.stringify(env));
		assert.deepEqual(split.notes, [], JSON.stringify(env));
	}

	// What only `serve` reads (issue #1006): a forge webhook block named and incomplete, or a malformed RECEIVER_PORT.
	// `serve` refuses it whatever the file holds, which is doctor's to say (`forgeWebhookFaults`), not this check's: the
	// verdict is the same with the setting as without, and the poller and the collector start exactly as they did.
	const listenerOnly = [{ GITLAB_TOKEN: "t" }, { GITLAB_WEBHOOK_MODE: "bogus" }, { FORGEJO_TOKEN: "t" }, { AZURE_TOKEN: "t" }, { AZURE_WEBHOOK_MODE: "header", AZURE_WEBHOOK_SECRET: "s", AZURE_TOKEN: "t", AZURE_ORG_URL: "https://dev.azure.com/o" }, { RECEIVER_PORT: "http" }];
	for (const name of ["watched", "plain", "gitlabOnly"]) {
		const path = join(dir, `${name}.json`);
		const env = { GITHUB_INGEST: "poll", POLL_REPOS: "o/r", WATCH_SIGNING: "set", PI_TRIGGERS_FILE: path };
		const without = await outcomes(env);
		const verdictWithout = checkTriggersText(JSON.stringify(docs[name]), path, { env: { ...env, PI_TRIGGERS_FILE: undefined }, now });
		for (const setting of listenerOnly) {
			const label = `${name} ${JSON.stringify(setting)}`;
			const got = await outcomes({ ...env, ...setting });
			assert.match(got.serve, /^GITLAB_|^FORGEJO_|^AZURE_|^invalid RECEIVER_PORT/, `serve refuses it: ${label}`);
			assert.deepEqual([got.poll, got.collector], [without.poll, without.collector], `the poller and the collector do not read it: ${label}`);
			assert.deepEqual(checkTriggersText(JSON.stringify(docs[name]), path, { env: { ...env, ...setting, PI_TRIGGERS_FILE: undefined }, now }).refusals, verdictWithout.refusals, label);
		}
	}
});

test("triggerLoaderConfig and triggerJobPathConfig are loadConfig's own readings of their keys, and read no other key", () => {
	const overlay = tempDir("pd-970-overlay-");
	const tables = [{}, { PI_TRIGGERS_FILE: "/d/triggers.json" }, { PI_TRIGGERS_FILE: "" }, { PI_MAX_COST_USD: "2.50" }, { PI_MAX_COST_USD: "" }, { PI_WORKER_NAME: "mini1" }, { PI_WORKER_NAME: "" }, { PI_TRIGGERS_FILE: "./t.json", PI_WORKER_NAME: "mini-2", PI_MAX_COST_USD: "0.40" }, { PI_DISPATCH_RUN_ROOTS: "/a:/b" }, { PI_GLOBAL_PI_DIR: overlay }, { PI_GLOBAL_PI_DIR: "" }, { PI_ENVELOPE_FILE: "/d/envelope.json" }, { PI_ENVELOPE_FILE: "" }];
	for (const env of tables) {
		const full = loadConfig(env);
		assert.deepEqual(triggerLoaderConfig(env), { triggersFile: full.triggersFile, maxCostUsd: full.maxCostUsd, workerName: full.workerName, workerNameDeclared: full.workerNameDeclared }, JSON.stringify(env));
		assert.deepEqual(triggerJobPathConfig(env), { dispatchRunRoots: full.dispatchRunRoots, globalPiDir: full.globalPiDir, envelopeFile: full.envelopeFile }, JSON.stringify(env));
	}
	for (const [env, of] of [[{ PI_MAX_COST_USD: "lots" }, triggerLoaderConfig], [{ PI_WORKER_NAME: "two words" }, triggerLoaderConfig], [{ PI_WORKER_NAME: "mini.json" }, triggerLoaderConfig], [{ PI_GLOBAL_PI_DIR: "relative" }, triggerJobPathConfig], [{ PI_GLOBAL_PI_DIR: "/no/such/overlay/here" }, triggerJobPathConfig]]) {
		let message;
		assert.throws(() => loadConfig(env), (e) => ((message = e.message), e.piDispatchConfig === true));
		assert.throws(() => of(env), (e) => e.message === message && e.piDispatchConfig === true, JSON.stringify(env));
	}
	// The keys each reads are exactly the ones `run --trigger` and this command resolve from the deployment.
	for (const [of, keys] of [[triggerLoaderConfig, TRIGGER_LOADER_ENV_KEYS], [triggerJobPathConfig, TRIGGER_JOB_PATH_ENV_KEYS]]) {
		const read = new Set();
		of(new Proxy({}, { get: (_t, key) => (typeof key === "string" && read.add(key), undefined) }));
		assert.deepEqual([...read].sort(), [...keys].sort(), of.name);
	}
});

test("[file] beats PI_TRIGGERS_FILE, a cron trigger another host schedules is a note, and so is cron the worker does not read", async () => {
	const cwd = deployment({ "triggers.json": { triggers: [NO_FLOW] }, "candidate.json": { triggers: [LABEL, cron("/no/such/folder/on/this/host")] } });
	writeFileSync(join(cwd, ".env"), `PI_TRIGGERS_FILE=${join(cwd, "triggers.json")}\nPI_WORKER_NAME=mini1\n${POLL}`);
	const deployed = await check(cwd);
	assert.equal(deployed.code, 1);
	const candidate = await check(cwd, ["candidate.json"]);
	assert.equal(candidate.code, 0, candidate.err);
	assert.ok(candidate.out.startsWith(`${join(cwd, "candidate.json")}: 2 triggers`), candidate.out);
	assert.match(candidate.out, /\nnote: cron trigger "nightly" is not scheduled here: its folder is not on this machine, which a named worker \(PI_WORKER_NAME\) takes as another host's\n$/);
	// Alone (no PI_WORKER_NAME), the same folder is a typo the worker refuses to start on.
	const alone = judge({ triggers: [cron("/no/such/folder/on/this/host")] }, { PI_TRIGGERS_FILE: "/d/t.json", GITHUB_INGEST: "poll" });
	assert.deepEqual(alone.refusals.map((x) => [x.readers, /run\.folder does not exist/.test(x.reason)]), [[["worker"], true]]);
	// PI_TRIGGERS_FILE unset: the worker schedules none of the file's cron, which is said, in the singular and the plural.
	assert.deepEqual(judge({ triggers: [cron("/srv/a")] }, { GITHUB_INGEST: "poll" }).notes, ["the worker here reads no triggers file (PI_TRIGGERS_FILE is unset), so its cron trigger is not scheduled on this host"]);
	assert.deepEqual(judge({ triggers: [cron("/srv/a"), cron("/srv/b", {}, "0 5 * * *", "later")] }, { GITHUB_INGEST: "poll" }).notes, ["the worker here reads no triggers file (PI_TRIGGERS_FILE is unset), so none of its 2 cron triggers is scheduled on this host"]);
});

test("a watch collector runs on the current file: a candidate with no pull source left is told it stops it, and one that does not parse names it", async () => {
	const current = { watchSources: { prod: source("WATCH_SIGNING") }, triggers: [WATCH_RULE] };
	const cwd = deployment({ "triggers.json": current, "nopull.json": { watchSources: { prod: source("WATCH_SIGNING", false) }, triggers: [WATCH_RULE] }, "broken.json": "{ nope", ".env": `${POLL}WATCH_SIGNING=${SECRET}\n` });
	const nopull = await check(cwd, ["nopull.json"]);
	assert.equal(nopull.code, 0, nopull.err);
	assert.match(nopull.out, /The receiver and the poller take it/);
	assert.match(nopull.out, /\nnote: the watch collector here refuses to start on it \(exit 2, "watch: no pull sources configured"\): the current file has a pull source and this one has none/);
	const broken = await check(cwd, ["broken.json"]);
	assert.match(broken.err, /^error: the receiver, the poller and the watch collector refuse it: triggers file is not valid JSON/);
	// Checking the current file itself: its own pull sources decide, and a copy of the same file says nothing more.
	assert.doesNotMatch((await check(cwd)).out, /note:/);
});

test("what cannot be judged exits 1: no file, a second file, a flag, no subcommand, a deployment that disagrees; usage exits 0 when asked", async () => {
	const cwd = deployment({});
	const none = await check(cwd);
	assert.deepEqual([none.code, none.err], [1, `error: no triggers file at ${join(cwd, "triggers.json")}\n`]);
	const two = await check(cwd, ["a.json", "b.json"]);
	assert.equal(two.code, 1);
	assert.match(two.err, /^error: pi-dispatch triggers check takes one file \(got 2\)\n/);
	const flag = await check(cwd, ["--json"]);
	assert.equal(flag.code, 1);
	assert.match(flag.err, /^error: pi-dispatch triggers check takes no flag \(got "--json"\)\n/);
	const split = deployment({ "triggers.json": { triggers: [LABEL] }, ".env": `PI_WORKER_NAME=mini1\n${POLL}` });
	const disagree = await check(split, [], { PI_WORKER_NAME: "mini2" });
	assert.equal(disagree.code, 1);
	assert.match(disagree.err, /^error: PI_WORKER_NAME is "mini2" in this shell and "mini1" in .*\.env: make them agree \(the service runs the file's\), so the file cannot be judged as this deployment's services load it\n$/);
	// No subcommand: the usage on stderr and 1, so `pi-dispatch triggers && mv ...` moves nothing.
	const bare = await check(cwd, [], {}, ["triggers"]);
	assert.deepEqual([bare.code, bare.out], [1, ""]);
	assert.match(bare.err, /^pi-dispatch triggers check \[file\]\n/);
	for (const argv of [["triggers", "--help"], ["triggers", "-h"], ["triggers", "help"], ["triggers", "check", "--help"]]) {
		const asked = await check(cwd, [], {}, argv);
		assert.deepEqual([asked.code, asked.err], [0, ""], argv.join(" "));
		assert.match(asked.out, /^pi-dispatch triggers check \[file\]\n/);
	}
	const unknown = await check(cwd, [], {}, ["triggers", "frob"]);
	assert.equal(unknown.code, 1);
	assert.match(unknown.err, /^pi-dispatch triggers: unknown subcommand "frob"\n/);
	assert.deepEqual(TRIGGERS_READERS, ["worker", "receiver", "poller", "watch collector"]);
});
