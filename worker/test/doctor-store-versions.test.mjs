import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fleetStoreVersionChecks, newerFileFix, STORE_FLEET_LINES, storeVersionNeeds, UNKNOWN_KEYS_SHOWN } from "../src/doctor.mjs";
import { assignCheckIds, NAMED_CHECK_IDS } from "../src/doctor-results.mjs";

// Issue #761 (DES-STORE-VERSION-WHEN-NEEDED): doctor's three new things for an upgrade. `fleet.store-versions` names a
// peer that cannot read a store this host's files need a version above 1 for; `settings.unknown-keys` names the overlay
// keys this build does not know; and a settings overlay a newer pi-dispatch wrote gets the upgrade as its fix.

const NEED = Object.freeze({ settingsVersion: 2 });

test("nothing at all while every store needs version 1, which is every deployment while the tables are empty", () => {
	const peers = [{ name: "old" }, { name: "same", settingsVersion: "1", pauseWindowsVersion: "1", triggersVersion: "1", jobDataVersion: "1" }];
	assert.deepEqual(fleetStoreVersionChecks({}, peers), []);
	assert.deepEqual(fleetStoreVersionChecks({ settingsVersion: 1, pauseWindowsVersion: 1, triggersVersion: 1, jobDataVersion: 1 }, peers), []);
	assert.deepEqual(fleetStoreVersionChecks(NEED, []), [], "no peers, no line");
	assert.deepEqual(fleetStoreVersionChecks(NEED, [{ name: "a", settingsVersion: "2" }, { name: "b", settingsVersion: "3" }]), [], "every peer reads it");
});

test("a need above 1 names the peers that publish a lower version and, apart, the ones that publish none, as warnings", () => {
	const peers = [{ name: "reads", settingsVersion: "2" }, { name: "lower", settingsVersion: "1" }, { name: "silent" }, { name: "blank", settingsVersion: "" }, { name: "garbled", settingsVersion: "two" }, { name: "newer", settingsVersion: "5" }];
	const checks = fleetStoreVersionChecks(NEED, peers);
	assert.equal(checks.length, 2);
	for (const c of checks) {
		assert.equal(c.id, "fleet.store-versions");
		assert.equal(c.ok, false);
		assert.equal(c.warn, true, "a warning: nothing here stops a job");
		assert.equal(c.fix, "upgrade and restart the workers named, and every panel and console that writes the settings overlay (one from before issue #761 drops a key it does not know when it writes), to a release that reads version 2");
	}
	assert.equal(checks[0].label, `lower, garbled read the settings overlay only below version 2, the version this host's file needs: each ${STORE_FLEET_LINES.settingsVersion.older}`);
	assert.equal(checks[1].label, `silent, blank publish no version for the settings overlay (a worker from before issue #761), while this host's file needs version 2: each ${STORE_FLEET_LINES.settingsVersion.silent}`);
	assert.match(checks[0].label, /defers every job \(newer-release\)/);
	assert.match(checks[1].label, /drops the overlay keys it does not know/);
	// One peer reads in the singular, and the published ids repeat with a tail, as every repeated id does.
	const one = fleetStoreVersionChecks({ jobDataVersion: 2 }, [{ name: "mini2", jobDataVersion: "1" }]);
	assert.match(one[0].label, /^mini2 reads the jobs this host's triggers queue only below version 2, .*: it defers each such job/);
	assert.deepEqual(assignCheckIds(checks), ["fleet.store-versions", "fleet.store-versions-2"]);
});

test("job data's fix names the receivers, which publish no row doctor could read, and a lower triggers peer defers every job", () => {
	const [jobData] = fleetStoreVersionChecks({ jobDataVersion: 2 }, [{ name: "mini2", jobDataVersion: "1" }]);
	assert.equal(jobData.fix, "upgrade and restart the workers named, and every receiver and every console that queues these jobs (a receiver publishes no registry row, so doctor cannot see which receivers are older), to a release that reads version 2");
	assert.doesNotMatch(jobData.fix, /panel/, "no panel queues a job");
	const [triggers] = fleetStoreVersionChecks({ triggersVersion: 2 }, [{ name: "mini2", triggersVersion: "1" }]);
	assert.equal(triggers.label, "mini2 reads the triggers file only below version 2, the version this host's file needs: it defers every job (newer-release) from its next reload of this file, keeps its last good schedules, and refuses the file at its next start");
	assert.equal(STORE_FLEET_LINES.triggersVersion.older.split(" from its next reload")[0], STORE_FLEET_LINES.pauseWindowsVersion.older.split(" from its next reload")[0], "the triggers and pause windows peers say the same thing about a reload");
	// Each file is written by the panels and consoles, and only job data by the receivers.
	for (const field of ["settingsVersion", "pauseWindowsVersion", "triggersVersion"]) {
		const line = STORE_FLEET_LINES[field];
		assert.equal(line.writers, `every panel and console that writes ${line.store} (one from before issue #761 drops a key it does not know when it writes)`, field);
	}
	for (const [field, line] of Object.entries(STORE_FLEET_LINES)) assert.ok(Object.isFrozen(line), field);
});

test("each store is judged on its own field, in the table's order, and the table is the four fields hosts publish", () => {
	assert.deepEqual(Object.keys(STORE_FLEET_LINES), ["settingsVersion", "pauseWindowsVersion", "triggersVersion", "jobDataVersion"]);
	assert.ok(Object.isFrozen(STORE_FLEET_LINES));
	const peers = [{ name: "p", settingsVersion: "3", pauseWindowsVersion: "1", triggersVersion: "1", jobDataVersion: "3" }];
	const checks = fleetStoreVersionChecks({ settingsVersion: 3, pauseWindowsVersion: 2, triggersVersion: 2, jobDataVersion: 3 }, peers);
	assert.deepEqual(checks.map((c) => c.label.split(" read")[0]), ["p", "p"]);
	assert.match(checks[0].label, /the pause windows file only below version 2/);
	assert.match(checks[1].label, /the triggers file only below version 2/);
	assert.ok(NAMED_CHECK_IDS.includes("fleet.store-versions") && NAMED_CHECK_IDS.includes("settings.unknown-keys"));
});

test("this host's needs come from its own files, and a store whose file does not load is left out", () => {
	const dir = tempDir("pi-761-needs-");
	const settingsFile = join(dir, "settings.json");
	const facts = { pauseWindowFacts: { versionNeed: 1, parseError: null }, triggersVersionNeed: 1, jobDataVersionNeed: 1, triggersParsed: true, fileExists: existsSync };
	assert.deepEqual(storeVersionNeeds({ ...facts, settingsFile }), { settingsVersion: 1, pauseWindowsVersion: 1, triggersVersion: 1, jobDataVersion: 1 }, "an absent overlay is the empty one");
	writeFileSync(settingsFile, '{"version": 1, "maxTurns": 5}');
	assert.equal(storeVersionNeeds({ ...facts, settingsFile }).settingsVersion, 1);
	writeFileSync(settingsFile, '{"version": 2}');
	assert.equal(Object.hasOwn(storeVersionNeeds({ ...facts, settingsFile }), "settingsVersion"), false, "a newer overlay has its own failing line");
	// A build that reads version 2: the declared version is the need, and a key its table puts at 3 raises it.
	assert.equal(storeVersionNeeds({ ...facts, settingsFile, settingsVersions: { supported: 2 } }).settingsVersion, 2, "the declared version");
	writeFileSync(settingsFile, '{"version": 3, "maxTurns": 5}');
	assert.equal(storeVersionNeeds({ ...facts, settingsFile, settingsVersions: { supported: 3, table: { maxTurns: 3 } } }).settingsVersion, 3);
	writeFileSync(settingsFile, '{"version": 2, "maxTurns": 5}');
	assert.equal(storeVersionNeeds({ ...facts, settingsFile, settingsVersions: { supported: 3, table: { maxTurns: 3 } } }).settingsVersion, undefined, "an under-declared file does not load, so it has no need");
	writeFileSync(settingsFile, '{"version": 1, "maxTurns": 5}');
	assert.deepEqual(storeVersionNeeds({ ...facts, settingsFile: join(dir, "absent.json"), pauseWindowFacts: { versionNeed: 1, parseError: "bad" }, triggersParsed: false }), { settingsVersion: 1 });
});

// Through the real collection: a minimal docker CLI that answers each argv by the first plan key it starts with.
function planSpawn(plan) {
	return (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		const outcome = plan[Object.keys(plan).find((k) => line.startsWith(k))];
		const stream = () => ({ handlers: {}, on(ev, cb) { this.handlers[ev] = cb; return this; } });
		const handlers = {};
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => {
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

/**
 * Doctor's checks for a deployment with this settings overlay text (null: no file), the peers `hosts`, and, when given,
 * a pause windows file and a triggers file holding these documents; `versionTables` is the collection's seam for the
 * stores' version tables (absent: this build's own, all empty).
 */
function doctorWith(settingsText, { hosts = [], pauseWindows = null, triggers = null, versionTables, pauseWindowsInEnvFile = false } = {}) {
	const dir = tempDir("pi-761-doctor-");
	const settingsFile = join(dir, "settings.json");
	if (settingsText !== null) writeFileSync(settingsFile, settingsText);
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SETTINGS_FILE: settingsFile, VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" };
	// A document is written as JSON; a string is the file's exact text (one that does not parse, say).
	const text = (doc) => (typeof doc === "string" ? doc : JSON.stringify(doc));
	const pauseWindowsFile = join(dir, "pause-windows.json");
	if (pauseWindows !== null) {
		writeFileSync(pauseWindowsFile, text(pauseWindows));
		// The service's `.env` names it, or this shell does: the two subjects doctor judges a boot file for.
		if (pauseWindowsInEnvFile) writeFileSync(join(dir, ".env"), `PI_PAUSE_WINDOWS_FILE=${pauseWindowsFile}\n`);
		else env.PI_PAUSE_WINDOWS_FILE = pauseWindowsFile;
	}
	const triggersFile = join(dir, "triggers.json");
	if (triggers !== null) writeFileSync((env.PI_TRIGGERS_FILE = triggersFile), text(triggers));
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return collectChecks(env, { cwd: dir, home: tempDir("pi-761-doctor-home-"), out: () => {}, spawn: planSpawn({ "docker info": 0, "docker image": 0 }), probeValkey: async () => true, readHosts: async () => ({ hosts: hosts.map((h) => ({ tz, ...h })) }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (path) => readFileSync(path), nodeVersion: "22.19.0", ...(versionTables ? { versionTables } : {}) }).then((checks) => ({ checks, settingsFile, pauseWindowsFile, triggersFile }));
}

test("the overlay keys this build does not know are named, sorted and capped, as a warning, never with a value", async () => {
	const { checks, settingsFile } = await doctorWith(JSON.stringify({ maxTurns: 5, zetaCap: "SECRET-VALUE-1", futureCap: 3, secretBundles: {} }));
	const line = checks.filter((c) => c.id === "settings.unknown-keys");
	assert.equal(line.length, 1);
	assert.equal(line[0].warn, true);
	assert.equal(line[0].label, `settings overlay ${settingsFile} holds 2 keys this build does not know (futureCap, zetaCap): the worker ignores them`);
	assert.equal(line[0].fix, "a key from a newer release is ignored here and kept by every panel and console from issue #761's release on, but an earlier one (4.3.1 included) drops every key it does not know when it writes this file, secretBundles included, so upgrade every panel and console first; a misspelt key is kept too, so remove it if it is a typo");
	assert.equal(JSON.stringify(checks).includes("SECRET-VALUE-1"), false, "names only");
	const many = Object.fromEntries(Array.from({ length: UNKNOWN_KEYS_SHOWN + 2 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]));
	const capped = (await doctorWith(JSON.stringify({ ...many, "tab\there": 1 }))).checks.find((c) => c.id === "settings.unknown-keys");
	assert.match(capped.label, /holds 11 keys this build does not know \(k00, k01, k02, k03, k04, k05, k06, k07, and 3 more\)/);
	const odd = (await doctorWith(JSON.stringify({ "tab\there": 1 }))).checks.find((c) => c.id === "settings.unknown-keys");
	assert.match(odd.label, /holds a key this build does not know \(tab here\): the worker ignores it$/, "a control character is printed as a space");
	for (const known of ['{"maxTurns": 5}', null]) assert.equal((await doctorWith(known)).checks.some((c) => c.id === "settings.unknown-keys"), false, "known keys only, or no file: nothing");
});

test("an overlay a newer pi-dispatch wrote fails with the upgrade as its fix, never an edit; a broken one keeps its own fix", async () => {
	const { checks, settingsFile } = await doctorWith('{"version": 2, "maxTurns": 5}');
	const line = checks.find((c) => c.id === "settings.overlay");
	assert.equal(line.ok, false);
	assert.equal(line.label, `settings overlay ${settingsFile} cannot be read here (settings file written by a newer pi-dispatch (version 2; this build understands 1)) -- the worker defers every job (newer-release) until it is upgraded, and the panel refuses to write over it`);
	assert.equal(line.fix, "upgrade this worker, and every panel and console that writes this file, to the release that wrote it; do not edit or delete the file, which would lose what that release wrote, unless you added `version` to it yourself: then remove that key");
	assert.equal(line.fix, newerFileFix("this worker"), "the one sentence every newer file's fix uses");
	const broken = (await doctorWith('{"maxTurns": "five"}')).checks.find((c) => c.id === "settings.overlay");
	assert.match(broken.label, /is invalid .* refuses every job as settings-overlay-invalid/);
	assert.equal(broken.fix, "fix what the reason names in that file, or delete the file to start from an empty overlay");
});

test("through the real collection, a fleet of peers from before the fields hears nothing while this host's files need version 1", async () => {
	const { checks } = await doctorWith('{"maxTurns": 5}', { hosts: [{ name: "mini2" }, { name: "mini3", settingsVersion: "1" }] });
	assert.ok(checks.some((c) => /^Fleet: 3 workers/.test(c.label ?? "")), "the fleet was read");
	assert.equal(checks.some((c) => c.id === "fleet.store-versions"), false);
});

// A build whose tables have a row: each store's need comes from this host's own files through the real collection, and
// every peer below it is named, apart from the ones that publish nothing.
const FUTURE = Object.freeze({
	settings: { supported: 2, table: { maxTurns: 2 } },
	pauseWindows: { supported: 2, table: { tz: 2 } },
	triggers: { supported: 2, runTable: { maxTurns: 2 } },
	jobData: { table: { maxTurns: 2 } },
});
const LABEL = (run = {}) => ({ on: { type: "label", any: ["dispatch"] }, run: { kind: "github", flow: "fix", ...run } });
const PEERS = [
	{ name: "mini2", settingsVersion: "1", pauseWindowsVersion: "1", triggersVersion: "1", jobDataVersion: "1" },
	{ name: "mini3" },
	{ name: "mini4", settingsVersion: "2", pauseWindowsVersion: "2", triggersVersion: "2", jobDataVersion: "2" },
];
const fleetLines = ({ checks }) => checks.filter((c) => c.id === "fleet.store-versions").map((c) => c.label);

test("with a version table that has a row, this host's files raise each store's need, and the lower and the silent peers are named apart", async () => {
	const needing = {
		hosts: PEERS,
		pauseWindows: { version: 2, windows: [{ scope: "*", from: "01:00", to: "02:00", tz: "Europe/Amsterdam" }] },
		triggers: { version: 2, triggers: [LABEL({ maxTurns: 5 })] },
		versionTables: FUTURE,
	};
	const lines = fleetLines(await doctorWith('{"version": 2, "maxTurns": 5}', needing));
	const stores = Object.values(STORE_FLEET_LINES);
	assert.deepEqual(lines, stores.flatMap((line) => [
		`mini2 reads ${line.store} only below version 2, the version this host's file needs: it ${line.older}`,
		`mini3 publishes no version for ${line.store} (a worker from before issue #761), while this host's file needs version 2: it ${line.silent}`,
	]), "one lower line and one silent line per store; mini4 reads every one");
	const fixes = (await doctorWith('{"version": 2, "maxTurns": 5}', needing)).checks.filter((c) => c.id === "fleet.store-versions").map((c) => c.fix);
	assert.deepEqual(fixes, stores.flatMap((line) => Array(2).fill(`upgrade and restart the workers named, and ${line.writers}, to a release that reads version 2`)));
	// The job data's need comes from the run keys alone: a triggers file that declares no version still queues such jobs.
	const jobOnly = fleetLines(await doctorWith("{}", { ...needing, pauseWindows: null, triggers: { triggers: [LABEL({ maxTurns: 5 })] }, versionTables: { jobData: FUTURE.jobData } }));
	assert.deepEqual(jobOnly.map((l) => l.split(" only below")[0].split(" (a worker")[0]), ["mini2 reads the jobs this host's triggers queue", "mini3 publishes no version for the jobs this host's triggers queue"]);
});

// The jobs a triggers file queues carry what the loader KEEPS of each entry (the builders copy the parsed `run`), never a
// raw key it drops. `packageCanary` is a job data field (version 2) only the Updates page's canary job carries; written
// by hand into a trigger's `run`, the loader drops it, so no job carries it and no peer needs version 2 for it.
test("the jobs' need is what the loader keeps: a hand-written run.packageCanary, which the loader drops, needs no version 2", async () => {
	const canary = { packageCanary: { name: "pi-x", version: "1.0.0" } };
	const cron = { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/repo", flow: "fix", task: "x", ...canary } };
	const { checks } = await doctorWith("{}", { hosts: PEERS, triggers: { triggers: [LABEL(canary), cron] } });
	assert.equal(checks.some((c) => c.id === "triggers.file" && c.ok === false), false, "the loader accepts the file");
	assert.ok(checks.some((c) => /^Fleet: 4 workers/.test(c.label ?? "")), "the fleet was read");
	assert.deepEqual(fleetLines({ checks }), [], "need 1: mini2 (version 1) and mini3 (none) are not named");
	assert.equal(checks.some((c) => /version 2/.test(`${c.label ?? ""} ${c.fix ?? ""}`)), false, "no line claims version 2");
	// A key the loader keeps still counts, beside the dropped one, under a table that puts both above 1.
	const both = { jobData: { table: { packageCanary: 2, maxTurns: 2 } } };
	assert.deepEqual(fleetLines(await doctorWith("{}", { hosts: PEERS, triggers: { triggers: [LABEL(canary)] }, versionTables: both })), []);
	const kept = fleetLines(await doctorWith("{}", { hosts: PEERS, triggers: { triggers: [LABEL({ ...canary, maxTurns: 5 })] }, versionTables: both }));
	assert.deepEqual(kept.map((l) => l.split(" only below")[0].split(" (a worker")[0]), ["mini2 reads the jobs this host's triggers queue", "mini3 publishes no version for the jobs this host's triggers queue"]);
});

test("the store-version lines clear when every peer reads the need, and when this host's files no longer need it", async () => {
	const files = {
		pauseWindows: { version: 2, windows: [{ scope: "*", from: "01:00", to: "02:00", tz: "Europe/Amsterdam" }] },
		triggers: { version: 2, triggers: [LABEL({ maxTurns: 5 })] },
		versionTables: FUTURE,
	};
	const upgraded = PEERS.map((h) => ({ ...h, settingsVersion: "2", pauseWindowsVersion: "2", triggersVersion: "3", jobDataVersion: "2" }));
	assert.deepEqual(fleetLines(await doctorWith('{"version": 2, "maxTurns": 5}', { ...files, hosts: upgraded })), [], "every peer reads version 2 or more");
	// The same old peers, and files holding nothing the table puts above 1: every need is 1 again.
	const plain = { hosts: PEERS, versionTables: FUTURE, pauseWindows: { windows: [{ scope: "*", from: "01:00", to: "02:00" }] }, triggers: { triggers: [LABEL()] } };
	const quiet = await doctorWith("{}", plain);
	assert.deepEqual(fleetLines(quiet), []);
	assert.ok(quiet.checks.some((c) => /^Fleet: 4 workers/.test(c.label ?? "")), "the fleet was read");
	assert.equal(quiet.checks.some((c) => c.ok === false && /^(settings\.overlay|triggers\.file|pause-windows\.)/.test(c.id ?? "")), false, "every file loads, so each need was judged, and is 1");
});

// The same build, but the row is a VALUE rule (a wider range for a field every release knows): each store's need comes
// from what its fields hold, through the same seam, and an ordinary value needs nothing.
const WIDER = (v) => (Number.isSafeInteger(v) && v > 100 ? 2 : 1);
const FUTURE_VALUES = Object.freeze({
	settings: { supported: 2, valueTable: { maxTurns: WIDER } },
	pauseWindows: { supported: 2, valueTable: { tz: (tz) => (tz === "Europe/Amsterdam" ? 2 : 1) } },
	triggers: { supported: 2, runValueTable: { maxTurns: WIDER } },
	jobData: { valueTable: { maxTurns: WIDER } },
});

test("with a value rule instead of a field row, a wider value raises each store's need, and an ordinary one needs nothing", async () => {
	const wider = {
		hosts: PEERS,
		pauseWindows: { version: 2, windows: [{ scope: "*", from: "01:00", to: "02:00", tz: "Europe/Amsterdam" }] },
		triggers: { version: 2, triggers: [LABEL({ maxTurns: 500 })] },
		versionTables: FUTURE_VALUES,
	};
	const lines = fleetLines(await doctorWith('{"version": 2, "maxTurns": 500}', wider));
	assert.deepEqual(lines, Object.values(STORE_FLEET_LINES).flatMap((line) => [
		`mini2 reads ${line.store} only below version 2, the version this host's file needs: it ${line.older}`,
		`mini3 publishes no version for ${line.store} (a worker from before issue #761), while this host's file needs version 2: it ${line.silent}`,
	]));
	const ordinary = { hosts: PEERS, versionTables: FUTURE_VALUES, pauseWindows: { windows: [{ scope: "*", from: "01:00", to: "02:00", tz: "UTC" }] }, triggers: { triggers: [LABEL({ maxTurns: 5 })] } };
	assert.deepEqual(fleetLines(await doctorWith('{"maxTurns": 5}', ordinary)), [], "the same fields holding ordinary values need version 1");
});

test("a pause windows or triggers file that declares version 2 while nothing in it needs 2 still needs 2, so a peer that reads only 1 is named", async () => {
	// A peer judges the DECLARED version, never the content: at 1 it reads such a file as newer and defers every job. So
	// each file's need is the higher of what it declares and what its fields need, as the settings need is; the content
	// alone would say 1 here (the tables are empty) and leave that peer unnamed.
	const declared = {
		hosts: PEERS,
		pauseWindows: { version: 2, windows: [{ scope: "*", from: "01:00", to: "02:00" }] },
		triggers: { version: 2, triggers: [LABEL()] },
		versionTables: { pauseWindows: { supported: 2 }, triggers: { supported: 2 } },
	};
	const lines = fleetLines(await doctorWith("{}", declared));
	assert.deepEqual(lines, [STORE_FLEET_LINES.pauseWindowsVersion, STORE_FLEET_LINES.triggersVersion].flatMap((line) => [
		`mini2 reads ${line.store} only below version 2, the version this host's file needs: it ${line.older}`,
		`mini3 publishes no version for ${line.store} (a worker from before issue #761), while this host's file needs version 2: it ${line.silent}`,
	]), "the settings overlay and the job data need 1; mini4 reads both files");
	// The same files declaring nothing: every need is 1, and nobody is named.
	const plain = { ...declared, pauseWindows: { windows: declared.pauseWindows.windows }, triggers: { triggers: declared.triggers.triggers } };
	assert.deepEqual(fleetLines(await doctorWith("{}", plain)), []);
});

test("a pause windows file a newer pi-dispatch wrote gets the upgrade as its fix, in this shell and in the service's .env; a broken one keeps its own fix", async () => {
	const newerReason = /pause-windows file written by a newer pi-dispatch \(version 2; this build understands 1\)/;
	const shell = await doctorWith("{}", { pauseWindows: { version: 2, windows: [] } });
	const shellLine = shell.checks.find((c) => c.id === "pause-windows.file-shell");
	assert.match(shellLine.label, newerReason);
	assert.equal(shellLine.fix, "upgrade this host's worker, and every panel and console that writes this file, to the release that wrote it; do not edit or delete the file, which would lose what that release wrote, unless you added `version` to it yourself: then remove that key");
	const service = await doctorWith("{}", { pauseWindows: { version: 2, windows: [] }, pauseWindowsInEnvFile: true });
	const serviceLine = service.checks.find((c) => c.id === "pause-windows.file");
	assert.deepEqual([serviceLine.ok, newerReason.test(serviceLine.label), serviceLine.fix], [false, true, newerFileFix("this host's worker")]);
	// Broken, not newer: a version that is no integer, and a file that does not parse. Today's fix, naming the file.
	for (const broken of [{ version: "2", windows: [] }, "{ nope"]) {
		const bad = await doctorWith("{}", { pauseWindows: broken });
		assert.equal(bad.checks.find((c) => c.id === "pause-windows.file-shell").fix, `fix ${bad.pauseWindowsFile}, or point PI_PAUSE_WINDOWS_FILE at a file that loads`, JSON.stringify(broken));
		const badService = await doctorWith("{}", { pauseWindows: broken, pauseWindowsInEnvFile: true });
		assert.equal(badService.checks.find((c) => c.id === "pause-windows.file").fix, `fix ${badService.pauseWindowsFile}, or point PI_PAUSE_WINDOWS_FILE at a file that loads`, JSON.stringify(broken));
	}
});

test("a triggers file a newer pi-dispatch wrote gets the upgrade as its fix; a broken one keeps its own fix", async () => {
	const newer = await doctorWith("{}", { triggers: { version: 2, triggers: [] } });
	const line = newer.checks.find((c) => c.id === "triggers.file");
	assert.match(line.label, /triggers file written by a newer pi-dispatch \(version 2; this build understands 1\)/);
	assert.equal(line.fix, "upgrade this host's worker and receiver, and every panel and console that writes this file, to the release that wrote it; do not edit or delete the file, which would lose what that release wrote, unless you added `version` to it yourself: then remove that key -- every trigger-derived check below is skipped until this host reads it");
	for (const broken of [{ version: "2", triggers: [] }, { triggers: "reshaped" }, "{ nope"]) {
		const bad = await doctorWith("{}", { triggers: broken });
		assert.equal(bad.checks.find((c) => c.id === "triggers.file").fix, `fix ${bad.triggersFile} so it loads (the message above names the entry and the reason), then re-run doctor -- every trigger-derived check below is skipped until it loads`, JSON.stringify(broken));
	}
});
