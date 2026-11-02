import { NOW } from "../../../launch/fixture-deployment.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { readUpdates } from "../../src/updates-view.mjs";

const HOUR = 3600000;
const LOOK = { v: 1, at: NOW - HOUR, everyHours: 24 };
const PINNED = "1.5.0";
const piRead = (fields = {}) => ({ pinned: PINNED, newest: PINNED, read: "ok", checks: null, ...fields });
const hostPi = (fields = {}) => ({ version: PINNED, tested: PINNED, state: "same", needles: "ok", extension: "ok", ...fields });
const row = (name, version, newest, read = "ok") => ({ name, version, newest, read });
const LINT = row("pi-lint", "1.4.2", "1.4.3");
const RUNNER = row("pi-test-runner", "0.9.0", "0.10.0");
const CURRENT = [row("pi-lint", "1.4.2", "1.4.2"), row("pi-test-runner", "0.9.0", "0.9.0")];
const look = (host, fields = {}) => ({ ...LOOK, host, pi: piRead(), hostPi: hostPi(), packages: [LINT, RUNNER], ...fields });
const STAGED = { stagedAt: "2026-10-01T00:00:00.000Z", packages: [{ name: "pi-lint", version: "1.4.2", dir: "pi-lint--1.4.2--aaaaaaaa", from: "pi-packages" }, { name: "pi-test-runner", version: "0.9.0", dir: "pi-test-runner--0.9.0--bbbbbbbb", from: "host" }] };
const TRIGGERS = { triggers: [{ on: { type: "comment" }, run: {} }, { on: { type: "cron", id: "nightly-off" }, run: { packages: false } }, { on: { type: "cron", id: "nightly" }, run: { maxCostUsd: 2 } }] };
const canaryRecord = (fields = {}) => ({ jobId: "gh-c0a7", outcome: "completed", endedAt: new Date(NOW - 2 * HOUR).toISOString(), tokens: { cost: 0.19 }, packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" }, ...fields });
const desired = (fields = {}) => JSON.stringify({ v: 1, generation: 5, name: "pi-lint", version: "1.4.3", op: "adopt", from: "1.4.2", by: "ops", at: NOW - HOUR, ...fields });
const applied = (fields = {}) => JSON.stringify({ v: 1, generation: 5, state: "adopted", version: "1.4.3", digest: "a".repeat(64), at: NOW - HOUR, ...fields });
const FACTS = JSON.stringify({ v: 1, host: "mini1", at: NOW - 2 * HOUR, digest: "a".repeat(64), excerpt: "## 1.4.3\n\nFixes the <b>path</b> rule on Windows." });

/** A Valkey that answers from these keys. Everything else about the page goes through the real read. */
function valkey({ looks = [look("mini1"), look("mini2"), look("build3", { hostPi: hostPi({ version: null, state: "absent" }) })], desiredRows = {}, appliedRows = {}, facts = {}, down = false, doctorHosts = [] } = {}) {
	const strings = new Map([...looks.map((l) => [`updates:h:${l.host}`, JSON.stringify(l)]), ...Object.entries(facts)]);
	const refuse = async () => { throw new Error("down"); };
	if (down) return { smembers: refuse, mget: refuse, hgetall: refuse, get: refuse };
	return {
		smembers: async (key) => (key === "updates:hosts" ? looks.map((l) => l.host) : key === "doctor:hosts" ? doctorHosts : []),
		mget: async (...keys) => keys.map((key) => strings.get(key) ?? null),
		get: async (key) => strings.get(key) ?? null,
		hgetall: async (key) => (key === "updates:desired" ? desiredRows : appliedRows[key.slice("updates:applied:".length)] ?? {}),
		hmget: async () => [],
		pipeline: () => { throw new Error("not used here"); },
	};
}

export async function updatesFacts({ redis = {}, records = [], audit = [], staged = STAGED, now = NOW } = {}) {
	return await readUpdates({ redis: valkey(redis), staged, records, audit, pinned: PINNED, triggersDocument: TRIGGERS, now });
}

async function draw({ role = "operator", readOnly = false, facts = {}, unavailable = false } = {}) {
	const parsed = parsePageQuery("updates", "");
	const made = unavailable ? null : await updatesFacts(facts);
	const deps = { now: () => NOW, fleet: { snapshot: async () => ({}), parkedCount: async () => 0 }, updates: async () => made };
	const data = await loadPageData("updates", parsed.query, deps, { role, readOnly });
	return String((await renderPage("updates", { data, query: parsed.query, session: { role, name: role === "operator" ? "ops" : "watcher" }, readOnly })).html);
}

const ALL_APPLIED = { mini1: { "pi-lint": applied() }, mini2: { "pi-lint": applied() }, build3: { "pi-lint": applied() } };
const NEWER = { looks: [look("mini1", { pi: piRead({ newest: "1.6.0", checks: "failing" }), hostPi: hostPi({ version: "1.6.0", state: "newer" }) }), look("mini2", { pi: piRead({ newest: "1.6.0", checks: "failing" }) }), look("build3", { hostPi: hostPi({ version: null, state: "absent" }), pi: piRead({ newest: "1.6.0", checks: "failing" }) })] };

export const UPDATES_DRAW = Object.freeze({
	"updates-newer-available.operator": () => draw(),
	"updates-newer-available.viewer": () => draw({ role: "viewer" }),
	"updates-readonly.operator": () => draw({ readOnly: true }),
	"updates-canary-completed.operator": () => draw({ facts: { records: [canaryRecord()], redis: { facts: { "updates:canary:pi-lint@1.4.3": FACTS } } } }),
	"updates-canary-completed.viewer": () => draw({ role: "viewer", facts: { records: [canaryRecord()] } }),
	"updates-canary-failed.operator": () => draw({ facts: { records: [canaryRecord({ packageCanary: { name: "pi-lint", version: "1.4.3", load: "failed" } })] } }),
	"updates-canary-run-failed.operator": () => draw({ facts: { records: [canaryRecord({ outcome: "failed" })] } }),
	"updates-checks-failing.operator": () => draw({ facts: { redis: NEWER } }),
	"updates-checks-passing.operator": () => draw({ facts: { redis: { looks: [look("mini1", { pi: piRead({ newest: "1.6.0", checks: "passing" }) })] } } }),
	"updates-checks-pending.operator": () => draw({ facts: { redis: { looks: [look("mini1", { pi: piRead({ newest: "1.6.0", checks: "pending" }) })] } } }),
	"updates-checks-unknown.operator": () => draw({ facts: { redis: { looks: [look("mini1", { pi: piRead({ newest: "1.6.0", checks: "unknown" }) })] } } }),
	"updates-host-probes.operator": () => draw({ facts: { redis: { looks: [look("mini1", { hostPi: hostPi({ version: "1.6.0", state: "newer", needles: "drift", extension: "drift" }) }), look("mini2", { hostPi: hostPi({ version: "1.4.0", state: "older" }) }), look("build3", { hostPi: hostPi({ version: null, state: "unknown", needles: "unknown", extension: "unknown" }) })] } } }),
	"updates-nothing-newer.operator": () => draw({ facts: { redis: { looks: [look("mini1", { packages: CURRENT })] } } }),
	"updates-not-looking.operator": () => draw({ facts: { redis: { looks: [] } } }),
	"updates-not-looking.viewer": () => draw({ role: "viewer", facts: { redis: { looks: [] } } }),
	"updates-stale.operator": () => draw({ facts: { now: NOW + 3 * 24 * HOUR } }),
	"updates-unknown.operator": () => draw({ facts: { redis: { looks: [look("mini1", { pi: piRead({ newest: null, read: "unknown" }), packages: [row("pi-lint", "1.4.2", null, "unknown"), row("pi-test-runner", "0.9.0", null, "unknown")] })] } } }),
	"updates-valkey-down.operator": () => draw({ facts: { redis: { down: true } } }),
	"updates-adopting.operator": () => draw({ facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: { mini1: { "pi-lint": applied() } } } } }),
	"updates-adopting-overdue.operator": () => draw({ facts: { now: NOW + 30 * HOUR, records: [canaryRecord()], redis: { doctorHosts: ["offline1"], desiredRows: { "pi-lint": desired() }, appliedRows: ALL_APPLIED } } }),
	"updates-adopted.operator": () => draw({ facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: ALL_APPLIED, facts: { "updates:canary:pi-lint@1.4.3": FACTS } } } }),
	"updates-adopted.viewer": () => draw({ role: "viewer", facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: ALL_APPLIED } } }),
	"updates-adopted-differs.operator": () => draw({ facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: { ...ALL_APPLIED, mini2: { "pi-lint": applied({ digest: "b".repeat(64) }) } }, facts: { "updates:canary:pi-lint@1.4.3": FACTS } } } }),
	"updates-partial.operator": () => draw({ facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: { ...ALL_APPLIED, mini2: { "pi-lint": applied({ state: "cannot-adopt", reason: "overlay-read-only", version: "1.4.2", digest: null }) } } } } }),
	"updates-undoing.operator": () => draw({ facts: { redis: { desiredRows: { "pi-lint": desired({ generation: 6, op: "undo", version: "1.4.2", from: "1.4.3", undoOf: 5 }) }, appliedRows: { mini1: { "pi-lint": applied({ generation: 6, state: "undone", version: "1.4.2" }) } } } } }),
	"updates-recent.operator": () => draw({ facts: { audit: [{ action: "write-applied", kind: "package-adopt", outcome: "ok", target: "pi-lint@1.4.2", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-01T10:00:00.000Z" }, { action: "write-applied", kind: "package-undo", outcome: "ok", target: "pi-test-runner@0.8.2", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-02T10:00:00.000Z" }, { action: "write", kind: "package-adopt", outcome: "ok", target: "not-applied@1.0.0" }] } }),
	"updates-unavailable.operator": () => draw({ unavailable: true }),
	"updates-adopting.viewer": () => draw({ role: "viewer", facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: { mini1: { "pi-lint": applied() } } } } }),
	"updates-partial.viewer": () => draw({ role: "viewer", facts: { records: [canaryRecord()], redis: { desiredRows: { "pi-lint": desired() }, appliedRows: { ...ALL_APPLIED, mini2: { "pi-lint": applied({ state: "cannot-adopt", reason: "overlay-read-only", version: "1.4.2", digest: null }) } } } } }),
	"updates-adapter.operator": () => draw({ facts: { staged: { packages: [{ name: "pi-anthropic-oauth", version: "0.3.6", dir: "oauth", from: "host" }] }, redis: { looks: [look("mini1", { packages: [row("pi-anthropic-oauth", "0.3.6", "0.3.7")] })] } } }),
	"updates-newer-after-adopt.operator": () => draw({ facts: { staged: { packages: [{ name: "pi-lint", version: "1.4.3", dir: "pi-lint--1.4.3--cccccccc", from: "pi-packages" }] }, records: [canaryRecord({ packageCanary: { name: "pi-lint", version: "1.4.4", load: "loaded" } })], redis: { looks: [look("mini1", { packages: [row("pi-lint", "1.4.3", "1.4.4")] })], desiredRows: { "pi-lint": desired() }, appliedRows: { mini1: { "pi-lint": applied() } } } } }),
	"updates-staged-unreadable.operator": () => draw({ facts: { staged: { packages: [], unreadable: true } } }),
});
/** Every golden of this page, the two previews included: `panel-goldens.mjs` draws those, through the real action and the real confirm. */
export const UPDATES_PANEL_STATES = Object.freeze([...Object.keys(UPDATES_DRAW)]);
export const UPDATES_CONFIRM_STATES = Object.freeze(["updates-confirm-canary.operator", "updates-confirm-adopt.operator"]);
export const UPDATES_CANARY_RECORD = canaryRecord();
export { PINNED as UPDATES_FIXTURE_PIN, STAGED as UPDATES_FIXTURE_STAGED };
