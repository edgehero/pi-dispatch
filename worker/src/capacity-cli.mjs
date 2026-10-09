/**
 * `pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json] [--valkey-url <url>]` (issue #599,
 * REQ-CAPACITY-INSIGHTS): how busy each host was over the window, read from the run records (`capacity-records.mjs`)
 * and computed by the one function every surface shares (`capacity.mjs`). `--json` prints the report itself
 * (INT-CAPACITY-REPORT).
 *
 * READ-ONLY, and needs what `status` needs and no more: the Valkey URL (the kill switch's rule, `killSwitchValkeyUrls`)
 * and the deployment's logs directory, never `loadConfig`, so it answers on a deployment whose forge auth is broken.
 * Where this shell and the deployment's `.env` name different Valkeys it refuses until `--valkey-url` says which: a
 * report from the wrong one would read a busy fleet as idle. An unreachable or refused Valkey taken from the shell or
 * the `.env` is not a failure: the local files are read and the report says why. One named with `--valkey-url` is: the
 * operator asked for that Valkey's fleet, and a local-only report would answer another question.
 */

import { parseArgs } from "node:util";
import { CAPACITY_WINDOWS, computeCapacity } from "./capacity.mjs";
import { readCapacityRecords } from "./capacity-records.mjs";
import { formatCpus, formatMemory } from "./job-size.mjs";

/** How long the CLI waits on the host registry, the kill switch's budget. */
const FLEET_READ_TIMEOUT_MS = 2_000;
/** The deployment keys this command reads beside the Valkey URL. */
export const CAPACITY_ENV_KEYS = Object.freeze(["PI_LOGS_DIR", "PI_LOG_RETENTION_DAYS", "PI_WORKER_NAME"]);

/**
 * Run the command. Returns the exit code. Every collaborator is a seam with the production default.
 * `deploymentEnv` is cli.mjs `cliDeploymentEnv`, handed in so this module does not import the CLI's entry module.
 */
export async function runCapacity(args, { env = process.env, write = (chunk) => process.stdout.write(chunk), errWrite = (chunk) => process.stderr.write(chunk), now = () => Date.now(), deploymentEnv = (e) => ({ env: e }), valkeyRefusal = async () => null, redisFn, readLiveHostsFn, fs, pickUrls } = {}) {
	const fail = (message) => {
		errWrite(`error: ${message}\n`);
		return 1;
	};
	let parsed;
	try {
		parsed = parseArgs({ args, allowPositionals: false, options: { since: { type: "string", default: "7d" }, host: { type: "string" }, json: { type: "boolean", default: false }, "valkey-url": { type: "string" } } });
	} catch (error) {
		return fail(`${error.message}\n  usage: pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json] [--valkey-url <url>]`);
	}
	const { since, host, json } = parsed.values;
	const window = Object.hasOwn(CAPACITY_WINDOWS, since) ? CAPACITY_WINDOWS[since] : null;
	if (!window) return fail(`--since takes ${Object.keys(CAPACITY_WINDOWS).join(", ")} (got ${JSON.stringify(since)})`);

	const deployment = deploymentEnv(env, CAPACITY_ENV_KEYS);
	if (deployment.problem) return fail(deployment.problem);
	const facts = await deploymentFacts(deployment.env);
	if (facts.problem) return fail(facts.problem);
	const { logsDir, retentionDays, localHost } = facts;

	const { killSwitchValkeyUrls, makeRedisClient, urlShown } = await import("./connection.mjs");
	const picked = (pickUrls ?? killSwitchValkeyUrls)({ env, flagUrl: parsed.values["valkey-url"] ?? null });
	if (picked.error) return fail(picked.error);
	if (picked.note) errWrite(`warning: ${picked.note}\n`);
	if (picked.urls.length > 1) return fail(`${picked.disagreement}: a report from the wrong one reads its fleet as idle. Say which: pi-dispatch capacity --valkey-url <url>`);
	const url = picked.urls[0];
	// A Valkey the operator NAMED that cannot be read is a failure: they asked for that one. One taken from the shell or
	// the `.env` is not: the report falls back to this host's files and says why.
	const named = parsed.values["valkey-url"] !== undefined;

	const nowMs = now();
	const windowStartMs = nowMs - window.ms;
	let redis = null;
	let refusedNote = null;
	const refused = await valkeyRefusal(url, env);
	if (refused && named) return fail(`Valkey at ${urlShown(url)} refused: ${refused}`);
	if (refused) refusedNote = `Valkey at ${urlShown(url)} refused (${refused}): only this host's files were read`;
	else {
		redis = (redisFn ?? makeRedisClient)(url);
		redis.on?.("error", () => {});
	}
	try {
		const { readLiveHosts } = await import("./host-registry.mjs");
		// Both reads at once, so a Valkey that does not answer costs one timeout, not two.
		// `prune: false`: this command writes nothing, not even the registry reader's tidying of a dead member. `now` is the
		// report's clock: a row's age decides how far its running jobs count (`LIVE_FRESH_MS`).
		const [fleet, read] = await Promise.all([
			redis ? (readLiveHostsFn ?? readLiveHosts)(redis, { now, timeoutMs: FLEET_READ_TIMEOUT_MS, prune: false }).catch((error) => ({ unreachable: error?.message ?? "registry unreadable" })) : { unreachable: null },
			readCapacityRecords({ redis, logsDir, sinceMs: windowStartMs, nowMs, retentionDays, localHost, noMirrorReason: refusedNote, timeoutMs: FLEET_READ_TIMEOUT_MS, ...(fs ? { fs } : {}) }),
		]);
		if (named && (fleet.unreachable || read.mirrorState.startsWith("unreachable"))) return fail(`could not read Valkey at ${urlShown(url)}: ${fleet.unreachable ? `host registry ${fleet.unreachable}` : `run mirror ${read.mirrorState}`}`);
		const coverage = { ...read.coverage, reason: [read.coverage.reason, fleet.unreachable ? `host registry unreadable (${fleet.unreachable})` : null].filter(Boolean).join("; ") || null };
		const report = computeCapacity({ records: read.records, live: fleet.hosts ?? [], windowStartMs, nowMs, bucketMs: window.bucketMs, coverage });
		const shown = host === undefined ? { report } : onlyHost(report, host);
		if (shown.unknown) return fail(`no host named ${JSON.stringify(host)} in the last ${since}${shown.unknown.length > 0 ? ` (hosts: ${shown.unknown.join(", ")})` : ""}`);
		write(json ? `${JSON.stringify(shown.report)}\n` : capacityText(shown.report, { since }));
		return 0;
	} finally {
		redis?.disconnect?.();
	}
}

/**
 * The report cut to one host (`--host`, and the admin's `dispatch_capacity`): `{ report }`, or `{ unknown: [names] }` when
 * the report has no such host. The coverage then says what the shown host's history is: its start, its cut and its
 * counts. What cannot be put on a host (a record with no readable host, the live rows' running jobs, the reasons a
 * source was not read) stays.
 */
export function onlyHost(report, host) {
	const known = report.hosts.map((h) => h.name);
	if (!known.includes(host)) return { unknown: known };
	const shown = report.hosts.find((h) => h.name === host);
	const { fromMs, source: _source, truncated, ...counts } = shown.coverage;
	return { report: { ...report, hosts: [shown], coverage: { ...report.coverage, fromMs, truncated, ...counts, historyNotShared: report.coverage.historyNotShared.filter((n) => n === host) } } };
}

/**
 * What this command reads of the deployment: the logs directory (config.mjs `logsDirPath`, the worker's rule), the
 * retention (30 days unless set; 0 keeps the files) and this host's name (`PI_WORKER_NAME`, else the hostname), or
 * `{ problem }` for a retention the worker would refuse to boot with.
 */
export async function deploymentFacts(env) {
	const raw = env.PI_LOG_RETENTION_DAYS;
	if (raw !== undefined && raw !== "" && !/^\d{1,6}$/.test(raw)) return { problem: `PI_LOG_RETENTION_DAYS must be a non-negative integer (got ${JSON.stringify(raw)})` };
	const { logsDirPath, defaultWorkerName, WORKER_NAME_RE } = await import("./config.mjs");
	const named = env.PI_WORKER_NAME;
	return { logsDir: logsDirPath(env), retentionDays: raw === undefined || raw === "" ? 30 : Number(raw), localHost: typeof named === "string" && WORKER_NAME_RE.test(named) ? named : defaultWorkerName() };
}

/** A span in the largest whole units that say it: `40s`, `6m`, `2h 5m`, `3d 4h`. */
export function durationText(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
	const d = Math.floor(h / 24);
	return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** Thousandths as a percentage, at most one decimal: 125 is `12.5%`, 1000 is `100%`. */
export function percentText(perMille) {
	return `${Math.floor(perMille / 10)}${perMille % 10 === 0 ? "" : `.${perMille % 10}`}%`;
}

/** Thousandths as a number with at most one decimal, rounded half up: 2149 is `2.1`, 2000 is `2`. */
export function milliText(milli) {
	const tenths = Math.floor((milli + 50) / 100);
	return `${Math.floor(tenths / 10)}${tenths % 10 === 0 ? "" : `.${tenths % 10}`}`;
}

/** Part of whole as a per-mille, rounded half up; 0 when there is no whole. The panel's HOSTS view reads its shares by it too. */
export const share = (part, whole) => (whole > 0 ? Math.floor((part * 2000 + whole) / (whole * 2)) : 0);

/**
 * Part of whole as a percentage, the way every surface prints a share of time: `percentText(share(...))`, except that a
 * share that is there but rounds to nothing reads `under 0.1%` and one short of the whole that rounds to all of it reads
 * `over 99.9%`. "full 0%" beside "peak 3 of 3" said the host was never full when it was, briefly.
 */
export function shareText(part, whole) {
	const p = share(part, whole);
	if (p === 0 && part > 0 && whole > 0) return "under 0.1%";
	if (p === 1000 && part < whole) return "over 99.9%";
	return percentText(p);
}

/**
 * C0 and C1 control characters, which a terminal acts on (cursor moves, a title, a cleared screen). The report admits
 * only worker names and project ids, which hold none; this strips them anyway before anything reaches the terminal, so
 * a reader that ever admits more cannot hand a record's author the operator's screen.
 */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** The human report: one block per host, then what the fleet's history covers. Control characters stripped. */
export function capacityText(report, { since }) {
	const lines = [];
	for (const h of report.hosts) lines.push(...hostLines(h, since, report.coverage));
	if (report.hosts.length === 0) lines.push(`${capitalized(noRunText(report.coverage, `in the last ${since}`))}.`);
	lines.push(...coverageLines(report.coverage));
	return `${lines.join("\n").replace(CONTROL, "")}\n`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const capitalized = (text) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/**
 * What a report with no host says, `when` being "in the last 24h" or "in this window": that no host ran a job only when
 * the whole window was read: no reason (no source missing, no record skipped), not this host's files alone, the run
 * mirror's history not cut (`truncated`, which for a report with no host is the mirror's own), and no record left
 * uncounted (unreadable, or without a host). Otherwise only that the history read here holds no run, since a host whose
 * runs were not read may have run many. The CLI, the panel's HOSTS view and the insights page say it in these words.
 */
export function noRunText(cov, when) {
	const whole = (cov?.reason ?? null) === null && cov?.source !== "local" && cov?.truncated !== true && !(cov?.unreadable > 0) && !(cov?.withoutHost > 0);
	return whole ? `no host ran a job ${when}` : `no run in the history read here ${when}`;
}

/**
 * Why a host's history starts inside the window when the run mirror cut it (`coverage.truncated`), in the words the CLI
 * uses; the insights page restates them (admin/src/insights-html.mjs `capGapWhy`, pinned by its test): the mirror
 * holds nothing older, because it started then (`runs:since`: a new deployment, or a Valkey that lost its keys), or its
 * cap or a peer's shorter retention cut it.
 */
export const MIRROR_CUT_WHY = "the run mirror holds nothing older: it started then, or its cap or a peer's shorter retention cut it";

/**
 * Why a host's history is not here (`hosts[].notShared`), in one sentence for the CLI, the tool and doctor, so none of
 * them blames the name for a Valkey that did not answer: `unread` names the reason the run mirror was not read (the
 * coverage's `reason`); only `unnamed` says it is a worker without `PI_WORKER_NAME`.
 */
export function notSharedWhy(h, coverage) {
	if (h?.notShared === "unread") return `the run mirror was not read${coverage?.reason ? ` (${coverage.reason})` : ""}, so its runs are not here`;
	return "no source here holds its runs (a worker without PI_WORKER_NAME writes no run mirror)";
}

function hostLines(h, since, coverage) {
	const lines = [`Host ${h.name}, last ${since}`];
	if (h.coveredMs === 0) {
		lines.push(`  no history here${h.shared ? "" : `: ${notSharedWhy(h, coverage)}`}`);
		return lines;
	}
	const f = hostFacts(h);
	const missing = f.missing !== null ? ` (${f.missing} of the window has no history)` : "";
	lines.push(`  busy ${f.busy}, idle ${f.idle}${missing}`);
	const of = f.slots !== null ? ` of ${f.slots}` : "";
	const basis = f.basis === null ? "" : ` (${f.basis})`;
	const full = f.full !== null ? `, full ${f.full} of the time` : "";
	lines.push(`  slots: avg ${f.avg}${of}, peak ${f.peak}${of}${full}${basis}`);
	lines.push(`  promised: ${f.memory}, ${f.cpu}`);
	if (f.cpuUsed !== null) lines.push(`  CPU used: ${f.cpuUsed}`);
	lines.push(f.wait !== null ? `  wait for a slot: ${f.wait}` : "  wait for a slot: no run recorded one");
	if (f.projects.length > 0) lines.push(`  projects by run time: ${f.projects.join(", ")}`);
	for (const caveat of hostCaveats(h.coverage)) lines.push(`  ${caveat}`);
	lines.push(`  ${historyNotes(h).join("; ")}`);
	return lines;
}

/**
 * A host's headline numbers in words, as the CLI prints them (`hostLines`) and the insights page shows them, so the two
 * cannot say a number differently: busy and idle of the covered time, the share of the window with no history (null
 * when none), slots on average and at peak with the slot count (null when unknown), time full (null when not known),
 * the basis note, what memory and CPU were promised against, CPU used (null when not measured), the wait (null when no
 * run recorded one), and the projects by run time with the rest summed. For a host with covered time only.
 */
export function hostFacts(h) {
	const c = h.capacity;
	const memOf = Number.isSafeInteger(c.memMiB) && c.memMiB > 0 ? ` of the ${formatMemory(c.memMiB)} budget` : "";
	const hostCpus = c.cpus !== null ? `the host's ${c.cpus} CPUs` : "the host's CPUs";
	const promiseOf = Number.isSafeInteger(c.cpuCenti) && c.cpuCenti > 0 ? `the ${formatCpus(c.cpuCenti)} CPU budget` : `${hostCpus} (no CPU budget)`;
	const projects = h.projects.map((p) => `${p.project ?? "(no project)"} ${durationText(p.runMs)}`);
	if (h.projects.length > 0 && h.otherProjects) projects.push(`${plural(h.otherProjects.count, "other")} ${durationText(h.otherProjects.runMs)}`);
	return {
		...busyIdleText(h.busyMs, h.coveredMs),
		missing: h.missingMs > 0 ? shareText(h.missingMs, h.missingMs + h.coveredMs) : null,
		avg: milliText(h.avgMilli ?? 0),
		slots: c.slots,
		peak: h.peak,
		full: h.fullMs !== null ? shareText(h.fullMs, h.coveredMs) : null,
		basis: basisNote(c),
		memory: h.promisedMemPerMille !== null ? `memory ${percentText(h.promisedMemPerMille)}${memOf}` : `memory: no budget${c.memMiB === "off" ? " (off)" : ""}`,
		cpu: h.promisedCpuPerMille !== null ? `CPU ${percentText(h.promisedCpuPerMille)} of ${promiseOf}` : "CPU: no budget or CPU count known",
		cpuUsed: h.usedCpuPerMille !== null ? `${percentText(h.usedCpuPerMille)} of ${hostCpus}` : null,
		wait: h.waits.n > 0 ? `p50 ${durationText(h.waits.p50Ms)}, p95 ${durationText(h.waits.p95Ms)} (${plural(h.waits.n, "run")})` : null,
		projects,
	};
}

/**
 * How a host's slot count was judged, as the CLI words it after "slots: avg ... of N", or null when the count is the one
 * every run recorded: the panel's HOSTS view qualifies its "of N" and its full share with the same words.
 */
export function basisNote(c) {
	if (c?.basis === "recorded") return c.changed ? "the capacity changed in the window: each part is judged by the one in force then, the newest is shown" : null;
	return c?.basis === "current" ? "current setting, no run recorded one" : "slot count unknown";
}

/**
 * What a host's numbers leave out or infer, one sentence each, from its coverage counts (`hosts[].coverage`): refusals
 * before a slot, retries and stalls that under-count busy time, the jobs running now and those not counted, an
 * unreadable job list, orphans. The CLI prints one per line; the panel's HOSTS view prints the same sentences.
 */
export function hostCaveats(cov) {
	const out = [];
	if (cov.refusedBeforeSlot > 0) out.push(`${plural(cov.refusedBeforeSlot, "job")} refused before a slot`);
	// Two sentences, each true of THIS host (phase 4's review): an earlier attempt is counted on the host that ran it, which
	// need not be the retry's, so "N retried runs: M earlier attempts counted" read 0 on the retry's host while the
	// attempt was counted on another.
	if (cov.retried > 0) out.push(`${plural(cov.retried, "retried run")}: ${cov.retried === 1 ? "its earlier attempts are" : "their earlier attempts are"} counted on the host that ran them, where that host's history is here and covers them; an attempt whose record was not kept is not counted, so busy time can be under-counted`);
	if (cov.earlier > 0) out.push(cov.earlier === 1 ? "1 earlier attempt of a retried run counted here, from the record its retry kept" : `${cov.earlier} earlier attempts of retried runs counted here, from the records their retries kept`);
	if (cov.live > 0) out.push(`${plural(cov.live, "job")} running now, counted as busy up to now (or the host's last beat)`);
	if (cov.liveNotCounted > 0) out.push(`${cov.liveNotCounted} more running now ${cov.liveNotCounted === 1 ? "is" : "are"} not counted (not listed by its row, or its history is not shared), so busy time can be under-counted`);
	if (cov.liveUnreadable > 0) out.push("its list of running jobs could not be read, so none of them is counted and how many run is unknown");
	if (cov.orphans > 0) out.push(`${plural(cov.orphans, "orphaned container")} (a stop that did not take) still held by the budget, counted by ${cov.orphans === 1 ? "its record" : "their records"} up to the stop`);
	if (cov.stalledRepick > 0) out.push(`${cov.stalledRepick} ${cov.stalledRepick === 1 ? "run was" : "runs were"} picked up again after a stall: the first pickup's time is not counted`);
	return out;
}

/** Where a host's history comes from (`hosts[].coverage.source`), in words. */
export function historySourceText(source) {
	return source === "local" ? "this host's files" : source === "mirror" ? "the run mirror" : source === "mirror+local" ? "the run mirror and this host's files" : "the run records";
}

/**
 * Where a host's history comes from and what of it is missing or inferred, one clause each: its source, the start of a
 * history that begins inside the window (earlier time is neither busy nor idle), and the records counted by inference
 * or left out of promised or CPU used. The CLI joins them with "; ", as does the panel's HOSTS view.
 */
export function historyNotes(h) {
	const cov = h.coverage;
	const notes = [`history from ${historySourceText(cov.source)}`];
	if (h.missingMs > 0) notes.push(`from ${new Date(cov.fromMs).toISOString().slice(0, 16).replace("T", " ")} UTC on${cov.truncated ? ` (${MIRROR_CUT_WHY})` : ""}, earlier time counted as neither busy nor idle`);
	const legacy = cov.legacyOccupied + cov.legacyRefused;
	if (legacy > 0) notes.push(`${plural(legacy, "record")} from before capacity was recorded, inferred (${cov.legacyOccupied} held a slot, ${cov.legacyRefused} refused)`);
	if (cov.withoutSize > 0) notes.push(`${cov.withoutSize} without a size (not in promised)`);
	if (cov.withoutResources > 0) notes.push(`${cov.withoutResources} without a CPU measurement (not in CPU used)`);
	if (cov.capacityOutOfRange > 0) notes.push(`${plural(cov.capacityOutOfRange, "record")} giving a capacity no host can have, that value read as unknown`);
	if (cov.cpuClamped > 0) notes.push(`${cov.cpuClamped} reporting more CPU than the job could use, read at that most`);
	return notes;
}

/**
 * The fleet's records that no host's numbers hold, one clause each: unreadable records, records without a host, carried
 * earlier attempts not counted. The CLI's coverage line and the panel's HOSTS view say them in these words.
 */
export function fleetRecordNotes(cov) {
	const notes = [];
	if (cov.unreadable > 0) notes.push(`${plural(cov.unreadable, "record")} unreadable, not counted`);
	if (cov.withoutHost > 0) notes.push(`${cov.withoutHost} without a host, not counted`);
	if (cov.earlierDropped > 0) notes.push(`${plural(cov.earlierDropped, "carried earlier attempt")} not counted (not valid, beyond the 4 a record keeps, or overlapping its own run)`);
	return notes;
}

/**
 * What the fleet's history covers, one clause each: where it comes from, the hosts whose history is not here, the records
 * no host's numbers hold, the running jobs not counted or unknown, and why a source was not read. The CLI joins them into
 * its coverage line (`coverageLines`); the insights page shows each on its own, so a long host list can never push the
 * others out. `namesShown` cuts the host list to that many names and says how many more (the CLI names them all).
 */
export function coverageNotes(cov, { namesShown = Infinity } = {}) {
	const notes = [`history: ${cov.source === "local" ? "this host's files only" : cov.source === "mirror" ? "the run mirror" : cov.source === "mirror+local" ? "the run mirror and this host's files" : "the records given"}`];
	const names = cov.historyNotShared;
	if (names.length > namesShown) notes.push(`${plural(names.length, "host")} whose history is not here: ${names.slice(0, namesShown).join(", ")} and ${names.length - namesShown} more`);
	else if (names.length > 0) notes.push(`not shared here: ${names.join(", ")}`);
	notes.push(...fleetRecordNotes(cov));
	// No row that lists anything (the registry not read, or every row gone until its next beat), or none for the reading
	// host while its runs are here: those running jobs are not counted, and the line says so rather than leaving a busy
	// host reading as one that runs nothing. The other rows' count stands.
	const noRows = cov.liveUnreadable === 0 && cov.running === null;
	if (cov.liveUnreadable > 0) notes.push(`the running jobs of ${plural(cov.liveUnreadable, "host")} unreadable, not counted, so how many run now is unknown`);
	else if (noRows) notes.push("no live row lists the jobs running now, so they are not known");
	if (cov.running !== null && cov.running > 0) notes.push(`${plural(cov.running, "job")} running now${cov.liveNotCounted > 0 ? `, ${cov.liveNotCounted} of them not counted until ${cov.liveNotCounted === 1 ? "it ends" : "they end"}` : ", counted up to now"}`);
	if (typeof cov.liveRowMissing === "string" && !noRows) notes.push(`no live row read for this host (${cov.liveRowMissing}), so the jobs it runs now are not known`);
	if (cov.reason) notes.push(cov.reason);
	return notes;
}

/**
 * Busy and idle as printed, `{ busy, idle }`: busy is `shareText(busy, covered)`, and idle is its complement, so the two
 * printed numbers always sum to 100% (each rounded on its own, 123.5 and 876.5 per mille printed 12.4% and 87.7%).
 * Covered time is busy or idle and nothing else (missing time is neither), so the complement is the idle share.
 */
export function busyIdleText(busyMs, coveredMs) {
	const busy = shareText(busyMs, coveredMs);
	if (!(coveredMs > 0)) return { busy, idle: busy };
	if (busyMs <= 0) return { busy, idle: "100%" };
	if (busyMs >= coveredMs) return { busy, idle: "0%" };
	const p = share(busyMs, coveredMs);
	if (p === 0) return { busy, idle: "over 99.9%" };
	if (p === 1000) return { busy, idle: "under 0.1%" };
	return { busy, idle: percentText(1000 - p) };
}

/** What no surface of the report can see (REQ-CAPACITY-INSIGHTS): every one says it in these words. */
export const JOBS_ONLY = "Jobs only: a machine busy with other work reads as idle.";

/** The CLI's last two lines: what the fleet's history covers, and what this report cannot see. */
export function coverageLines(cov) {
	const notes = coverageNotes(cov);
	// The insights page draws this clause as its own warning, so it is added here, not in `coverageNotes`.
	if (cov.truncated === true) notes.splice(1, 0, TRUNCATED_NOTE);
	return [`Coverage: ${notes.join("; ")}.`, JOBS_ONLY];
}

/** The fleet's history cut by the run mirror (`coverage.truncated`), as the CLI's coverage line says it. */
export const TRUNCATED_NOTE = "history truncated: the run mirror holds nothing older for at least one host, so its earlier time is counted as neither busy nor idle";
