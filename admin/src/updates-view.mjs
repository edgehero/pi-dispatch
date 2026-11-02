/**
 * What the Updates page reads (issue #796, `REQ-OPERATOR-CONSOLE-SCREENS` (g8), `INT-UPDATES-KEYS`).
 *
 * Writes nothing and decides nothing. A failed read is `unknown`, a look that is off reads `not-looking`, a record past two intervals reads `stale`, and none of them is ever drawn as healthy.
 * The result of a canary is read from the run record it wrote, because that is what the runner signed: a canary that ended well reads "completed", never "passed".
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { PACKAGES_SUBDIR, STAGE_MANIFEST, readStageManifest } from "@edgehero/pi-dispatch/packages";
import { DOCTOR_HOSTS } from "@edgehero/pi-dispatch/doctor-results";
import { compareVersions, readApplied, readCanaryFacts, readDesired, readLooks, UPDATES_OVERDUE_MS } from "@edgehero/pi-dispatch/updates";
import { parsePackageCanary } from "@edgehero/pi-dispatch/package-canary-record";
import { isSubscriptionAdapter } from "@edgehero/pi-dispatch/updates-subscription-adapters";

/** Every state a staged package's row can be in. Each has a golden, and a test holds the panel's sentences to this list. */
export const UPDATE_ROW_STATES = Object.freeze(["current", "newer", "canary-completed", "canary-failed", "adopting", "adopted", "partial", "undoing", "not-looking", "stale", "unknown"]);
/** Every state pi's own row can be in. */
export const PI_ROW_STATES = Object.freeze(["current", "checks-passing", "checks-failing", "checks-pending", "checks-unknown", "not-looking", "stale", "unknown"]);
/** Each host's standing against what a person asked for. */
export const HOST_ADOPT_STATES = Object.freeze(["adopted", "undone", "no-change", "cannot-adopt", "pending", "overdue"]);

/** What "Recently adopted" lists. A canary is not an adoption: its result is on the package's own row. */
const AUDIT_KINDS = Object.freeze(["package-adopt", "package-undo"]);
const RECENT_MAX = 5;

/** A canary's result, from the newest run record that ran this exact version. `null` when none is retained. */
export function canaryResultOf(records, name, version) {
	let best = null;
	for (const record of records ?? []) {
		const canary = parsePackageCanary(record?.packageCanary);
		if (!canary || canary.name !== name || canary.version !== version) continue;
		const at = Date.parse(record.endedAt ?? "");
		if (!best || at > best.at) best = { at, record };
	}
	if (!best) return null;
	const { record } = best;
	const loaded = record.packageCanary.load === "loaded";
	const completed = record.outcome === "completed";
	return {
		jobId: typeof record.jobId === "string" ? record.jobId : null,
		at: Number.isFinite(best.at) ? best.at : null,
		state: loaded && completed ? "completed" : "failed",
		// A missing report reads as did-not-load: the runner signs the word, so its absence is no evidence the candidate ran.
		why: loaded ? (completed ? null : "run-ended") : "did-not-load",
		outcome: typeof record.outcome === "string" ? record.outcome : null,
		costUsd: Number.isFinite(record.tokens?.cost) ? record.tokens.cost : null,
	};
}

/** Each known host's standing on one desired row. A host with no row at this generation is pending, and past the limit overdue, never lost. */
export function hostStandings({ desired, applied, hosts, now }) {
	return hosts.map((host) => {
		const row = applied[host]?.[desired.name];
		if (row && row.generation >= desired.generation) return { host, state: row.state, reason: row.reason, version: row.version, digest: row.digest };
		return { host, state: now - desired.at > UPDATES_OVERDUE_MS ? "overdue" : "pending", reason: null, version: row?.version ?? null, digest: null };
	});
}

/** One package's row. Pure, so every state can be drawn from a fixture. */
export function packageRow({ pkg, look, desired, standings, canary, facts }) {
	const base = { name: pkg.name, version: pkg.version, from: pkg.from ?? null, adapter: isSubscriptionAdapter(pkg.name), newest: look.newest, canary, facts, desired, standings };
	if (desired) {
		const waiting = standings.some((s) => s.state === "pending" || s.state === "overdue");
		const refused = standings.some((s) => s.state === "cannot-adopt");
		if (desired.op === "adopt" && (refused || waiting)) return { ...base, state: refused ? "partial" : "adopting", differs: false };
		if (desired.op === "undo" && (refused || waiting)) return { ...base, state: refused ? "partial" : "undoing", differs: false };
		// Adopted everywhere, and nothing newer since: done. Once something newer appears the row is about that, and it keeps its Undo.
		if (desired.op === "adopt" && !(look.newest && compareVersions(look.newest, desired.version) > 0)) return { ...base, state: "adopted", differs: treesDiffer(standings, facts) };
	}
	if (look.state === "not-looking" || look.state === "stale" || look.state === "unknown") return { ...base, state: look.state };
	if (!look.newest || compareVersions(look.newest, pkg.version) <= 0) return { ...base, state: "current" };
	if (canary) return { ...base, state: canary.state === "completed" ? "canary-completed" : "canary-failed" };
	return { ...base, state: "newer" };
}

/** Whether what a host adopted is not the tree the canary ran: a package has no lockfile, so its dependencies float. Said, not solved. */
function treesDiffer(standings, facts) {
	if (!facts?.digest) return false;
	return standings.some((s) => s.digest && s.digest !== facts.digest);
}

/** What the looks say of one package: its newest, from a host whose look is fresh if any is. */
function lookOf(name, looks) {
	if (looks.unreachable) return { state: "unknown", newest: null };
	if (looks.hosts.length === 0) return { state: "not-looking", newest: null };
	const fresh = looks.hosts.filter((h) => !h.stale);
	const rows = (fresh.length ? fresh : looks.hosts).flatMap((h) => h.record.packages.filter((p) => p.name === name));
	if (fresh.length === 0) return { state: "stale", newest: rows.find((p) => p.newest)?.newest ?? null };
	const known = rows.filter((p) => p.read === "ok" && p.newest);
	if (known.length === 0) return { state: "unknown", newest: null };
	return { state: "ok", newest: known.map((p) => p.newest).sort((a, b) => compareVersions(b, a))[0] };
}

/** pi's row: it arrives in a release, so its one action is the bump pull request. */
export function piRow({ pinned, looks }) {
	const base = { pinned, newest: null };
	if (looks.unreachable) return { ...base, state: "unknown" };
	if (looks.hosts.length === 0) return { ...base, state: "not-looking" };
	const fresh = looks.hosts.filter((h) => !h.stale);
	if (fresh.length === 0) return { ...base, newest: looks.hosts.map((h) => h.record.pi.newest).find(Boolean) ?? null, state: "stale" };
	const known = fresh.map((h) => h.record.pi).filter((p) => p.read === "ok" && p.newest);
	if (known.length === 0) return { ...base, state: "unknown" };
	const top = known.sort((a, b) => compareVersions(b.newest, a.newest))[0];
	if (!pinned || compareVersions(top.newest, pinned) <= 0) return { ...base, newest: top.newest, state: "current" };
	const checks = ["passing", "failing", "pending"].includes(top.checks) ? top.checks : "unknown";
	return { ...base, newest: top.newest, state: `checks-${checks}` };
}

/**
 * The cron triggers a canary can run as: on this deployment's file and loading staged packages. A trigger that withholds them is refused at the preview anyway, so it is not offered, and
 * neither is one the preview could only refuse. Read from the raw file, as the plan it leads to is: the snapshot's rows are for display, and they carry none of these fields.
 */
function canaryTriggers(document) {
	const rows = document?.triggers;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((trigger, index) => {
		const on = trigger?.on, run = trigger?.run;
		if (on?.type !== "cron" || run?.packages === false || run?.resume === true || run?.command !== undefined || run?.portfolio === true) return [];
		return [{ index, id: typeof on.id === "string" ? on.id : null, capUsd: Number.isFinite(run?.maxCostUsd) ? run.maxCostUsd : null }];
	});
}

/** The stage manifest, whole: `{ packages, unreadable }`. A manifest that is absent is nothing staged; one that is there and cannot be read is said. */
export function readStaged({ globalPiDir, fs = nodeFs } = {}) {
	if (typeof globalPiDir !== "string" || globalPiDir === "") return { packages: [], unreadable: false };
	const manifest = readStageManifest({ globalPiDir, readFile: (p, e) => fs.readFileSync(p, e), fileExists: (p) => fs.existsSync(p) });
	if (manifest) return { packages: manifest.packages, unreadable: false };
	return { packages: [], unreadable: fs.existsSync(join(globalPiDir, PACKAGES_SUBDIR, STAGE_MANIFEST)) };
}

/** The triggers file as written, or nothing when it cannot be read: the page then offers no canary, and the preview would say why. */
export function readTriggersDocument({ triggersPath, fs = nodeFs } = {}) {
	try {
		return JSON.parse(fs.readFileSync(triggersPath, "utf8"));
	} catch {
		return null;
	}
}

/** The newest of what people did here, from the audit log. Names and versions only, which is all those rows carry. */
function recentOf(rows) {
	const kept = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!AUDIT_KINDS.includes(row?.kind) || row?.outcome !== "ok" || row?.action !== "write-applied") continue;
		const at = /^(.+)@([^@]+)$/.exec(String(row.target ?? ""));
		const canary = at ? parsePackageCanary({ name: at[1], version: at[2] }) : null;
		if (!canary) continue;
		kept.push({ kind: row.kind, ...canary, by: typeof row.actor?.name === "string" ? row.actor.name : null, at: typeof row.at === "string" ? row.at : null });
	}
	return kept.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, RECENT_MAX);
}

/**
 * What a deployment holds, read from where it really lives: its stage manifest and its triggers file. The console calls this, so that the shapes it hands `readUpdates` are the ones the
 * actions look rows up by. The read model's own `readStagedPackages` and the snapshot's trigger rows are for display, and they carry neither the fields nor the shapes this needs.
 */
export async function readDeploymentUpdates({ redis = null, paths = {}, records = [], recordsPartial = false, audit = [], pinned = null, now = Date.now(), fs = nodeFs } = {}) {
	return await readUpdates({ redis, records, recordsPartial, audit, pinned, now, staged: readStaged({ globalPiDir: paths.globalPiDir, fs }), triggersDocument: readTriggersDocument({ triggersPath: paths.triggersPath, fs }) });
}

/**
 * Everything the page draws, from injected sources so that each state is a fixture. `null` when even the stage manifest could not be asked: the page then says so rather than drawing nothing.
 */
export async function readUpdates({ redis = null, staged, records = [], recordsPartial = false, audit = [], pinned = null, triggersDocument = null, now = Date.now() } = {}) {
	const looks = redis ? await readLooks(redis, { now: () => now }) : { unreachable: true };
	const desired = redis ? await readDesired(redis) : null;
	let known = looks.unreachable ? [] : looks.hosts.map((h) => h.record.host);
	if (redis) {
		// Offline hosts stay on the page: doctor's index remembers a host for a week after its last publish, which the live set does not.
		try { known = [...known, ...(await redis.smembers(DOCTOR_HOSTS) ?? [])]; } catch { /* the live set below, or nothing */ }
		try {
			const live = await readLiveHosts(redis, { prune: false });
			if (Array.isArray(live?.hosts)) known = [...known, ...live.hosts.map((h) => h?.name ?? h)];
			else if (Array.isArray(live)) known = [...known, ...live.map((h) => h?.name ?? h)];
		} catch { /* a host that cannot be listed is not asserted either way */ }
	}
	const hostNames = [...new Set(known.filter((n) => typeof n === "string" && n !== ""))].sort();
	const applied = {};
	for (const host of hostNames) applied[host] = redis ? (await readApplied(redis, host)) ?? {} : {};
	const packages = [];
	for (const pkg of staged?.packages ?? []) {
		const row = (desired ?? []).find((d) => d.name === pkg.name) ?? null;
		const look = lookOf(pkg.name, looks);
		// What this row is about: the newest once it passes what was adopted, else what was adopted. Adopt's gate reads `canary` for the version it is asked about, so this must never be another version's.
		const adoptedVersion = row?.op === "adopt" ? row.version : null;
		const target = adoptedVersion && !(look.newest && compareVersions(look.newest, adoptedVersion) > 0) ? adoptedVersion : look.newest;
		const canary = target ? canaryResultOf(records, pkg.name, target) : null;
		const facts = target && redis ? await readCanaryFacts(redis, pkg.name, target) : null;
		packages.push(packageRow({ pkg, look, desired: row, standings: row ? hostStandings({ desired: row, applied, hosts: hostNames, now }) : [], canary, facts }));
	}
	const hosts = looks.unreachable ? [] : looks.hosts.map(({ record, stale }) => ({ name: record.host, at: record.at, stale, ...record.hostPi }));
	const newestLook = looks.unreachable || looks.hosts.length === 0 ? null : Math.max(...looks.hosts.map((h) => h.record.at));
	return {
		state: looks.unreachable ? "unknown" : looks.hosts.length === 0 ? "not-looking" : looks.hosts.every((h) => h.stale) ? "stale" : "looking",
		at: newestLook,
		everyHours: looks.unreachable || looks.hosts.length === 0 ? null : looks.hosts[0].record.everyHours,
		pi: piRow({ pinned, looks }),
		packages,
		stagedUnreadable: staged === null || staged === undefined || staged.unreadable === true,
		recordsPartial: recordsPartial === true,
		moreHosts: looks.unreachable ? 0 : looks.more ?? 0,
		hosts,
		triggers: canaryTriggers(triggersDocument),
		recent: recentOf(audit),
		desiredUnreadable: redis ? desired === null : true,
	};
}
