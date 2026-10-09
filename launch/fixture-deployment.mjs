/**
 * The one canned deployment the README images are drawn from (`launch/render-images.mjs`): config files, a month of
 * run records across three hosts, and a Valkey seeded with the registry rows, the run mirror, the counters, a held
 * job, the cron schedulers and the budget split's history, all dated around one frozen instant (`NOW`).
 *
 * EVERY VALUE IS WRITTEN THROUGH THE PROJECT'S OWN CODE, never as a hand-made key or a hand-made record: the records
 * are `buildRecord`'s, written by `makeRecordWriter` and mirrored by `makeRunMirror`; the host rows are
 * `makeHostRegistry`'s beat, their running jobs `liveJobsFields`'; the counters use the budget's key builders; the held
 * job is `makeWaitState().hold`; the schedulers are BullMQ's own `upsertJobScheduler`; the split's history is
 * `applyPriorities` and `revertAllocation`. So an image cannot show a shape the shipped code would never write.
 *
 * SYNTHETIC BY CONSTRUCTION. Hosts `mini1`, `mini2` and `build3`; projects `web`, `api`, `billing` and `ops`; repos
 * under the placeholder owner `acme`; job ids from a seeded generator. No person, machine, account or address of the
 * maintainer's appears, and the only paths are under the temporary directory the caller passes (the panel and the
 * insights page print a local folder by its basename).
 *
 * DETERMINISTIC. No `Math.random`, no wall clock (every instant derives from `NOW`; the caller freezes `Date` for the
 * code that reads it), and every list is built in a fixed order, so two runs seed the same bytes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Thu 2026-10-08 15:39:08 UTC: the week window began Mon 10-05, the month on 10-01. */
export const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);
const MIN = 60_000;
const H = 3_600_000;
const DAY = 86_400_000;
const M = 1_000_000;

/** build3's `PI_LOG_RETENTION_DAYS`: its own logs directory, and its trim of the shared run mirror. */
const BUILD3_RETENTION_DAYS = 7;

/** This host, the one whose panel the images show (`PI_WORKER_NAME`). */
export const LOCAL_HOST = "mini1";

/** What each host offers: the live slot count, its host budget (`off` for none) and its CPUs. */
const HOSTS = {
	mini1: { slots: 4, memMiB: 16384, cpuCenti: 800, cpus: 10 },
	mini2: { slots: 2, memMiB: "off", cpuCenti: "off", cpus: 8 },
	build3: { slots: 3, memMiB: 24576, cpuCenti: 1200, cpus: 16 },
};

/**
 * The queue's live state, which only a running fleet produces (a job in a processor, a worker connection, a job that
 * failed its last attempt): canned per queue, and consistent with the registry rows below (mini1 runs two jobs, mini2
 * one, build3 one, and nothing waits, since every host has a slot free; the three delayed are the two schedulers' next
 * fires and the job held on run.waitFor).
 */
export const QUEUE_STATE = {
	"pi-jobs": { counts: { waiting: 0, active: 0, paused: 0, delayed: 3, failed: 1 } },
	"pi-jobs@mini1": { counts: { waiting: 0, active: 2, paused: 0, delayed: 0, failed: 0 } },
	"pi-jobs@mini2": { counts: { waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 } },
	"pi-jobs@build3": { counts: { waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 } },
};
export const WORKERS = ["mini1", "mini2", "build3"];
export const FAILED = { id: "gh-5d10", attemptsMade: 3, failedReason: "clone failed: remote rejected the token (403)", finishedOn: NOW - 3 * H };

// ---- a seeded generator: the same sequence on every run ------------------------------------------------------------
function generator(seed) {
	let s = seed;
	const next = () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join("") };
}

// ---- files -------------------------------------------------------------------------------------------------------
const skill = (name, desc, body) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;

/**
 * Write the deployment's files under `dir` and return their paths. With `git`, the two job folders are made git
 * repositories (the insights page's topology reads a local folder's flow gate from git); the panel never needs it.
 */
export function writeDeployment(dir, { git = false } = {}) {
	const paths = {
		site: join(dir, "work", "site"),
		pm: join(dir, "work", "pm"),
		skills: join(dir, "pi-skills"),
		logs: join(dir, "logs"),
		settings: join(dir, "settings.json"),
		triggers: join(dir, "triggers.json"),
		pause: join(dir, "pause-windows.json"),
		limits: join(dir, "scoped-limits.json"),
		projects: join(dir, "projects.json"),
		envelope: join(dir, "envelope.json"),
		subs: join(dir, "subscriptions.json"),
		graph: join(dir, "graph"),
	};
	const files = (root, entries) => {
		for (const [rel, text] of Object.entries(entries)) {
			mkdirSync(join(root, rel, ".."), { recursive: true });
			writeFileSync(join(root, rel), text);
		}
	};
	mkdirSync(paths.logs, { recursive: true });
	files(paths.site, {
		".pi/skills/tidy/SKILL.md": skill("tidy", "Format, fix lint, and tighten types.", "Run the formatter and linter and fix what they report. Then build the report with build-report."),
		".pi/skills/build-report/SKILL.md": skill("build-report", "Build the weekly site report.", "Build the report and check how it renders."),
	});
	files(paths.pm, {
		".pi/skills/portfolio-manager/SKILL.md": skill("portfolio-manager", "Plan the week's budget split and report it.", "Read /job/portfolio.json and priorities.md, write /outbox/priorities.json, then report."),
		"priorities.md": "# Priorities\n\n- web: checkout launch\n- billing: invoice rework\n- ops: maintenance\n",
	});
	files(paths.skills, { "frontend-fix/SKILL.md": skill("frontend-fix", "Fix a frontend issue and screenshot it.", "Reproduce, fix, screenshot.") });
	if (git) for (const folder of [paths.site, paths.pm]) gitInit(folder, dir);

	const json = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
	json(paths.settings, { model: "claude-sonnet-4-5", provider: "anthropic", maxTurns: 30, maxTokens: 400000, dailyCap: 40, weeklyCap: 200, monthlyCap: 600, dailyTokenCap: 8000000, concurrency: 4, softHoldPct: 80, maxCostUsd: "2", dailyCostUsd: "25", weeklyCostUsd: "120" });
	json(paths.projects, {
		version: 1,
		projects: [
			{ id: "web", members: ["github:acme/web"] },
			{ id: "api", members: ["github:acme/api"] },
			{ id: "billing", members: ["github:acme/billing", "gitlab:acme/billing-ui"] },
			{ id: "ops", members: [paths.site, paths.pm] },
		],
	});
	json(paths.limits, {
		version: 3,
		limits: [
			{ scope: "github:acme/web", day: 20, week: 80, concurrent: WEB_AT_ONCE },
			{ scope: "project:billing", memory: "8g", cpus: 4 },
			{ scope: "project:api", memory: "2g", cpus: 1 },
			{ scope: "project:ops", memory: "2g", cpus: 1 },
			{ scope: "project:web", weekUsd: "45" },
			{ scope: "model:anthropic/claude-sonnet-4-5", weekUsd: "80" },
		],
	});
	json(paths.envelope, {
		version: 1,
		window: "week",
		totalUsd: "100",
		floorsUsd: { web: "10", api: "10", billing: "10", ops: "5", _other: "0" },
		defaultWeights: { web: 1, api: 1, billing: 1, ops: 1, _other: 1 },
		delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 },
	});
	json(paths.subs, { version: 1, subscriptions: [{ id: "kimi", vendor: "Moonshot AI", provider: "kimi-coding", models: ["*"], price: { amount: 19, currency: "USD", per: "month" } }] });
	json(paths.pause, { windows: [{ scope: "github:acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["mon", "tue", "wed", "thu", "fri"] }] });
	json(paths.triggers, {
		triggers: [
			{ on: { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" }, run: { kind: "local", folder: paths.site, flow: "tidy", packages: false, task: "run the nightly tidy", provider: "kimi-coding", model: "kimi-for-coding" } },
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix", packages: false, skillsDir: paths.skills, replicas: 2 } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", packages: false, instructions: "the tests run with pnpm here" } },
			{ on: { type: "pull_request", action: ["open", "update"] }, run: { kind: "gitlab", flow: "review", packages: false } },
			{ on: { type: "issue", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy", packages: false } },
			{ on: { type: "cron", id: "pm-weekly", pattern: "0 6 * * 1" }, run: { kind: "local", folder: paths.pm, flow: "portfolio-manager", packages: false, task: "Plan this week's budget split and report it.", portfolio: true, model: "claude-haiku-4-5", maxTurns: 15 } },
		],
	});
	return paths;
}

/** A one-commit repository with a fixed author and date, through a git that reads no config of this machine. */
function gitInit(folder, dir) {
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: dir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig-none"),
		GIT_AUTHOR_NAME: "ops",
		GIT_AUTHOR_EMAIL: "ops@example.invalid",
		GIT_COMMITTER_NAME: "ops",
		GIT_COMMITTER_EMAIL: "ops@example.invalid",
		GIT_AUTHOR_DATE: "2026-09-01T10:00:00Z",
		GIT_COMMITTER_DATE: "2026-09-01T10:00:00Z",
	};
	const git = (...a) => execFileSync("git", a, { cwd: folder, env, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
}

// ---- run records -------------------------------------------------------------------------------------------------
const RATES = { "claude-sonnet-4-5": [3, 15, 0.3], "claude-haiku-4-5": [1, 5, 0.1], "kimi-for-coding": [0.95, 4, 0.19] };
/** Each project's size, as its scoped-limits row sets it (web has none, so the default). */
const SIZES = { small: { memMiB: 2048, cpuCenti: 100, source: "project" }, normal: { memMiB: 4096, cpuCenti: 200, source: "default" }, build: { memMiB: 8192, cpuCenti: 400, source: "project" } };
const iso = (ms) => new Date(ms).toISOString();

/** The scoped limit's `concurrent` for github:acme/web (`writeDeployment`): the scheduler below holds the records to it. */
const WEB_AT_ONCE = 6;

/**
 * The jobs of the month, as `{ host, queuedMs, mins, ... }` before any slot is assigned. Fixed shapes per day (the
 * nightly tidy, the replicas of a label, comment fixes, reviews, billing builds), denser in the last seven days, which
 * the HOSTS view and the capacity report read.
 */
function plannedJobs(g, taken) {
	const jobs = [];
	// A job id the month has not used yet: four hex digits collide within a few hundred jobs, and a collision would
	// make one record replace another.
	const uid = (prefix) => {
		for (;;) {
			const id = `${prefix}-${g.hex(4)}`;
			if (!taken.has(id)) return taken.add(id), id;
		}
	};
	const first = Date.UTC(2026, 8, 9);
	for (let d = first; d <= Date.UTC(2026, 9, 8); d += DAY) {
		const date = new Date(d).getUTCDate();
		const recent = d >= NOW - 7 * DAY;
		const tidyAt = d + 3 * H;
		const tidyId = `repeat:nightly-tidy:${tidyAt}`;
		jobs.push({ host: "mini1", id: tidyId, kind: "local", folder: "site", flow: "tidy", queuedMs: tidyAt, mins: g.int(6, 11), model: "kimi-for-coding", provider: "kimi-coding", project: "ops", turns: g.int(8, 13), size: SIZES.small });
		if (date % 4 === 1) jobs.push({ host: "mini1", id: uid("local"), kind: "local", folder: "site", flow: "build-report", queuedMs: tidyAt + 15 * MIN, mins: 4, project: "ops", turns: 9, size: SIZES.small, parent: tidyId });
		const fix = (host, repo, project, number, at, mins, size) => jobs.push({ host, id: uid("gh"), kind: "github", repo, number, flow: "fix", queuedMs: at, mins, project, turns: g.int(6, 14), triggerIndex: 2, triggerType: "comment", size });
		// Comment fixes on the api, through the working day: several a day in the last week, every third day before it.
		const apiFixes = recent ? g.int(3, 5) : date % 3 === 0 ? 1 : 0;
		for (let i = 0; i < apiFixes; i++) fix(i % 2 === 0 ? "mini2" : "mini1", "acme/api", "api", 80 + date * 5 + i, d + (8 + i * 2) * H + g.int(0, 90) * MIN, g.int(15, 45), SIZES.small);
		// Merge request reviews on billing-ui, on mini2.
		const reviews = recent ? g.int(2, 3) : date % 4 === 2 ? 1 : 0;
		for (let i = 0; i < reviews; i++) jobs.push({ host: "mini2", id: uid("gl"), kind: "gitlab", repo: "acme/billing-ui", number: 380 + date * 3 + i, mrType: "merge_request", flow: "review", queuedMs: d + (10 + i * 3) * H + g.int(0, 50) * MIN, mins: g.int(8, 20), project: "billing", turns: 5, scale: 0.7, triggerIndex: 3, triggerType: "pull_request", size: SIZES.build });
		// A label's two replicas, one per host, on the web; in the last week it lands in a burst of web fixes that fills
		// mini1's four slots, so later jobs of the burst wait for one.
		if (recent || date % 5 === 0) {
			const id = uid("gh");
			const n = 400 + date;
			for (const r of [1, 2]) {
				jobs.push({ host: r === 1 ? "mini1" : "mini2", id: `${id}-r${r}`, kind: "github", repo: "acme/web", number: n, flow: "frontend-fix", queuedMs: d + 13 * H + 20 * MIN, mins: g.int(30, 60), project: "web", turns: 10 + r * 2, scale: 1.3, replica: r, replicas: 2, triggerIndex: 1, triggerType: "label", size: SIZES.normal });
			}
		}
		if (recent) {
			for (let i = 0; i < 5; i++) fix("mini1", "acme/web", "web", 430 + date * 7 + i, d + 13 * H + (22 + i * 4) * MIN, g.int(30, 70), SIZES.normal);
			for (let i = 0; i < g.int(2, 3); i++) fix("mini1", "acme/web", "web", 600 + date * 7 + i, d + (8 + i * 3) * H + g.int(0, 60) * MIN, g.int(25, 60), SIZES.normal);
		}
		// Long billing builds on build3, overlapping: four to six a day in the last week, one every other day before it.
		const builds = recent ? g.int(4, 6) : date % 2 === 0 ? 1 : 0;
		for (let i = 0; i < builds; i++) jobs.push({ host: "build3", id: uid("gh"), kind: "github", repo: "acme/billing", number: 200 + date * 7 + i, flow: "fix", queuedMs: d + (6 + i * 2) * H + g.int(0, 45) * MIN, mins: g.int(70, 180), project: "billing", turns: g.int(14, 24), scale: 1.6, triggerIndex: 2, triggerType: "comment", size: SIZES.build });
	}
	return jobs;
}

const isWeb = (j) => j.repo === "acme/web";

/**
 * Whether `j` may hold `[t, end)` beside what is already `placed`, by the rules the worker admits by: its host's slot
 * count, its host budget's memory and CPU (an orphan's hold counts, its slot does not), and the scoped limit's
 * `concurrent` for github:acme/web across the fleet.
 */
function fits(placed, j, t, end) {
	const c = HOSTS[j.host];
	const over = placed.filter((p) => p.startMs < end && p.endMs > t);
	const points = [t, ...over.map((p) => p.startMs).filter((s) => s > t)];
	for (const at of points) {
		const now = over.filter((p) => p.startMs <= at && p.endMs > at);
		const here = now.filter((p) => p.host === j.host);
		if (here.filter((p) => p.slot !== false).length + 1 > c.slots) return false;
		if (c.memMiB !== "off" && here.reduce((s, p) => s + p.size.memMiB, 0) + j.size.memMiB > c.memMiB) return false;
		if (c.cpuCenti !== "off" && here.reduce((s, p) => s + p.size.cpuCenti, 0) + j.size.cpuCenti > c.cpuCenti) return false;
		if (isWeb(j) && now.filter((p) => isWeb(p) && p.slot !== false).length + 1 > WEB_AT_ONCE) return false;
	}
	return true;
}

/**
 * Give each planned job its slot: in queue order, the earliest moment from its queueing on that the admission rules
 * (`fits`) allow it, beside what is `placed` already (the runs now, the retry, the cancelled job and its orphaned
 * container). A job that finds no room waits, which is where the report's waits and its time at the slot limit come
 * from. A job that could not have ended by `NOW` is left out: the month as planned ends with the runs now.
 */
function scheduled(jobs, placed) {
	const out = [];
	const all = [...placed];
	for (const j of [...jobs].sort((a, b) => a.queuedMs - b.queuedMs || (a.id < b.id ? -1 : 1))) {
		const dur = j.mins * MIN;
		const from = j.queuedMs + 2_000;
		const candidates = [from, ...all.map((p) => p.endMs).filter((e) => e > from)].sort((a, b) => a - b);
		const start = candidates.find((t) => fits(all, j, t, t + dur));
		if (start === undefined || start + dur > NOW - MIN) continue;
		const run = { ...j, startMs: start, endMs: start + dur };
		all.push(run);
		out.push(run);
	}
	return out;
}

/** A BullMQ job as the processor holds it, for `buildRecord`: id, data, attempts, and when it was added. */
function bullJob(j) {
	const data = { kind: j.kind, flow: j.flow };
	if (j.kind === "local") data.folder = `/work/${j.folder}`;
	else {
		data.repo = j.repo;
		data.target = { type: j.mrType ?? "issue", number: j.number };
	}
	if (j.parent) Object.assign(data, { parentJobId: j.parent, chainDepth: 1 });
	if (j.replica) Object.assign(data, { replica: j.replica, replicas: j.replicas });
	if (j.triggerType) data.trigger = { matched: { index: j.triggerIndex, type: j.triggerType } };
	return { id: j.id, name: j.kind, data, attemptsMade: (j.attempt ?? 1) - 1, stalledCounter: 0, timestamp: j.queuedMs, opts: { delay: 0 } };
}

/** The one model the deployment caps by itself (its `model:` scoped row), so the one whose window a job reserves in. */
const CAPPED_MODEL = "anthropic/claude-sonnet-4-5";

/**
 * A run's `dollars` as the processor settles it, through the worker's own `dollar-budget.mjs` (`D`): the job reserved
 * `maxCostUsd`, and settles metered from a trusted exit line, at the floor (the whole reservation) without one; its
 * model window, where the deployment caps that model, settles by the same rule.
 */
function dollarsOf(D, { tokens, usage, provider, model, trusted }) {
	const reservedMicros = 2 * M;
	const { settledMicros, basis } = D.dollarSettlement({ tokens, usage, reservedMicros, trusted });
	const ref = `${provider}/${model}`.toLowerCase();
	const modelBasis = ref === CAPPED_MODEL ? D.modelDollarSettlement({ ref, basis, tokens, usage, reservedMicros, trusted }).basis : null;
	return D.dollarsRecord({ reservedMicros, settledMicros, basis, modelBasis });
}

/** The runner's outcome for a completed run: tokens, the usage ledger, dollars and what the container used. */
function outcomeOf(g, j, D) {
	const model = j.model ?? "claude-sonnet-4-5";
	const provider = j.provider ?? "anthropic";
	const scale = j.scale ?? 1;
	const input = Math.round((30000 + g.next() * 90000) * scale);
	const output = Math.round((3000 + g.next() * 9000) * scale);
	const cacheRead = Math.round(input * 0.6);
	const [ri, ro, rc] = RATES[model];
	const cost = Math.round(input * ri + output * ro + cacheRead * rc) / 1e6;
	const total = input + output + cacheRead;
	const wallUsec = (j.endMs - j.startMs) * 1000;
	const tokens = { input, output, total, cost, metered: true, rootTotal: total, otherTotal: 0, looseTotal: 0, sessions: 1, calls: j.turns, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costUnreported: 0, costCapMicros: 2 * M, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };
	const usage = { v: 1, piAi: "0.99.1", truncated: 0, models: [{ provider, model, calls: j.turns, input, output, cacheRead, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total, cost, unpriced: 0 }] };
	return {
		outcome: "completed",
		reason: null,
		exitCode: 0,
		turns: j.turns,
		tokens,
		usage,
		provider,
		model,
		budgetReserved: true,
		dollars: dollarsOf(D, { tokens, usage, provider, model, trusted: true }),
		resources: {
			memPeak: Math.round(j.size.memMiB * (0.35 + g.next() * 0.4)) * 1024 * 1024,
			swapPeak: 0,
			oomKills: 0,
			memSomeUsec: 0,
			memFullUsec: 0,
			cpuUsec: Math.round(wallUsec * (j.size.cpuCenti / 100) * (0.2 + g.next() * 0.45)),
			throttledUsec: 0,
			throttled: 0,
			pidsPeak: g.int(40, 160),
		},
	};
}

/** The retry: attempt 1 lost its container to the runtime, attempt 2 finished it, both on mini1. */
const RETRY = { host: "mini1", id: "gh-7a31", kind: "github", repo: "acme/web", number: 452, flow: "fix", queuedMs: NOW - 2 * DAY - 10 * H, startMs: NOW - 2 * DAY - 10 * H + 4_000, endMs: NOW - 2 * DAY - 9 * H - 20 * MIN, project: "web", turns: 4, size: SIZES.normal, triggerIndex: 2, triggerType: "comment" };
const RETRY_2 = { ...RETRY, attempt: 2, startMs: NOW - 2 * DAY - 9 * H, endMs: NOW - 2 * DAY - 8 * H - 25 * MIN, turns: 9 };
/**
 * The job the operator cancelled on build3 whose container's stop did not take: its record ends at the stop
 * (`operator-cancel`), and its hold stays in build3's budget as an orphan under the same job id until the runtime
 * says the container is gone (host-budget.mjs `orphan`).
 */
const CANCELLED = { host: "build3", id: "gh-4a7e", kind: "github", repo: "acme/billing", number: 290, flow: "fix", queuedMs: NOW - 5 * H - 2 * MIN, startMs: NOW - 5 * H, endMs: NOW - 4 * H - 40 * MIN, project: "billing", turns: 6, scale: 1.6, size: SIZES.build, triggerIndex: 2, triggerType: "comment" };

/**
 * What the processor returns for the cancelled job (processor.mjs, the aborted branch): the stop did not take, so
 * `boundAfterAbort` (index.mjs) answered for the container with `{ code: 137, aborted: true }` and no exit line, so no
 * turns, tokens, usage or resources, and the dollars settle at the floor, the whole reservation.
 */
function cancelledOutcome(D) {
	const provider = "anthropic";
	const model = "claude-sonnet-4-5";
	return { outcome: "policy", reason: "operator-cancel", exitCode: 137, turns: null, tokens: null, provider, model, session: null, budgetReserved: true, dollars: dollarsOf(D, { tokens: null, usage: null, provider, model, trusted: false }) };
}

/** What is placed before the month is scheduled: the runs now, the retry's attempts, the cancelled job and its hold. */
function placedFirst() {
	const live = Object.entries(RUNNING).flatMap(([host, list]) => list.map((e) => ({ host, id: e.id, repo: e.repo, startMs: e.at, endMs: NOW, size: { memMiB: e.memMiB, cpuCenti: e.cpuCenti } })));
	const orphanHold = { host: CANCELLED.host, id: CANCELLED.id, repo: CANCELLED.repo, startMs: CANCELLED.endMs, endMs: NOW, size: CANCELLED.size, slot: false };
	const pm = PM_RUNS.map((run) => pmJob(run));
	return [...live, RETRY, RETRY_2, CANCELLED, orphanHold, ...pm];
}

/**
 * Every run record of the month, through `buildRecord`: the scheduled runs, the retry (its second attempt's record,
 * carrying the first in `earlier` the way the processor carries it), and the cancelled job. The portfolio manager's
 * runs are `pmRecord`'s.
 */
export function buildRecords({ buildRecord, earlierFrom, dollarBudget: D }) {
	const g = generator(599);
	const taken = new Set(["gh-5d10", "gh-77c1", RETRY.id, CANCELLED.id, ...Object.values(RUNNING).flat().map((e) => e.id)]);
	const runs = scheduled(plannedJobs(g, taken), placedFirst());
	const record = (j, result, { earlier = null } = {}) => buildRecord({ job: bullJob(j), result, startedAt: iso(j.startMs), endedAt: iso(j.endMs), host: j.host, defaultBackend: "docker", project: j.project, size: j.size, capacity: HOSTS[j.host], earlier });
	const records = runs.map((j) => record(j, outcomeOf(g, j, D)));
	const failed = record(RETRY, { ...outcomeOf(g, RETRY, D), outcome: "failed", reason: "container-lost", exitCode: null });
	records.push(record(RETRY_2, outcomeOf(g, RETRY_2, D), { earlier: earlierFrom(failed) }));
	records.push(record(CANCELLED, cancelledOutcome(D)));
	return records;
}

/** The portfolio manager's runs (Mondays, and one by hand an hour after the last), which write the split's plans. */
export const PM_RUNS = [Date.UTC(2026, 8, 21, 6), Date.UTC(2026, 8, 28, 6), Date.UTC(2026, 9, 5, 6), Date.UTC(2026, 9, 5, 7, 4)].map((at, i) => ({
	at,
	id: i === 3 ? `manual:pm-weekly:${Math.floor(at / MIN)}` : `repeat:pm-weekly:${at}`,
}));

/** A portfolio manager run as a planned job, for `buildRecords`' shape. */
export function pmJob(run) {
	return { host: "mini1", id: run.id, kind: "local", folder: "pm", flow: "portfolio-manager", queuedMs: run.at, startMs: run.at + 2_000, endMs: run.at + 2_000 + 2 * MIN, mins: 2, model: "claude-haiku-4-5", project: "ops", turns: 7, scale: 0.6, size: SIZES.small };
}

/** A pm run's record with the plan it wrote. */
export function pmRecord({ buildRecord, dollarBudget: D }, run, plan) {
	const g = generator(run.at % 100_000);
	const j = pmJob(run);
	return buildRecord({ job: bullJob(j), result: { ...outcomeOf(g, j, D), plan }, startedAt: iso(j.startMs), endedAt: iso(j.endMs), host: j.host, defaultBackend: "docker", project: j.project, size: j.size, capacity: HOSTS[j.host] });
}

// ---- the live fleet --------------------------------------------------------------------------------------------
/** The jobs each host runs at `NOW` (the in-flight map's entries), and the orphaned hold of build3's cancelled job. */
export const RUNNING = {
	mini1: [
		{ id: "gh-b3d7", project: "web", repo: "acme/web", memMiB: 4096, cpuCenti: 200, at: NOW - 12 * MIN },
		{ id: "gh-c41f", project: "api", memMiB: 2048, cpuCenti: 100, at: NOW - 41 * MIN },
	],
	mini2: [{ id: "local-9e20", project: "ops", memMiB: 2048, cpuCenti: 100, at: NOW - 6 * MIN }],
	build3: [{ id: "gh-e802", project: "billing", memMiB: 8192, cpuCenti: 400, at: NOW - 80 * MIN }],
};
const ORPHANS = { build3: [{ id: CANCELLED.id, project: CANCELLED.project, memMiB: CANCELLED.size.memMiB, cpuCenti: CANCELLED.size.cpuCenti, at: CANCELLED.startMs, orphan: true }] };

/** Each host's registry fields, as `start.mjs` publishes them; build3's last beat is 150 s old (a stale row). */
export function hostRows({ liveJobsOf, liveJobsFields, version }) {
	return Object.entries(HOSTS).map(([name, c]) => {
		const running = RUNNING[name] ?? [];
		const orphans = ORPHANS[name] ?? [];
		const held = [...running, ...orphans];
		const sum = (k) => String(held.reduce((s, e) => s + e[k], 0));
		const budget = c.memMiB !== "off";
		const live = liveJobsFields(liveJobsOf({ running, budgetEntries: orphans }));
		return {
			name,
			beatAt: name === "build3" ? NOW - 150_000 : NOW - 4_000,
			fields: {
				version,
				concurrency: String(c.slots),
				routes: "true",
				caps: "",
				tz: "UTC",
				budgetMemMiB: String(c.memMiB),
				budgetCpuCenti: String(c.cpuCenti),
				usedMemMiB: budget ? sum("memMiB") : "",
				usedCpuCenti: budget ? sum("cpuCenti") : "",
				budgetRunning: budget ? String(running.length) : "",
				waiters: budget ? "0" : "",
				jobs: live.jobs,
				jobsMore: live.jobsMore,
			},
		};
	});
}

// ---- Valkey -------------------------------------------------------------------------------------------------------
const PLAN_REASONS = { web: "checkout launch is done; keep a floor for bug reports", billing: "the invoice rework starts this week", ops: "the weekly plan and report" };

/**
 * Seed the Valkey at `url` and write the run records under `paths.logs`. `mods` are the project's modules, imported
 * by the caller after it froze the clock and emptied the environment.
 */
export async function seedDeployment({ url, paths, mods }) {
	const { RM, DW } = mods;
	// The settlement rules are the worker's own (a caller that predates the key gets them imported here).
	const W = { ...mods.W, dollarBudget: mods.W.dollarBudget ?? (await import("../worker/src/dollar-budget.mjs")) };
	const redis = W.connection.makeRedisClient(url);
	try {
		// The split's history, through the console's own writers, before the records (the pm runs carry the plans).
		const read = RM.readEnvelope({ envelopeFile: paths.envelope, projectsPath: paths.projects, scopedLimitsPath: paths.limits, maxCostMicros: 2 * M });
		if (!read.envelope) throw new Error(`the fixture's envelope does not read: ${JSON.stringify(read)}`);
		const audit = W.allocation.makeAllocationAudit({ logsDir: paths.logs });
		let lock = 0;
		const state = W.allocation.makeAllocationState({ redis, host: "mini1", audit, token: () => `seed-${++lock}` });
		await state.reconcile({ envelope: read.envelope, digest: read.digest, now: new Date(Date.UTC(2026, 8, 21, 5, 0, 2)) });
		const apply = (at, weights, run, host) =>
			RM.applyPriorities({
				url,
				envelope: read.envelope,
				digest: read.digest,
				projects: read.projects,
				plan: { projects: Object.entries(weights).map(([id, weight]) => ({ id, weight, ...(PLAN_REASONS[id] ? { reason: PLAN_REASONS[id] } : {}) })) },
				host,
				logsDir: paths.logs,
				now: new Date(at),
				writer: { kind: "portfolio-job", jobId: run.id, triggerId: "pm-weekly" },
			});
		const plans = [];
		plans.push(await apply(PM_RUNS[0].at + 2 * MIN + 11_000, { web: 3, api: 2, billing: 1, ops: 1, _other: 0 }, PM_RUNS[0], "mini1"));
		const log = await RM.readAllocations({ url, envelope: read.envelope, projects: read.projects });
		const neutral = log.log.find((r) => r.outcome === "neutral");
		await RM.revertAllocation({ url, envelope: read.envelope, digest: read.digest, target: neutral, host: "mini2", logsDir: paths.logs, now: new Date(Date.UTC(2026, 8, 23, 10, 12, 40)) });
		plans.push(await apply(PM_RUNS[1].at + 2 * MIN + 5_000, { web: 4, api: 1, billing: 3, ops: 1, _other: 0 }, PM_RUNS[1], "mini1"));
		plans.push(await apply(PM_RUNS[2].at + 2 * MIN + 9_000, { web: 4, api: 1, billing: 5, ops: 1, _other: 0 }, PM_RUNS[2], "mini1"));
		plans.push(await apply(PM_RUNS[3].at + 2 * MIN + 30_000, { web: 4, api: 1, billing: 7, ops: 1, _other: 0 }, PM_RUNS[3], "mini1"));
		const planOf = (res) => ({ outcome: res.outcome, reason: res.reason ?? null, planId: res.planId ?? null, clamped: res.clamped === true });

		const records = buildRecords({ buildRecord: W.runHistory.buildRecord, earlierFrom: W.runHistory.earlierFrom, dollarBudget: W.dollarBudget });
		PM_RUNS.forEach((run, i) => records.push(pmRecord({ buildRecord: W.runHistory.buildRecord, dollarBudget: W.dollarBudget }, run, planOf(plans[i]))));
		records.sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt) || (a.jobId < b.jobId ? -1 : 1));
		// mini1 and mini2 share one PI_LOGS_DIR (this one) and keep 30 days; build3 keeps its own logs directory for 7
		// days (BUILD3_RETENTION_DAYS), so its runs reach the others only through the run mirror every named worker
		// writes. Each writer trims the mirror by its own retention, and a trim that removes a run raises the fleet horizon
		// (`runs:horizon`) to its age cutoff, that write's time less the writer's window (run-mirror.mjs `TRIM_SCRIPT`).
		// So build3's history here starts at the cutoff of its last trim that removed a run, 7 days before that write,
		// which the insights page hatches as no data before it; mini1 and mini2 keep their month in the shared files.
		// Written as time wrote them: the two minis' runs first, then build3's.
		const write = W.runHistory.makeRecordWriter({ logsDir: paths.logs });
		// Each write trims as of the moment the record was written (its end), as a worker's mirror does, not as of the
		// render's instant.
		let writing = NOW;
		const mirrors = Object.fromEntries(Object.keys(HOSTS).map((h) => [h, W.runMirror.makeRunMirror({ redis, retentionDays: h === "build3" ? BUILD3_RETENTION_DAYS : 30, now: () => writing })]));
		for (const r of [...records.filter((x) => x.host !== "build3"), ...records.filter((x) => x.host === "build3")]) {
			if (r.host !== "build3") write(r);
			writing = Date.parse(r.endedAt);
			if (!(await mirrors[r.host].mirror(r, W.runHistory.sanitizeJobId(r.jobId)))) throw new Error(`the mirror refused ${r.jobId}`);
		}
		writing = NOW;

		// The registry: one beat per host through the worker's writer, at that host's own last-beat instant.
		for (const row of hostRows({ liveJobsOf: W.liveJobs.liveJobsOf, liveJobsFields: W.liveJobs.liveJobsFields, version: mods.version })) {
			const reg = W.hostRegistry.makeHostRegistry({ redis, name: row.name, now: () => row.beatAt });
			// One beat, and an interval that never fires during a render (it is unref'd, so it holds nothing open).
			await reg.start(row.fields, { intervalMs: 2 ** 31 - 1 });
		}

		// The counters, from the records, through the budget's own key builders. The running jobs hold their slots and
		// their per-job dollar caps.
		const now = new Date(NOW);
		const dayStart = Date.UTC(2026, 9, 8);
		const weekStart = Date.UTC(2026, 9, 5);
		const monthStart = Date.UTC(2026, 9, 1);
		const running = Object.values(RUNNING).flat();
		const since = (r, from) => Date.parse(r.startedAt) >= from;
		const slots = (from) => records.filter((r) => r.budgetReserved && since(r, from)).length + running.length;
		await redis.set(W.budget.dayKey(now), slots(dayStart));
		await redis.set(W.budget.weekKey(now), slots(weekStart));
		await redis.set(W.budget.monthKey(now), slots(monthStart));
		await redis.set(W.budget.tokenDayKey(now), records.filter((r) => since(r, dayStart)).reduce((s, r) => s + (r.tokens?.total ?? 0), 0));
		const web = (r) => r.kind === "github" && r.target?.startsWith("acme/web#");
		const webScope = W.scopedLimits.scopeKeyPrefix("github:acme/web");
		await redis.set(W.budget.dayKey(now, webScope), records.filter((r) => web(r) && r.budgetReserved && since(r, dayStart)).length + 1);
		await redis.set(W.budget.weekKey(now, webScope), records.filter((r) => web(r) && r.budgetReserved && since(r, weekStart)).length + 1);
		const settled = (pred, from) => records.filter((r) => pred(r) && r.dollars && since(r, from)).reduce((s, r) => s + r.dollars.settledMicros, 0);
		const held = (pred) => running.filter(pred).length * 2 * M;
		const settings = RM.readSettingsView({ settingsFile: paths.settings });
		const limits = RM.readScopedLimits({ scopedLimitsPath: paths.limits }).limits;
		const { caps } = DW.deploymentDollarCaps(settings.overlay, {});
		for (const spec of DW.dollarWindowSpecs({ caps, limits, now })) {
			const from = spec.window === "day" ? dayStart : spec.window === "week" ? weekStart : monthStart;
			let pred = () => true;
			let livePred = () => true;
			if (spec.ledger === "scope" && spec.name === "project:web") {
				pred = (r) => r.project === "web";
				livePred = (e) => e.project === "web";
			}
			if (spec.ledger === "model") pred = (r) => r.model === "claude-sonnet-4-5";
			await redis.set(spec.key, settled(pred, from) + held(livePred));
		}
		// The envelope's own counters (each project's week), the same rule.
		const spend = await RM.readAllocations({ url, envelope: read.envelope, projects: read.projects, now });
		for (const [id, v] of Object.entries(spend.spend.projects)) {
			const mine = (p) => (id === "_other" ? p === null || p === undefined : p === id);
			await redis.set(v.key, settled((r) => mine(r.project), weekStart) + held((e) => mine(e.project)));
		}

		// The job held on run.waitFor, as the wait gate writes it.
		const wait = W.waitState.makeWaitState({ redis, now: () => NOW - (2 * 3600 + 14 * 60) * 1000 });
		await wait.hold("gh-77c1", { dedupId: "github:acme/web#415", target: "acme/web#415", label: "after 2026-10-09T07:00Z + ci-green", untilMs: Date.UTC(2026, 9, 9, 7) });

		// The cron schedulers, through BullMQ itself (their next fires are the queue's delayed jobs).
		const q = W.queue.makeQueue(W.connection.parseConnection(url));
		try {
			await q.upsertJobScheduler("nightly-tidy", { pattern: "0 3 * * *" }, { name: "nightly-tidy", data: {} });
			await q.upsertJobScheduler("pm-weekly", { pattern: "0 6 * * 1" }, { name: "pm-weekly", data: {} });
		} finally {
			await q.close();
		}
		return { records };
	} finally {
		redis.disconnect();
	}
}
