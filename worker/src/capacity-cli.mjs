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
		// `prune: false`: this command writes nothing, not even the registry reader's tidying of a dead member.
		const [fleet, read] = await Promise.all([
			redis ? (readLiveHostsFn ?? readLiveHosts)(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS, prune: false }).catch((error) => ({ unreachable: error?.message ?? "registry unreadable" })) : { unreachable: null },
			readCapacityRecords({ redis, logsDir, sinceMs: windowStartMs, nowMs, retentionDays, localHost, noMirrorReason: refusedNote, timeoutMs: FLEET_READ_TIMEOUT_MS, ...(fs ? { fs } : {}) }),
		]);
		if (named && (fleet.unreachable || read.mirrorState.startsWith("unreachable"))) return fail(`could not read Valkey at ${urlShown(url)}: ${fleet.unreachable ? `host registry ${fleet.unreachable}` : `run mirror ${read.mirrorState}`}`);
		const coverage = { ...read.coverage, reason: [read.coverage.reason, fleet.unreachable ? `host registry unreadable (${fleet.unreachable})` : null].filter(Boolean).join("; ") || null };
		const report = computeCapacity({ records: read.records, live: fleet.hosts ?? [], windowStartMs, nowMs, bucketMs: window.bucketMs, coverage });
		if (host !== undefined) {
			const known = report.hosts.map((h) => h.name);
			if (!known.includes(host)) return fail(`no host named ${JSON.stringify(host)} in the last ${since}${known.length > 0 ? ` (hosts: ${known.join(", ")})` : ""}`);
			const shown = report.hosts.find((h) => h.name === host);
			report.hosts = [shown];
			// The coverage says what the shown host's history is: its start, its cut and its counts. What cannot be put on
			// a host (a record with no readable host, the live rows' running jobs, the reasons a source was not read) stays.
			const { fromMs, source: _source, truncated, ...counts } = shown.coverage;
			report.coverage = { ...report.coverage, fromMs, truncated, ...counts, historyNotShared: report.coverage.historyNotShared.filter((n) => n === host) };
		}
		write(json ? `${JSON.stringify(report)}\n` : capacityText(report, { since }));
		return 0;
	} finally {
		redis?.disconnect?.();
	}
}

/**
 * What this command reads of the deployment: the logs directory (config.mjs `logsDirPath`, the worker's rule), the
 * retention (30 days unless set; 0 keeps the files) and this host's name (`PI_WORKER_NAME`, else the hostname), or
 * `{ problem }` for a retention the worker would refuse to boot with.
 */
async function deploymentFacts(env) {
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

/** Part of whole as a per-mille, rounded half up; 0 when there is no whole. */
const share = (part, whole) => (whole > 0 ? Math.floor((part * 2000 + whole) / (whole * 2)) : 0);

/**
 * C0 and C1 control characters, which a terminal acts on (cursor moves, a title, a cleared screen). The report admits
 * only worker names and project ids, which hold none; this strips them anyway before anything reaches the terminal, so
 * a reader that ever admits more cannot hand a record's author the operator's screen.
 */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** The human report: one block per host, then what the fleet's history covers. Control characters stripped. */
export function capacityText(report, { since }) {
	const lines = [];
	for (const h of report.hosts) lines.push(...hostLines(h, since));
	if (report.hosts.length === 0) lines.push(`No host ran a job in the last ${since}.`);
	lines.push(...coverageLines(report.coverage));
	return `${lines.join("\n").replace(CONTROL, "")}\n`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function hostLines(h, since) {
	const lines = [`Host ${h.name}, last ${since}`];
	if (h.coveredMs === 0) {
		lines.push(`  no history here${h.shared ? "" : ": no source here holds this host's runs (a worker without PI_WORKER_NAME writes no run mirror)"}`);
		return lines;
	}
	const cov = h.coverage;
	const missing = h.missingMs > 0 ? ` (${percentText(share(h.missingMs, h.missingMs + h.coveredMs))} of the window has no history)` : "";
	lines.push(`  busy ${percentText(share(h.busyMs, h.coveredMs))}, idle ${percentText(share(h.idleMs, h.coveredMs))}${missing}`);
	const c = h.capacity;
	const of = c.slots !== null ? ` of ${c.slots}` : "";
	const basis = c.basis === "recorded" ? (c.changed ? " (the capacity changed in the window: each part is judged by the one in force then, the newest is shown)" : "") : c.basis === "current" ? " (current setting, no run recorded one)" : " (slot count unknown)";
	const full = h.fullMs !== null ? `, full ${percentText(share(h.fullMs, h.coveredMs))} of the time` : "";
	lines.push(`  slots: avg ${milliText(h.avgMilli ?? 0)}${of}, peak ${h.peak}${of}${full}${basis}`);
	const memOf = Number.isSafeInteger(c.memMiB) && c.memMiB > 0 ? ` of the ${formatMemory(c.memMiB)} budget` : "";
	const mem = h.promisedMemPerMille !== null ? `memory ${percentText(h.promisedMemPerMille)}${memOf}` : `memory: no budget${c.memMiB === "off" ? " (off)" : ""}`;
	const hostCpus = c.cpus !== null ? `the host's ${c.cpus} CPUs` : "the host's CPUs";
	const promiseOf = Number.isSafeInteger(c.cpuCenti) && c.cpuCenti > 0 ? `the ${formatCpus(c.cpuCenti)} CPU budget` : `${hostCpus} (no CPU budget)`;
	const cpu = h.promisedCpuPerMille !== null ? `CPU ${percentText(h.promisedCpuPerMille)} of ${promiseOf}` : "CPU: no budget or CPU count known";
	lines.push(`  promised: ${mem}, ${cpu}`);
	if (h.usedCpuPerMille !== null) lines.push(`  CPU used: ${percentText(h.usedCpuPerMille)} of ${hostCpus}`);
	lines.push(h.waits.n > 0 ? `  wait for a slot: p50 ${durationText(h.waits.p50Ms)}, p95 ${durationText(h.waits.p95Ms)} (${plural(h.waits.n, "run")})` : "  wait for a slot: no run recorded one");
	if (h.projects.length > 0) {
		const named = h.projects.map((p) => `${p.project ?? "(no project)"} ${durationText(p.runMs)}`);
		if (h.otherProjects) named.push(`${plural(h.otherProjects.count, "other")} ${durationText(h.otherProjects.runMs)}`);
		lines.push(`  projects by run time: ${named.join(", ")}`);
	}
	if (cov.refusedBeforeSlot > 0) lines.push(`  ${plural(cov.refusedBeforeSlot, "job")} refused before a slot`);
	if (cov.retried > 0) lines.push(`  ${plural(cov.retried, "retried run")}: ${plural(cov.earlier, "earlier attempt")} counted from the records the retries kept; an attempt whose record was not kept is not counted, so busy time can be under-counted`);
	if (cov.stalledRepick > 0) lines.push(`  ${cov.stalledRepick} ${cov.stalledRepick === 1 ? "run was" : "runs were"} picked up again after a stall: the first pickup's time is not counted`);
	const notes = [`history from ${cov.source === "local" ? "this host's files" : cov.source === "mirror" ? "the run mirror" : "the run records"}`];
	if (h.missingMs > 0) notes.push(`from ${new Date(cov.fromMs).toISOString()} on${cov.truncated ? " (the run mirror holds nothing older: its cap, or a peer's shorter retention, cut it)" : ""}, earlier time counted as neither busy nor idle`);
	const legacy = cov.legacyOccupied + cov.legacyRefused;
	if (legacy > 0) notes.push(`${plural(legacy, "record")} from before capacity was recorded, inferred (${cov.legacyOccupied} held a slot, ${cov.legacyRefused} refused)`);
	if (cov.withoutSize > 0) notes.push(`${cov.withoutSize} without a size (not in promised)`);
	if (cov.withoutResources > 0) notes.push(`${cov.withoutResources} without a CPU measurement (not in CPU used)`);
	if (cov.cpuClamped > 0) notes.push(`${cov.cpuClamped} reporting more CPU than the job could use, read at that most`);
	lines.push(`  ${notes.join("; ")}`);
	return lines;
}

/** What the fleet's history covers, said plainly, ending with what this report cannot see. */
function coverageLines(cov) {
	const notes = [`history: ${cov.source === "local" ? "this host's files only" : cov.source === "mirror" ? "the run mirror" : cov.source === "mirror+local" ? "the run mirror and this host's files" : "the records given"}`];
	if (cov.historyNotShared.length > 0) notes.push(`not shared here: ${cov.historyNotShared.join(", ")}`);
	if (cov.unreadable > 0) notes.push(`${plural(cov.unreadable, "record")} unreadable, not counted`);
	if (cov.withoutHost > 0) notes.push(`${cov.withoutHost} without a host, not counted`);
	if (cov.running !== null && cov.running > 0) notes.push(`${plural(cov.running, "job")} running now, counted once ${cov.running === 1 ? "it ends" : "they end"}`);
	if (cov.reason) notes.push(cov.reason);
	return [`Coverage: ${notes.join("; ")}.`, "Jobs only: a machine busy with other work reads as idle."];
}
