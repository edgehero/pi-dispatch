/**
 * `pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json] [--valkey-url <url>]` (issue #599,
 * REQ-CAPACITY-INSIGHTS): how busy each host was over the window, read from the run records (`capacity-records.mjs`)
 * and computed by the one function every surface shares (`capacity.mjs`). `--json` prints the report itself
 * (INT-CAPACITY-REPORT).
 *
 * READ-ONLY, and needs what `status` needs and no more: the Valkey URL (the kill switch's rule, `killSwitchValkeyUrls`)
 * and the deployment's logs directory, never `loadConfig`, so it answers on a deployment whose forge auth is broken.
 * Where this shell and the deployment's `.env` name different Valkeys it refuses until `--valkey-url` says which: a
 * report from the wrong one would read a busy fleet as idle. An unreachable or refused Valkey is not a failure: the
 * local files are read and the report says so.
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
		return fail(`${error.message}\n  usage: pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json]`);
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

	const nowMs = now();
	const windowStartMs = nowMs - window.ms;
	let redis = null;
	let refusedNote = null;
	const refused = await valkeyRefusal(url, env);
	if (refused) refusedNote = `Valkey at ${urlShown(url)} refused: ${refused}`;
	else {
		redis = (redisFn ?? makeRedisClient)(url);
		redis.on?.("error", () => {});
	}
	try {
		const { readLiveHosts } = await import("./host-registry.mjs");
		// Both reads at once, so a Valkey that does not answer costs one timeout, not two.
		const [fleet, read] = await Promise.all([
			redis ? (readLiveHostsFn ?? readLiveHosts)(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((error) => ({ unreachable: error?.message ?? "registry unreadable" })) : { unreachable: "no Valkey" },
			readCapacityRecords({ redis, logsDir, sinceMs: windowStartMs, nowMs, retentionDays, localHost, timeoutMs: FLEET_READ_TIMEOUT_MS, ...(fs ? { fs } : {}) }),
		]);
		const coverage = { ...read.coverage, reason: [refusedNote, read.coverage.reason, fleet.unreachable ? `host registry unreadable (${fleet.unreachable})` : null].filter(Boolean).join("; ") || null };
		const report = computeCapacity({ records: read.records, live: fleet.hosts ?? [], windowStartMs, nowMs, bucketMs: window.bucketMs, coverage });
		if (host !== undefined) {
			const known = report.hosts.map((h) => h.name);
			if (!known.includes(host)) return fail(`no host named ${JSON.stringify(host)} in the last ${since}${known.length > 0 ? ` (hosts: ${known.join(", ")})` : ""}`);
			report.hosts = report.hosts.filter((h) => h.name === host);
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

/** The human report: one block per host, then what the history covers. */
export function capacityText(report, { since }) {
	const lines = [];
	for (const h of report.hosts) {
		lines.push(`Host ${h.name}, last ${since}`);
		if (h.coveredMs === 0) {
			lines.push(`  no history here${h.shared ? "" : ": this host's runs are not shared (it declares no PI_WORKER_NAME, so it writes no run mirror)"}`);
			continue;
		}
		const missing = h.missingMs > 0 ? ` (${percentText(share(h.missingMs, h.missingMs + h.coveredMs))} of the window has no history)` : "";
		lines.push(`  busy ${percentText(share(h.busyMs, h.coveredMs))}, idle ${percentText(share(h.idleMs, h.coveredMs))}${missing}`);
		const c = h.capacity;
		const of = c.slots !== null ? ` of ${c.slots}` : "";
		const basis = c.basis === "recorded" ? (c.changed ? " (changed in the window, newest shown)" : "") : c.basis === "current" ? " (current setting, no run recorded one)" : " (slot count unknown)";
		const full = h.fullMs !== null ? `, full ${percentText(share(h.fullMs, h.coveredMs))} of the time` : "";
		lines.push(`  slots: avg ${milliText(h.avgMilli ?? 0)}${of}, peak ${h.peak}${of}${full}${basis}`);
		const mem = h.promisedMemPerMille !== null ? `memory ${percentText(h.promisedMemPerMille)} of ${formatMemory(c.memMiB)}` : `memory: no budget${c.memMiB === "off" ? " (off)" : ""}`;
		const cpuOf = Number.isSafeInteger(c.cpuCenti) && c.cpuCenti > 0 ? `${formatCpus(c.cpuCenti)} CPUs (budget)` : c.cpus !== null ? `${c.cpus} CPUs (all, no CPU budget)` : null;
		const cpu = h.promisedCpuPerMille !== null ? `CPU ${percentText(h.promisedCpuPerMille)} of ${cpuOf}` : "CPU: no budget or CPU count known";
		lines.push(`  promised: ${mem}, ${cpu}`);
		if (h.usedCpuPerMille !== null) lines.push(`  CPU used: ${percentText(h.usedCpuPerMille)} of ${cpuOf}`);
		lines.push(h.waits.n > 0 ? `  wait for a slot: p50 ${durationText(h.waits.p50Ms)}, p95 ${durationText(h.waits.p95Ms)} (${h.waits.n} run${h.waits.n === 1 ? "" : "s"})` : "  wait for a slot: no run recorded one");
		if (h.projects.length > 0) {
			const named = h.projects.map((p) => `${p.project ?? "(no project)"} ${durationText(p.runMs)}`);
			if (h.otherProjects) named.push(`${h.otherProjects.count} other${h.otherProjects.count === 1 ? "" : "s"} ${durationText(h.otherProjects.runMs)}`);
			lines.push(`  projects by run time: ${named.join(", ")}`);
		}
		if (h.refused > 0) lines.push(`  ${h.refused} job${h.refused === 1 ? "" : "s"} refused before a slot`);
	}
	if (report.hosts.length === 0) lines.push(`No host ran a job in the last ${since}.`);
	lines.push(...coverageLines(report.coverage, report.window));
	return `${lines.join("\n")}\n`;
}

/** What the history covers, said plainly, ending with what this report cannot see. */
function coverageLines(cov, window) {
	const notes = [`history: ${cov.source === "local" ? "this host's files only" : cov.source === "mirror" ? "the run mirror" : "the run mirror and this host's files"}`];
	if (cov.fromMs > window.fromMs) notes.push(`from ${new Date(cov.fromMs).toISOString()} on${cov.truncated ? " (the run mirror is at its cap, so older runs were cut)" : ""}, earlier time counted as neither busy nor idle`);
	if (cov.historyNotShared.length > 0) notes.push(`not shared here: ${cov.historyNotShared.join(", ")}`);
	if (cov.legacyInferred > 0) notes.push(`${cov.legacyInferred} run${cov.legacyInferred === 1 ? "" : "s"} from before capacity was recorded, inferred from their length`);
	if (cov.withoutSize > 0) notes.push(`${cov.withoutSize} without a size (not in promised)`);
	if (cov.withoutResources > 0) notes.push(`${cov.withoutResources} without a CPU measurement (not in CPU used)`);
	if (cov.unreadable > 0) notes.push(`${cov.unreadable} record${cov.unreadable === 1 ? "" : "s"} unreadable, not counted`);
	if (cov.withoutHost > 0) notes.push(`${cov.withoutHost} without a host, not counted`);
	if (cov.running !== null && cov.running > 0) notes.push(`${cov.running} job${cov.running === 1 ? "" : "s"} running now, counted once ${cov.running === 1 ? "it ends" : "they end"}`);
	if (cov.reason) notes.push(cov.reason);
	return [`Coverage: ${notes.join("; ")}.`, "Jobs only: a machine busy with other work reads as idle."];
}
