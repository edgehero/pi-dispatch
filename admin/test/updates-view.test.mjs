import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { CANNOT_ADOPT_REASONS, CHECK_STATES, HOST_PI_STATES, UPDATES_OVERDUE_MS } from "@edgehero/pi-dispatch/updates";
import { ADMIN_USED_API } from "../../worker/src/updates-look.mjs";
import { CANNOT_ADOPT_WORDS, HOST_STATES_DRAWN, PI_STATES_DRAWN } from "../src/console/panels/updates.mjs";
import { HOST_ADOPT_STATES, PI_ROW_STATES, UPDATE_ROW_STATES, canaryResultOf, hostStandings, packageRow, piRow, readUpdates } from "../src/updates-view.mjs";
import { UPDATES_DRAW, updatesFacts } from "./helpers/updates-goldens.mjs";
import { USED_API } from "../src/index.ts";

const NOW = 1_800_000_000_000;
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
	const newest = canaryResultOf([rec({ jobId: "old", outcome: "failed", endedAt: "2026-11-01T10:00:00.000Z" }), rec({ jobId: "new" })], "pi-lint", "1.4.3");
	assert.equal(newest.jobId, "new", "the newest run is the result, whatever order they were read in");
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
	const seen = new Set(), pi = new Set();
	const sources = { "updates-newer-available": {}, };
	void sources;
	for (const key of Object.keys(UPDATES_DRAW)) assert.match(key, /^updates-[a-z-]+\.(operator|viewer)$/);
	const probe = async (facts) => {
		const read = await updatesFacts(facts);
		pi.add(read.pi.state);
		for (const r of read.packages) seen.add(r.state);
	};
	const HOUR = 3_600_000;
	await probe({});
	await probe({ records: [rec()] });
	await probe({ records: [rec({ outcome: "failed" })] });
	await probe({ redis: { looks: [] } });
	await probe({ redis: { down: true } });
	await probe({ now: 1_767_355_200_000 + 400 * 24 * HOUR });
	assert.ok(seen.has("newer") && seen.has("canary-completed") && seen.has("canary-failed") && seen.has("not-looking") && seen.has("unknown") && seen.has("stale"), [...seen].join());
	const golden = new Set(readdirSync(new URL("./fixtures/console/panels/", import.meta.url)).filter((f) => f.startsWith("updates-")).map((f) => f.replace(/\.html$/, "")));
	assert.deepEqual([...golden].sort(), Object.keys(UPDATES_DRAW).sort(), "a golden per drawn state");
	const text = [...golden].map((name) => readFileSync(new URL(`./fixtures/console/panels/${name}.html`, import.meta.url), "utf8")).join("\n");
	for (const sentence of ["The newest version.", "Not tried yet.", "Canary completed, read the run", "Canary failed: the candidate did not load", "Canary failed: the run did not complete", "Adopting 1.4.3", "on every host", "Going back to 1.4.2", "Not looking.", "Unknown: the look could not read this", "Checks fail. Jobs stay on 1.5.0", "checks pass on 1.6.0", "still running on it", "Whether pi-dispatch", "Newer than pi-dispatch is tested with", "Older than pi-dispatch is tested with", "No pi on this host", "pi could not be read", "its overlay is read-only here", "is not the tree the canary ran", "overdue"]) {
		assert.ok(text.includes(sentence), `a golden draws: ${sentence}`);
	}
	assert.doesNotMatch(text, /\bpassed\b/i, "a canary never reads passed: a job that completed does not prove the extension is good");
});

test("a viewer sees versions and results and no button; a read-only console shows none either", async () => {
	for (const name of ["updates-newer-available.viewer", "updates-canary-completed.viewer", "updates-adopted.viewer", "updates-readonly.operator"]) {
		const page = await UPDATES_DRAW[name]();
		const panels = page.slice(page.indexOf('id="p-up-jobs"'));
		assert.doesNotMatch(panels, /data-action="package-(canary|adopt|undo)"/, name);
	}
	assert.match(await UPDATES_DRAW["updates-newer-available.operator"](), /data-action="package-canary"/);
	assert.match(await UPDATES_DRAW["updates-canary-completed.operator"](), /data-action="package-adopt"/);
	assert.match(await UPDATES_DRAW["updates-adopted.operator"](), /data-action="package-undo"/);
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
});
