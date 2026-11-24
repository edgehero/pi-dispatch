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
export const HOST_ADOPT_STATES = Object.freeze(["adopted", "undone", "no-change", "cannot-adopt", "pending", "overdue", "unread"]);

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

/**
 * Each known host's standing on one desired row. A host with no row at this generation is pending, and past the limit overdue, never lost.
 * A host whose applied rows could not be read (`applied[host]` null, `readApplied`'s own word for it) is `unread` (issue #962): it may have adopted, refused or done nothing,
 * so it is neither pending nor overdue, and it is not counted as done.
 */
export function hostStandings({ desired, applied, hosts, now }) {
	return hosts.map((host) => {
		if (applied[host] === null) return { host, state: "unread", reason: null, version: null, digest: null };
		const row = applied[host]?.[desired.name];
		if (row && row.generation >= desired.generation) return { host, state: row.state, reason: row.reason, version: row.version, digest: row.digest };
		return { host, state: now - desired.at > UPDATES_OVERDUE_MS ? "overdue" : "pending", reason: null, version: row?.version ?? null, digest: null };
	});
}

/** One package's row. Pure, so every state can be drawn from a fixture. */
export function packageRow({ pkg, look, desired, standings, canary, facts }) {
	const base = { name: pkg.name, version: pkg.version, from: pkg.from ?? null, adapter: isSubscriptionAdapter(pkg.name), newest: look.newest, canary, facts, desired, standings };
	if (desired) {
		// A host that could not be read may still be moving: the row stays in progress, never adopted everywhere.
		const waiting = standings.some((s) => s.state === "pending" || s.state === "overdue" || s.state === "unread");
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
 * neither is one the preview could only refuse. Read from the raw file, as the plan it leads to is: the snapshot's rows are for display, and they carry none of these fields. One that leaves a
 * package out by name is such a trigger for that package alone (`canaryTriggersFor`), so it says which, and only where it has any.
 */
function canaryTriggers(document) {
	const rows = document?.triggers;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((trigger, index) => {
		const on = trigger?.on, run = trigger?.run;
		if (on?.type !== "cron" || run?.packages === false || run?.resume === true || run?.command !== undefined || run?.portfolio === true) return [];
		const excludes = Array.isArray(run?.excludeExtensions) ? run.excludeExtensions.filter((name) => typeof name === "string") : [];
		return [{ index, id: typeof on.id === "string" ? on.id : null, capUsd: Number.isFinite(run?.maxCostUsd) ? run.maxCostUsd : null, ...(excludes.length > 0 ? { excludes } : {}) }];
	});
}

/** Of those, what a canary of this package can run as: one that leaves it out would load it anyway and say nothing of the jobs it goes into, and the preview refuses that. */
export function canaryTriggersFor(triggers, name) {
	return (triggers ?? []).filter((trigger) => !(trigger.excludes ?? []).includes(name));
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
	return readTriggersFile({ triggersPath, fs }).document;
}

/**
 * The same read with why it gave nothing (issue #962): `trouble` is null for a file that was read and for one that is not there, where "no cron trigger can run a canary" is true;
 * `unreadable` for a file that is there and could not be read, and `invalid` for one that is no JSON or holds no `triggers` list. Of those two the page says which trigger a canary would
 * run as is not known, never that none can.
 */
export function readTriggersFile({ triggersPath, fs = nodeFs } = {}) {
	let text;
	try {
		text = fs.readFileSync(triggersPath, "utf8");
	} catch (error) {
		return { document: null, trouble: error?.code === "ENOENT" ? null : "unreadable" };
	}
	try {
		const document = JSON.parse(text);
		return { document, trouble: Array.isArray(document?.triggers) ? null : "invalid" };
	} catch {
		return { document: null, trouble: "invalid" };
	}
}

/** The newest of what people did here, from the audit log. Names and versions only, which is all those rows carry. A log that could not be read (null) lists nothing, and `recentUnread` says why. */
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

/** What the audit reader marked instead of handing over, in the rows it read: null for none. A `broken` row with line 0 is a file whose read failed (`readConsoleAudit`), any other a line that is not a row. */
function recentGapsOf(rows) {
	const broken = (Array.isArray(rows) ? rows : []).filter((row) => row?.broken === true);
	if (broken.length === 0) return null;
	return broken.some((row) => row.line === 0) ? "unread" : "damaged";
}

/**
 * What a deployment holds, read from where it really lives: its stage manifest and its triggers file. The console calls this, so that the shapes it hands `readUpdates` are the ones the
 * actions look rows up by. The read model's own `readStagedPackages` and the snapshot's trigger rows are for display, and they carry neither the fields nor the shapes this needs.
 */
export async function readDeploymentUpdates({ redis = null, paths = {}, records = [], recordsPartial = false, audit = [], pinned = null, now = Date.now(), fs = nodeFs } = {}) {
	const triggers = readTriggersFile({ triggersPath: paths.triggersPath, fs });
	return await readUpdates({ redis, records, recordsPartial, audit, pinned, now, staged: readStaged({ globalPiDir: paths.globalPiDir, fs }), triggersDocument: triggers.document, triggersTrouble: triggers.trouble });
}

/** How long the doctor index's host list may take: the bound the other reads here have inside `updates.mjs`. */
const HOSTS_READ_TIMEOUT_MS = 3_000;

/** `promise` within `ms`, or a rejection: a read with no bound of its own (the doctor index's SMEMBERS). */
function inTime(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("valkey did not answer")), ms);
		timer.unref?.();
		Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
	});
}

/**
 * Everything the page draws, from injected sources so that each state is a fixture. `null` when even the stage manifest could not be asked: the page then says so rather than drawing nothing.
 *
 * Valkey is read in three waves, the reads of a wave at once (issue #961). One after another, each read waited out its own bound on a Valkey that stopped answering, thirteen seconds where one bound says as much.
 * When neither read of the first wave was answered, the rest is not asked: the rows are drawn from the stage manifest alone, as a console without a Valkey draws them. `factsUnread` says a host's applied rows or a
 * canary's published facts were asked for and not answered: an Adopt judges by them, so its gate must read that as "not known", never as "none". A host whose rows were not answered
 * has the standing `unread` on every desired row, from the same null that sets `factsUnread`, so the page and the gate cannot disagree. `audit` null is an audit log that could not be read.
 */
export async function readUpdates({ redis = null, staged, records = [], recordsPartial = false, audit = [], pinned = null, triggersDocument = null, triggersTrouble = null, now = Date.now(), hostsTimeoutMs = HOSTS_READ_TIMEOUT_MS } = {}) {
	const [looks, desired] = redis ? await Promise.all([readLooks(redis, { now: () => now }), readDesired(redis)]) : [{ unreachable: true }, null];
	// Whether Valkey answered anything: where it did not, nothing more is asked of it.
	const answering = redis !== null && !(looks.unreachable && desired === null);
	let known = looks.unreachable ? [] : looks.hosts.map((h) => h.record.host);
	if (answering) {
		const [indexed, live] = await Promise.all([
			// Offline hosts stay on the page: doctor's index remembers a host for a week after its last publish, which the live set does not.
			inTime(redis.smembers(DOCTOR_HOSTS), hostsTimeoutMs).catch(() => null /* the live set, or nothing */),
			Promise.resolve().then(() => readLiveHosts(redis, { prune: false })).catch(() => null /* a host that cannot be listed is not asserted either way */),
		]);
		if (Array.isArray(indexed)) known = [...known, ...indexed];
		if (Array.isArray(live?.hosts)) known = [...known, ...live.hosts.map((h) => h?.name ?? h)];
		else if (Array.isArray(live)) known = [...known, ...live.map((h) => h?.name ?? h)];
		// A member whose row was not read (issue #1036: `unreadHosts`, a row Valkey answered with an error or that got no answer) is a
		// host all the same. It was left out, so a host that neither looked nor published a doctor result had no row on this page, and
		// an Adopt was judged without it.
		if (Array.isArray(live?.unreadHosts)) known = [...known, ...live.unreadHosts];
	}
	const hostNames = [...new Set(known.filter((n) => typeof n === "string" && n !== ""))].sort();
	// What each staged package's row is about, decided before the third wave so that its reads can go out together.
	const rows = (staged?.packages ?? []).map((pkg) => {
		const row = (desired ?? []).find((d) => d.name === pkg.name) ?? null;
		const look = lookOf(pkg.name, looks);
		// What this row is about: the newest once it passes what was adopted, else what was adopted. Adopt's gate reads `canary` for the version it is asked about, so this must never be another version's.
		const adoptedVersion = row?.op === "adopt" ? row.version : null;
		const target = adoptedVersion && !(look.newest && compareVersions(look.newest, adoptedVersion) > 0) ? adoptedVersion : look.newest;
		return { pkg, row, look, target };
	});
	let factsUnread = false;
	const [appliedRows, factRows] = await Promise.all([
		Promise.all(hostNames.map(async (host) => {
			if (!answering) return {};
			const read = await readApplied(redis, host);
			// Kept null (issue #962): `hostStandings` says such a host is not known, where `{}` read as a host that has not answered.
			if (read === null) factsUnread = true;
			return read;
		})),
		Promise.all(rows.map(async ({ pkg, target }) => {
			if (!target || !answering) return null;
			try {
				return await readCanaryFacts(redis, pkg.name, target, { strict: true });
			} catch {
				factsUnread = true;
				return null;
			}
		})),
	]);
	const applied = Object.fromEntries(hostNames.map((host, i) => [host, appliedRows[i]]));
	// In the stage manifest's order, whatever order the reads were answered in.
	const packages = rows.map(({ pkg, row, look, target }, i) => packageRow({ pkg, look, desired: row, standings: row ? hostStandings({ desired: row, applied, hosts: hostNames, now }) : [], canary: target ? canaryResultOf(records, pkg.name, target) : null, facts: factRows[i] }));
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
		factsUnread,
		moreHosts: looks.unreachable ? 0 : looks.more ?? 0,
		hosts,
		triggers: canaryTriggers(triggersDocument),
		recent: recentOf(audit),
		// The audit log was asked for and could not be read (issue #962): the card says so, never that its window holds nothing.
		recentUnread: audit === null,
		// Rows the audit reader could not hand over, among those it did: `unread` where a month's file could not be read (its row has no line), else `damaged` where a line is no row.
		// Either way an adoption may be missing from the list, and an empty list is not "nothing was adopted".
		recentGaps: recentGapsOf(audit),
		// Why the triggers file gave no canary trigger, where it is not simply that it holds none (`readTriggersFile`).
		triggersTrouble: triggersTrouble === "unreadable" || triggersTrouble === "invalid" ? triggersTrouble : null,
		desiredUnreadable: redis ? desired === null : true,
	};
}
