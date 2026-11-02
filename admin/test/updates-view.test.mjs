import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANNOT_ADOPT_REASONS, CHECK_STATES, HOST_PI_STATES, UPDATES_OVERDUE_MS } from "@edgehero/pi-dispatch/updates";
import { ADMIN_USED_API } from "../../worker/src/updates-look.mjs";
import { CANNOT_ADOPT_WORDS, HOST_STATES_DRAWN, PI_STATES_DRAWN } from "../src/console/panels/updates.mjs";
import { HOST_ADOPT_STATES, PI_ROW_STATES, UPDATE_ROW_STATES, canaryResultOf, hostStandings, packageRow, piRow, readDeploymentUpdates, readStaged, readTriggersDocument, readUpdates } from "../src/updates-view.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { UPDATES_DRAW } from "./helpers/updates-goldens.mjs";
import { USED_API } from "../src/index.ts";

const NOW = 1_800_000_000_000;
/** A Valkey holding these rows. */
const fakeValkey = ({ looks = [], desiredRow = null } = {}) => ({
	smembers: async (key) => (key === "updates:hosts" ? looks.map((l) => l.host) : []),
	mget: async () => looks.map((l) => JSON.stringify(l)),
	get: async () => null,
	hgetall: async (key) => (key === "updates:desired" && desiredRow ? { [desiredRow.name]: JSON.stringify(desiredRow) } : {}),
});
const pkg = { name: "pi-lint", version: "1.4.2", from: "pi-packages" };
const rec = (fields = {}) => ({ jobId: "gh-1", outcome: "completed", endedAt: "2026-11-02T10:00:00.000Z", tokens: { cost: 0.19 }, packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" }, ...fields });

test("a canary reads completed only when the run completed AND the runner said its candidate loaded", () => {
	assert.equal(canaryResultOf([rec()], "pi-lint", "1.4.3").state, "completed");
	const notLoaded = canaryResultOf([rec({ packageCanary: { name: "pi-lint", version: "1.4.3", load: "failed" } })], "pi-lint", "1.4.3");
	assert.deepEqual([notLoaded.state, notLoaded.why], ["failed", "did-not-load"], "a clean exit proves nothing");
	const unreported = canaryResultOf([rec({ packageCanary: { name: "pi-lint", version: "1.4.3", load: "not-reported" } })], "pi-lint", "1.4.3");
	assert.deepEqual([unreported.state, unreported.why], ["failed", "did-not-load"], "a missing report reads as failed");
	const ranOut = canaryResultOf([rec({ outcome: "failed" })], "pi-lint", "1.4.3");
	assert.deepEqual([ranOut.state, ranOut.why], ["failed", "run-ended"]);
	assert.equal(canaryResultOf([rec()], "pi-lint", "1.4.4"), null, "another version's run says nothing about this one");
	assert.equal(canaryResultOf([rec()], "other", "1.4.3"), null);
	assert.equal(canaryResultOf([{ jobId: "x", outcome: "completed" }, null, 7], "pi-lint", "1.4.3"), null);
	const older = rec({ jobId: "old", outcome: "failed", endedAt: "2026-11-01T10:00:00.000Z" }), newer = rec({ jobId: "new" });
	assert.equal(canaryResultOf([older, newer], "pi-lint", "1.4.3").jobId, "new");
	assert.equal(canaryResultOf([newer, older], "pi-lint", "1.4.3").jobId, "new", "the newest run is the result, whatever order they were read in");
});

test("a host with no row at this generation is pending, past the limit overdue, and an older row does not count", () => {
	const desired = { name: "pi-lint", generation: 5, at: NOW };
	const applied = { a: { "pi-lint": { generation: 5, state: "adopted", version: "1.4.3", digest: "d" } }, b: { "pi-lint": { generation: 4, state: "adopted", version: "1.4.2" } }, c: {} };
	assert.deepEqual(hostStandings({ desired, applied, hosts: ["a", "b", "c"], now: NOW + 1 }).map((s) => s.state), ["adopted", "pending", "pending"]);
	assert.deepEqual(hostStandings({ desired, applied, hosts: ["a", "b"], now: NOW + UPDATES_OVERDUE_MS + 1 }).map((s) => s.state), ["adopted", "overdue"]);
});

const row = (fields) => packageRow({ pkg, look: { state: "ok", newest: "1.4.3" }, desired: null, standings: [], canary: null, facts: null, ...fields });
const adopt = { op: "adopt", version: "1.4.3", generation: 5, name: "pi-lint" };
const undo = { op: "undo", version: "1.4.2", generation: 6, undoOf: 5, name: "pi-lint" };

test("a package's row: every state, and what a person asked for leads what a registry says", () => {
	assert.equal(row({}).state, "newer");
	assert.equal(row({ look: { state: "ok", newest: "1.4.2" } }).state, "current");
	assert.equal(row({ look: { state: "ok", newest: "1.4.1" } }).state, "current", "older than what is staged is not newer");
	assert.equal(row({ look: { state: "not-looking", newest: null } }).state, "not-looking");
	assert.equal(row({ look: { state: "stale", newest: "1.4.3" } }).state, "stale", "stale is said, even with a version in hand");
	assert.equal(row({ look: { state: "unknown", newest: null } }).state, "unknown");
	assert.equal(row({ canary: { state: "completed" } }).state, "canary-completed");
	assert.equal(row({ canary: { state: "failed" } }).state, "canary-failed");
	assert.equal(row({ desired: adopt, standings: [{ state: "adopted" }, { state: "pending" }] }).state, "adopting");
	assert.equal(row({ desired: adopt, standings: [{ state: "adopted" }, { state: "overdue" }] }).state, "adopting");
	assert.equal(row({ desired: adopt, standings: [{ state: "adopted" }, { state: "no-change" }] }).state, "adopted");
	assert.equal(row({ desired: adopt, standings: [{ state: "adopted" }, { state: "cannot-adopt" }] }).state, "partial", "partial is a real state, and outranks pending");
	assert.equal(row({ desired: adopt, standings: [{ state: "pending" }, { state: "cannot-adopt" }] }).state, "partial");
	assert.equal(row({ desired: undo, standings: [{ state: "undone" }, { state: "pending" }] }).state, "undoing");
	assert.equal(row({ desired: undo, standings: [{ state: "undone" }, { state: "no-change" }], canary: { state: "completed" } }).state, "canary-completed", "after an Undo the row is what it was before");
	assert.equal(row({ desired: undo, standings: [{ state: "cannot-adopt" }] }).state, "partial");
});

test("once something newer appears, an adopted row is about that, and its Undo stays", () => {
	const after = packageRow({ pkg: { ...pkg, version: "1.4.3" }, look: { state: "ok", newest: "1.5.0" }, desired: adopt, standings: [{ state: "adopted" }], canary: null, facts: null });
	assert.equal(after.state, "newer", "a person can try the next one");
	assert.equal(after.desired.op, "adopt", "the panel still offers Undo from this");
	assert.equal(packageRow({ pkg: { ...pkg, version: "1.4.3" }, look: { state: "ok", newest: "1.4.3" }, desired: adopt, standings: [{ state: "adopted" }], canary: null, facts: null }).state, "adopted");
});

test("a row's canary is the one for the version it is about, never the version adopted before it", async () => {
	const read = await readUpdates({ redis: fakeValkey({ looks: [{ v: 1, host: "h", at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [{ name: "pi-lint", version: "1.4.3", newest: "1.5.0", read: "ok" }] }], desiredRow: { v: 1, generation: 5, name: "pi-lint", version: "1.4.3", op: "adopt", from: "1.4.2", by: "ops", at: NOW } }), staged: { packages: [{ ...pkg, version: "1.4.3" }] }, records: [rec()], pinned: "1.5.0", now: NOW });
	assert.equal(read.packages[0].newest, "1.5.0");
	assert.equal(read.packages[0].canary, null, "only 1.4.3 has run: nothing says 1.5.0 completed, so Adopt's gate must not think so");
});

test("the adopted tree is compared with the canaried one, and the difference is said", () => {
	const facts = { digest: "a".repeat(64) };
	assert.equal(row({ desired: adopt, facts, standings: [{ state: "adopted", digest: "a".repeat(64) }] }).differs, false);
	assert.equal(row({ desired: adopt, facts, standings: [{ state: "adopted", digest: "a".repeat(64) }, { state: "adopted", digest: "b".repeat(64) }] }).differs, true);
	assert.equal(row({ desired: adopt, facts: null, standings: [{ state: "adopted", digest: "b".repeat(64) }] }).differs, false, "no canary digest retained: nothing to compare, and nothing claimed");
});

test("pi's row: its checks are only words a look reported, and unknown is never drawn as passing", () => {
	const looks = (pi, stale = false) => ({ hosts: [{ stale, record: { pi } }] });
	assert.equal(piRow({ pinned: "1.5.0", looks: { unreachable: true } }).state, "unknown");
	assert.equal(piRow({ pinned: "1.5.0", looks: { hosts: [] } }).state, "not-looking");
	assert.equal(piRow({ pinned: "1.5.0", looks: looks({ read: "ok", newest: "1.6.0", checks: "passing" }, true) }).state, "stale", "an old passing is not a passing");
	assert.equal(piRow({ pinned: "1.5.0", looks: looks({ read: "unknown", newest: null }) }).state, "unknown");
	assert.equal(piRow({ pinned: "1.5.0", looks: looks({ read: "ok", newest: "1.5.0", checks: null }) }).state, "current");
	for (const word of CHECK_STATES) assert.equal(piRow({ pinned: "1.5.0", looks: looks({ read: "ok", newest: "1.6.0", checks: word }) }).state, `checks-${word}`);
	assert.equal(piRow({ pinned: "1.5.0", looks: looks({ read: "ok", newest: "1.6.0", checks: "great" }) }).state, "checks-unknown");
});

test("every state has its words, each held to the list it comes from, both ways", () => {
	assert.deepEqual(Object.keys(CANNOT_ADOPT_WORDS).sort(), [...CANNOT_ADOPT_REASONS].sort());
	assert.deepEqual([...PI_STATES_DRAWN].sort(), [...PI_ROW_STATES].sort());
	assert.deepEqual([...HOST_STATES_DRAWN].sort(), [...HOST_PI_STATES].sort());
	assert.deepEqual([...HOST_ADOPT_STATES].sort(), ["adopted", "cannot-adopt", "no-change", "overdue", "pending", "undone"]);
});

test("the look's copy of the admin extension's API list is that list", () => {
	assert.deepEqual([...ADMIN_USED_API], [...USED_API]);
});

test("each row state and each pi state is actually drawn by a golden, so none is unreviewed", async () => {
	for (const key of Object.keys(UPDATES_DRAW)) assert.match(key, /^updates-[a-z-]+\.(operator|viewer)$/);
	const golden = new Set(readdirSync(new URL("./fixtures/console/panels/", import.meta.url)).filter((f) => f.startsWith("updates-")).map((f) => f.replace(/\.html$/, "")));
	assert.deepEqual([...golden].sort(), Object.keys(UPDATES_DRAW).sort(), "a golden per drawn state");
	const text = [...golden].map((name) => readFileSync(new URL(`./fixtures/console/panels/${name}.html`, import.meta.url), "utf8")).join("\n");
	// One sentence for each state on each list, so a state nobody draws, or a word that went missing from one, fails here.
	const ROW = { current: "The newest version.", newer: "Not tried yet.", "canary-completed": "Canary completed, read the run", "canary-failed": "Canary failed: the candidate did not load", adopting: "Adopting 1.4.3", adopted: "on every host", partial: "its overlay is read-only here", undoing: "Going back to 1.4.2", "not-looking": "Not looking.", stale: "old, so what is newest may have moved", unknown: "Unknown: the look could not read this" };
	assert.deepEqual(Object.keys(ROW).sort(), [...UPDATE_ROW_STATES].sort());
	const PI = { current: "The newest version.", "checks-passing": "checks pass on 1.6.0", "checks-failing": "Checks fail. Jobs stay on 1.5.0", "checks-pending": "still running on it", "checks-unknown": "Whether pi-dispatch", "not-looking": "Not looking.", stale: "old, so what is newest may have moved", unknown: "Unknown: the look could not read this" };
	assert.deepEqual(Object.keys(PI).sort(), [...PI_ROW_STATES].sort());
	for (const sentence of [...Object.values(ROW), ...Object.values(PI), "Canary failed: the run did not complete", "Newer than pi-dispatch is tested with", "Older than pi-dispatch is tested with", "No pi on this host", "pi could not be read", "is not the tree the canary ran", "overdue", "The stage manifest could not be read", "reviewed subscription adapter"]) {
		assert.ok(text.includes(sentence), `a golden draws: ${sentence}`);
	}
	assert.doesNotMatch(text, /\bpassed\b/i, "a canary never reads passed: a job that completed does not prove the extension is good");
});

test("a viewer sees versions and results and no button; a read-only console shows none either", async () => {
	for (const name of ["updates-newer-available.viewer", "updates-canary-completed.viewer", "updates-adopted.viewer", "updates-adopting.viewer", "updates-partial.viewer", "updates-readonly.operator"]) {
		const page = await UPDATES_DRAW[name]();
		const panels = page.slice(page.indexOf('id="p-up-jobs"'));
		assert.doesNotMatch(panels, /data-action="package-(canary|adopt|undo)"/, name);
	}
	assert.match(await UPDATES_DRAW["updates-newer-available.operator"](), /data-action="package-canary"/);
	assert.match(await UPDATES_DRAW["updates-canary-completed.operator"](), /data-action="package-adopt"/);
	assert.match(await UPDATES_DRAW["updates-adopted.operator"](), /data-action="package-undo"/);
});

test("a trigger that resumes its transcript is not offered: its next run would continue the candidate's work", async () => {
	const read = await readUpdates({ redis: fakeValkey(), staged: { packages: [] }, triggersDocument: { triggers: [{ on: { type: "cron", id: "a" }, run: { resume: true } }, { on: { type: "cron", id: "cmd" }, run: { command: "x" } }, { on: { type: "cron", id: "folio" }, run: { portfolio: true } }, { on: { type: "cron", id: "off" }, run: { packages: false } }, { on: { type: "comment" }, run: {} }, { on: { type: "cron", id: "b" }, run: {} }] }, now: NOW });
	assert.deepEqual(read.triggers.map((t) => [t.index, t.id]), [[5, "b"]], "and it keeps the file's own index, which is what the preview takes");
});

test("a reviewed subscription adapter says why it has no button, and an operator gets none either", async () => {
	const page = await UPDATES_DRAW["updates-adapter.operator"]();
	assert.match(page, /reviewed subscription adapter/);
	assert.doesNotMatch(page.slice(page.indexOf('id="p-up-jobs"')), /data-action="package-(canary|adopt)"/);
});

test("something newer after an Adopt can be tried, and the Adopt can still be undone from there", async () => {
	const page = await UPDATES_DRAW["updates-newer-after-adopt.operator"]();
	assert.match(page, /data-action="package-adopt"/);
	assert.match(page, /data-action="package-undo"/);
});

test("the page's facts come from what a deployment really holds: its manifest and its triggers file, through the real readers", async () => {
	const root = tempDir("updates-real-");
	mkdirSync(join(root, "pi-global", "packages"), { recursive: true });
	writeFileSync(join(root, "pi-global", "packages", "packages.json"), JSON.stringify({ stagedAt: "x", packages: [{ name: "pi-lint", version: "1.4.2", dir: "pi-lint--1.4.2--aaaaaaaa", from: "host" }] }));
	writeFileSync(join(root, "triggers.json"), JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 6 * * *" }, run: { kind: "local", folder: "/f", flow: "fix", task: "t", maxCostUsd: 2 } }] }));
	const look = { v: 1, host: "h", at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [{ name: "pi-lint", version: "1.4.2", newest: "1.4.3", read: "ok" }] };
	const read = await readDeploymentUpdates({ redis: fakeValkey({ looks: [look] }), paths: { globalPiDir: join(root, "pi-global"), triggersPath: join(root, "triggers.json") }, pinned: "1.5.0", now: NOW });
	assert.equal(read.packages[0].name, "pi-lint", "a row has the name the actions look it up by");
	assert.equal(read.packages[0].version, "1.4.2");
	assert.equal(read.packages[0].state, "newer");
	assert.deepEqual(read.triggers, [{ index: 0, id: "nightly", capUsd: 2 }]);
	assert.deepEqual(readStaged({ globalPiDir: join(root, "nowhere") }), { packages: [], unreadable: false }, "nothing staged is not a fault");
	writeFileSync(join(root, "pi-global", "packages", "packages.json"), "{ not json");
	assert.deepEqual(readStaged({ globalPiDir: join(root, "pi-global") }), { packages: [], unreadable: true }, "a manifest that cannot be read is said");
	assert.equal(readTriggersDocument({ triggersPath: join(root, "absent.json") }), null);
});

test("the console reads Updates through that one composed read, with its own paths, and both of its actions use it", () => {
	const cli = readFileSync(new URL("../src/console/cli.mjs", import.meta.url), "utf8");
	assert.match(cli, /m\.updatesView\.readDeploymentUpdates\(\{[^}]*paths: side\.paths/s, "an actions' lookup and the page must read the same shapes");
	assert.match(cli, /updates: \(\) => readUpdatesFacts\(\)/, "the page");
	assert.match(cli, /updates: \{ read: readUpdatesFacts,/, "the actions");
	assert.doesNotMatch(cli.slice(cli.indexOf("const readUpdatesFacts"), cli.indexOf("const pageDeps")), /readStagedPackages/, "that one is for display, and hands back strings");
});

test("pi's row: a stale host's word does not count beside a fresh one", () => {
	const stale = { stale: true, record: { pi: { read: "ok", newest: "1.6.0", checks: "passing" } } };
	const fresh = { stale: false, record: { pi: { read: "ok", newest: "1.5.0", checks: null } } };
	assert.equal(piRow({ pinned: "1.5.0", looks: { hosts: [stale, fresh] } }).state, "current");
});

test("an adopted row keeps its own canary and facts when nothing newer has been seen, whether or not anything is known", async () => {
	const adopted = { v: 1, generation: 5, name: "pi-lint", version: "1.4.3", op: "adopt", from: "1.4.2", by: "ops", at: NOW };
	for (const newest of ["1.4.3", "1.4.1", null]) {
		const look = { v: 1, host: "h", at: NOW, everyHours: 24, pi: {}, hostPi: {}, packages: [{ name: "pi-lint", version: "1.4.3", newest, read: newest ? "ok" : "unknown" }] };
		const read = await readUpdates({ redis: fakeValkey({ looks: [look], desiredRow: adopted }), staged: { packages: [{ ...pkg, version: "1.4.3" }] }, records: [rec()], pinned: "1.5.0", now: NOW });
		assert.equal(read.packages[0].canary?.jobId, "gh-1", String(newest));
	}
});

test("a look's view: only fresh hosts speak while any is fresh, and the newest version any of them saw leads", async () => {
	const look = (host, at, newest, pi = "1.5.0") => ({ v: 1, host, at, everyHours: 24, pi: { pinned: "1.5.0", newest: pi, read: "ok", checks: "passing" }, hostPi: {}, packages: [{ name: "pi-lint", version: "1.4.2", newest, read: "ok" }] });
	const staged = { packages: [{ name: "pi-lint", version: "1.4.2" }] };
	const old = NOW - 72 * 3_600_000;
	const mixed = await readUpdates({ redis: fakeValkey({ looks: [look("stale", old, "1.9.9"), look("fresh", NOW, "1.4.3")] }), staged, now: NOW, pinned: "1.5.0" });
	assert.equal(mixed.packages[0].newest, "1.4.3", "what a stale look saw is not what is newest");
	assert.equal(mixed.state, "looking");
	const disagree = await readUpdates({ redis: fakeValkey({ looks: [look("a", NOW, "1.4.3", "1.6.0"), look("b", NOW, "1.4.9", "1.7.0")] }), staged, now: NOW, pinned: "1.5.0" });
	assert.equal(disagree.packages[0].newest, "1.4.9");
	assert.equal(disagree.pi.newest, "1.7.0");
	const reversed = await readUpdates({ redis: fakeValkey({ looks: [look("b", NOW, "1.4.9", "1.7.0"), look("a", NOW, "1.4.3", "1.6.0")] }), staged, now: NOW, pinned: "1.5.0" });
	assert.equal(reversed.packages[0].newest, "1.4.9", "whichever host answered first");
});

test("a canary is offered only as a trigger that could run it: cron, serving staged packages", async () => {
	const page = await UPDATES_DRAW["updates-newer-available.operator"]();
	assert.match(page, /name="index"[^>]*value="2"/, "the fixture's one eligible trigger");
	assert.doesNotMatch(page, /nightly-off/, "a trigger that withholds staged packages is not offered");
});

test("third-party text is escaped where it is drawn", async () => {
	const page = await UPDATES_DRAW["updates-adopted.operator"]();
	const facts = await UPDATES_DRAW["updates-canary-completed.operator"]();
	assert.match(facts, /Fixes the &lt;b&gt;path&lt;\/b&gt; rule/);
	assert.doesNotMatch(facts, /<b>path<\/b>/);
	assert.doesNotMatch(page, /<b>path<\/b>/);
});

test("with no Valkey the page says unknown, not that all is well", async () => {
	const read = await readUpdates({ redis: null, staged: { packages: [pkg] }, pinned: "1.5.0", now: NOW });
	assert.equal(read.state, "unknown");
	assert.equal(read.pi.state, "unknown");
	assert.equal(read.packages[0].state, "unknown");
	assert.equal(read.desiredUnreadable, true);
});

test("the recent list is only what was applied, from rows that name a real package and version", async () => {
	const read = await readUpdates({ redis: null, staged: { packages: [] }, now: NOW, audit: [
		{ action: "write-applied", kind: "package-adopt", outcome: "ok", target: "pi-lint@1.4.3", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-02T00:00:00.000Z" },
		{ action: "write", kind: "package-adopt", outcome: "ok", target: "not-applied@1.0.0", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-03T00:00:00.000Z" },
		{ action: "write-applied", kind: "package-adopt", outcome: "failed", target: "failed@1.0.0", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-03T00:00:00.000Z" },
		{ action: "write-applied", kind: "setting-set", outcome: "ok", target: "maxTurns@1.0.0", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-03T00:00:00.000Z" },
		{ action: "write-applied", kind: "package-adopt", outcome: "ok", target: "<script>@1.0.0", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-03T00:00:00.000Z" },
	] });
	assert.deepEqual(read.recent.map((r) => `${r.name}@${r.version}`), ["pi-lint@1.4.3"]);
	const canary = await readUpdates({ redis: null, staged: { packages: [] }, now: NOW, audit: [{ action: "write-applied", kind: "package-canary", outcome: "ok", target: "pi-lint@1.4.3" }] });
	assert.deepEqual(canary.recent, [], "a canary is not an adoption");
});
