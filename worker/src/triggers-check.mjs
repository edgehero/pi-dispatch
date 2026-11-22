/**
 * Judge a triggers file the way the services that load it would, before it is swapped in (issue #970).
 *
 * The file has four readers, and each refuses to START on a file it cannot take (exit 2, which a supervisor does not
 * restart), while one that is already running keeps the last copy that loaded: the worker (`loadSchedules`, only where
 * `PI_TRIGGERS_FILE` is set, since unset means it schedules no cron and reads no file), the receiver (`serve`), the
 * poller (`poll`) and the watch collector (`watch`, which loads the file with `serve`'s loader, less what only a
 * listener reads, and has nothing to do without a pull source). The edit that took polling down in #970 was an invalid file
 * meeting a restart: the worker had kept its old schedules, so the deployment looked healthy while no forge event
 * reached it. A check run before the swap is the one place that refusal can be seen while nothing is down yet.
 *
 * ONE JUDGEMENT PER READER, BY THE READERS' OWN CODE wherever the worker package has it: a copy is the drift this file
 * would otherwise exist to catch. The few receiver rules it cannot import (which files make `serve` serve GitHub, that
 * `serve` alone judges a watch source's secret and WEBHOOK_SECRET, the collector's pull-source test) are copies, held
 * to the real loaders by the parity table in its tests. In order:
 *
 *  1. `parseTriggersDocument`, the shared validator every loader runs first. A refusal here is every reader's, and
 *     nothing below can be judged on a file that does not parse.
 *  2. The worker's boot, where `PI_TRIGGERS_FILE` is set. `loadSchedules` under `triggerLoaderConfig` (a trigger's
 *     `run.maxCostUsd` above `PI_MAX_COST_USD`, a cron folder or skills directory this host should have and does not);
 *     each served schedule's pattern through BullMQ's own `defaultRepeatStrategy`, which the boot reconcile's
 *     `upsertJobScheduler` calls and whose throw the boot turns into a refusal (the loader only counts the fields, so
 *     `0 99 * * *` loads and then stops the worker); and the job paths the file names (`envelopeJobPaths`, with the run
 *     roots and the overlay of `triggerJobPathConfig`) against the deployment's private endpoint folders
 *     (`privateFoldersInsideJobPaths`) and, where `PI_ENVELOPE_FILE` is set, the envelope (`envelopeInsideJobPaths`),
 *     the two containment refusals at the worker's start. A cron trigger left to another host is a note, never a
 *     refusal: that is a fleet working as declared.
 *  3. The receiver's loader. `watchSecretsMissing`, its own predicate, on presence only: a watch source whose signing
 *     secret is unset or blank refuses the receiver alone, which verifies the source's pushes with it: the loader judges
 *     it for `command: "serve"` and not for the poller and the collector, which read no push (issues #994, #1006). Then `serve`'s own secret, the receiver's alone for the same reason: with `GITHUB_INGEST` and
 *     `GITHUB_AUTH_SOURCE` unset the FILE decides whether `serve` serves GitHub (`githubServedByServe`, asked with the
 *     receiver's own test of the file, a GitHub-sourced forge rule), so adding the first GitHub rule to a deployment
 *     with no `WEBHOOK_SECRET` stops `serve` at its next start, and is this file's refusal; where the deployment alone
 *     says GitHub, the same refusal is named as the deployment's.
 *
 * worker/test/triggers-check.test.mjs holds step 3 to the real `loadReceiverConfig`, `loadPollerConfig` and
 * `startWatchPuller`, and each config read here to `loadConfig`'s.
 *
 * NOT JUDGED HERE, on purpose: what the environment alone decides beyond the two refusals above (the forge webhook
 * blocks and `RECEIVER_PORT`, which only `serve` reads, issue #1006; `POLL_REPOS`, `GITHUB_INGEST=webhook` against a poller, the other boot files' own contents, Valkey), and what needs a
 * live fleet (the cron fingerprint the boot reconcile compares with its peers). Those are doctor's and the services'.
 * Neither is whether each service runs on this host: the answer is for every reader that would load this file here. A
 * private endpoint folder the worker's boot cannot judge either (a path it cannot read) is a note naming it, since the
 * boot logs that and starts.
 *
 * No write, no Valkey. The filesystem is read only where the worker's boot reads it (a cron folder, a skills directory,
 * the deployment's private endpoint folders, the envelope's place). A secret's VALUE never leaves `env`: every refusal
 * and note names variables, and the CLI passes marks instead of values.
 */
import { existsSync as fsExistsSync } from "node:fs";
import { defaultRepeatStrategy } from "./queue.mjs";
import { TRIGGER_JOB_PATH_ENV_KEYS, TRIGGER_LOADER_ENV_KEYS, githubIngestFrom, githubServedByServe, triggerJobPathConfig, triggerLoaderConfig } from "./config.mjs";
import { envelopeInsideJobPathSentence, envelopeInsideJobPaths } from "./envelope.mjs";
import { privateFolderInsideJobPathSentence, privateFoldersInsideJobPaths } from "./private-endpoints.mjs";
import { envelopeJobPaths, loadSchedules } from "./schedules.mjs";
import { DISARMED_TYPE, parseTriggersDocument, sourceForgeOf } from "./triggers.mjs";
import { watchSecretsMissing } from "./watch-contract.mjs";

/** The readers, in the order every sentence names them. */
export const TRIGGERS_READERS = Object.freeze(["worker", "receiver", "poller", "watch collector"]);

/**
 * Every environment key `checkTriggersText` reads besides the watch sources' own secret variables and `WEBHOOK_SECRET`
 * (each read for its presence): the CLI resolves exactly these from the deployment, and a test probes the check's reads
 * against this list, so no key can be judged from the shell alone.
 */
export const TRIGGERS_CHECK_ENV_KEYS = Object.freeze([...TRIGGER_LOADER_ENV_KEYS, ...TRIGGER_JOB_PATH_ENV_KEYS, "GITHUB_INGEST", "GITHUB_AUTH_SOURCE"]);

/**
 * The variables `checkTriggersText` reads for their PRESENCE in judging `text` under `env` (its `TRIGGERS_CHECK_ENV_KEYS`
 * resolved): each watch source's secret, and `WEBHOOK_SECRET` where `serve` would serve GitHub on this file. The CLI
 * resolves exactly these from the deployment, as marks; none when the file does not parse.
 */
export function triggersCheckSecrets(text, path, env) {
	let document;
	try {
		document = parseTriggersDocument(text, path);
	} catch {
		return [];
	}
	const names = new Set(Object.values(document.watchSources ?? {}).map((source) => source.secretEnv));
	try {
		if (githubServedByServe(env, hasGithubRule(document))) names.add("WEBHOOK_SECRET");
	} catch {
		// A GITHUB_INGEST no reader takes: the check refuses on it before it asks for the secret.
	}
	return [...names];
}

/**
 * The receiver's own test of the file (receiver/src/config.mjs, `hasGithubRules` over `groupTriggers`): every entry its
 * grouping puts under github, which is every entry whose `sourceForgeOf` is github (a webhook rule of kind github, or a
 * local listener on a GitHub event). Cron, watch and a spent one-shot have none.
 */
function hasGithubRule(document) {
	return document.triggers.some((t) => sourceForgeOf(t) === "github");
}

/** The wording a refusal gets when this deployment's settings cause it whatever the file holds. */
const DEPLOYMENT = "a setting of this deployment, whatever the file says";

/**
 * `{ ok, counts, readers, refusals, notes }` for a candidate triggers file's `text`, judged as if it stood at `path`
 * (messages name `path`; it is never read). `env` is the deployment's (`TRIGGERS_CHECK_ENV_KEYS`, and each secret's
 * presence). `cwd` is the deployment folder, which holds the private endpoint folders the worker protects. `now` is the
 * instant a pattern's next run is computed from. `currentCollects` says the deployment's current file has a pull
 * source, so a watch collector runs on it here: on a candidate that does not parse it is named among the readers, and
 * on one with no pull source left it is told it will not start.
 *
 *  - `counts`: `{ triggers, cron, forge, watch }`, every entry and the three kinds (a spent one-shot is in `triggers`
 *    only); null when the file does not parse.
 *  - `readers`: who would load it here, the worker only where `PI_TRIGGERS_FILE` is set and the watch collector only
 *    where a pull source is known (in this file, or, when it does not parse, in the current one).
 *  - `refusals`: `[{ readers, reason }]`, each naming the readers that refuse and the loader's own reason.
 *  - `notes`: what is true and refuses nothing, and what could not be judged.
 *  - `ok`: no refusal.
 */
export function checkTriggersText(text, path, { env = process.env, existsSync = fsExistsSync, cwd = process.cwd(), now = Date.now, currentCollects = false } = {}) {
	const workerReads = env.PI_TRIGGERS_FILE !== undefined;
	const notes = [];
	let document;
	try {
		document = parseTriggersDocument(text, path);
	} catch (error) {
		const readers = TRIGGERS_READERS.filter((r) => (r === "worker" ? workerReads : r === "watch collector" ? currentCollects : true));
		return { ok: false, counts: null, readers, refusals: [{ readers, reason: error?.message ?? String(error) }], notes };
	}
	const counts = { triggers: document.triggers.length, cron: 0, forge: 0, watch: 0 };
	for (const { on } of document.triggers) {
		if (on.type === "cron") counts.cron++;
		else if (on.type === "watch") counts.watch++;
		else if (on.type !== DISARMED_TYPE) counts.forge++;
	}
	const sources = document.watchSources ?? {};
	// startWatchPuller's own test: without a pull source it refuses to start whatever else the file holds.
	const collects = Object.values(sources).some((source) => source.pull);
	if (currentCollects && !collects) notes.push(`the watch collector here refuses to start on it (exit 2, "watch: no pull sources configured"): the current file has a pull source and this one has none; one already running goes on and collects nothing. Stop it if that is what you meant`);
	const readers = TRIGGERS_READERS.filter((r) => (r === "worker" ? workerReads : r === "watch collector" ? collects : true));
	const refusals = [];

	if (workerReads) {
		const worker = (reason) => refusals.push({ readers: ["worker"], reason });
		let config = null;
		try {
			config = { ...triggerLoaderConfig(env), ...triggerJobPathConfig(env, { fileExists: existsSync }) };
		} catch (error) {
			worker(`${error?.message ?? error} (${DEPLOYMENT})`);
		}
		if (config !== null) {
			// The text in hand stands at `path`: its own existence is never the question, and the one file both loaders below
			// read is it (`config.triggersFile`).
			const io = { readFileSync: () => text, existsSync: (p) => p === path || existsSync(p) };
			let schedules = null;
			try {
				schedules = loadSchedules({ ...config, triggersFile: path }, { ...io, fleet: config.workerNameDeclared });
			} catch (error) {
				worker(error?.message ?? String(error));
			}
			for (const { schedulerId, unserved, pattern } of schedules ?? []) {
				if (unserved === "worker-mismatch") notes.push(`cron trigger "${schedulerId}" names another worker in run.worker, so the worker here does not schedule it`);
				else if (unserved) notes.push(`cron trigger "${schedulerId}" is not scheduled here: its folder is not on this machine, which a named worker (PI_WORKER_NAME) takes as another host's`);
				else {
					// The boot reconcile hands `{ pattern }` and nothing else to `upsertJobScheduler` (cron.mjs, `reconcile`), which
					// asks this strategy for the next run: a throw is the boot's refusal. No answer is a silent no-op, not a refusal:
					// BullMQ writes nothing and reports success, so a scheduler already resident under this id keeps its old pattern
					// (measured on bullmq 5.80.4: reconcile says installed 1, the resident pattern unchanged) and a new one is never
					// made. A note, since the worker starts either way.
					let next;
					try {
						next = defaultRepeatStrategy(now(), { pattern });
					} catch (error) {
						worker(`cron trigger "${schedulerId}": BullMQ refuses its pattern ${JSON.stringify(pattern)} (${error?.message ?? error}), so the worker's boot reconcile refuses to start`);
						continue;
					}
					if (typeof next !== "number") notes.push(`cron trigger "${schedulerId}": its pattern ${JSON.stringify(pattern)} has no next run, which BullMQ takes without a word: where a schedule with this id already exists the worker leaves it on its old pattern, and where none exists nothing is installed and the trigger never fires`);
				}
			}
			if (schedules !== null) judgeJobPaths({ config, path, io, cwd, worker, notes });
		}
	} else if (counts.cron > 0) {
		notes.push(`the worker here reads no triggers file (PI_TRIGGERS_FILE is unset), so ${counts.cron === 1 ? "its cron trigger is not" : `none of its ${counts.cron} cron triggers is`} scheduled on this host`);
	}

	// The receiver's alone (issue #994): the poller and the watch collector load the file without the rule.
	for (const missing of watchSecretsMissing(sources, env)) refusals.push({ readers: ["receiver"], reason: `watch source "${missing.source}" needs its signing secret ${missing.secretEnv}, which is unset or blank here` });
	judgeServeSecret({ document, env, collects, refusals });
	return { ok: refusals.length === 0, counts, readers, refusals, notes };
}

/**
 * The worker boot's two containment refusals against the job paths this file names, each as the boot takes them.
 *
 *  - The envelope (start.mjs, `loadEnvelopeChecked`): a job path that holds it refuses the start, and so does every throw
 *    of `envelopeInsideJobPaths` (a job path it cannot read, an envelope path that is not canonical, a relative run root
 *    beside an envelope), which the boot lets through as its configError. A throw is the file's when the deployment's
 *    own job paths alone (the run roots and the overlay) do not throw: then a path this file names caused it.
 *  - The private endpoint folders (`privateFoldersInsideJobPaths`): one a job path holds refuses the start, while a path
 *    the rule cannot read is logged and the boot goes on, so that alone is a note.
 *
 * A job path that is a run root or the overlay is the deployment's, whatever the file holds, and is said so.
 */
function judgeJobPaths({ config, path, io, cwd, worker, notes }) {
	const jobPaths = envelopeJobPaths({ ...config, triggersFile: path }, io);
	const whose = (kind) => (kind === "run-root" || kind === "global-pi-dir" ? ` (${DEPLOYMENT})` : "");
	if (config.envelopeFile !== null) {
		// PWD left out: it only matters for a relative path, which the envelope's own rule refuses.
		const inside = (paths) => envelopeInsideJobPaths(config.envelopeFile, paths, { cwd, env: {} });
		try {
			const found = inside(jobPaths);
			if (found) worker(`${envelopeInsideJobPathSentence(config.envelopeFile, found)}${whose(found.kind)}`);
		} catch (error) {
			let deployment = false;
			try {
				inside({ ...jobPaths, cronFolders: [], skillsDirs: [] });
			} catch {
				deployment = true;
			}
			worker(`${error?.message ?? error}${deployment ? ` (${DEPLOYMENT})` : ""}`);
		}
	}
	try {
		const exposed = privateFoldersInsideJobPaths(cwd, jobPaths);
		if (exposed) worker(`${privateFolderInsideJobPathSentence(exposed)}${whose(exposed.kind)}`);
	} catch (error) {
		notes.push(`whether a job path holds the private endpoint folders (egress-private/, egress-grants/) was not judged (${error?.code ?? error?.message ?? error}): the worker starts and logs it, and pi-dispatch doctor names the path`);
	}
}

/**
 * `serve`'s `WEBHOOK_SECRET`, where it serves GitHub (receiver/src/config.mjs, `loadReceiverConfig`): the receiver alone
 * refuses to start without it, since the poller and the collector load as commands that do not listen and never read it
 * (issue #1006: the poller refused a secret of spaces, and the collector any missing one). Whether `serve` serves GitHub
 * is `githubServedByServe`, asked with the receiver's own test of the file (`hasGithubRule`). A `GITHUB_INGEST` none of
 * them takes refuses all three receiver commands (each reads it), and is said as the deployment's.
 */
function judgeServeSecret({ document, env, collects, refusals }) {
	const receivers = ["receiver"];
	let servedByFile;
	let servedAlone;
	try {
		servedByFile = githubServedByServe(env, hasGithubRule(document));
		servedAlone = githubServedByServe(env, false);
	} catch (error) {
		refusals.push({ readers: ["receiver", "poller", ...(collects ? ["watch collector"] : [])], reason: `${error?.message ?? error} (${DEPLOYMENT})` });
		return;
	}
	const secret = env.WEBHOOK_SECRET;
	if (!servedByFile || (typeof secret === "string" && secret.trim() !== "")) return;
	if (servedAlone) {
		const why = githubIngestFrom(env) !== null ? `GITHUB_INGEST=${env.GITHUB_INGEST}` : "GITHUB_AUTH_SOURCE is set";
		refusals.push({ readers: receivers, reason: `serve serves GitHub here (${why}) and WEBHOOK_SECRET is unset or blank, so it refuses to start (${DEPLOYMENT})` });
	} else {
		refusals.push({ readers: receivers, reason: "this file holds a GitHub rule, and with GITHUB_INGEST and GITHUB_AUTH_SOURCE unset that makes serve serve GitHub, which needs WEBHOOK_SECRET, unset or blank here: set it, or set GITHUB_INGEST=poll where the poller brings GitHub's events" });
	}
}
