import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir, networkInterfaces, release as osRelease, userInfo } from "node:os";
import { dirname, basename, join } from "node:path";
import { configError, ensureJobsDir, ensureSandboxDir, ensureUnderAccountRoot, loadConfig } from "./config.mjs";
import { passwdNameFrom, probeTcpAddress, readSubuidRanges, resolveWorkerValkey } from "./podman-stack.mjs";
import { valkeyClientContext } from "./valkey-endpoint.mjs";
import { authRefusalFor, makeRedisClient, onValkeyError, parseConnection, valkeyAuthState, valkeyPasswordFor } from "./connection.mjs";
import { reconcileGated, reloadSchedules } from "./cron.mjs";
import { makeGitHubAuth } from "./get-token.mjs";
import { InfraRetry, NETNS_KEEPER_CRASH_LOOP, NETNS_KEEPER_NOT_HOLDING } from "./processor.mjs";
import { transientError } from "./transient.mjs";
import { makeGitHubHost } from "./github-host.mjs";
import { githubFailureFields } from "./octokit-log.mjs";
import { makeGitLabAuth } from "./gitlab-auth.mjs";
import { makeGitLabHost } from "./gitlab-host.mjs";
import { makeForgejoAuth } from "./forgejo-auth.mjs";
import { makeForgejoHost } from "./forgejo-host.mjs";
import { makeAzureAuth } from "./azure-auth.mjs";
import { makeAzureHost } from "./azure-host.mjs";
import { makeEgressPreflight } from "./egress.mjs";
import { checkSlotKey, endpointSlotKey, hash16, makeClaimSweeper, makeFleetLease, makeScopeClaimSweeper, scopeSlotKey } from "./fleet-lease.mjs";
import { MAX_SLOTS, loadModelEndpoints, modelEndpointsPath, readOverlayModels } from "./model-endpoints.mjs";
import { builtinModel, checkModelsKnown } from "./model-catalog.mjs";
import { capabilityTokens, serializeCaps } from "./capabilities.mjs";
import { cronFingerprint } from "./fingerprint.mjs";
import { makeHostRegistry } from "./host-registry.mjs";
import { budgetField, readUserServiceLimits } from "./host-budget.mjs";
import { makeCpuReserve, reservePlan } from "./cpu-reserve.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { createWorker, JOB_TIMEOUT_MS, STALLED_FAILED_REASON } from "./index.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, DAEMON_FACTS_TIMEOUT_MS, jobUserRefusal, makeDaemonFactsReader, makeJobUserResolver, relabelsPrivateMounts, resolveImageUser } from "./job-user.mjs";
import { unenforcedSizeFlags } from "./job-size.mjs";
import { makeCollectChain } from "./outbox.mjs";
import { makeCollectPlan } from "./outbox-plan.mjs";
import { makePortfolioSnapshot } from "./portfolio-snapshot.mjs";
import { containerPackagePaths, readStageManifest } from "./packages.mjs";
import { makeCleanup, makeForgePreparers, makePrepareWorkspace } from "./prepare.mjs";
import { listRunningSandboxes, makeSandboxNetworkSweeper, makeSandboxRuntimeWatch } from "./sandbox.mjs";
import { makeRetentionSweep } from "./retention-sweep.mjs";
import { makeSandboxReaper } from "./sandbox-store.mjs";
import { makeSessionStore } from "./session-store.mjs";
import { scrubCredentials } from "./redact.mjs";
import { makeCheckOnceSpent, makeCheckPortfolioFlag, makeCheckWaitSkew, makeDisarmOnce } from "./triggers-file.mjs";
import { WATCH_DEBOUNCE_MS, changedWhileArming, makeWatchCloser, readBeforeArming } from "./watch-closer.mjs";
import { loadPauseWindows, pauseUntilMs } from "./pause-windows.mjs";
import { checkProjectRows, danglingProjectRows, dollarRowsWithoutCap, loadScopedLimits, SCOPED_LIMITS_VERSION, scopeClaimRows } from "./scoped-limits.mjs";
import { escapeControls, loadProjects, projectOf, projectsFingerprint } from "./projects.mjs";
import { envelopeDigest, envelopeInsideJobPaths, loadEnvelopeChecked } from "./envelope.mjs";
import { NO_ENVELOPE_FINGERPRINT, makeAllocationAudit, makeAllocationLogReaper, makeAllocationState } from "./allocation.mjs";
import { optionalUsdMicros } from "./money.mjs";
import { makeOnFailure } from "./on-failure.mjs";
import { makeWaitChecker } from "./wait-check.mjs";
import { makeWaitState } from "./wait-state.mjs";
import { hostQueueName, makeQueue } from "./queue.mjs";
import { endpointShown, execDockerBounded, makeContainerGone, makeDockerEndpointResolver, makeJobContainerLister, makeLocalBackend, makeReaper, makeStopContainer, quotedShown } from "./backend-local.mjs";
import { NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_YOUNG_MARGIN_MS, runtimeFromFacts } from "./netns-keeper.mjs";
import { makeBackendRegistry, reapAll, resolveBackendName } from "./backend-registry.mjs";
import { DEFAULT_BACKEND, DOCKER_ENDPOINT_LOCAL, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_SERVICE_LOCAL, backendFor, isPerMachineHost, observationRefusalIsTransient, observationRefusals, unobservedFloor } from "./backends.mjs";
import { PODMAN_BOOT_REFUSING_CAUSES, PODMAN_INFO_TIMEOUT_MS, cachedPodmanInfo, decidePodmanJobUser, makePodmanBackend, makePodmanInfoReader, makePodmanReaper, observePodman, podmanConfRefusal, unavailableFor, podmanConfWidening, podmanJobUserRefusal, resolvePodmanImageUser } from "./backend-podman.mjs";
import { PODMAN_RESTART_HOLD_EXPIRED, makePodmanServiceReader, onceFs, makeRootfulMemory, observeHost, observeRootfulConf, readRootfulService, rootfulConfRefusal, rootfulConfRetries, rootfulUnreadList, runtimeObservationKey } from "./runtime-observations.mjs";

import { makeRunContainer } from "./run-container.mjs";
import { resolveProviderCredential } from "./env-allowlist.mjs";
import { makeSecretsResolver } from "./secrets.mjs";
import { buildRecord, EXIT_OOM_KILLED, makeFindPreviousRun, makeLogReaper, makeLogSink, makeReadRecord, makeRecordWriter, makeSettledRecord, RUNNER_POLICY_REASONS, sanitizeJobId } from "./run-history.mjs";
import { makeRunMirror, readMirroredRecord } from "./run-mirror.mjs";
import { readOverlay, resolveSettings } from "./runtime-settings.mjs";
import { usdFingerprint } from "./dollar-fingerprint.mjs";
import { authoredCron, envelopeJobPaths, loadSchedules, servedSchedules } from "./schedules.mjs";
import { makeStallGuard } from "./scheduler-stall-guard.mjs";


/** How long boot will wait for `docker image inspect` before shipping without a digest. */
const BOOT_IMAGE_TIMEOUT_MS = 5_000;

/**
 * How long boot waits for the daemon facts read (issues #341 and #345): the image read's 5 s, unless the floor asks for a
 * word only a DAEMON observation earns (`isolation`, `mountSet`), when it waits the facts read's own bound plus 2 s. A
 * busy host's `docker info` is the slow read, and a floor this boot met from the table before must not exit 1 on every
 * restart of a healthy daemon. Exported for its test.
 */
export function bootFactsBoundMs({ backends, backendFloor }) {
	const needsDaemon = unobservedFloor(backends, backendFloor, { [DOCKER_ENDPOINT_LOCAL]: true }).length > 0;
	return needsDaemon ? DAEMON_FACTS_TIMEOUT_MS + 2_000 : BOOT_IMAGE_TIMEOUT_MS;
}

/**
 * How long after a failed forge-auth re-resolve before another job is allowed to try again (issue #316).
 *
 * The in-flight promise dedupes concurrent callers; this bounds sequential ones. Thirty seconds is short
 * enough that a forge coming back is picked up within one job of it, and long enough that a worker
 * draining a thousand-job backlog against a forge that is still down opens tens of identity calls rather
 * than a thousand -- each of which can otherwise sit on undici's 300-second header timeout with the queue
 * waiting behind it.
 */
const AUTH_RETRY_COOLDOWN_MS = 30_000;

/**
 * How long a job will wait for a forge-auth re-resolve before giving up on it.
 *
 * This is the bound that keeps the re-resolve off the critical path, and without it the feature is a
 * wedge rather than a repair. `mintToken` is awaited inside `runJob`, none of the four identity
 * resolvers passes an `AbortSignal`, and undici's default `headersTimeout` is FIVE MINUTES -- so a forge
 * that accepts the connection and then answers nothing (a load balancer draining, a firewall that drops
 * rather than rejects) would hold every job for that long, with BullMQ renewing the lock the whole time
 * so nothing ever stalls out. At `PI_CONCURRENCY=1` that is the queue stopped, with no error line.
 *
 * Ten seconds is far longer than a healthy `GET /user` and far shorter than anything an operator would
 * call a hang. Losing the race does not cancel the underlying call: it is left to settle into the
 * cooldown, so the next job still benefits from whatever it eventually learns.
 */
const AUTH_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * How long a fleet-wide scope claim lives. `JOB_TIMEOUT_MS` plus slack: a container cannot outlive that
 * ceiling, so the claim cannot expire underneath a live job -- which is what makes a refresh unnecessary
 * rather than merely unimplemented. DERIVED from that constant rather than written as a number, so the
 * coupling maintains itself if the timeout ever moves.
 */
const SCOPE_CLAIM_TTL_MS = JOB_TIMEOUT_MS + 5 * 60 * 1000;

/**
 * This worker's own package version, for the registry row (issue #57): a rolling upgrade should be
 * visible as a fact about the fleet rather than as a diff someone has to run. Read once, and never
 * fatal -- an unreadable manifest costs a blank field, not a boot. npm always ships `package.json`
 * whatever `files` says, so this resolves from an installed package as well as from a checkout.
 */
const WORKER_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "";
	} catch {
		return "";
	}
})();

// `makeWatchCloser` lives in its own module since issue #301 (the receiver's triggers watch registers
// the same handle); re-exported here so every existing importer keeps its address.
export { makeWatchCloser } from "./watch-closer.mjs";

/**
 * Race a read against a fuse, and CLEAN THE FUSE UP whichever side wins (issue #300). The fuse is
 * unref'd, deliberately: it exists so a wedged docker daemon cannot hold boot, and it must never itself
 * hold the process. But unref'd is not cleaned up (#295's lesson, both halves): when the read won, the
 * old inline race left its five-second timer armed for the full term. The LOSING read stays pending --
 * a wedged `docker inspect` has no cancel -- which is the read-is-a-nicety posture the call site
 * documents, unchanged here.
 *
 * NOT FOR BARE CONTEXTS, and the boundary is the fuse's own unref: awaited when nothing else holds the
 * event loop, the fuse never fires and node exits mid-await (measured, exit 13). In this boot the shared
 * redis client and the workers hold the loop, so the fallback always arrives; a caller with an empty
 * loop needs a ref'd timer and a different trade.
 *
 * EXPORTED for the reason `makeWatchCloser` is: the cleared-fuse property is not observable through a
 * full boot without racing every other timer the boot arms, and a guarantee the shutdown story rests on
 * deserves a deterministic pin rather than a census.
 */
export async function settleWithin(promise, ms, fallback) {
	let timer = null;
	try {
		return await Promise.race([
			promise,
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(fallback), ms);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Watch the DIRECTORY holding the triggers file (robust to the admin's atomic tmp+rename, which swaps the
 * inode a file-watch would lose), debounce, and re-reconcile the cron schedulers on change via
 * `reloadSchedules`. Best-effort: a platform without `fs.watch` logs and the worker keeps its boot-time
 * schedulers. The FSWatcher is unref'd (the debounce it arms is NOT), and the returned closer is what
 * `startWorker` registers so the watch dies with the worker that armed it (issue #295).
 */
function watchTriggersFile(config, queue, log, ref, registry, tz, fleet, atBoot, afterReload = () => {}) {
	const path = config.triggersFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	const closer = makeWatchCloser(handles, log);
	const readFile = () => readFileSync(path, "utf8");
	// The baseline is what the BOOT LOAD read, handed in: the reconcile above and everything between it and
	// this arm -- the endpoint probe, forge auth, the reaper, Valkey -- is the window an edit is lost in
	// (issue #386). A baseline taken here would measure the arming instead.
	readBeforeArming(handles, readFile, atBoot);
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return; // see makeWatchCloser: by construction, not by a delivery rule
			if (changed && changed !== file) return; // only our file (a null name -> reload to be safe)
			clearTimeout(handles.timer);
			// Issue #504 part B: a cron folder or a skills dir an edit adds is a new job path, so the envelope's place is
			// judged again after every triggers reload.
			handles.timer = setTimeout(() => void reloadSchedules(config, queue, { log: closer.reloadLog, ref, registry, tz, fleet }).then(() => afterReload(closer.reloadLog)), WATCH_DEBOUNCE_MS);
		});
		handles.watcher.unref?.();
		log("triggers_watching", { path });
	} catch (err) {
		log("triggers_watch_unavailable", { reason: err?.message });
	}
	// ONLY WHEN THE BYTES MOVED, because this one costs a Valkey round trip and a reconcile: a quiet boot
	// must not pay for the race it did not lose, and must not log a second `schedules` line saying nothing
	// changed.
	if (changedWhileArming(handles, readFile)) {
		log("triggers_reread_after_arming", { path });
		void reloadSchedules(config, queue, { log: closer.reloadLog, ref, registry, tz, fleet }).then(() => afterReload(closer.reloadLog));
	}
	return closer;
}

/**
 * Watch the DIRECTORY holding the pause-windows file (same atomic-rename robustness as the triggers watch)
 * and hot-swap the in-memory windows in `ref.current` on change. A bad edit keeps the last-good windows in
 * effect (OQ-008 live-edit safety) — the pause gate never loses its config to a typo. Best-effort; the
 * FSWatcher is unref'd and the returned closer stops the watch with the worker (issue #295).
 */
function watchPauseWindowsFile(config, ref, log, atBoot) {
	const path = config.pauseWindowsFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	const closer = makeWatchCloser(handles, log);
	const reload = () => {
		try {
			ref.current = loadPauseWindows(config);
			closer.reloadLog("pause_windows_reloaded", { count: ref.current.length });
		} catch (err) {
			closer.reloadLog("pause_windows_reload_invalid", { reason: err?.message });
		}
	};
	const readFile = () => readFileSync(path, "utf8");
	readBeforeArming(handles, readFile, atBoot); // the BOOT LOAD's own bytes; see watch-closer (issue #386)
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return; // see makeWatchCloser: by construction, not by a delivery rule
			if (changed && changed !== file) return;
			clearTimeout(handles.timer);
			handles.timer = setTimeout(reload, WATCH_DEBOUNCE_MS);
		});
		handles.watcher.unref?.();
		log("pause_windows_watching", { path });
	} catch (err) {
		log("pause_windows_watch_unavailable", { reason: err?.message });
	}
	// SAID, like the triggers watch says it: without a line of its own an operator cannot tell a boot-race
	// reload from an ordinary one, and this is the only reload that happens with nobody editing.
	if (changedWhileArming(handles, readFile)) {
		log("pause_windows_reread_after_arming", { path });
		reload();
	}
	return closer;
}

/**
 * The scoped-limits reload, EXPORTED apart from its watcher so keep-last-good is unit-testable without
 * fs.watch (its two watcher siblings above bind theirs inline; this one is money config, so the
 * last-good property carries its own test). A bad edit keeps `ref.current` untouched and logs
 * `scoped_limits_reload_invalid` -- the pause-windows posture, INT-SCOPED-LIMITS-FILE-CONTRACT.
 */
export function reloadScopedLimits(config, ref, log, deploymentCap = null, pair = null) {
	try {
		const next = loadScopedLimits(config);
		// Issue #499 part B: the new limits are checked against projects.json (`pair`, null only on a bare test wiring);
		// a row naming a missing project keeps the last good limits, the boot rule held live.
		const other = pair ? pairWith(config, next, pair, "limits") : null;
		ref.current = next;
		log("scoped_limits_reloaded", { count: ref.current.length });
		if (deploymentCap) warnDollarRowsWithoutCap(ref.current, deploymentCap(), log);
		if (other) {
			pair.projects.current = other;
			log("projects_reloaded", { count: other.length, with: "scoped-limits" });
		}
	} catch (err) {
		log("scoped_limits_reload_invalid", { reason: err?.message });
		return;
	}
	// Issue #504 part B: the envelope's floors are judged against both files, so a committed edit re-judges it.
	pair?.afterCommit?.();
}

/**
 * The two files a project row joins (issue #499 part B): scoped-limits.json names `project:<id>`, projects.json defines
 * the id. `{ limits, projects }` are the two live refs, and `deploymentCap` the merged per-job cap thunk the
 * dollar-rows-without-cap warning reads (null on a bare wiring). A reload of either file is judged as a PAIR (`pairWith`), so the
 * two live lists never disagree and a correct pair applies whatever order its files were saved in.
 */
export function makeProjectPair(limits, projects, deploymentCap = null) {
	return { limits, projects, deploymentCap };
}

/**
 * Judge one side's new list (`next`, already loaded) against the other side, statelessly (issue #499 part B):
 *   1. against the other file AS IT IS ON DISK: when that loads and the two agree, both are taken together, and the
 *      other side's list is returned for the caller to commit too (only when it differs from the live one). This is
 *      what makes a rename (`shop` to `store` in both files) or a project added with its row apply in EITHER save
 *      order: the second save sees the first file already on disk.
 *   2. else against the other side's LIVE list: when they agree, this side alone is taken (null returned). This is the
 *      path when the other file is mid-edit and does not load.
 *   3. else a `configError` naming the row, its index and both files, so the caller keeps its last good list.
 */
function pairWith(config, next, pair, side) {
	const limitsSide = side === "limits";
	let disk = null;
	try {
		disk = limitsSide ? loadProjects(config) : loadScopedLimits(config);
	} catch {
		// The other file does not load right now: its own watcher says so. Judge against its live list alone.
	}
	const agree = (limits, projects) => danglingProjectRows(limits, projects).length === 0;
	if (disk !== null && (limitsSide ? agree(next, disk) : agree(disk, next))) {
		const live = limitsSide ? pair.projects.current : pair.limits.current;
		return JSON.stringify(disk) === JSON.stringify(live) ? null : disk;
	}
	const liveOther = limitsSide ? pair.projects.current : pair.limits.current;
	if (limitsSide) checkProjectRows(next, liveOther, config.scopedLimitsFile, config.projectsFile ?? null);
	else checkProjectRows(liveOther, next, config.scopedLimitsFile, config.projectsFile ?? null);
	return null;
}

/**
 * PR #549's review: a `scoped-limits.json` dollar row on a deployment with no per-job cap (env and overlay merged)
 * refuses every job it applies to as `config-refused`, unless that job's trigger sets `run.maxCostUsd`. So it is a
 * WARNING at load and at each reload, never a refusal: the rows by index and kind, never a scope string.
 */
export function warnDollarRowsWithoutCap(limits, deploymentMaxCostUsd, log) {
	const rows = dollarRowsWithoutCap(limits, deploymentMaxCostUsd);
	if (rows.length > 0) log("scoped_limits_dollar_rows_without_cap", { rows });
}

/**
 * Watch the scoped-limits file (issue #242) the way the pause-windows watcher above does: the DIRECTORY,
 * for atomic tmp+rename robustness, filtered to the one basename, debounced. Best-effort; the FSWatcher is
 * unref'd and the returned closer stops the watch with the worker (issue #295).
 */
function watchScopedLimitsFile(config, ref, log, atBoot, deploymentCap = null, pair = null) {
	const path = config.scopedLimitsFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	const closer = makeWatchCloser(handles, log);
	const readFile = () => readFileSync(path, "utf8");
	readBeforeArming(handles, readFile, atBoot); // the BOOT LOAD's own bytes; see watch-closer (issue #386)
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return; // see makeWatchCloser: by construction, not by a delivery rule
			if (changed && changed !== file) return;
			clearTimeout(handles.timer);
			handles.timer = setTimeout(() => reloadScopedLimits(config, ref, closer.reloadLog, deploymentCap, pair), WATCH_DEBOUNCE_MS);
		});
		handles.watcher.unref?.();
		log("scoped_limits_watching", { path });
	} catch (err) {
		log("scoped_limits_watch_unavailable", { reason: err?.message });
	}
	if (changedWhileArming(handles, readFile)) {
		log("scoped_limits_reread_after_arming", { path });
		reloadScopedLimits(config, ref, closer.reloadLog, deploymentCap, pair);
	}
	return closer;
}

/**
 * The projects reload (issue #499), exported apart from its watcher for `reloadScopedLimits`' reason: last-good is
 * testable without fs.watch. A bad edit keeps `ref.current` and logs `projects_reload_invalid`; a good one swaps it,
 * so the next pickup resolves against the new membership. A job already past its pickup keeps the id it was given.
 * The reason is the loader's message, which never quotes a project's `name` (projects.mjs).
 */
export function reloadProjects(config, ref, log, pair = null) {
	try {
		const next = loadProjects(config);
		// Issue #499 part B: an edit that drops (or renames) a project a scoped-limits row still names is kept out, and the
		// last good projects stay, unless scoped-limits.json on disk already agrees with it (`pairWith`).
		const other = pair ? pairWith(config, next, pair, "projects") : null;
		ref.current = next;
		log("projects_reloaded", { count: ref.current.length });
		if (other) {
			pair.limits.current = other;
			log("scoped_limits_reloaded", { count: other.length, with: "projects" });
			// Every limits list that goes live is warned on, whichever file's reload committed it.
			if (pair.deploymentCap) warnDollarRowsWithoutCap(other, pair.deploymentCap(), log);
		}
	} catch (err) {
		// Escaped (PR #569's review): the parser's own refusals already are, and an fs error quoting the path is too.
		log("projects_reload_invalid", { reason: escapeControls(err?.message) });
		return;
	}
	// Issue #504 part B: as `reloadScopedLimits` does, so the envelope follows a projects edit in either save order.
	pair?.afterCommit?.();
}

/**
 * Watch the projects file (issue #499) as the scoped-limits watcher does: the directory, filtered to the one basename,
 * debounced, the boot read as the arming baseline. The closer joins `extraClosers`, so the watch stops with the worker
 * (DES-WATCHERS-CLOSE-WITH-THE-WORKER).
 */
function watchProjectsFile(config, ref, log, atBoot, pair = null) {
	const path = config.projectsFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	const closer = makeWatchCloser(handles, log);
	const readFile = () => readFileSync(path, "utf8");
	readBeforeArming(handles, readFile, atBoot);
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return;
			if (changed && changed !== file) return;
			clearTimeout(handles.timer);
			handles.timer = setTimeout(() => reloadProjects(config, ref, closer.reloadLog, pair), WATCH_DEBOUNCE_MS);
		});
		handles.watcher.unref?.();
		log("projects_watching", { path });
	} catch (err) {
		log("projects_watch_unavailable", { reason: err?.message });
	}
	if (changedWhileArming(handles, readFile)) {
		log("projects_reread_after_arming", { path });
		reloadProjects(config, ref, closer.reloadLog, pair);
	}
	return closer;
}

/**
 * `envelopeJobPaths` as a thunk that keeps its last good answer (issue #504 part B): a triggers file caught mid-edit
 * must not turn a containment check into a failure of its own, and the last parse that succeeded is what the running
 * schedulers were built from. The first call has no last good answer and throws, which at boot refuses.
 */
export function makeEnvelopeJobPaths(config, io = {}) {
	let lastGood = null;
	return () => {
		try {
			lastGood = envelopeJobPaths(config, io);
		} catch (err) {
			if (lastGood === null) throw err;
		}
		return lastGood;
	};
}

/**
 * The envelope reload (issue #504 part B), exported apart from its watcher for `reloadScopedLimits`' reason. `ref` is
 * `{ current, digest }`. The file is judged against the LIVE projects and scoped limits (its floors name projects and
 * sit under project rows) and the job paths of the moment, so a reload is paired with both files: their own reloads
 * call this again once they commit (`pair.afterCommit`), and an envelope edit that needs a projects edit applies in
 * either save order. A bad edit, or one that puts the file inside a job path, keeps the last good envelope and logs
 * `envelope_reload_invalid`; the last good copy can never be one a job wrote, because every reload re-runs the
 * containment check. A changed digest logs `envelope_reloaded` and calls `onChange` (the re-base, or the mismatch).
 */
export function reloadEnvelope(config, ref, log, { projects, limits, maxCostMicros = () => null, jobPaths, onChange = () => {} }) {
	let next;
	try {
		next = loadEnvelopeChecked(config, { projects: projects?.current ?? [], limits: limits?.current ?? [], maxCostMicros: maxCostMicros(), jobPaths: jobPaths() });
	} catch (err) {
		log("envelope_reload_invalid", { reason: escapeControls(err?.message) });
		return;
	}
	const digest = next === null ? null : envelopeDigest(next);
	const changed = digest !== ref.digest;
	ref.current = next;
	ref.digest = digest;
	if (!changed) return;
	log("envelope_reloaded", { digest });
	onChange();
}

/**
 * Watch the envelope file (issue #504 part B) as the projects watcher does: the directory, filtered to the one
 * basename, debounced, the boot read as the arming baseline, the closer joining `extraClosers`.
 */
function watchEnvelopeFile(config, ref, log, atBoot, ctx) {
	const path = config.envelopeFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	const closer = makeWatchCloser(handles, log);
	const readFile = () => readFileSync(path, "utf8");
	readBeforeArming(handles, readFile, atBoot);
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return;
			if (changed && changed !== file) return;
			clearTimeout(handles.timer);
			handles.timer = setTimeout(() => reloadEnvelope(config, ref, closer.reloadLog, ctx), WATCH_DEBOUNCE_MS);
		});
		handles.watcher.unref?.();
		log("envelope_watching", { path });
	} catch (err) {
		log("envelope_watch_unavailable", { reason: err?.message });
	}
	if (changedWhileArming(handles, readFile)) {
		log("envelope_reread_after_arming", { path });
		reloadEnvelope(config, ref, closer.reloadLog, ctx);
	}
	return closer;
}

/**
 * The model-endpoints reload (issue #503), exported apart from its watcher for `reloadScopedLimits`' reason: the
 * last-good property is testable without fs.watch. A bad edit keeps `ref.current` and logs
 * `model_endpoints_reload_invalid`; a good one swaps it, so a `slots` edit applies to the next pickup.
 */
export function reloadModelEndpoints(config, ref, log) {
	try {
		ref.current = loadModelEndpoints(config);
		log("model_endpoints_reloaded", { count: ref.current.length });
	} catch (err) {
		log("model_endpoints_reload_invalid", { reason: err?.message });
	}
}

/**
 * Watch the model-endpoints file (issue #503) as the scoped-limits watcher does. Armed only when the file is named
 * or exists at boot: the default path is the deployment folder, and a worker started elsewhere must not watch an
 * arbitrary directory for a file nobody declared. A default file created later is read at the next restart.
 */
function watchModelEndpointsFile(config, ref, log, atBoot) {
	const { path } = modelEndpointsPath(config);
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	const closer = makeWatchCloser(handles, log);
	const readFile = () => readFileSync(path, "utf8");
	readBeforeArming(handles, readFile, atBoot);
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return;
			if (changed && changed !== file) return;
			clearTimeout(handles.timer);
			handles.timer = setTimeout(() => reloadModelEndpoints(config, ref, closer.reloadLog), WATCH_DEBOUNCE_MS);
		});
		handles.watcher.unref?.();
		log("model_endpoints_watching", { path });
	} catch (err) {
		log("model_endpoints_watch_unavailable", { reason: err?.message });
	}
	if (changedWhileArming(handles, readFile)) {
		log("model_endpoints_reread_after_arming", { path });
		reloadModelEndpoints(config, ref, closer.reloadLog);
	}
	return closer;
}

/**
 * The runnable worker. Reads config, connects to Valkey, wires every REAL dependency the processor
 * needs, and starts draining the queue. `createWorker` already installs the timeout, the
 * abort->docker-stop, and the SIGTERM/SIGINT graceful shutdown.
 *
 * This is where a job's KIND becomes a pair of collaborators. Each forge is one `forges` entry of
 * `{ auth, host }`, and the four deps that used to be bound to one forge -- `mintToken`, `comment`,
 * `isDefaultBranchProtected`, `prepareWorkspace` -- now look their forge up from the job. The processor
 * therefore never branches on which forge a job belongs to; the only place that knows is here.
 *
 * Forge auth is initialised best-effort, per forge: a local-only deployment must still boot when no
 * working GITHUB_AUTH_SOURCE is present, so an auth failure is logged and that forge's deps fail closed
 * per job (mintToken throws configError) rather than blocking startup. Collaborators are injectable
 * (defaulting to the real ones) so the wiring is testable offline with no Redis and no forge.
 */
export async function startWorker(
	env = process.env,
	{
		// WHERE THE BOOT LOG BYTES GO. Defaults to the real stdout, so production is byte-identical; a test
		// passes a collector instead of reassigning `process.stdout.write`.
		//
		// That distinction is not stylistic. `node --test` runs each file in a CHILD PROCESS that serialises
		// its own results over `process.stdout`, so a test that replaces the global and holds the replacement
		// across an `await` swallows the runner's result frames for whatever completes in that window. Three
		// tests in `start-wiring.test.mjs` were reported as not existing at all -- no name, no count, exit 0 --
		// because this function's log line went through the same channel the runner needed (issue #266).
		write = (chunk) => process.stdout.write(chunk),
		// Issue #354: the configuration loader, a seam for ONE reason: a test venue that is not in the backend table (an
		// injected `extraBackends` bundle) cannot be written through the real loader, which refuses a name it does not know.
		// The table's own venues (`local`, and `podman` since part 2) go through the real loader.
		loadConfig: loadConfigFn = loadConfig,
		makeAuth = makeGitHubAuth,
		makeHost = makeGitHubHost,
		createWorkerFn = createWorker,
		makeCpuReserve: makeCpuReserveFn = makeCpuReserve,
		makeReaper: makeReaperFn = makeReaper,
		makeBackendRegistry: makeBackendRegistryFn = makeBackendRegistry,
		// Additional backend bundles, in registration order after `local` (which is built only while blessed,
		// issue #354). The deployment still decides which are BLESSED (PI_BACKENDS) and which is default; this only
		// says which exist.
		extraBackends = [],
		makeLogSink: makeLogSinkFn = makeLogSink,
		makeRecordWriter: makeRecordWriterFn = makeRecordWriter,
		makeRunMirror: makeRunMirrorFn = makeRunMirror,
		// The fleet copy's by-id read, seamed so a wiring test can answer it without a live mirror.
		readMirroredRecord: readMirroredRecordFn = readMirroredRecord,
		makeLogReaper: makeLogReaperFn = makeLogReaper,
		makeSandboxReaper: makeSandboxReaperFn = makeSandboxReaper,
		makeSandboxNetworkSweeper: makeSandboxNetworkSweeperFn = makeSandboxNetworkSweeper,
		// Issue #429: the one call that asks a runtime which sandboxes are open, seamed so a wiring test can drive the real
		// sandbox reaper against a real retention root without spawning docker or podman.
		listRunningSandboxes: listRunningSandboxesFn = listRunningSandboxes,
		makeRetentionSweep: makeRetentionSweepFn = makeRetentionSweep,
		makeRunContainer: makeRunContainerFn = makeRunContainer,
		makeSecretsResolver: makeSecretsResolverFn = makeSecretsResolver,
		makeImagePreflight: makeImagePreflightFn = makeImagePreflight,
		makeScopeClaimSweeper: makeScopeClaimSweeperFn = makeScopeClaimSweeper,
		makeClaimSweeper: makeClaimSweeperFn = makeClaimSweeper,
		makeHostRegistry: makeHostRegistryFn = makeHostRegistry,
		makeEgressPreflight: makeEgressPreflightFn = makeEgressPreflight,
		// Which docker endpoint this host's CLI resolves (issue #278). A seam because the real one spawns the
		// docker CLI, and a wiring test must decide what it answers.
		resolveDockerEndpoint: resolveDockerEndpointFn = makeDockerEndpointResolver(),
		// Issue #341: the one `docker info` the job-user decision reads, and the process facts it reads beside it.
		// Seams for the same reason as the endpoint: a wiring test decides what the daemon and the process say.
		readDaemonFacts: readDaemonFactsFn = makeDaemonFactsReader(),
		// Issue #596, phase 2: a cgroup file's text (a rootless account's `memory.max` and `cpu.max`), for the host budget.
		readCgroupFile: readCgroupFileFn = (path) => readFileSync(path, "utf8"),
		// Issue #596, phase 2: whether an orphaned job container is gone, per venue's CLI.
		containerGone: containerGoneFn = null,
		// Issue #596, gate round 1 of phase 2 (P2G1-L4): the job containers a venue's CLI still lists after the boot reaper,
		// with their size labels, `(bin) => async () => [{ name, memMiB, cpuCenti }]`, throwing when the CLI does not answer.
		listJobContainers: listJobContainersFn = (bin) => makeJobContainerLister({ bin }),
		// `home` (issue #354) is the account whose rootless Podman runs the podman venue's jobs: its own mounts.conf and
		// containers.conf are read from there. Absent in a test's identity, it falls to the observation's own default.
		jobUserIdentity = { platform: process.platform, release: osRelease(), euid: process.geteuid?.(), egid: process.getegid?.(), home: homedir() },
		// Issue #345: the host files the runtime-mounts observation reads (Podman's mounts.conf and containers.conf). A seam so
		// a wiring test never reads this machine's /etc.
		observationFs = { statSync, readFileSync, readdirSync },
		// Issue #448: `systemctl show podman.service`, read only where a local job runs on rootful Podman's Docker API on this
		// host. A seam so a wiring test decides what the unit says, and never asks this machine's systemd.
		readPodmanService: readPodmanServiceFn = makePodmanServiceReader(),
		// Issue #354: the podman venue's three boot collaborators, each a seam for the endpoint's reason: the real ones spawn
		// `podman`, and a wiring test must decide what `podman info` says, what the reaper lists and what the bundle is
		// built from. Constructing the default reader spawns nothing; only a call does, and only while `podman` is blessed.
		readPodmanInfo: readPodmanInfoFn = makePodmanInfoReader(),
		makePodmanReaper: makePodmanReaperFn = makePodmanReaper,
		makePodmanBackend: makePodmanBackendFn = makePodmanBackend,
		makeGitLabAuth: makeGitLabAuthFn = makeGitLabAuth,
		makeGitLabHost: makeGitLabHostFn = makeGitLabHost,
		makeForgejoAuth: makeForgejoAuthFn = makeForgejoAuth,
		makeForgejoHost: makeForgejoHostFn = makeForgejoHost,
		makeAzureAuth: makeAzureAuthFn = makeAzureAuth,
		makeAzureHost: makeAzureHostFn = makeAzureHost,
		// The clock the forge-auth re-resolve cooldown reads. Injected because a test that asserts a window
		// beside a subject built on the default `Date.now` is a fuse: it passes until the wall clock drifts
		// past that window, then fails in CI on a tree nobody touched (issue #284).
		now = () => Date.now(),
		// Issue #476: how the boot waits out a rootless network keeper that is only too young. A seam so a wiring test
		// proves the wait and its bound without spending real seconds.
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		// How long a job waits for a forge-auth re-resolve. A seam rather than a constant because the
		// property under test is that the bound EXISTS, and a test that proved it by waiting ten real
		// seconds would be paid for on every run for the life of the file.
		authResolveTimeoutMs = AUTH_RESOLVE_TIMEOUT_MS,
		// Issue #464: the jobs dir, created and checked as this account's at boot. A seam so a wiring test decides it.
		ensureJobsDir: ensureJobsDirFn = ensureJobsDir,
		// Issue #464: the same rule for the two durable stores, which default into that root on an account with no home.
		ensureUnderAccountRoot: ensureUnderAccountRootFn = ensureUnderAccountRoot,
		// Issue #464 (gate round 1): the sandbox dir, refused at boot when another account owns it, as the jobs dir is.
		ensureSandboxDir: ensureSandboxDirFn = ensureSandboxDir,
		// Issue #464 (gate round 2): whose Valkey VALKEY_URL reaches, judged here, where the connection is made, and the
		// literal address every Valkey client of this worker then connects to. A seam: the real one reads /proc, probes
		// this host's addresses and resolves the name, none of which belongs in a wiring test.
		judgeValkey = defaultJudgeValkey,
		// The scoped-limits watcher, injectable so a test can see what it is armed with (PR #549's review: the cap
		// thunk the reload warning reads). Production passes nothing and gets the real watcher.
		watchScopedLimits: watchScopedLimitsFn = watchScopedLimitsFile,
		// The projects watcher (issue #499), injectable for the same reason: a test sees it armed and closed.
		watchProjects: watchProjectsFn = watchProjectsFile,
		// The envelope watcher (issue #504 part B), injectable for the same reason.
		watchEnvelope: watchEnvelopeFn = watchEnvelopeFile,
	} = {},
) {
	const config = loadConfigFn(env);
	// Issue #354: whether this deployment blesses the local adapter (its name is `DEFAULT_BACKEND`, the word
	// `makeLocalBackend` stamps on its bundle). `local` stopped being mandatory in `PI_BACKENDS`, and every read
	// below that asks THIS HOST'S DOCKER CLI something is a read about that one venue: its endpoint, its daemon's
	// facts, its image, its reaper, its sandboxes. With `local` unblessed none of them runs, so a host without
	// Docker never spawns `docker` at boot for a venue it will never use, and a floor naming an observation only
	// `local` makes cannot hold such a worker at exit 1 forever. Everything is byte-identical while it is blessed.
	const localBlessed = config.backends.includes(DEFAULT_BACKEND);
	// The same split for the native podman venue (issue #354, `DES-PODMAN-NATIVE-ROOTLESS-BACKEND`): its `podman info`
	// read, its reaper and its bundle exist only while it is blessed, so a deployment that never chose it spawns no
	// `podman` and pays nothing for it being in the table.
	const podmanBlessed = config.backends.includes(PODMAN_BACKEND);
	// Issue #354: an ABSENT `observationPreflight` admits every job, which is the right answer only for a venue whose
	// words hold without observing anything. A venue whose table entry names an `observedBy` and carries no preflight
	// would have those words hold with nothing looking, and a floor naming one would pass on capability alone: the
	// believed-in control `unarmedFloor` was written against. The registry cannot read the table, so it is refused
	// here, and HERE rather than beside the registry: this runs before anything is spawned or connected, so the refusal
	// leaves nothing open behind it. Only the extra bundles need it; `local`'s is built below carrying its preflight.
	for (const bundle of extraBackends) {
		// A string name only: `backendFor(undefined)` answers with the table's default, and a nameless bundle is the
		// registry's refusal to make, with its own message.
		const gated = typeof bundle?.name === "string" ? Object.keys(backendFor(bundle.name)?.observedBy ?? {}) : [];
		if (gated.length > 0 && typeof bundle?.observationPreflight !== "function") {
			throw new Error(`backend ${JSON.stringify(bundle.name)} declares ${gated.join(", ")} as held only while observed, and carries no observationPreflight to observe them`);
		}
	}
	// Issue #464: the jobs dir is this account's, or the worker does not start. Before it built anything, and a
	// `configError` (exit 2, never restarted) where another account owns it, since a restart meets the same owner: the
	// shared `<tmp>/pi-dispatch/jobs` default let one account's jobs dir fail every other account's jobs with EACCES
	// while the worker ran on. A failed mkdir is the fs error it is (exit 1).
	ensureJobsDirFn(config.jobsDir, { env });
	ensureSandboxDirFn(config.sandboxDir, { env });
	for (const store of [config.logsDir, dirname(config.settingsFile)]) ensureUnderAccountRootFn(store, { env });
	// `host` sits AFTER the spread, so it is authoritative rather than overridable (issue #57). No call
	// site can know better than this closure which process wrote a line, and one that passed `host` would
	// be lying by construction -- verified: none does. This is also why the stamp lives ONLY here. Every
	// other module takes `log` injected, and two tests pin the KEY SET of the fields object handed to an
	// injected log (`run_record_failed`, `wait_check`); a `host` added at any call site would break them,
	// while one added inside this closure cannot reach them.
	const log = (event, fields = {}) => write(`${JSON.stringify({ event, ...fields, host: config.workerName })}\n`);

	// Issue #464 (gate round 2): the owner rule where the connection is made. `service install`, `up` and doctor judge
	// the Valkey too, but a VALKEY_URL edited after they refused it, a 0.0.0.0 URL, or another account publishing on ::1
	// after the install each reached another account's queue through an unjudged worker (measured on Fedora 44). So the
	// worker judges it itself, before it contacts Valkey at all, with the same function (`resolveWorkerValkey`), and
	// every client below connects to the judged literal address, never to a name resolved again later. A refusal is a
	// configError (exit 2, not restarted into the same answer); nothing answering is a plain error (exit 1, restarted).
	const valkey = await judgeValkey({ url: config.valkeyUrl, venues: { localUsed: localBlessed, podmanUsed: podmanBlessed }, env });
	for (const note of valkey.notes ?? []) log("valkey_note", { note });
	if (valkey.pinned) log("valkey_pinned", { address: valkey.pinned.address, port: valkey.pinned.port, heldBy: valkey.pinned.heldBy });
	// Every client below connects through connection.mjs' JudgedConnector, which judges the (pinned) address again on
	// each connect, as this boot judged it: root refused as the boot decided it, PI_VALKEY_SHARED from the deployment .env.
	const valkeyContext = workerValkeyContext(valkey, env);
	// Issue #468: whether this worker sends a password, and never the password: the only thing a log line may say of it.
	log("valkey_password", { set: Boolean(valkeyPasswordFor(valkey.url, valkeyContext).password) });
	const valkeyConn = (opts = {}) => parseConnection(valkey.url, { ...opts, servername: valkey.servername, context: valkeyContext });

	// DES-CRON-VIA-BULLMQ-SCHEDULER: load and validate the triggers file with the operator present and
	// before any Valkey contact, so a misconfigured schedule refuses startup loudly (configError) rather
	// than upserting a broken scheduler. [] means cron disabled (no PI_TRIGGERS_FILE, or no cron triggers).
	// A mutable ref, like its `pauseWindows` and `scopedLimits` siblings and for a reason this one only
	// acquired with issue #57: the heartbeat fingerprints what this host CURRENTLY believes should be
	// scheduled, and a `const` frozen at boot would make it publish the pre-edit set forever -- so two
	// hosts would see each other's fingerprint oscillate on the beat period, refusing or agreeing
	// depending on which half of a beat a reload happened to land in.
	// THE BOOT LOADS' OWN READS are the baselines for the three watches' boot-race checks (issue #386),
	// captured through the seam each loader already has rather than re-read where the watch arms. The window
	// this race lives in is between these lines and the arming a thousand lines below -- the endpoint probe,
	// forge auth, the reaper, Valkey -- not the microseconds around the arming itself, which is what a first
	// attempt measured. `null` where a file is not configured, which reads as "nothing to compare".
	const atBoot = { triggers: null, pauseWindows: null, scopedLimits: null, projects: null, modelEndpoints: null, envelope: null };
	const recording = (into, path) => ({
		readFileSync: (file, enc) => {
			const text = readFileSync(file, enc);
			if (file === path) atBoot[into] = text;
			return text;
		},
	});
	const schedules = { current: loadSchedules(config, { fleet: config.workerNameDeclared, ...recording("triggers", config.triggersFile) }) };

	// REQ-SCOPED-PAUSE-WINDOWS: load + validate the pause-windows file with the operator present and before any
	// Valkey contact, so a malformed file refuses startup (configError) rather than silently disabling scoped
	// pauses. Held in a mutable ref so the live-reload watcher can hot-swap it. [] means no scoped pauses.
	const pauseWindows = { current: loadPauseWindows(config, recording("pauseWindows", config.pauseWindowsFile)) };

	// Issue #242: same posture for the scoped-limits file -- fail-loud with the operator present, mutable
	// ref for the live-reload watcher, [] when unset (the folder mutex is code and needs no file).
	const scopedLimits = { current: loadScopedLimits(config, recording("scopedLimits", config.scopedLimitsFile)) };

	// Issue #499: the projects file, same posture (INT-PROJECTS-FILE-CONTRACT): a bad file refuses boot with the operator
	// present, a mutable ref for the live reload, [] when unset. The pickup gate reads it once per pickup, beside the
	// limits snapshot, and the id it resolves there is the one the job's record carries.
	const projects = { current: loadProjects(config, recording("projects", config.projectsFile)) };
	// Issue #499 part B: a `project:<id>` row whose id is not a project refuses BOOT, naming the row and the id: it would
	// read as a cap on a group that no job can belong to. The live reloads of either file hold the same rule (`pair`).
	checkProjectRows(scopedLimits.current, projects.current, config.scopedLimitsFile, config.projectsFile ?? null);

	// Issue #504 part B: the allocation envelope (INT-ENVELOPE-FILE-CONTRACT), same posture: a bad file refuses boot with
	// the operator present, before any Valkey contact. It is judged against the projects and scoped limits just loaded
	// (its floors name projects and sit under project rows), needs the merged per-job cost cap (each governed job
	// reserves it against its share), and must lie outside every host path a job container can see, which is checked
	// with this load and again with every reload. A mutable ref `{ current, digest }`; null when PI_ENVELOPE_FILE is
	// unset, and then nothing below governs anything.
	const envelopeCap = () => {
		try {
			const s = resolveSettings(config, readOverlay(config.settingsFile));
			return optionalUsdMicros(s.invalid ? config.maxCostUsd : s.maxCostUsd, "maxCostUsd");
		} catch {
			return null;
		}
	};
	const envelopeJobPathsNow = makeEnvelopeJobPaths(config);
	const envelope = { current: null, digest: null };
	if (config.envelopeFile !== null && config.envelopeFile !== undefined) {
		envelope.current = loadEnvelopeChecked(config, { projects: projects.current, limits: scopedLimits.current, maxCostMicros: envelopeCap(), jobPaths: envelopeJobPathsNow() }, { io: recording("envelope", config.envelopeFile) });
		envelope.digest = envelope.current === null ? null : envelopeDigest(envelope.current);
		log("envelope_loaded", { digest: envelope.digest, window: envelope.current?.window ?? null, delegation: envelope.current?.delegation?.enabled === true });
	}
	// After a triggers reload (a cron folder or a skills dir is a job path): the envelope's place judged again. The live
	// copy is kept either way, since every envelope reload re-runs the check and so never adopts a file a job could have
	// written; this line is what tells the operator that a job can now reach the file.
	const checkEnvelopePlace = (say = log) => {
		if (!envelope.current) return;
		try {
			const inside = envelopeInsideJobPaths(config.envelopeFile, envelopeJobPathsNow());
			if (inside) say("envelope_inside_job_path", { kind: inside.kind });
		} catch (err) {
			say("envelope_inside_job_path", { reason: escapeControls(err?.message) });
		}
	};

	// Issue #503: the declared model endpoints, same posture (INT-MODEL-ENDPOINTS-FILE-CONTRACT): a bad file refuses
	// boot with the operator present, a mutable ref for the live reload, [] when there is no file. Read per pickup
	// from the ref, so a `slots` edit applies to the next job.
	const modelEndpointsAt = modelEndpointsPath(config);
	const modelEndpoints = { current: loadModelEndpoints(config, recording("modelEndpoints", modelEndpointsAt.path)) };
	const watchModelEndpoints = modelEndpointsAt.explicit || atBoot.modelEndpoints !== null;

	// Issue #278: WHICH DOCKER DAEMON the job containers' credentials will travel to. Asked of the CLI at boot,
	// AFTER the free file validations above (a wedged CLI costs up to its bound, and must not delay them) and
	// BEFORE forge auth, the reaper, Valkey and the worker -- so a refusal here stops a process that built
	// nothing. Without a floor naming credentialTransit a redirect is words only: pointing the worker at a
	// daemon is the operator's call. With one asking for `enforced`, it refuses: a floor is not met by capability
	// alone. A TRANSIENT failure to ask (a timeout, a spawn out of resources) throws untagged, exit 1, so the
	// supervisor retries; everything else is a config error, exit 2.
	//
	// Issue #354: judged for `local` ALONE, not for every blessed venue. These are observations of this host's docker
	// CLI and its daemon, which mean nothing for another venue's words: a venue with its own `observedBy` brings its own
	// boot read (the podman venue's is below, judged for `podman` alone the same way).
	const bootEndpoint = localBlessed ? await resolveDockerEndpointFn() : null;
	if (bootEndpoint) {
		logDockerEndpoint(log, bootEndpoint);
		const [endpointRefusal] = observationRefusals({
			backends: [DEFAULT_BACKEND],
			backendFloor: config.backendFloor,
			observations: { [DOCKER_ENDPOINT_LOCAL]: bootEndpoint.local === true },
			evidence: { [DOCKER_ENDPOINT_LOCAL]: dockerEndpointEvidence(bootEndpoint) },
			// The daemon has not been read yet; the runtime observations are checked once it has (issue #345).
			only: [DOCKER_ENDPOINT_LOCAL],
		});
		if (endpointRefusal) throw bootEndpoint.local === null && bootEndpoint.transient ? new Error(endpointRefusal) : configError(endpointRefusal);
	}
	// The per-job read (below, `observationPreflight`) logs only when the answer CHANGES from the last one, so a
	// deliberate, standing redirect writes one line at boot rather than one per job.
	let endpointSeen = bootEndpoint ? dockerEndpointState(bootEndpoint) : null;
	// Issue #596, phase 2: the endpoint the last job-user read asked about, so the host budget's tick reads the SAME cached
	// facts a job was decided from (and re-reads them when they age), never a second daemon of its own choosing.
	let budgetEndpoint = bootEndpoint ? { endpoint: bootEndpoint, key: endpointSeen } : null;

	// Issue #341: WHO job containers run as on this daemon (`DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST`). Decided
	// from facts, never a probe container, cached per endpoint state. Bounded like the boot image read, because a
	// wedged daemon must not hang boot. Only an IDENTITY verdict refuses at boot, and only when `local` is the
	// default venue: rootless, userns-remap, a root worker and Docker Desktop on Linux cannot run any local job here.
	// An unknown answer (a daemon still starting) boots, so a unit with RestartPreventExitStatus=2 is never stranded
	// by one; so does `runtime-unreadable`, which a later job re-reads.
	const resolveJobUser = makeJobUserResolver({ readFacts: readDaemonFactsFn, ...jobUserIdentity, now, log });
	// Issue #345: a floor that needs a DAEMON observation waits the facts read's own bound (plus a margin), not the image
	// read's 5 s: a busy host's `docker info` is the slow read, and a floor this boot met from the table before would
	// otherwise exit 1 on every restart of a healthy daemon.
	// Issue #354: `null` throughout with `local` unblessed. There is no local job to decide a user for, so nothing is
	// read, nothing is said, and the boot line carries `jobUser: null` rather than a decision about a daemon nobody asked.
	const bootJobUser = bootEndpoint
		? await settleWithin(
				resolveJobUser({ endpoint: bootEndpoint, key: endpointSeen }).catch(() => null),
				bootFactsBoundMs(config),
				null,
			)
		: null;
	const bootDecision = bootEndpoint ? (bootJobUser?.decision ?? { mode: "unknown", user: null, cause: null, reason: "boot-read-timeout" }) : null;
	if (bootDecision) log("job_user", { mode: bootDecision.mode, user: bootDecision.user, cause: bootDecision.cause, reason: bootDecision.reason });
	// Said again whenever a job's decision differs from the last one said, so a boot that read `unknown` (a daemon still
	// starting) and a later answer that refuses every job are never separated by silence.
	let jobUserSaid = bootDecision ? jobUserLogKey(bootDecision) : null;

	// Issue #345: the RUNTIME observations, from that same facts read and this host's files, checked against the floor
	// the way the endpoint was above: `isolation` holds only while the daemon is observed applying a container's bounds,
	// `mountSet` only while the runtime is observed adding no mounts of its own. Without a floor naming either, this is
	// words (worker_started, and doctor). A refusal resting only on a read that did not answer (a daemon still starting,
	// the boot bound) throws untagged, exit 1, so the supervisor retries; one resting on an answer is a config error.
	// Issue #354: for `local` alone, like the endpoint above, and not at all with `local` unblessed. This is the site that
	// would otherwise hold a worker without `local` at exit 1 forever: a floor naming `isolation` against observations
	// nobody made reads as unanswered, which is the transient arm, which the supervisor retries without end.
	// Issue #448: `systemctl show podman.service`, read once here where the local daemon is rootful Podman on this host, and
	// handed to both the mounts observation and the containers.conf refusal below, so they judge one answer.
	// The deletion rule's memory (gate round 1 of PR #473): which chain files this worker saw while one service start ran.
	const rootfulMemory = makeRootfulMemory();
	const bootUnit = bootEndpoint && bootJobUser?.daemon ? await readRootfulService({ endpoint: bootEndpoint, daemon: bootJobUser.daemon, readService: readPodmanServiceFn }) : undefined;
	const bootObserved = bootEndpoint ? observeHost({ endpoint: bootEndpoint, daemon: bootJobUser?.daemon ?? { answered: false, reason: "boot-read-timeout", transient: true }, fs: observationFs, unit: bootUnit, env, memory: rootfulMemory }) : null;
	if (bootObserved) {
		const bootObservedArgs = { backends: [DEFAULT_BACKEND], backendFloor: config.backendFloor, observations: bootObserved.observations, evidence: bootObserved.evidence };
		const [runtimeRefusal] = observationRefusals(bootObservedArgs);
		if (runtimeRefusal) throw observationRefusalIsTransient(bootObservedArgs) ? new Error(runtimeRefusal) : configError(runtimeRefusal);
	}
	let runtimeObservedSaid = bootObserved ? runtimeObservationKey(bootObserved) : null;

	const bootRefusal = jobUserBootRefusal(bootDecision, config.defaultBackend);
	if (bootRefusal) throw configError(bootRefusal);
	// Issue #448: where a local job runs on rootful Podman's Docker API service on this host, the containers.conf that
	// service reads (the system chain, root's own, the unit's CONTAINERS_CONF) and whether the running service started
	// before it last changed. A VENUE refusal, as the podman venue's #428 one is and for its reason: with egress off no
	// declared property covers what `env` or `annotations` add to a job. After the identity, whose fix comes first, and
	// only while `local` is the default venue; merely blessed, each local job is refused and the default venue's run.
	// Tagged (exit 2) since a restart reads the same bytes, except what heals by itself (exit 1): a read that failed for a
	// moment, a running service older than its containers.conf, a change time ahead of the clock. What the worker's account
	// cannot read under root's own config home is said once here, never refused on; any other unreadable part refuses.
	const bootRootful = bootEndpoint && bootJobUser?.daemon ? await observeRootfulConf({ endpoint: bootEndpoint, daemon: bootJobUser.daemon, fs: observationFs, readService: readPodmanServiceFn, env, unit: bootUnit, memory: rootfulMemory }) : null;
	let rootfulUnreadSaid = "";
	const sayRootfulUnread = (rootful) => {
		const said = rootfulUnreadList(rootful?.unread);
		if (said === rootfulUnreadSaid) return;
		rootfulUnreadSaid = said;
		if (said !== "") log("local_podman_conf_unread", { unread: said });
	};
	sayRootfulUnread(bootRootful);
	const localConfBoot = localConfBootRefusal(bootDecision, config.defaultBackend, bootRootful);
	if (localConfBoot) throw localConfBoot.transient ? new Error(localConfBoot.message) : configError(localConfBoot.message);

	// Issue #354: the podman venue's ONE facts read, `podman info --format json`, at boot, where local's reads are and for
	// their reasons: free, before forge auth, the reaper and any Valkey client (the Valkey owner judgement above only reads
	// sockets and probes addresses), so a refusal here stops a process that built nothing.
	// Wrapped once in `cachedPodmanInfo` and the SAME wrapper is handed to the bundle below, so an answer read here is the
	// one the first job is decided from rather than a second spawn. Bounded twice: the reader's own timeout (docker info's
	// 15 s, reused) and this fuse two seconds past it, because a spawn that never settles has no timeout to fire.
	const podmanInfo = podmanBlessed ? cachedPodmanInfo(readPodmanInfoFn, { now, log }) : null;
	// Issue #596, phase 2: what the host budget's `auto` is computed from, read on its tick (off every job path) from the
	// two cached readers above: each blessed venue's memory and CPU count, the SMALLER where both answered (two venues on
	// one host share it; a desktop VM is the smaller), and on rootless Podman the user service's own `memory.max` and
	// `cpu.max` beside them. A venue that did not answer adds nothing, so the budget is unknown only when none did.
	// The same reads also say how each venue manages cgroups (`reserveVenues`), from which the CPU reserve keeps the jobs'
	// parent cgroup's quota at the budget (`cpu-reserve.mjs`, on every refresh, off every job path).
	const readHostFacts = async () => {
		const views = [];
		const reserveVenues = [];
		let user = {};
		if (localBlessed && budgetEndpoint) {
			const read = await resolveJobUser(budgetEndpoint).catch(() => null);
			if (read?.daemon?.answered === true) {
				views.push(read.daemon.facts);
				reserveVenues.push({ venue: DEFAULT_BACKEND, facts: read.daemon.facts, endpointLocal: budgetEndpoint.endpoint?.local === true });
			}
		}
		if (podmanInfo) {
			const read = await podmanInfo().catch(() => null);
			if (read?.answered === true) {
				views.push(read.info);
				reserveVenues.push({ venue: PODMAN_BACKEND, facts: read.info, endpointLocal: read.info?.serviceIsRemote === false });
				if (read.info?.rootless === true) user = readUserServiceLimits({ uid: jobUserIdentity.euid, readFile: readCgroupFileFn });
			}
		}
		const least = (key) => {
			const known = views.map((v) => v?.[key]).filter((v) => Number.isSafeInteger(v));
			return known.length > 0 ? Math.min(...known) : null;
		};
		return { memTotalMiB: least("memTotalMiB"), hostCpus: least("hostCpus"), ...user, reserveVenues };
	};
	// Issue #596, phase 2: the aggregate CPU reserve. One per worker; the helper container (Docker's cgroupfs driver) runs
	// the job image this worker already pins, with `--pull=never`, never an image fetched for it.
	const cpuReserve = makeCpuReserveFn({ run: (bin, args, { timeoutMs }) => execDockerBounded(args, { bin, timeoutMs }), image: config.jobImage, now, log });
	const syncCpuReserve = (budget, facts) => cpuReserve.sync({ cpuCenti: budget.cpuCenti, plans: (facts?.reserveVenues ?? []).map((v) => reservePlan({ ...v, platform: jobUserIdentity.platform })) });
	const bootPodmanRead = podmanInfo
		? await settleWithin(
				Promise.resolve()
					.then(() => podmanInfo())
					.catch(() => ({ answered: false, reason: "spawn-failed", transient: true })),
				PODMAN_INFO_TIMEOUT_MS + 2_000,
				{ answered: false, reason: "boot-read-timeout", transient: true },
			)
		: null;
	const bootPodmanDecision = bootPodmanRead ? decidePodmanJobUser({ platform: jobUserIdentity.platform, euid: jobUserIdentity.euid, egid: jobUserIdentity.egid, read: bootPodmanRead }) : null;
	// The IDENTITY verdict first, before the observations, and unlike `local`'s order on purpose: a rootful or remote
	// Podman also fails the observations (the mounts check reads a rootless user's files, the service one its remoteness),
	// and a floor refusal naming `podmanAddsNoMounts` would send the operator after a mounts.conf when the fix is the
	// account Podman runs as. Only when `podman` is the DEFAULT venue, as `jobUserBootRefusal` for `local`: with it merely
	// blessed, the jobs that name it are refused one by one and the default venue's still run.
	const podmanRefusal = podmanBootRefusal(bootPodmanDecision, config.defaultBackend);
	if (podmanRefusal) throw configError(podmanRefusal);
	// Issue #428: the account's containers.conf, next, under the same rule (only while `podman` is the default venue; merely
	// blessed, each podman job is refused and the default venue's still run). A VENUE refusal rather than a floor
	// observation: with egress off no declared property covers what a job reaches on the host, so a floor would never
	// fire on the deployments at risk. Read from this host's files with no daemon, so it is determinate whatever the info
	// read said, and tagged (exit 2): a restart reads the same bytes. After the identity, whose fix comes first. The one
	// exception is a read that failed for a moment (out of descriptors, an I/O error), which is untagged (exit 1) so the
	// supervisor restarts it, as an unanswered observation is.
	const podmanConfBoot = podmanConfBootRefusal(bootPodmanDecision, config.defaultBackend, { fs: observationFs, home: jobUserIdentity.home, env, euid: jobUserIdentity.euid, runRoot: bootPodmanRead?.answered === true && bootPodmanRead.info ? (bootPodmanRead.info.runRoot ?? null) : undefined });
	if (podmanConfBoot) throw podmanConfBoot.transient ? new Error(podmanConfBoot.message) : configError(podmanConfBoot.message);
	// The podman venue's own observations, judged for `podman` ALONE, as the endpoint and the daemon's are for `local`
	// alone: each venue's words are earned by its own reads, and judging one venue's answers over every blessed venue
	// would read the other's observations as unanswered, which is the transient arm, exit 1 on every restart. Same split
	// as `local`'s: a refusal resting only on a read that did not answer is untagged (retried), one on an answer tagged.
	const bootPodmanObserved = bootPodmanRead ? observePodman({ read: bootPodmanRead, fs: observationFs, home: jobUserIdentity.home, env, euid: jobUserIdentity.euid }) : null;
	// Not judged at all when the venue's identity is already refused (it is then merely blessed, or the refusal above would
	// have stopped the boot): every job naming it is refused by that cause, and a floor refusal here would stop the whole
	// worker, the default venue's jobs included, with a fix (delegate controllers, empty a mounts.conf) that is not the one.
	if (bootPodmanObserved && bootPodmanDecision?.mode !== "unmappable") {
		const podmanObservedArgs = { backends: [PODMAN_BACKEND], backendFloor: config.backendFloor, observations: bootPodmanObserved.observations, evidence: bootPodmanObserved.evidence };
		const [podmanObservationRefusal] = observationRefusals(podmanObservedArgs);
		if (podmanObservationRefusal) throw observationRefusalIsTransient(podmanObservedArgs) ? new Error(podmanObservationRefusal) : configError(podmanObservationRefusal);
	}

	// The forge a job belongs to is resolved PER JOB from `job.kind`, not bound once for the process.
	// Each entry is `{ auth, host }`: `auth` is get-token's `{ mintToken, selfId, source }` (null when that
	// forge is unconfigured or unreachable), `host` is the three methods github-host.mjs returns. The map
	// is the seam -- `forgeFor` below is the only place a kind becomes a pair of collaborators, so the
	// processor never learns which forge it is talking to.
	//
	// Auth stays BEST-EFFORT per forge, exactly as it was: a local-only deployment has no GitHub
	// credentials and must still boot and drain cron jobs. The refusal is deferred to the job that needs
	// the missing credential (the mintToken fallback below), not raised at startup.
	//
	// WHAT CHANGED (issue #316): best-effort used to mean best-effort ONCE. Any throw left `auth` null for
	// the lifetime of the process, so a forge that was merely unreachable during the seconds this loop ran
	// stayed credential-less until somebody restarted the worker, and every job of that kind then hit the
	// `configError` fallback below -- which, since #310, refunds the reserve and posts a public comment
	// telling the issue author that the operator's deployment is misconfigured. A deployment that
	// `doctor` reports as healthy. The boot posture is unchanged for a DETERMINATE failure, which is what
	// the local-only case is (no `gh` on PATH is `ENOENT`); a TRANSIENT one now leaves a re-resolver
	// behind instead of a permanent null.
	// Issue #530: the GitHub clients take this worker's logger, so a client's own warning is one more JSON line here and
	// its plain request lines (`GET /user - 401 ...`) are never printed (`octokitLog`).
	const forges = { github: { auth: null, host: makeHost({ log }) } };
	// Per forge kind, what it would take to resolve its auth again: the closure, and the `idOf` its log
	// line needs. Present only while the last attempt failed transiently -- a determinate failure removes
	// it, because retrying a wrong credential is how a deployment pays to be told the same thing twice.
	const authRetries = new Map();
	const authInFlight = new Map();
	// When the last transient attempt happened, so a backlog draining against a forge that is still down
	// does not open one identity round-trip per job. The in-flight promise below dedupes CONCURRENT
	// callers; this bounds SEQUENTIAL ones, which is the shape a PI_CONCURRENCY=1 worker actually has.
	const authCooldownUntil = new Map();
	const authLastError = new Map();

	/**
	 * Boot-time attempt for one forge, and the record of what to do if it failed.
	 *
	 * `idOf` exists because azure's selfId is an object while the other three are scalars, which is the
	 * one place a forge identity does not reduce to a single value.
	 */
	const attachAuth = async (kind, make, cfg, idOf = (auth) => auth.selfId) => {
		try {
			forges[kind].auth = await make(cfg);
			log("self_identity", { kind, id: idOf(forges[kind].auth), source: forges[kind].auth.source });
		} catch (err) {
			// The tag is the whole discriminator, and it is now trustworthy at these sites: the identity
			// modules throw untagged for a fetch rejection, a transient status and an unparseable body.
			const transient = err?.piDispatchConfig !== true;
			if (transient) authRetries.set(kind, { resolve: () => make(cfg), idOf });
			log(`${kind}_auth_unavailable`, { kind, reason: err?.message, ...githubFailureFields(err), transient });
		}
	};

	/**
	 * The auth for a forge, resolving it now if boot could not and the reason was transient.
	 *
	 * THREE bounds, because "ask again" is a live network round-trip on the job path and each of them is a
	 * different way of asking too often.
	 *
	 * ONE in-flight promise per forge dedupes CONCURRENT callers, which is what a worker at
	 * PI_CONCURRENCY>1 draining a backlog produces. A COOLDOWN bounds sequential ones: without it a
	 * PI_CONCURRENCY=1 worker chewing through a backlog against a forge that is still down opens one
	 * identity call per job, forever, and each of them can sit on undici's 300-second header timeout with
	 * the queue behind it. Inside the cooldown the last error is re-thrown immediately, which is the same
	 * verdict at none of the cost. And a DETERMINATE answer retires the re-resolver entirely.
	 *
	 * The determinate error is RETHROWN rather than turned into `null`. Returning null sent every such job
	 * to the generic "configure GITHUB_AUTH_SOURCE" message while the specific reason -- bad credentials,
	 * a key that is not PKCS//8 -- was already in hand and went only to the log. The caller decides what to
	 * do with it; the point is that it reaches the caller.
	 */
	const ensureAuth = async (kind) => {
		if (forges[kind]?.auth) return forges[kind].auth;
		const retry = authRetries.get(kind);
		if (!retry) return null;
		if (!authInFlight.has(kind)) {
			const until = authCooldownUntil.get(kind) ?? 0;
			if (now() < until) throw authLastError.get(kind) ?? transientError(`${kind} auth is still unavailable`);
			const attempt = async () => {
				try {
					const auth = await retry.resolve();
					forges[kind].auth = auth;
					authCooldownUntil.delete(kind);
					authLastError.delete(kind);
					log("self_identity", { kind, id: retry.idOf(auth), source: auth.source });
					return auth;
				} catch (err) {
					authLastError.set(kind, err);
					if (err?.piDispatchConfig === true) {
						authRetries.delete(kind);
						log(`${kind}_auth_unavailable`, { kind, reason: err?.message, ...githubFailureFields(err), transient: false });
					} else {
						authCooldownUntil.set(kind, now() + AUTH_RETRY_COOLDOWN_MS);
					}
					throw err;
				}
			};
			// The cleanup is chained OUTSIDE the async body rather than written as its `finally`, and that is
			// not a style choice. An async function runs synchronously up to its first `await`, so a factory
			// that throws SYNCHRONOUSLY runs the whole body -- catch and finally included -- before this
			// `set` ever happens: the delete would find an empty map and the rejected promise would then be
			// installed permanently, leaving that forge dead for the lifetime of the process. Which is the
			// exact defect issue #316 exists to remove, reintroduced by its own fix. A `.finally` callback
			// is always a microtask, so it cannot outrun the `set`, and the identity check makes it safe
			// against a later attempt having already replaced the entry.
			const inflight = attempt().finally(() => {
				if (authInFlight.get(kind) === inflight) authInFlight.delete(kind);
			});
			// A handler, so that a caller losing the timeout race below cannot turn this into an unhandled
			// rejection. Every awaiter still sees the rejection through its own `await`.
			inflight.catch(() => {});
			authInFlight.set(kind, inflight);
		}
		const inflight = authInFlight.get(kind);
		let timer;
		try {
			return await Promise.race([
				inflight,
				new Promise((_resolve, reject) => {
					timer = setTimeout(() => reject(transientError(`${kind} auth did not answer within ${authResolveTimeoutMs}ms`)), authResolveTimeoutMs);
					timer.unref?.();
				}),
			]);
		} catch (err) {
			// A lost race is a forge that is not answering, which is exactly what the cooldown is for: the
			// in-flight call is still out there and will set it when it settles, but the next job must not
			// queue up behind it in the meantime.
			if (!authLastError.has(kind)) {
				authLastError.set(kind, err);
				authCooldownUntil.set(kind, now() + AUTH_RETRY_COOLDOWN_MS);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	};

	await attachAuth("github", (cfg) => makeAuth(cfg, { log }), config.github);
	// GitLab joins the same map on the same best-effort terms. It appears only when configured: a forge
	// with no entry refuses its jobs at mint time with a message naming what is missing, which is a better
	// answer than an entry that exists and cannot authenticate.
	if (config.gitlab) {
		forges.gitlab = { auth: null, host: makeGitLabHostFn({ apiUrl: config.gitlab.apiUrl }) };
		await attachAuth("gitlab", makeGitLabAuthFn, config.gitlab);
	}
	// Forgejo joins on the same best-effort terms. Its auth can fail for one reason the others cannot: a
	// repository-scoped token cannot call GET /user, so an operator who scoped their token without setting
	// FORGEJO_BOT_ID lands here. The message names the fix (forgejo-identity.mjs) and the forge stays
	// credential-less, which refuses its jobs at mint time rather than running them unattributed.
	if (config.forgejo) {
		forges.forgejo = { auth: null, host: makeForgejoHostFn({ apiUrl: config.forgejo.apiUrl }) };
		await attachAuth("forgejo", makeForgejoAuthFn, config.forgejo);
	}
	// Azure joins on the same terms. Its selfId is an OBJECT (`{ id, email }`) rather than a scalar, because
	// a pull-request delivery names an actor by GUID and a work item names them only by address -- the one
	// place a forge's identity does not reduce to a single value.
	if (config.azure) {
		forges.azure = { auth: null, host: makeAzureHostFn({ orgUrl: config.azure.orgUrl }) };
		await attachAuth("azure", makeAzureAuthFn, config.azure, (auth) => auth.selfId?.id ?? null);
	}

	/** The `{ auth, host }` pair a job's kind names, or `undefined` for a local job (which has no forge). */
	const forgeFor = (job) => forges[job?.kind];

	// Clear strays left by a previous crash before the worker starts draining. Best-effort: the reaper
	// swallows its own docker errors; this guard keeps any reaper failure from blocking boot.
	// Whether the container reaper actually ENUMERATED, which the scope-claim sweep below depends on.
	// #227. ONE map, read twice: the boot sweep below combines every entry, and each backend's bundle takes
	// its own reaper from it by name. Held here rather than derived from the bundles because the bundles
	// cannot exist yet -- they need the log sink, the package resolver and the image preflight, all built
	// further down -- and reaching for one here is a temporal dead zone the boot try/catch would swallow.
	let backendReaps = {};

	let reaped = false;
	try {
		// CONSTRUCTED INSIDE THE GUARD, not above it. The comment on this try says it "keeps any reaper
		// failure from blocking boot", and a factory that throws is a reaper failure -- an earlier draft
		// hoisted the construction out and quietly made that sentence false.
		// DERIVED from the bundles, not a hand-kept parallel map. An earlier draft had a literal here and the
		// registry cross-checking it, which made adding a venue three edits that nothing forced to agree --
		// and a forgotten one is INVISIBLE, because `reapAll` is conservative over the reapers it is handed
		// rather than over the venues that exist. A bundle already carries its own `reap`, so taking it from
		// there is one place. `local`'s is built here because its bundle cannot exist yet.
		// Issue #354: `local`'s only while it is blessed, since its bundle is built only then and the registry refuses a
		// boot reaper for a venue it does not hold.
		// Issue #354: podman's the same way and for the same reason, `makeReaper` with `bin: "podman"`, so the sweep lists
		// the store this account's jobs actually ran in. Docker's listing says nothing about it, and the reverse.
		backendReaps = {
			...(localBlessed ? { [DEFAULT_BACKEND]: makeReaperFn({ log }) } : {}),
			...(podmanBlessed ? { [PODMAN_BACKEND]: makePodmanReaperFn({ log }) } : {}),
			...Object.fromEntries(extraBackends.map((b) => [b?.name, b?.reap])),
		};
		const swept = (await reapAll(Object.values(backendReaps), { log }))?.reaped === true;
		// PROVEN FOR THE WHOLE HOST, or not at all (issue #354). `reapAll` is conservative over the reapers it is
		// handed, and two gaps sit outside that. A BLESSED venue with no reaper here is refused by the registry, but
		// only further down, after the scope sweep has already acted on this answer. And a host without `local` can
		// still hold `pi-job-` containers under Docker, from before `local` was dropped from PI_BACKENDS, that no
		// blessed venue's reaper lists: "every blessed venue enumerated" is then true while this host is not shown
		// clean. The scope sweep is an optimisation over the TTL, so declining it costs one TTL of a stale claim, never
		// a slot; claiming it would free slots for containers that may still be running. A venue that can prove the
		// Docker side too (a read-only listing) is what lifts the second gap, and it is not this change.
		reaped = swept && localBlessed && config.backends.every((name) => typeof backendReaps[name] === "function");
		// Its own event, said once at boot: the sweeper's `scope_claims_sweep_skipped` says only that the reap did not
		// prove the host, and this is the one case where every reaper answered and the host is still not proven.
		if (swept && !reaped) log("host_reap_unproven", { reason: localBlessed ? "a blessed backend has no boot reaper" : "local is not blessed, so no reaper lists this host's docker containers" });
	} catch (err) {
		log("reaper_skipped", { reason: scrubCredentials(err?.message) });
	}

	// REQ-LOCAL-JOB-VISIBILITY: sweep aged `.log`/`.json` history at boot so the logs directory stays
	// bounded across restarts. Best-effort with the same double-wrap posture as the container reaper: the
	// reaper swallows its own fs errors, and this guard keeps any reaper failure from blocking draining.
	// HELD, not discarded: the periodic sweep (issue #292) re-runs this exact closure, so one configuration
	// read serves boot and every tick after it and the two cannot drift. The `let` with an inert default is
	// what keeps a throwing FACTORY from leaving the sweep holding `undefined` -- the guard below promises
	// that no reaper failure blocks draining, and that promise now has to cover construction too.
	let reapLogs = () => {};
	try {
		reapLogs = makeLogReaperFn({ logsDir: config.logsDir, retentionDays: config.logRetentionDays, log });
		await reapLogs();
	} catch (err) {
		log("log_reaper_skipped", { reason: scrubCredentials(err?.message) });
	}
	// Issue #504 part B: the allocation audit files (`allocations/YYYY-MM.jsonl`) on the same retention, which the log
	// reaper above never reaches (it reaps the top-level `.log` and `.json` only). Never throws, so no double wrap.
	const reapAllocationLogs = makeAllocationLogReaper({ logsDir: config.logsDir, retentionDays: config.logRetentionDays, log });
	reapAllocationLogs();

	// REQ-RESURRECTABLE-SANDBOX: sweep retained per-job directories past their window, so what `cleanup`
	// kept for re-opening stays bounded. Third in the row and deliberately its own sweep -- a different
	// retention policy, a different PII class, and one thing neither sibling needs: it asks the container runtimes
	// which sandboxes are live first, because an operator's shell can outlive a worker restart by design and
	// deleting a bind mount underneath it is a confusing failure with a boring cause. Same double-wrap.
	// Held for the periodic sweep, same as the log reaper above. Safe to re-run on a timer without any
	// state carried between calls: `makeSandboxReaper` declares `running` INSIDE its returned function and
	// re-issues `listRunning` every call, so a docker outage costs one interval of retention overshoot
	// rather than latching the sweep off until the next boot.
	let reapSandboxes = async () => {};
	try {
		// Issue #429, as corrected by its review: which sandboxes are open is asked PER RETAINED RUN, of the runtime that
		// run's manifest records, never of the runtimes this worker blesses. The opener's blessing is the OPENER's
		// `PI_BACKENDS` and routinely differs from the worker's (`OQ-038`), so a blessed-list listing let a podman-only
		// worker delete a local run's directory under a docker shell an operator had just opened. A runtime that cannot
		// answer holds its own runs this pass and nothing else, so a stale docker CLI does not stop a podman sweep, and a
		// run it cannot place (an unreadable manifest, a venue with no launcher) is asked of every runtime present.
		// `blessed` only adds runtimes to the network sweep; a host that blesses neither and retains nothing from either
		// spawns neither CLI.
		// The store a podman run recorded is compared with THIS worker's podman store (review round 2): the cached boot
		// read when podman is blessed, else one read through the same seam, asked only when a podman run recorded one.
		const readPodmanStore = async () => {
			const read = await (podmanInfo ?? readPodmanInfoFn)();
			return read?.answered === true ? (read.info?.graphRoot ?? null) : null;
		};
		const watch = makeSandboxRuntimeWatch({ sandboxDir: config.sandboxDir, blessed: config.backends, list: listRunningSandboxesFn, readPodmanStore, makeSweeper: makeSandboxNetworkSweeperFn, proxy: config.egressProxy, log });
		reapSandboxes = makeSandboxReaperFn({
			sandboxDir: config.sandboxDir,
			retentionHours: config.sandboxRetentionHours,
			listRunning: watch.listRunning,
			// Issue #337: the session networks a died-mid-session process left, one sweeper per runtime present (issue
			// #429), each listing and removing in its own runtime. Unconditional on `PI_EGRESS`, on the boot reaper's own
			// precedent (it lists `pi-job-` networks whatever the posture) and for a sharper reason: a deployment that has
			// turned the policy OFF is exactly where the leftovers are guaranteed dead, since nothing is making new ones.
			sweepNetworks: watch.sweepNetworks,
			// Issue #446, gate round 1: each expired run's own runtime is asked once more right before it is renamed aside.
			isOpen: watch.isOpen,
			log,
		});
		await reapSandboxes();
	} catch (err) {
		log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message) });
	}

	// One raw Redis client, shared by the budget (via the worker) and the scheduler stall guard, so it is
	// hoisted out of the createWorkerFn arg object.
	const redis = makeRedisClient(valkey.url, { servername: valkey.servername, context: valkeyContext });
	// Its errors as one message-only line (PR #475's review, round 2), like every Queue and Worker's: without a listener
	// ioredis printed a stack per reconnect attempt.
	onValkeyError(redis, "shared client");

	// Issue #504 part B: the applied split lives in Valkey (`alloc:plan`), shared by every host. Only with an envelope.
	// The boot reconcile seeds the neutral split when there is none, expires a plan past its life and re-bases on an
	// envelope this host changed while it was down; a fault is logged and the first pickup tries again, because the
	// pickup reconciles too and refuses nothing it cannot judge (it throws, and the job is retried).
	// Built on EVERY host, with an envelope or without: a host with none still asks, at each pickup, whether the fleet is
	// governed (an applied split exists), and refuses its jobs as envelope-mismatch when it is.
	const allocationState = makeAllocationState({ redis, host: config.workerName, audit: makeAllocationAudit({ logsDir: config.logsDir }), log });
	const reconcileAllocation = (why) => {
		if (!envelope.current) return Promise.resolve();
		return allocationState
			.reconcile({ envelope: envelope.current, digest: envelope.digest, now: new Date() })
			.then((r) => log("allocation_reconciled", { why, mismatch: r.mismatch, digest: envelope.digest, applied: r.state?.envelopeDigest ?? null }))
			.catch((err) => log("allocation_reconcile_failed", { why, reason: scrubCredentials(err?.message) }));
	};
	await reconcileAllocation("boot");

	// This host's own stale scope claims, gated on the reaper having having enumerated: the
	// reaper is what establishes that this machine holds no `pi-job-*` containers, so a claim naming this
	// host is a claim for a container that no longer exists. Deleting it is not a second source of truth --
	// it is the SAME source writing down what it just established, which is what answers `OQ-008` here.
	// Best-effort and double-wrapped like every other boot sweep: an OPTIMISATION over the TTL, never the
	// mechanism, so a fault costs one TTL of a stale claim and never a boot.
	try {
		if (config.workerNameDeclared)
			await makeScopeClaimSweeperFn({ redis, workerName: config.workerName, limits: scopeClaimRows(scopedLimits.current), log })({ reaped });
	} catch (err) {
		log("scope_claims_sweep_skipped", { reason: scrubCredentials(err?.message) });
	}
	// Issue #503: this host's stale model endpoint claims, on the same precondition and for the same reason (each is a
	// claim for a container). Every index up to the parse ceiling, not up to today's `slots`: `slots` can be lowered
	// live, and a claim on an index above the new value is still this host's to clear. A per-machine endpoint (a host
	// alias name) takes no fleet claim, so it has none to sweep. The sweep stops at its first fault.
	try {
		if (config.workerNameDeclared && modelEndpoints.current.length > 0)
			await makeClaimSweeperFn({ redis, workerName: config.workerName, keyFor: endpointSlotKey, rows: modelEndpoints.current.filter((e) => !isPerMachineHost(e.host)).map((e) => ({ hash: hash16(e.id), count: MAX_SLOTS })), event: "endpoint_claims", log })({ reaped });
	} catch (err) {
		log("endpoint_claims_sweep_skipped", { reason: scrubCredentials(err?.message) });
	}

	// The persistent runtime queue: the stall guard tears schedulers down through it, AND the outbox
	// collector enqueues chained children onto it -- the same pi-jobs queue, so one handle serves both.
	// Non-failFast: a long-lived handle rides out a Valkey blip. Registered as an extraCloser so shutdown
	// drains it after the worker.
	const runtimeQueue = makeQueue(valkeyConn());

	// THE HOST QUEUE (issue #57): work only this machine can do, because the folder lives here.
	//
	// Armed by the operator DECLARING a name, not by a peer appearing. Two reasons, and the first is
	// decisive: which queue a job is enqueued to is a routing decision made by whoever enqueues it, so it
	// cannot be allowed to flip underneath a running deployment when a second host happens to register --
	// a cron scheduler upserted on one queue and pruned from another is exactly the mutual teardown this
	// issue exists to stop. And a second BullMQ Worker is a second blocking connection, which a single-host
	// deployment should not pay for silently. Declaring a name IS the multi-host declaration; `doctor`
	// warns when peers exist and nobody has made it.
	const hostQueue = config.workerNameDeclared ? hostQueueName(config.workerName) : null;
	// The long-lived handle the cron watcher reloads through. Its own when a host queue is armed, so a
	// live triggers-file edit lands on the same queue the boot reconcile used; otherwise the shared
	// runtime queue, exactly as before. Registered as an extraCloser only when it is a NEW handle --
	// closing `runtimeQueue` twice would be closing another owner's connection.
	const cronQueue = hostQueue ? makeQueue(valkeyConn(), { name: hostQueue }) : runtimeQueue;

	// REQ-LOCAL-JOB-VISIBILITY durable run history, all host-side. The raw `.log` sink is gated on
	// captureJobLogs (raw container output is user-authored data, opt-in per no-pii-in-logs); the id-only
	// `.json` record via recordRun is ALWAYS on, so every run leaves a stable, non-PII trace regardless.
	// logsDir wires only into these host-side factories and openJobLog into runContainer -- never into the
	// container env allowlist (no-broad-env-into-container).
	const openJobLog = makeLogSinkFn({ logsDir: config.logsDir, enabled: config.captureJobLogs, log });
	const writeRecord = makeRecordWriterFn({ logsDir: config.logsDir, log });
	// REQ-RESUMABLE-SESSION. Wires into prepareWorkspace and the processor's completed branch only --
	// never into the container env allowlist, exactly as logsDir does not. The one difference from logsDir
	// is that a PER-JOB COPY of one key's transcript IS mounted; the store itself never is.
	const sessionStore = makeSessionStore({
		sessionsDir: config.sessionsDir,
		ttlDays: config.sessionsTtlDays,
		maxBytes: config.sessionMaxBytes,
		maxAgeDays: config.sessionMaxAgeDays,
		maxResumeChain: config.sessionMaxResumeChain,
		maxContextPct: config.sessionMaxContextPct,
		// The venue a transcript is stamped with and gated on (#277), resolved with the registry's own default.
		defaultBackend: config.defaultBackend,
		log,
	});
	// Boot sweep, beside the log reaper and for the same reason it is beside rather than inside it: these
	// files have a different retention policy and a different PII class. Until issue #292 the age check at
	// OPEN was carrying this alone, because a worker that never restarts never re-swept; the periodic sweep
	// now covers the DISK half and the open gate covers the INPUT half, which is the one that matters
	// (OQ-007, RESOLVED).
	try {
		sessionStore.reapSessions();
	} catch (err) {
		log("session_reaper_skipped", { reason: scrubCredentials(err?.message) });
	}
	// The one-shot file path (issue #231): PI_TRIGGERS_FILE, else ./triggers.json against this process's
	// cwd -- doctor's own fallback, chosen for doctor's own reason ("the two must read the same file"),
	// and deliberately NOT config.triggersFile, whose null means "cron disabled" and must keep meaning
	// that: under that knob the DEFAULT single-host deployment would have a firing receiver and a worker
	// that can neither disarm nor pre-spend-check.
	const onceTriggersFile = env.PI_TRIGGERS_FILE ?? join(process.cwd(), "triggers.json");
	const disarmOnce = makeDisarmOnce({ triggersPath: onceTriggersFile, log });
	// The fleet-visible copy of the run history (issue #57, Gap 3). Armed only on a deployment that declared
	// a worker name: an unnamed one is a single host, its own files ARE the whole history, and a mirror
	// would be bytes nothing reads. That is also what keeps a single-host deployment byte-identical, since
	// no job then issues a single extra Valkey command.
	const runMirror = config.workerNameDeclared ? makeRunMirrorFn({ redis, retentionDays: config.logRetentionDays, log }) : null;
	const recordRun = ({ job, result, error, startedAt, endedAt, project, size = null }) => {
		// The project (issue #499) was resolved at the pickup gate and rides here as `project` (an id or null), so a live
		// edit of projects.json mid-run cannot make the record disagree with what the job was counted against. A record
		// path that ends BEFORE the pickup gate (the wait gate's refusals) passes none, and resolves from the live ref
		// with the same function.
		const projectId = project !== undefined ? project : projectOf(job?.data ?? {}, projects.current);
		// The `host` is stamped HERE rather than inside the processor, which is what keeps every one of its
		// four `recordRun` call sites byte-unchanged and `buildRecord` a pure function of its arguments.
		// The default venue rides the same way and for the same reason (#277): it is the value the registry
		// below is built with, so the record resolves a job's venue exactly as dispatch does.
		const record = buildRecord({ job, result, error, startedAt, endedAt, host: config.workerName, defaultBackend: config.defaultBackend, project: projectId, size });
		writeRecord(record);
		// STRICTLY AFTER the file, and deliberately not awaited. After, because a crash between the two must
		// leave a record with no fleet row rather than a fleet row with no record -- the mirror is a VIEW,
		// and a view that can outlive its source is a second source of truth. Not awaited, because this is
		// the job's own completion path: a slow Valkey may cost a row in a panel and must never hold up a
		// job that has already finished and already been written to disk. `mirror` never rejects.
		void runMirror?.mirror(record, sanitizeJobId(record.jobId));
		// Strictly AFTER the durable record: "fired" means "produced a run record", and the crash
		// direction this ordering buys is the chosen one -- an armed one-shot with a record, never a
		// disarm before writeRecord RETURNED. Returned, not succeeded: the record writer swallows fs
		// errors by contract (run_record_failed), so a full disk still spends the one-shot -- the
		// alternative, skipping the disarm on a failed record write, would re-fire it unbounded. Fire-and-forget: the hook never rejects, and the record path must not
		// wait on a lock retry. An uncontended disarm completes synchronously inside this call; the
		// one loss window is a drain's process.exit landing mid-lock-retry sleep, which loses only
		// the disarm -- the same chosen direction, met at shutdown instead of a crash.
		void disarmOnce({ job, endedAt });
	};
	// The record read back, for a job the queue lost the lock of after it finished (DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK,
	// CONST-RETRY-INFRA-ONLY): this host's own file first, then the fleet's copy where a mirror is armed, because the
	// host that meets the stalled job need not be the one that ran it. A single host has no mirror and needs none.
	const settledRecord = makeSettledRecord({
		readRecord: makeReadRecord({ logsDir: config.logsDir }),
		readMirrored: runMirror ? (jobId) => readMirroredRecordFn(redis, sanitizeJobId(jobId)) : null,
	});

	// INT-CONFIG-OVERLAY-CONTRACT: the worker reads the runtime-settings overlay at EACH job start, so this
	// closure -- not a value frozen at boot -- is what the processor calls per job. It resolves the fourteen
	// effective settings from the overlay over env; an invalid overlay returns `{ invalid }` (logged loudly,
	// key-name-only per no-pii-in-logs) so the processor RETURNS a settings-overlay-invalid refusal instead
	// of the run.
	const settingsFile = config.settingsFile;
	const getSettings = () => {
		// `resolveSettings` merges overlay over env and then checks the cross-key dollar rule on the MERGED values
		// (issue #501), so an overlay window with an env per-job cap is valid. `secretProfiles` rides alongside the
		// effective keys; that function says why.
		const res = resolveSettings(config, readOverlay(settingsFile, { log }));
		if (res.invalid) {
			log("settings_overlay_invalid", { reason: res.invalid, settingsFile });
			return { invalid: res.invalid };
		}
		return res;
	};

	// Resolve the Worker constructor's slot count once from the overlay: a present overlay may raise or lower
	// boot concurrency. An invalid overlay must NOT dead-end the worker -- fall back to the env/default and let
	// the per-job path enforce the refusal (getSettings already logged the invalid reason).
	const bootSettings = getSettings();
	const bootConcurrency = bootSettings.invalid ? config.concurrency : bootSettings.concurrency;
	// PR #549's review: the merged per-job cap, for the scoped-limits dollar-row warning at boot and at each reload.
	// An invalid overlay falls back to the env value, the same fallback as the slot count above.
	const deploymentMaxCostUsd = () => {
		const s = getSettings();
		return s.invalid ? config.maxCostUsd : s.maxCostUsd;
	};
	warnDollarRowsWithoutCap(scopedLimits.current, bootSettings.invalid ? config.maxCostUsd : bootSettings.maxCostUsd, log);

	// INT-OUTBOX-CONTRACT chain collector: the host-side reader of a completed local parent's /outbox. It
	// enqueues chained children onto the CRON queue via enqueueLocalJob -- this host's own when one is
	// armed, since a chained child continues the working tree this machine just used. Never throws, so a chain fault cannot flip a completed parent
	// (CONST-RETRY-INFRA-ONLY). The processor calls it as the sole COMPLETED-path chain step.
	// Onto the HOST queue when one is armed. A chained child is same-folder and local-parent-only
	// (`OQ-009`), so the working tree it needs is the one this machine just used: routing it anywhere
	// else would enqueue a job only this host can run onto a queue every host drains.
	const collectChain = makeCollectChain({ queue: cronQueue, config, log });

	// Issue #505. One live-file check, shared by the pickup gate, the snapshot and the plan collector, so the three ask one
	// file by one rule: the same file and rule as the one-shot checks below (`onceTriggersFile`). `pi-dispatch run
	// --trigger` reads it there too, so the command that fires a trigger and the check that confirms its flag see one file.
	const checkPortfolioFlag = makeCheckPortfolioFlag({ triggersPath: onceTriggersFile });
	const governingNow = () => (envelope.current ? { envelope: envelope.current, digest: envelope.digest } : null);
	// The plan collector: a completed portfolio job's /outbox/priorities.json, applied under the envelope by the same
	// allocation state every pickup reconciles. Never throws, like collectChain beside it.
	const collectPlan = makeCollectPlan({ allocation: allocationState, governing: governingNow, projects: () => projects.current, checkPortfolioFlag, log });
	// The snapshot a confirmed portfolio job reads as /job/portfolio.json, built at prepare. The run counts are complete
	// only with the run mirror, which a declared worker name arms (the `runMirror` rule below).
	const portfolioSnapshot = makePortfolioSnapshot({ checkPortfolioFlag, governing: governingNow, projects: () => projects.current, limits: () => scopedLimits.current, allocation: allocationState, redis, logsDir: config.logsDir, mirror: config.workerNameDeclared === true, log });

	// REQ-GLOBAL-PI-OVERLAY staged packages: read the operator's stage manifest at EACH job start, like
	// getSettings above and the pause-window ref below.
	//
	// This was a boot-time read until issue #102, and the argument for that was sound while it held: the
	// staged set was deploy-time state under a :ro mount, identical for every job, so a per-job read bought
	// nothing. What changed is that `import-pi --with-packages` now discovers what the operator installed in
	// pi, which makes `pi install X` then re-stage a ROUTINE act rather than a rare one. Under the boot read
	// the jobs after such a re-stage keep the old set until someone restarts the worker, and when the re-stage
	// DROPS a package the symptom is worse than staleness: the runner refuses a missing staged dir at
	// container start (exit 2), and budget is reserved before the container, so every job burns a daily-cap
	// slot until the restart. A free filesystem read that prevents a reserved-and-wasted slot is exactly what
	// CONST-BUDGET-BEFORE-TOKENS asks for.
	//
	// Last-known-good on a failed read, never []: an empty set emits no PI_PACKAGES at all, so the runner's
	// assertPackagePathsExist has nothing to refuse and the job would run WITHOUT its tools and still exit 0.
	// That is the silent no-op this project refuses. And never a throw: a transient overlay fault must not
	// become a queue retry (CONST-RETRY-INFRA-ONLY).
	let lastGoodPackagePaths = [];
	let lastPackageKey = null;
	// Logged once per CHANGE, not once per job: a line every job would drown the log it is meant to serve.
	// EVERY resolved read records its key, including the empty one, so "nothing staged" becoming "one package
	// staged" is the change it obviously is rather than a first read that logs nothing.
	const notePackageKey = (key) => {
		if (lastPackageKey !== null && key !== lastPackageKey) log("packages_stage_changed", { count: key === "" ? 0 : key.split(":").length });
		lastPackageKey = key;
	};
	const getPackagePaths = () => {
		if (!config.globalPiDir) return [];
		const staged = readStageManifest({ globalPiDir: config.globalPiDir });
		if (!staged) {
			if (lastGoodPackagePaths.length > 0) {
				log("packages_manifest_unreadable", { overlay: config.globalPiDir, keeping: lastGoodPackagePaths.length });
				return lastGoodPackagePaths;
			}
			notePackageKey("");
			return [];
		}
		const paths = containerPackagePaths(staged);
		notePackageKey(paths.join(":"));
		lastGoodPackagePaths = paths;
		return paths;
	};
	// One read at boot, for the same log line the boot read always emitted, and to seed last-known-good.
	if (config.globalPiDir && !readStageManifest({ globalPiDir: config.globalPiDir })) log("packages_manifest_absent", { overlay: config.globalPiDir });
	getPackagePaths();

	// Issue #57. Published before the worker starts draining, so a peer that boots a moment later sees this
	// host rather than an empty fleet. The image identity rides the SAME preflight the job path uses -- one
	// inspect implementation, one format string -- called once here with an empty job, which resolves the
	// deployment default and trips none of the per-job label gates.
	//
	// The boot line and the registry may cache this where the GATE may not, and the distinction is the whole
	// argument: a gate that caches gives a WRONG DECISION when an operator builds or removes an image
	// mid-day, which is why `imagePreflight` is deliberately not memoised below. A heartbeat that caches
	// gives a STALE ROW, and nothing reads a row to decide anything.
	// ONE preflight instance, constructed once and shared: `start-wiring.test.mjs` pins that, and the
	// reason is the module's own -- the tag the preflight checked has to be the tag `docker run` is
	// handed, and two constructions are two chances for that to stop being true.
	// Issue #354: built only while `local` is blessed, since it IS local's (`docker image inspect`). Without `local` the
	// boot read below asks the default venue's own preflight instead, the one its jobs will be gated on.
	const imagePreflight = localBlessed ? makeImagePreflightFn({ image: config.jobImage }) : null;
	// Issue #354: the podman bundle, built only while `podman` is blessed, from the SAME deployment inputs local's
	// runContainer is handed below (one image, one overlay, one forward list, one egress posture: a venue must not quietly
	// run a different job than the one configured), plus what only this venue reads: the cached `podman info` the boot
	// read above already asked, the floor its per-job observation preflight judges, the boot-built reaper, and the
	// process's identity and host files, through the same seams local's decisions read. Built HERE rather than beside
	// local's, because the boot image read just below asks the default venue's own preflight when that venue is podman.
	const podmanBackend = podmanBlessed
		? makePodmanBackendFn({
				image: config.jobImage,
				hostEnv: env,
				egress: config.egress,
				egressProxy: config.egressProxy,
				openJobLog,
				globalPiDir: config.globalPiDir,
				allowGlobalExtensions: config.allowGlobalExtensions,
				packagePaths: getPackagePaths,
				forwardEnv: config.forwardEnv,
				authFromPi: config.authFromPi,
				forgeHosts: { gitlab: config.gitlab?.apiUrl ?? null, forgejo: config.forgejo?.apiUrl ?? null, azure: config.azure?.orgUrl ?? null },
				backendFloor: config.backendFloor,
				reap: backendReaps[PODMAN_BACKEND],
				readInfo: podmanInfo,
				platform: jobUserIdentity.platform,
				euid: jobUserIdentity.euid,
				egid: jobUserIdentity.egid,
				fs: observationFs,
				home: jobUserIdentity.home,
				env,
				log,
			})
		: null;
	// Issue #458 (PR #463 round 2): on Podman 4.x with egress armed, the keeper read ONCE at boot through the bundle's own
	// preflight, bounded, and said as its own event with the whole sentence. A deployment that upgraded without re-running
	// `service install` or `up` has no keeper, and would otherwise learn it only from retried jobs. Only a warning: the
	// per-job preflight is the gate: once the keeper holds, the next job runs (under a proxy up longer than the grace,
	// 15 s, after the proxy's restart, which the job's retry message and doctor both ask for).
	if (podmanBackend && config.egress) {
		const readBootKeeper = () =>
			settleWithin(
				Promise.resolve()
					.then(() => podmanBackend.egressPreflight({}))
					.catch(() => ({})),
				BOOT_IMAGE_TIMEOUT_MS * 4,
				{},
			);
		let bootKeeper = await readBootKeeper();
		// Issue #476: a keeper whose only fault is its age is waited out, once and bounded (at most the minimum age plus
		// the margin), then judged again. A stack started together reads it under a second old (measured 0.5 to 0.8 s on
		// 4.9.3), and warning then was wrong every time; a keeper still young after the wait restarted in it, and is said.
		if (bootKeeper?.young && typeof bootKeeper.young === "object") {
			const waitMs = Math.min(Number.isFinite(bootKeeper.young.waitMs) ? bootKeeper.young.waitMs : 0, NETNS_KEEPER_MIN_AGE_MS + NETNS_KEEPER_YOUNG_MARGIN_MS);
			// Said as information, not a warning: the one line that shows a joint start was waited out, and for how long.
			log("netns_keeper_young_at_boot", { keeperAgeMs: bootKeeper.young.ageMs ?? null, waitMs });
			await sleep(Math.max(0, waitMs));
			bootKeeper = await readBootKeeper();
		}
		// Its own sentence (PR #463 round 3): the job-shaped one says "this job is retried", and at boot there is no job.
		if (typeof bootKeeper?.keeper === "string") log("netns_keeper_not_holding_at_boot", { reason: bootKeeper.keeperAtBoot ?? bootKeeper.keeper });
	}
	// Every bundle this boot built beside local's, in registration order: the podman one first, then the injected ones.
	const builtBackends = [...(podmanBackend ? [podmanBackend] : []), ...extraBackends];
	// BOUNDED, because `.catch()` cannot rescue a promise that never settles: `runDocker` resolves only on
	// the child's `close` or `error` and has no timeout of its own, so a wedged daemon would hang boot
	// here. This read is a nicety -- a digest for the boot line and the registry -- and a nicety may
	// never be able to stop a worker starting. The per-JOB preflight keeps its unbounded wait, where a
	// wedged daemon is the job's problem and the 30-minute job timeout already covers it.
	// Without `local` (issue #354) the default venue's own preflight, under the same bound and the same swallow: a
	// nicety that throws synchronously must not stop a boot either, hence the `then`. None at all reads as no digest.
	const defaultVenueImageRead = () => {
		const read = builtBackends.find((b) => b?.name === config.defaultBackend)?.imagePreflight;
		return Promise.resolve()
			.then(() => (typeof read === "function" ? read({}) : {}))
			.then((answer) => answer ?? {})
			.catch(() => ({}));
	};
	const bootImage = await settleWithin(imagePreflight ? imagePreflight({}).catch(() => ({})) : defaultVenueImageRead(), BOOT_IMAGE_TIMEOUT_MS, {});
	// Issue #341: say it at boot, not only as a refusal on every job. The deployment's default image cannot run as
	// this worker's uid on this daemon, so every local job that uses it will be refused pre-spend.
	if (bootDecision?.mode === "worker" && bootImage.ok) {
		const planned = resolveImageUser(bootDecision, { capabilities: bootImage.capabilities ?? [], euid: jobUserIdentity.euid, egid: jobUserIdentity.egid, socket: bootJobUser?.socket ?? null });
		if (planned.refused === "job-image-any-uid-unsupported") log("job_image_any_uid_unsupported", { image: config.jobImage });
		else if (planned.refused) log("job_user_group_refused", { cause: planned.cause });
		if (planned.user && config.forwardEnv.includes("HOME")) log("forward_env_home_overridden", { reason: "HOME is set beside --user" });
	}
	// Issue #354: the same boot sentence for a podman DEFAULT venue, whose image was read from this account's own store
	// just above. Only as the default: with `local` the default, `bootImage` is docker's copy of the tag, which says
	// nothing about the one in the podman store. `backend` names the venue, since `local`'s lines carry none.
	if (config.defaultBackend === PODMAN_BACKEND && bootPodmanDecision?.mode === "worker" && bootImage.ok) {
		const planned = resolvePodmanImageUser(bootPodmanDecision, { capabilities: bootImage.capabilities ?? [], euid: jobUserIdentity.euid, egid: jobUserIdentity.egid });
		if (planned.refused === "job-image-any-uid-unsupported") log("job_image_any_uid_unsupported", { image: config.jobImage, backend: PODMAN_BACKEND });
		else if (planned.refused) log("job_user_group_refused", { cause: planned.cause, backend: PODMAN_BACKEND });
		if (planned.user && config.forwardEnv.includes("HOME")) log("forward_env_home_overridden", { reason: "HOME is set beside --user", backend: PODMAN_BACKEND });
	}
	// Resolved once: `Intl` is not free, and this value cannot change without a restart.
	const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
	const registry = makeHostRegistryFn({ redis, name: config.workerName, log });
	// Issue #596, phase 2: one integer of the host budget's snapshot for the beat, or "" before the worker exists.
	const snapshotField = (key) => {
		const snap = worker?.hostBudget?.snapshot?.();
		return Number.isSafeInteger(snap?.[key]) ? String(snap[key]) : "";
	};
	// NOT awaited, and that is load-bearing rather than an optimisation. `makeRedisClient` sets
	// `maxRetriesPerRequest: null` -- required for BullMQ's blocking connections -- which means a command
	// issued against an unreachable server QUEUES FOREVER instead of rejecting. Awaiting the first beat
	// would therefore hang boot indefinitely on a deployment whose Valkey is down, turning a telemetry
	// keyspace into a boot dependency. The registry is never on a decision path, so a worker that comes
	// up before its own row does is correct: the row appears when Valkey does.
	void registry.start({
		version: WORKER_VERSION,
		image: config.jobImage,
		imageDigest: bootImage.imageDigest ?? "",
		piVersion: bootImage.piVersion ?? "",
		// A thunk, because the spec says this row carries the LIVE slot count and the overlay can lower it
		// mid-run through `dispatch_set`. A literal here would publish the boot value forever.
		concurrency: () => worker?.concurrency ?? bootConcurrency,
		pid: process.pid,
		// Whether this host DRAINS a queue of its own. Every worker publishes a row; only a host that declared
		// a name has somewhere for routed work to go, and a reader must not invent a queue for one that has not.
		routes: config.workerNameDeclared,
		// What this host can serve that another might not (issue #57, `OQ-032`): the secret and wait profiles
		// it has declared. NAMES only, never the resolver paths behind them -- a path is PII on Windows and
		// operator topology everywhere, and the receiver only needs to know WHICH host, not what it runs.
		//
		// Recomputed per beat rather than frozen at boot, for the reason the digest is: a host that gains a
		// profile on restart must start attracting that work within one beat, and one that loses it must stop.
		caps: () => serializeCaps(capabilityTokens(config)),
		// The host's IANA zone, because a cron PATTERN carries none: `triggers.json` has no `tz` field and
		// BullMQ hands the pattern to cron-parser with no zone, so it resolves in each worker's LOCAL time.
		// On one host that is exactly what an operator means; on two in different zones the same pattern is
		// two different instants, and nothing anywhere says so. Published now so a later slice can refuse.
		tz: hostTz,
		// The cron fingerprint rides every beat from the LIVE ref, so a peer always compares against what
		// this host believes now rather than what it believed at boot. `null` means abstain: cron disabled
		// here is no opinion at all, and such a host must never be able to disagree with one that has one.
		fpCron: () => cronFingerprint(authoredCron(config), { tz: hostTz }) ?? "",
		cronCount: () => schedules.current.length,
		// Issue #501 part 6: a fingerprint of the dollar caps this host judges the SHARED dollar counters against (the four
		// settings as a job resolves them, and the scoped-limits dollar rows), so doctor can name two hosts that would
		// admit different jobs against one counter. A thunk for `fpCron`'s reason: the overlay and the scoped-limits file
		// change without a restart. Read without a log, so an invalid overlay is not logged on every beat (each job
		// logs it already). With an invalid overlay it hashes the env values, the slot count's fallback above; such a
		// host refuses every job (settings-overlay-invalid) until the file is fixed. The env list rides along: it decides
		// which model rows a job without its own list reserves in.
		fpUsd: () => {
			const settings = resolveSettings(config, readOverlay(settingsFile));
			return usdFingerprint(settings.invalid ? config : settings, scopedLimits.current, config.allowedModels);
		},
		// Issue #499 part C: a fingerprint of the LIVE projects (ids and member hashes, never a name), so doctor can name a
		// host whose projects.json differs. Each host resolves its own jobs' project from its own copy, while the project
		// rows' counters are shared, so two copies put one repo in two projects. A thunk, so a live edit shows in one beat.
		fpProjects: () => projectsFingerprint(projects.current),
		// Issue #504 part B: the digest of this host's live envelope (`envelopeDigest`, 16 hex, never a value), so doctor can
		// name a host whose envelope differs; such a host refuses governed jobs as `envelope-mismatch`. `none` without one.
		fpEnvelope: () => envelope.digest ?? NO_ENVELOPE_FINGERPRINT,
		// Issue #596: the highest scoped-limits version this build reads, so doctor can name a worker that would keep its
		// last good file (so no size and no later edit to the file applies on it) once the file is version 3. An integer.
		limitsVersion: SCOPED_LIMITS_VERSION,
		// Issue #596, phase 2: this host's budget and what its jobs hold against it, integers (MiB and hundredths of a CPU),
		// `off` for a budget switched off and "" while unknown, so doctor and a forge job's never-fits check can read which
		// host a size fits on. Thunks over the worker's one budget, so every beat says what is held now.
		budgetMemMiB: () => budgetField(worker?.hostBudget?.current().memMiB ?? null),
		budgetCpuCenti: () => budgetField(worker?.hostBudget?.current().cpuCenti ?? null),
		usedMemMiB: () => snapshotField("usedMemMiB"),
		usedCpuCenti: () => snapshotField("usedCpuCenti"),
		heldMemMiB: () => snapshotField("heldMemMiB"),
		heldCpuCenti: () => snapshotField("heldCpuCenti"),
		budgetRunning: () => snapshotField("running"),
		budgetHolds: () => snapshotField("holds"),
		budgetOrphans: () => snapshotField("orphans"),
		// P2G1-L4: whether the boot listing of the job containers left from before this worker started has been read
		// (`listed`); until it is, the worker admits no job (`unlisted`), and doctor says so. "" before the worker exists.
		budgetSeed: () => {
			const snap = worker?.hostBudget?.snapshot?.();
			return typeof snap?.seeded === "boolean" ? (snap.seeded ? "listed" : "unlisted") : "";
		},
	});


	// `local`'s two optional preflights (issue #354: they were `deps` closures, and are now the bundle's own members,
	// dispatched per venue by the registry). Bodies unchanged.
	//
	// Issue #278: the docker endpoint read AGAIN before each job's spend, because a `docker context use`
	// after boot redirects every later job, and a preflight that answered once at boot would give a
	// wrong decision all day (the image preflight is not cached for the same reason). Only for a venue
	// whose declaration is observation-gated on it, and only a refusal under a floor that needs it.
	// Issue #345: the runtime observations come from the same per-job read, in the same place: the facts the job user is
	// decided from (cached per endpoint state, so no second daemon call) and this host's Podman files, re-read per job
	// because an operator creating the empty mounts.conf override must not need a restart.
	const localObservationPreflight = async (job) => {
		const venue = resolveBackendName(job, config.defaultBackend);
		if (Object.keys(backendFor(venue)?.observedBy ?? {}).length === 0) return { ok: true };
		const endpoint = await resolveDockerEndpointFn();
		const state = dockerEndpointState(endpoint);
		if (state !== endpointSeen) {
			endpointSeen = state;
			logDockerEndpoint(log, endpoint, { changed: true });
		}
		// The endpoint refusal FIRST, from the CLI's own configuration only, as boot does: a floor that distrusts this
		// endpoint must not wait on, or send the CLI's own TLS client credentials to, the daemon behind it.
		const endpointArgs = {
			backends: [venue],
			backendFloor: config.backendFloor,
			observations: { [DOCKER_ENDPOINT_LOCAL]: endpoint.local === true },
			evidence: { [DOCKER_ENDPOINT_LOCAL]: dockerEndpointEvidence(endpoint) },
			only: [DOCKER_ENDPOINT_LOCAL],
		};
		const [endpointRefusal] = observationRefusals(endpointArgs);
		if (endpointRefusal) {
			if (endpoint.local === null && endpoint.transient) return { unavailable: true, reason: endpoint.reason };
			return { refused: true, message: endpointRefusal, observations: [DOCKER_ENDPOINT_LOCAL] };
		}
		budgetEndpoint = { endpoint, key: state };
		const jobUser = await resolveJobUser({ endpoint, key: state });
		const unit = await readRootfulService({ endpoint, daemon: jobUser.daemon, readService: readPodmanServiceFn });
		// One read of each host path for this job's two checks (`onceFs`, gate round 3 of PR #473), fresh per job.
		const jobFs = onceFs(observationFs);
		const observed = observeHost({ endpoint, daemon: jobUser.daemon, fs: jobFs, unit, env, memory: rootfulMemory });
		if (runtimeObservationKey(observed) !== runtimeObservedSaid) {
			runtimeObservedSaid = runtimeObservationKey(observed);
			log("runtime_observed", { daemonAppliesBounds: observed.observations.daemonAppliesBounds, runtimeAddsNoMounts: observed.observations.runtimeAddsNoMounts, changed: true });
		}
		// Issue #448: rootful Podman's containers.conf, per job and before any spend, re-read every time because removing a
		// key must need no worker restart (only the Podman service's). Handed back as the podman venue's refusal is
		// (`podmanConfRefused`, `rootful: true`), ahead of the floor: it is what the venue IS on this host, and the processor
		// returns it before the image preflight. Nothing is read where the daemon is not rootful Podman on this host.
		const rootful = await observeRootfulConf({ endpoint, daemon: jobUser.daemon, fs: jobFs, readService: readPodmanServiceFn, env, unit, memory: rootfulMemory });
		sayRootfulUnread(rootful);
		if (rootful?.refusal) return { ok: true, endpoint, jobUser, podmanConfRefused: rootfulRefused(rootful.refusal) };
		const args = {
			backends: [venue],
			backendFloor: config.backendFloor,
			observations: observed.observations,
			evidence: { [DOCKER_ENDPOINT_LOCAL]: dockerEndpointEvidence(endpoint), ...observed.evidence },
		};
		const [refusal] = observationRefusals(args);
		if (!refusal) return { ok: true, endpoint, jobUser };
		const missed = [...new Set(unobservedFloor(args.backends, args.backendFloor, args.observations).map((m) => m.observedBy))];
		if (observationRefusalIsTransient(args)) return unavailableFor(observed, missed[0]);
		return { refused: true, message: refusal, observations: missed };
	};
	// Issue #452, gate round 5: the runtime each local job was admitted on, by job id, taken (and forgotten) by that job's
	// teardown. Bounded: a job refused after its job-user preflight never reaches a teardown, so the oldest entries go first.
	const admittedRuntimes = new Map();
	const ADMITTED_RUNTIMES_MAX = 1000;
	const recordAdmittedRuntime = (job, runtime) => {
		if (job?.id === undefined || runtime === undefined) return;
		admittedRuntimes.delete(job.id);
		admittedRuntimes.set(job.id, runtime);
		while (admittedRuntimes.size > ADMITTED_RUNTIMES_MAX) admittedRuntimes.delete(admittedRuntimes.keys().next().value);
	};
	const takeAdmittedRuntime = (job) => {
		const runtime = admittedRuntimes.get(job?.id);
		admittedRuntimes.delete(job?.id);
		return runtime;
	};
	// Issue #341: the job user, for a job on the `local` venue only (its containers are this host's docker
	// CLI's). The endpoint is the one `observationPreflight` just read, so one job's two decisions agree.
	const localJobUserPreflight = async (job, { capabilities = [], observed } = {}) => {
		const venue = resolveBackendName(job, config.defaultBackend);
		if (venue !== DEFAULT_BACKEND) return { user: null, home: null };
		const endpoint = observed?.endpoint ?? (await resolveDockerEndpointFn());
		if (!observed?.jobUser) budgetEndpoint = { endpoint, key: dockerEndpointState(endpoint) };
		const admittedOn = observed?.jobUser ?? (await resolveJobUser({ endpoint, key: dockerEndpointState(endpoint) }));
		const { decision, socket, facts } = admittedOn;
		// Issue #452, gate round 5: the runtime THIS job is admitted on, recorded per job for its teardown's detach gate. The
		// resolver's cache is per endpoint state and moves when the endpoint does, so reading it at teardown could hand a
		// job the answer of another endpoint's daemon.
		recordAdmittedRuntime(job, admittedOn?.daemon?.answered ? runtimeFromFacts(admittedOn.daemon) : undefined);
		if (jobUserLogKey(decision) !== jobUserSaid) {
			jobUserSaid = jobUserLogKey(decision);
			log("job_user", { mode: decision.mode, user: decision.user, cause: decision.cause, reason: decision.reason });
		}
		const chosen = resolveImageUser(decision, { capabilities, euid: jobUserIdentity.euid, egid: jobUserIdentity.egid, socket });
		// Issue #355: whether this job's own mounts carry `:Z`, from the SAME facts and endpoint the user was decided
		// from, so one job's two answers cannot come from two reads. Only on a path that runs (a refusal or an
		// undecidable daemon runs nothing), and only when true: every host this does not apply to keeps the answer
		// shape, and so the argv, it had before.
		if (chosen.refused || chosen.unavailable) return chosen;
		// Issue #596: the daemon's CPU count from that same read, for the job's `--cpus` ceiling. Absent when it did not say.
		// Beside it, the size flags the same daemon said it drops (SwapLimit or CPUShares false), which the job logs.
		const unenforced = unenforcedSizeFlags(facts);
		const counted = Number.isSafeInteger(facts?.hostCpus) ? { ...chosen, hostCpus: facts.hostCpus } : chosen;
		const sized = unenforced.length > 0 ? { ...counted, unenforced } : counted;
		return relabelsPrivateMounts(facts, endpoint, jobUserIdentity.platform) ? { ...sized, relabel: true } : sized;
	};

	// #227: WHERE this job's container runs. The three functions that decide whether a container may start and
	// then start it -- two pre-spend gates and the launcher -- bundled into one value with a completeness
	// check, so the set has a name instead of being three unrelated `deps` keys. Byte-identical to passing them individually -- the same three functions reach the same three keys,
	// built from the same config, behind the same injectable factories -- and this is the seam a second
	// backend is selected at once there is one to select.
	//
	// Assigned key by key below rather than spread, because the bundle also carries `name` and `declares`,
	// and `deps` is the processor's namespace: a spread would put a backend's name into it under a key the
	// processor is free to mean something else by.
	//
	// Issue #354: built ONLY while `local` is blessed. Built unconditionally, as it was while PI_BACKENDS had to include
	// it, it would be a registered venue this deployment never chose, whose reaper the boot map must then carry and
	// whose reads spawn `docker` on a host that may have none. The two optional preflights ride on the bundle rather
	// than through `makeLocalBackend`, whose completeness check treats every member it takes as required.
	const localBackend = localBlessed
		? {
				...makeLocalBackend({
					// #227. The two the earlier slices deferred, now real seams. `reap` keeps its tri-state: the boot
					// sweep below only sweeps this host's scope claims once the reaper has PROVEN this host holds no
					// job containers, and an unproven answer must never free a slot.
					stopContainer: makeStopContainer(),
					reap: backendReaps[DEFAULT_BACKEND],
					// One deployment default, two consumers, adjacent by construction: the preflight that refuses a missing
					// image BEFORE the budget slot, and the factory that puts it in the argv. Both resolve a trigger's own
					// `run.image` through the same resolveJobImage, so the image that was checked is the image that runs.
					// Nothing is memoised (see its construction above): `docker image inspect` costs ~tens of ms against a
					// container run of minutes, and a cache would be wrong in both directions -- an operator who builds the
					// image mid-day would stay refused, one who removes it would stay admitted. Contrast the staged-package
					// manifest, correctly read once at boot because it is deploy-time state under a :ro mount.
					imagePreflight,
					// REQ-EGRESS-ALLOWLIST, and built here for the same reason the image preflight is: one deployment
					// value, one place, so the gate that checks the proxy and the runner that attaches to its network
					// cannot disagree about which proxy is meant. Nothing is memoised here either -- an operator who
					// starts the proxy mid-day must not stay refused, and one who stops it must not stay admitted.
					// Unarmed it spawns nothing at all, so a deployment without a policy pays for none of this.
					egressPreflight: makeEgressPreflightFn({ proxy: config.egressProxy, armed: config.egress }),
					runContainer: makeRunContainerFn({
						image: config.jobImage,
						hostEnv: env,
						egress: config.egress, // REQ-EGRESS-ALLOWLIST: the per-job network and the proxy variables
						egressProxy: config.egressProxy,
						openJobLog,
						globalPiDir: config.globalPiDir, // REQ-GLOBAL-PI-OVERLAY: :ro overlay mount when configured
						allowGlobalExtensions: config.allowGlobalExtensions,
						// REQ-GLOBAL-PI-OVERLAY: staged package paths; every job receives them unless its trigger set
						// packages:false. A RESOLVER, not the array: the factory is still constructed exactly once, only
						// the value it reads became a call, so a re-stage takes effect on the next job without a restart.
						packagePaths: getPackagePaths,
						forwardEnv: config.forwardEnv,
						authFromPi: config.authFromPi, // source the provider key from ~/.pi/agent/auth.json when env has none
						// Self-hosted instance URLs, keyed by forge. A MAP rather than one scalar per forge: the table says
						// which variable each lands in, so a forge with no self-hosted concept simply has no entry, and
						// adding one does not widen this signature again.
						forgeHosts: { gitlab: config.gitlab?.apiUrl ?? null, forgejo: config.forgejo?.apiUrl ?? null, azure: config.azure?.orgUrl ?? null },
						// Issue #452, gate round 4: the teardown's detach gate uses the `docker info` facts this job was admitted
						// on (the job-user resolver's cached answer), never a fresh read, which on Docker Engine read as
						// `runtime-unreadable` whenever it timed out or failed and leaked the job's network. No cached answer: it
						// reads. A refused teardown is logged with its token.
						teardownRuntime: (job) => takeAdmittedRuntime(job),
						log,
						// Issue #596: Docker refused a job's `--cpus` as above its CPU count, so the count the resolver cached is
						// stale (a resized Docker Desktop VM); the next pickup reads the daemon again.
						onCpuCeilingStale: () => resolveJobUser.invalidate?.(),
					}),
				}),
				observationPreflight: localObservationPreflight,
				jobUserPreflight: localJobUserPreflight,
			}
		: null;

	// #227. WHICH backend runs which job, and the one place that decides. One bundle today, so every
	// resolution returns it -- but the mechanism is real, so `run.backend` stops being a validated label and
	// the abort path can reach a venue it did not build. `config.backends[0]` is the deployment's default,
	// and the registry refuses a default it does not hold rather than discovering it at the first pickup.
	// A refusal here comes AFTER boot opened the Redis client, the runtime and cron queues and the host registry, so all of
	// them are released before the refusal travels: any one left open keeps the event loop alive, and a worker that refused
	// to boot would hang instead of exiting (measured against a real Valkey: two sockets held past 30 s).
	let backends;
	try {
		backends = makeBackendRegistryFn({
			// #227. A SEAM, not a literal. `docs/backends.md` tells an adapter author to register their bundle
			// here, and until this was injectable that instruction described code nobody could run: the array
			// was hard-coded, so a venue could pass the conformance suite, get a table entry and be blessed in
			// PI_BACKENDS, and then be refused at boot as blessed-but-unbuilt with nowhere to put it. It is also
			// what lets a wiring test prove `startWorker` actually CONNECTS the registry to the processor --
			// six mutations reverting that connection survived the whole suite, which is the same shape as the
			// bug that shipped: invisible while there is one venue.
			bundles: [...(localBackend ? [localBackend] : []), ...builtBackends],
			defaultName: config.defaultBackend,
			// Cross-checked at boot rather than discovered at the first pickup: a name PI_BACKENDS blesses but
			// nothing builds passes both the loader and the pre-spend gate, and a venue with no boot reaper is
			// swept by nothing while still reporting the host as proven clean.
			blessed: config.backends,
			reaps: backendReaps,
		});
	} catch (err) {
		const opened = [registry, runtimeQueue, ...(cronQueue !== runtimeQueue ? [cronQueue] : [])];
		// Bounded, then forced: a queue whose connection came up closes by sending QUIT and awaiting the reply, and against a
		// server that stopped answering that wait never ends (measured through a stalling proxy), so the refusal itself would
		// never travel. Five seconds covers the host registry's own bounded close; whatever is still open is disconnected.
		await settleWithin(Promise.allSettled(opened.map((handle) => Promise.resolve().then(() => handle?.close?.()))), 5_000);
		for (const handle of opened) {
			try {
				handle?.disconnect?.();
			} catch {
				// a handle with nothing left to drop
			}
		}
		redis.disconnect();
		throw err;
	}

	// The auxiliary handles the shutdown closes after the worker drains (`index.mjs` -> shutdown). A NAMED
	// array rather than the literal it used to be, because up to three of its members do not exist yet: the
	// live-edit watchers are armed at the END of boot, below, and deliberately after the boot reconcile --
	// arming them earlier would let an operator edit run `reloadSchedules` concurrently with the boot
	// `reconcileGated`, on a different queue handle, and reconcile's orphan prune is not safe against that.
	//
	// PUSHING AFTER THE HANDOFF IS SOUND FOR ONE REASON ONLY: `index.mjs` reads this array at SHUTDOWN time,
	// not when it receives it, and so does the test harness at teardown. A refactor that COPIES it there --
	// a spread, a freeze, a snapshot inside `createWorker` -- un-registers the watchers in SILENCE and puts
	// issue #295 back. Append only: two tests pin `[0]` as the runtime queue and `[1]` as the registry.
	const extraClosers = [runtimeQueue, registry, ...(cronQueue === runtimeQueue ? [] : [cronQueue])];

	// HOISTED out of the deps literal (issue #288): the terminal failed listener below needs the same
	// adapter the processor gets, and two bodies would drift exactly where drift costs a public comment.
	const comment = async (job, text) => {
		// Best-effort: the processor awaits comment() inside its try, so a rejection here would
		// corrupt the job outcome and could drive a wrong retry / second PR (CONST-RETRY-INFRA-ONLY).
		// This adapter NEVER throws.
		const forge = forgeFor(job);
		// Same re-resolve as the mint path, and it matters more here: a comment is how a refusal
		// reaches the person who asked for the job, so a forge whose auth was merely unreachable at
		// boot must not degrade every later comment to a stdout line nobody is watching.
		//
		// A THROWING re-resolve is treated as no auth rather than as a failed comment, which is what
		// keeps the fallthrough below reachable: the text still lands on stdout instead of being
		// replaced by a `comment_failed` line that does not carry it. This adapter never throws.
		let auth = forge?.auth ?? null;
		if (forge && !auth) {
			try {
				auth = await ensureAuth(job.kind);
			} catch {
				auth = null;
			}
		}
		if (auth) {
			try {
				const token = await auth.mintToken(job);
				await forge.host.postStatusComment(job, job.target, text, token);
			} catch (err) {
				log("comment_failed", { jobId: job?.id, reason: err?.message });
			}
			return;
		}
		// A local job, or a forge-backed one whose auth never came up. Either way there is nowhere to
		// post, so the line on stdout IS the completion signal (REQ-LOCAL-JOB-VISIBILITY).
		log("comment", { jobId: job?.id, text });
	};

	// The operator's failure hook (issue #288, INT-ON-FAILURE-HOOK-CONTRACT). Constructed ONLY when the
	// knob is set: an unset PI_ON_FAILURE builds nothing, spawns nothing, and logs nothing -- the
	// byte-identical guarantee. Fired from the two terminal listeners below, never from the processor:
	// a hook fault must not be able to flip an outcome, and the listeners sit outside every try that
	// decides one.
	// `hostEnv: env`, not the default process.env -- the #309 rule every spawner in this file follows
	// (runContainer, resolveSecrets): a subprocess runs with THIS worker's env, identical on the real
	// path and divergent only under an injected one, which is exactly where the difference would hide.
	const onFailure = config.onFailure
		? makeOnFailure({ command: config.onFailure, timeoutMs: config.onFailureTimeoutMs, host: config.workerName ?? "", hostEnv: env, log })
		: null;
	// Which POLICY reasons page the operator. Paid terminals only: worker-abort, runner-policy and every
	// named runner reason cost a container and ended wrong. The runner's named reasons are SPREAD from
	// RUNNER_POLICY_REASONS rather than listed, because each is an exit 2 that would have paged as
	// runner-policy before it got its own label, and a label must not be the thing that silences a page;
	// provider-auth-refused (issue #437) is the case in point, a refusal only the operator can fix. Excluded on purpose: `completed` and every pre-spend refusal (free, and
	// each already comments -- a delivery storm against a spent cap must not page anyone), and
	// `operator-cancel`, because the operator initiated it and a push telling them what they just did is
	// noise with a pager attached.
	// `oom-killed` (issue #596) is a paid terminal the operator alone can fix (a job's memory size), so it pages too.
	const HOOK_POLICY_REASONS = new Set(["worker-abort", "runner-policy", EXIT_OOM_KILLED, ...RUNNER_POLICY_REASONS]);
	// One predicate for the completed listener and the lost-lock path below, so a record replays exactly the page its
	// result would have sent.
	const pagesAsPolicy = (result) => Boolean(onFailure) && result?.outcome === "policy" && HOOK_POLICY_REASONS.has(result.reason) && result.budgetReserved !== false;
	// The infra-terminal sentence (issue #288). FIXED, never err.message: the message classes that reach
	// a failedReason carry host paths and library words (the #310 record), and for a local job this text
	// lands verbatim in the service log through the adapter's stdout fallthrough. The worker log already
	// holds the truncated reason on the job_failed line beside it.
	const FAILED_COMMENT = "Failed: an error stopped this job and it will not be retried further. Ask the operator to check the worker log.";
	// Issue #458 (PR #463 round 2): a job that never started because the podman venue's rootless network keeper did not
	// hold says so, since the generic line sends an operator to a log that only says the job failed. Fixed text keyed by
	// the fixed reason token, never the error's own words: a forge comment carries nothing a host read produced.
	const FAILED_COMMENT_BY_REASON = Object.freeze({
		// Neutral on the cause (PR #463 round 3): a keeper that is not running and a proxy that must restart after it both land here.
		[NETNS_KEEPER_NOT_HOLDING]: "Failed before it started: this worker's rootless Podman egress proxy did not pass its pre-start check (its rootless network keeper, pi-dispatch-netns-keeper), so the job was retried and never run. Nothing was spent. Ask the operator to run `pi-dispatch doctor` on the worker for the exact fix.",
		// Issue #476: a job held on a young keeper that kept restarting while it waited.
		[NETNS_KEEPER_CRASH_LOOP]: "Failed before it started: this worker's rootless network keeper (pi-dispatch-netns-keeper), which its Podman egress proxy needs, kept restarting while the job waited for it, so the job was retried and never run. Nothing was spent. Ask the operator to run `pi-dispatch doctor` on the worker and read the keeper's log (`journalctl --user -u pi-dispatch-netns-keeper.service`).",
		// Issue #448 (gate round 2 of PR #473): the hold's own ending, so the comment names the cause and the fix.
		[PODMAN_RESTART_HOLD_EXPIRED]: "Failed before it started: rootful Podman's service on this worker kept running with a containers.conf older than its files (or a file's change time stayed ahead of the host's clock) for an hour, so the job was held and never run. Nothing was spent. Ask the operator to restart it while no local job runs (`sudo systemctl restart podman.service`), then run the job again.",
	});

	const worker = createWorkerFn({
		connection: valkeyConn(),
		// Issue #596, phase 2 (DES-HOST-BUDGET): the host budget's inputs. `createWorker` builds the ONE budget from them and
		// shares it between both queues' processors. The settings and the default size were refused at boot if bad.
		hostBudget: {
			settings: config.hostBudget,
			jobDefault: { memMiB: config.jobSize.memMiB, cpuCenti: config.jobSize.cpuCenti },
			readFacts: readHostFacts,
			onRefresh: syncCpuReserve,
			containerGone: containerGoneFn ?? makeContainerGone({ binOf: (venue) => (resolveBackendName(venue ?? {}, config.defaultBackend) === PODMAN_BACKEND ? "podman" : "docker") }),
			// P2G1-L4: AFTER the boot reaper (above), every blessed venue's remaining job containers, seeded into the ledger
			// as orphans from their size labels. One venue that cannot be listed fails the whole listing: the budget then
			// admits nothing until a tick reads it, because a container nobody counted is an overcommit.
			survivors: async () => {
				const venues = [...(localBlessed ? [[DEFAULT_BACKEND, "docker"]] : []), ...(podmanBlessed ? [[PODMAN_BACKEND, "podman"]] : [])];
				const all = [];
				for (const [backend, bin] of venues) {
					for (const c of await listJobContainersFn(bin)()) all.push({ ...c, venue: { backend } });
				}
				return all;
			},
			now,
			log,
		},
		// #227. The abort path's stop, resolved per job rather than hard-wired to docker. A container NAME is
		// not enough to find the runtime holding it once there is more than one venue.
		stopContainer: backends.stopContainer,
		// The NAME the abort stops, built by the venue that will build the container rather than by the local
		// adapter reached for directly -- the name and the stop have to come from the same venue.
		containerName: backends.containerName,
		hostQueue,
		// Names the BullMQ Worker, which makes `getWorkers()` rows tell hosts apart -- bullmq appends
		// `:w:<name>` to the client name and `moveToActive` stamps `processedBy` onto each active job's
		// hash, so per-job host attribution arrives for free. A NICETY on top of the registry and never the
		// source of truth: that call rests on CLIENT SETNAME, which bullmq's own doc-comment says some
		// providers do not support, and a host list that silently empties cannot be what a decision reads.
		name: config.workerName,
		concurrency: bootConcurrency,
		getSettings,
		redis,
		recordRun,
		settledRecord,
		extraClosers,
		// REQ-SCOPED-PAUSE-WINDOWS: the processor defers a job whose folder/repo is inside an active window.
		// Reads the live-reloaded ref, so an operator edit takes effect on the next job without a restart.
		pauseUntil: (job, now) => pauseUntilMs(pauseWindows.current, job, now),
		// Issue #242: the scoped-limits snapshot the pickup gate and the scoped budget read, once per
		// pickup, from the live-reloaded ref -- same next-job grain as pauseUntil above.
		scopedLimits: () => scopedLimits.current,
		// Issue #499: the projects snapshot, read by the pickup gate once, beside the limits snapshot above.
		projects: () => projects.current,
		// Issue #596: the deployment's default job size, the two settings `loadConfig` already refused at boot if bad. ENV
		// ONLY, never the settings overlay, so a size cannot change under a running worker.
		jobSizeEnv: { PI_JOB_MEMORY: env.PI_JOB_MEMORY, PI_JOB_CPUS: env.PI_JOB_CPUS },
		// Issue #504 part B: the live envelope and its digest, and the reconcile the pickup runs before it narrows a job's
		// dollar ledgers by the applied split. Without an envelope `current()` is null, and `fleetGoverned` asks whether an
		// applied split exists: if it does, this host's jobs refuse as envelope-mismatch rather than run ungoverned.
		allocation: { current: () => (envelope.current ? { envelope: envelope.current, digest: envelope.digest } : null), reconcile: allocationState.reconcile, fleetGoverned: allocationState.fleetGoverned },
		// Issue #230. The `after` ceiling is read per pickup from config rather than frozen into the
		// processor, so it is one value with one home; the wait state shares the budget's redis client
		// because it describes the same delayed jobs that client already reasons about.
		afterMaxMs: () => config.waitAfterMaxMs,
		waitState: makeWaitState({ redis }),
		// The polled tier's bounds, read per pickup from config so they are one value with one home. The
		// slot count is a CEILING the gate clamps against the live concurrency, never the final number.
		// The fleet-wide half of the wait-check bound (issue #57), armed on the same predicate as the host
		// queue: declaring a name is declaring a fleet. Its TTL is DERIVED rather than guessed -- the gate
		// holds the lease across every profile in turn, each bounded by the check timeout, so one timeout
		// per profile plus one for the overhead between them.
		// The fleet-wide half of a scoped `concurrent` ceiling. Its TTL is DERIVED rather than guessed, and
		// derived is what makes a heartbeat unnecessary: `JOB_TIMEOUT_MS` is a hard 30-minute ceiling on how
		// long any container can run, so a TTL above it cannot expire underneath a live job -- which is the
		// failure that would matter, because it would let another host start a second container on a scope
		// the operator limited to one. Nothing refreshes this claim, deliberately: a refresher would be a
		// second thing to get wrong for a window that cannot be reached.
		scopeLease: hostQueue ? makeFleetLease({ redis, holderPrefix: config.workerName, keyFor: scopeSlotKey, ttlMs: SCOPE_CLAIM_TTL_MS, log }) : null,
		// Issue #503: the fleet-wide half of a model endpoint's `slots`, armed like the scope lease (declaring a name is
		// declaring a fleet) and with its TTL for its reason: the claim lives as long as the job's container, which
		// `JOB_TIMEOUT_MS` bounds. Without a declared name only the in-process bound applies, per host.
		endpointLease: hostQueue ? makeFleetLease({ redis, holderPrefix: config.workerName, keyFor: endpointSlotKey, ttlMs: SCOPE_CLAIM_TTL_MS, log }) : null,
		// The endpoint gate's snapshot, read per pickup: the live-reloaded declaration and the overlay models.json, which
		// the operator edits without a restart too. Read only when an endpoint is declared (the gate's own rule).
		modelEndpoints: () => modelEndpoints.current,
		overlayModels: () => readOverlayModels(config.globalPiDir),
		checkLease: hostQueue
			? makeFleetLease({
					redis,
					holderPrefix: config.workerName,
					keyFor: checkSlotKey,
					ttlMs: config.waitCheckTimeoutMs, // a floor; the gate passes the real one, derived from the profile count
					log,
				})
			: null,
		checkSlotCount: () => config.waitCheckSlots,
		checkTimeoutMs: () => config.waitCheckTimeoutMs,
		intervalMs: () => config.waitIntervalMs,
		maxWaitMs: () => config.waitMaxMs,
		maxChecks: () => config.waitMaxChecks,
		maxFaults: () => config.waitMaxFaults,
		deps: {
			collectChain,
			collectPlan,
			// The one-shot pre-spend check (issue #231): reads the same file the disarm writes, refuses
			// only on a FOREIGN positive mark (index.mjs binds the real queue jobId so a retry of the
			// spending delivery is excused). In the compose topology this check is the once-enforcement
			// layer, because the receiver's single-file :ro mount pins a dead inode until restart.
			checkOnceSpent: makeCheckOnceSpent({ triggersPath: onceTriggersFile }),
			// Issue #310. The free provider-credential gate, bound from EXACTLY the values the container builder
			// is handed, and asserted to be the same by a wiring test. A gate that resolves against different
			// inputs than the writer is the divergence class this whole cluster of issues is about: it would pass
			// a job the container then refuses, or refuse one the container would have run. `agentDir` is
			// defaulted by both, from the same `hostEnv`.
			//
			// A processor dep and NOT a backend bundle member: the bundle is a closed set about how a venue runs
			// a container, and this is a question about the deployment, asked before any venue is chosen.
			//
			// A PROBE: whatever it resolves is dropped on the floor. The credential itself is read where it always
			// was, inside buildContainerEnv, so no live key is ever in scope in the processor.
			// Issue #503: `modelEndpoints` is the pickup's snapshot, the same one runContainer hands buildContainerEnv.
			checkProviderCredential: (job, { modelEndpoints = null } = {}) => {
				try {
					resolveProviderCredential({ provider: job.provider, hostEnv: env, authFromPi: config.authFromPi, forwardEnv: config.forwardEnv, modelEndpoints });
					return { ok: true };
				} catch (error) {
					// Only OUR determinate refusal. Anything else (a bug here, an fs fault the module does not model)
					// must not become a policy refusal on the operator's issue: it rethrows into runJob's catch, which
					// classifies it the way it always did.
					// Issue #503: a transient overlay read at this pickup is no verdict; the processor retries it as infra.
					if (error?.piDispatchTransient === true) return { ok: false, unavailable: error.code ?? "unreadable" };
					if (error?.piDispatchConfig !== true) throw error;
					return { ok: false, message: error.message };
				}
			},
			// Issue #502. The model-exists gate: pi's builtin catalog, then the overlay models.json, read at most once per
			// job and only when a model is not builtin, so the operator's edits apply without a restart. The SAME file
			// the endpoint gate reads, through the same reader, so absent, unreadable and unparseable mean one thing.
			checkModelsKnown: (refs) => checkModelsKnown(refs, { readOverlay: () => readOverlayModels(config.globalPiDir) }),
			// Issue #503 part 7: the builtin catalog's model object, for the zero-rated check that lets a job on local
			// zero-rated models reserve nothing in the dollar windows (processor.mjs, `zeroRatedVerdict`).
			builtinModel,
			// Issue #502. The deployment's allowed-model list (PI_ALLOWED_MODELS), null = unrestricted. Env only, and
			// handed to the processor here rather than through the settings overlay, which a model-callable tool writes.
			// index.mjs folds it into the effective job (`effectiveJobOf`) under the trigger's own `run.models`.
			allowedModels: config.allowedModels,
			// Issue #230. The same file and the same fail-open posture, but its own mtime-cached read: this one
			// asks whether the AUTHORED entry declares wait conditions the job arrived without, which is how a
			// service below the version floor turns a wait into a paid run nothing can tell from a correct
			// one. In the compose topology the worker's read is the live inode while the receiver's is dead
			// until restart, which is exactly the deployment where the skew happens.
			checkWaitSkew: makeCheckWaitSkew({ triggersPath: onceTriggersFile }),
			// Issue #505. Whether the live file still flags a portfolio job's cron trigger, read when such a job is picked
			// up, from the same file and by the same rule as the two checks above (built once, beside collectPlan).
			checkPortfolioFlag,
			// Issue #230. Whether a job the supersede lease names is still in the queue. Without it a holder
			// that vanished by any route except the clean one leaves a key that refuses every later delivery
			// for that target until it expires -- and a refused forge delivery is gone, since no webhook
			// resends it. `getJob` answers from the queue rather than from our own bookkeeping, so the two
			// cannot agree with each other while both being wrong.
			// REQ-WAIT-FOR's polled tier. Built here for the image and egress preflights' reason: one
			// deployment value, one place, so the gate that refuses an undeclared profile and the spawn that
			// runs it cannot disagree about which checks exist. The env-declared table is parsed once at boot
			// (it is env, not overlay -- the gate reads its config above the per-job settings read).
			// The free half of the profile check: whether this deployment declares the name at all. A table
			// lookup, so it belongs with the gate's other free refusals rather than inside the subprocess.
			waitProfileDeclared: (name) => typeof config.waitProfiles[name] === "string",
			checkWait: makeWaitChecker({ profiles: config.waitProfiles, timeoutMs: config.waitCheckTimeoutMs, log }),
			isJobLive: async (id) => {
				const held = await runtimeQueue.getJob(id);
				if (!held) return false;
				// EXISTENCE IS NOT LIVENESS, and the difference decides whether a target stays deafened:
				// `removeOnComplete`/`removeOnFail` keep a finished job's hash for 31 days, so a holder that
				// can never wake again would answer "still waiting" for a month. Only a state it can still be
				// picked up from counts.
				const state = await held.getState();
				return state === "delayed" || state === "waiting" || state === "active" || state === "prioritized" || state === "waiting-children";
			},
			imagePreflight: backends.imagePreflight,
			egressPreflight: backends.egressPreflight,
			// Issue #354: both are the VENUE's, dispatched through the registry like the two gates above, so a job on a
			// venue that carries neither gets the processor's own defaults and never asks this host's docker CLI anything.
			// `local`'s are the closures built beside its bundle below, unchanged.
			observationPreflight: backends.observationPreflight,
			jobUserPreflight: backends.jobUserPreflight,
			// Completed-only, so a policy or infra exit leaves the canonical transcript byte-identical and a
			// retry starts from what the first attempt did (CONST-RETRY-INFRA-ONLY).
			promoteSession: sessionStore.promoteSession,
			// The same value the store above was built from, passed explicitly so the processor's fail-closed
			// `run.resume` gate answers from THIS config rather than from its own env default. Identical on the
			// real path; the difference shows under an injected env, where the store would be built from the
			// synthetic value while the gate read the process one.
			sessionsDir: config.sessionsDir,
			// REQ-TRIGGER-SECRETS. Built here for the image and egress preflights' reason: one deployment
			// value, one place, so the gate that refuses an unknown profile and the spawn that runs it cannot
			// disagree about which resolvers exist. The env-declared table is parsed once at boot (it is env,
			// and a change to it is a restart), while the OVERLAY half arrives per job through index.mjs,
			// because the settings file is read at each job start and an operator who declares a profile in
			// the panel should not have to restart the worker to use it. A deployment that declares nothing
			// spawns nothing at all: the gate only calls this when a trigger is armed.
			// `hostEnv` is the env THIS worker was started with, not `process.env` by default (issue #309). It is
			// the environment the resolver subprocess runs in, and makeRunContainer above is handed the same
			// `env` for the container it builds. Identical on the real path, where both are process.env; under an
			// injected env they were not, which is the divergence this file already calls out by name for
			// sessionsDir. One deployment value, one place, same rule as the profiles below it.
			resolveSecrets: makeSecretsResolverFn({ envProfiles: config.secretProfiles, roots: config.secretResolverRoots, timeoutMs: config.secretResolveTimeoutMs, forwardEnv: config.forwardEnv, hostEnv: env, log }),
			// #227. What PI_BACKENDS blessed, so a trigger naming an unblessed venue refuses pre-spend. The
			// panel's picker is bounded by the same list, and this is the half that binds: the overlay is
			// not the reviewed artifact (DES-PER-TRIGGER-SECRET-PROFILE).
			blessedBackends: config.backends,
			runContainer: backends.runContainer,
			// #227. Resolved through the registry like every other per-job backend fact, so the integers the
			// processor treats as "never started" are the ones the venue that ran the job actually uses.
			// NOT `?? []`. An empty list means "this venue never reports a never-started exit", which sends a
			// 125 to the unknown-exit branch -- no `reason`, so the budget slot is KEPT and BullMQ retries,
			// burning a second one per never-started job. That is the bug the explicit case group was added
			// to fix. A bundle that omits the field is a wiring defect, so it fails loudly here rather than
			// silently in the money direction; `backends.mjs` requires it of every bundle.
			// Off the REGISTRY's surface, like every other per-job backend fact. Rebuilding it at the call site
			// is how a fact ends up dispatched on one path and hardcoded on another.
			neverStartedExits: backends.neverStartedExits,
			prepareWorkspace: makePrepareWorkspace({
				jobsDir: config.jobsDir,
				// Issue #464: the boot's own check, asked again before every job against the same env.
				ensureDir: (dir) => ensureJobsDirFn(dir, { env }),
				forgeFor,
				// REQ-RESURRECTABLE-SANDBOX: the deployment default, resolved per job against run.image so a
				// retained directory records the image that actually ran and a sandbox re-opens that one.
				jobImage: config.jobImage,
				// #277: the venue a retained directory records, which the sandbox refuses by when it is not here.
				defaultBackend: config.defaultBackend,
				// Issue #504 part B: a local job's folder is resolved at prepare and mounted resolved; one named inside a run
				// root or a cron folder must still resolve inside it, and none may be the envelope's folder or above it.
				localPlacement: { jobPaths: envelopeJobPathsNow, envelopeFile: config.envelopeFile ?? null },
				// Issue #505: /job/portfolio.json for a confirmed portfolio job.
				portfolioSnapshot,
				preparers: makeForgePreparers({ gitlabApiUrl: config.gitlab?.apiUrl ?? null, forgejoApiUrl: config.forgejo?.apiUrl ?? null, azureOrgUrl: config.azure?.orgUrl ?? null }),
				// The cron event.json's previousRunAt (INT-CONTAINER-JOB-INPUTS): read back from the same
				// per-job run-history sidecars recordRun writes above -- no new store, no new query surface.
				findPreviousRun: makeFindPreviousRun({ logsDir: config.logsDir }),
				// Which transcript, if any, a job continues (REQ-RESUMABLE-SESSION). Returns null for every
				// job whose trigger did not arm run.resume, whose key does not resolve, or when
				// PI_SESSIONS_DIR is unset -- and a null means no mount and nothing written.
				resolveSession: sessionStore.resolveSession,
			}),
			// REQ-RESURRECTABLE-SANDBOX. With the window at 0 this IS the old bare `cleanup`, by the same
			// `rm` on the same path -- a deployment that wants no retention keeps today's behaviour exactly.
			cleanup: makeCleanup({ sandboxDir: config.sandboxDir, retentionHours: config.sandboxRetentionHours, log }),
			comment,
			log,
			// Resolved per job so the credential always comes from the job's OWN forge. A job whose forge has
			// no working auth refuses here, at mint time, rather than running anonymously -- and the refusal
			// names the kind, because with more than one forge configured "auth is broken" is not diagnostic.
			//
			// A LOCAL job reaches this only via the `run.github: true` cron opt-in
			// (INT-TRIGGERS-FILE-CONTRACT), and that flag names github explicitly -- so it mints from the
			// github forge and not from a "default" one. There is deliberately no default: which forge a
			// token comes from must always be something the trigger said.
			mintToken: async (job) => {
				const kind = job?.kind === "local" ? "github" : job?.kind;
				// `ensureAuth` returns the boot-time auth when there is one, and otherwise re-resolves once
				// if boot's failure was transient (issue #316). It throws the transient failure through, and
				// that throw is UNTAGGED, so the arm below turns it into the retryable class rather than
				// letting it reach the processor's config classifier: "the forge was unreachable a moment
				// ago" is not "this deployment is misconfigured", and only one of those deserves a public
				// comment saying so.
				let auth;
				try {
					auth = await ensureAuth(kind);
				} catch (err) {
					// A determinate re-resolve failure carries the REAL reason (bad credentials, a key that
					// is not PKCS//8), which is strictly better than the generic message below, so it is
					// passed straight through rather than collapsed into it.
					if (err?.piDispatchConfig === true) throw err;
					throw new InfraRetry(`${kind} auth could not be resolved: ${err?.message ?? "unknown"}`);
				}
				if (auth) return await auth.mintToken(job);
				if (kind === "github") {
					throw configError("github jobs and cron triggers with run.github require a working GITHUB_AUTH_SOURCE (gh/pat/app)");
				}
				throw configError(`no forge credentials are configured for job kind ${JSON.stringify(job?.kind)} -- see .env.example`);
			},
			isDefaultBranchProtected: async (job, token) => {
				const host = forgeFor(job)?.host;
				if (!host) throw configError(`no forge host is configured for job kind ${JSON.stringify(job?.kind)}`);
				return await host.isDefaultBranchProtected(job, token);
			},
		},
	});

	// FROM HERE TO THE RETURN, THE WORKER IS LIVE AND THE BOOT CAN STILL REFUSE (issue #299). The
	// Worker starts consuming at construction, so everything below runs beside a paid drain --
	// registrations, the stall guard, the boot reconcile (the reachable refusal, reproduced), the
	// watcher pushes, the retention sweep's construction and start. A refusal that merely threw left
	// the process printing an error while taking jobs, because `cli.mjs` sets `process.exitCode` and
	// the live Worker held the loop forever. The catch below covers the REGION, not a list of calls,
	// so a step added tomorrow is covered the day it is added.
	try {

		// REQ-LOCAL-JOB-VISIBILITY: exactly one terminal line per job, carrying the job id and outcome,
		// where the operator is already looking. This is the local counterpart of the GitHub issue
		// comment and the signal for CONST-PI-VERSION-PINNED's silent-no-op mode -- a missing line is
		// what tells a human a run did nothing. The container's own output already streams via
		// runContainer's onOutput during the run.
		// `reason` is a fixed enum (worker-abort | over-budget | dollar-cap | allocation-cap | envelope-mismatch | portfolio-no-envelope | portfolio-snapshot-oversize | unprotected-branch | runner-policy |
		// provider-auth-refused | job-image-missing), never
		// user content. Included only when present so success lines stay clean; a shutdown-aborted job logs
		// { outcome: "policy", reason: "worker-abort" }, making a restart-dropped job visible.
		// BOTH workers, or a cron job on the host queue produces no `job_completed` line at all -- and
		// REQ-LOCAL-JOB-VISIBILITY's whole point is that a missing line is what tells a human a run did nothing.
		const allWorkers = [worker, ...(worker.hostWorker ? [worker.hostWorker] : [])];
		for (const w of allWorkers) w.on("completed", (job, result) => {
			log("job_completed", { jobId: job?.id, outcome: result?.outcome, ...(result?.reason ? { reason: result.reason } : {}) });
			// The hook's POLICY half (issue #288): worker-abort, runner-policy and provider-auth-refused RETURN, so they land here
			// and never in the failed listener -- a failed-only mount would miss exactly the paid terminals
			// the feature exists for. Folded into the existing listener body, never a second w.on: the
			// start-wiring harness records ONE handler per event, and two would race the log line's pin.
			// `budgetReserved !== false` (issue #502): `model-not-allowed` is both a runner stop (paid, pages) and a
			// pre-spend refusal of a main model outside the job's list (free, comments, pages nobody), and the reason
			// alone cannot tell them apart. Every paid terminal above carries `budgetReserved: true`.
			if (pagesAsPolicy(result)) {
				onFailure({ jobId: job?.id, outcome: "policy", reason: result.reason });
			}
		});
		// The failed listener's body, for a failure the queue decided. Split out only so the lost-lock check below can
		// run it after an await; a failure of any other reason runs it synchronously, exactly as before.
		const onFailed = (job, err) => {
			log("job_failed", { jobId: job?.id, attempt: job?.attemptsMade, reason: String(err?.message ?? err).slice(0, 120) });
			// The one reason whose sentence is the fix itself (issue #458): logged WHOLE, beside the cut line above.
			if (err?.reason === NETNS_KEEPER_NOT_HOLDING || err?.reason === NETNS_KEEPER_CRASH_LOOP) log("job_failed_netns_keeper", { jobId: job?.id, attempt: job?.attemptsMade, reason: String(err?.message ?? "") });
			// The TERMINAL failed attempt only (issue #288): `finishedOn` is set by BullMQ's own move on the
			// non-retry branch alone, and the emit follows it, so this guard reads the queue's decision
			// instead of re-deriving attempts arithmetic that could drift from shouldRetry. A retried
			// attempt comments nothing (a flaky daemon must not post three comments for one recovery) and
			// pages nobody; a recovery comments nothing at all. This seam also catches what the processor
			// never sees: the stall-kill (maxStalledCount 0 fails a crashed worker's job at next pickup)
			// and the wait-gate rethrow that escapes above the processor's catch.
			if (job?.finishedOn) {
				void comment({ ...job.data, id: job.id }, (typeof err?.reason === "string" && Object.hasOwn(FAILED_COMMENT_BY_REASON, err.reason) ? FAILED_COMMENT_BY_REASON[err.reason] : null) ?? FAILED_COMMENT);
				onFailure?.({ jobId: job?.id, outcome: "failed", reason: typeof err?.reason === "string" ? err.reason : "infra" });
			}
		};
		// A job that FINISHED, then lost its lock (DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK). When Valkey is unreachable
		// for longer than the lock renewal window while a processor finishes, the record is written, BullMQ refuses the
		// completion ("Missing lock"), and its stall check (`maxStalledCount: 0`) fails the job at the next pickup with
		// STALLED_FAILED_REASON. Without this check that job posted the failure comment and paged the operator for a run
		// that ended. So a terminal stall failure first asks the run record: when the record says this attempt finished
		// without failing, the job's terminal line is `job_lost_lock_after_completion` and nothing is posted. The page
		// the completed listener would have sent for that record (a paid policy stop) is sent here instead, because
		// that listener never saw the first finish. No record, an earlier attempt's, a `failed` one, or a lookup fault
		// keeps the failure path below: the comment and the page.
		for (const w of allWorkers) w.on("failed", (job, err) => {
			if (!(job?.finishedOn && err?.message === STALLED_FAILED_REASON)) return onFailed(job, err);
			void (async () => {
				// `attemptsMade` is read AFTER BullMQ's moveToFailed added one, so it equals the attempt number the
				// record carries (`buildRecord`'s `attemptsMade + 1`, written while the job was processing).
				// A record found and refused is said, with its fixed reason, so an operator reading the failure comment
				// can see why the record did not suppress it (a clock skew past the tolerance reads `older-than-job`).
				const onReject = (reason, source) => log("job_lost_lock_record_rejected", { jobId: job.id, reason, source });
				const record = await settledRecord(job.id, { attempt: job.attemptsMade, since: job.timestamp, onReject });
				if (!record) return onFailed(job, err);
				log("job_lost_lock_after_completion", { jobId: job.id, outcome: record.outcome, ...(record.reason ? { reason: record.reason } : {}) });
				if (pagesAsPolicy(record)) onFailure({ jobId: job.id, outcome: "policy", reason: record.reason });
			})().catch(() => {}); // `settledRecord` never rejects; this only keeps a throwing log line from going unhandled
		});

		// CONST-RETRY-INFRA-ONLY money backstop: BullMQ's maxStalledCount does not bound scheduler jobs, so a
		// wedged scheduled run is re-paid on every stall. The guard counts stalls per scheduler and tears the
		// scheduler down past the threshold. Keyed on "stalled", not "failed" -- only a stall is the unbounded re-run.
		const onStalled = makeStallGuard({
			redis,
			threshold: config.schedulerStallMax,
			// The queue the schedulers were actually INSTALLED on. Torn down from `runtimeQueue` on a named
			// host, this money backstop -- a wedged scheduled run is re-paid on every stall -- silently no-ops.
			removeJobScheduler: (id) => cronQueue.removeJobScheduler(id),
			log,
		});
		// `makeStallGuard` returns the LISTENER, not an object holding one -- hence the name of the local. It was
		// called as `guard.onStalled(jobId)` here for the whole life of the feature, which is `undefined(jobId)`,
		// so every stall threw a TypeError and the money backstop never counted one (issue #267).
		for (const w of allWorkers) w.on("stalled", (jobId) => void onStalled(jobId));

		// DES-CRON-VIA-BULLMQ-SCHEDULER: install the schedule set (and prune orphans) before announcing the
		// worker is up, so schedules_installed always precedes worker_started. An empty set skips the reconcile
		// queue entirely -- no getJobSchedulers Redis hit -- but still logs {0,0} so the operator sees cron is off.
		// What this host will NOT be running, said once at boot and per trigger. A folder that belongs to
		// another machine is ordinary on a fleet; a folder that belongs to NO machine is a trigger that will
		// silently never fire, which is the silent no-op this project refuses -- and which `doctor` is the
		// right place to catch, because it can ask the registry and this cannot.
		const { served, unserved } = servedSchedules(schedules.current);
		for (const s of unserved) log("schedule_unserved", { schedulerId: s.schedulerId, reason: s.unserved });

		if (served.length > 0) {
			// Onto the HOST queue when one is armed. That makes Gap 1 structural rather than merely gated: a
			// host queue's resident schedulers are only ever that host's, so `reconcile`'s "resident minus my
			// config" is correct again by construction and two hosts can no longer prune each other at all. The
			// fingerprint gate stays, because it still catches the divergence itself -- including a timezone
			// disagreement, which no queue split can detect.
			const rq = makeQueue(valkeyConn({ failFast: true }), { ...(hostQueue ? { name: hostQueue } : {}) });
			try {
				const r = await reconcileGated(rq, served, { registry, log, tz: hostTz, authored: authoredCron(config) });
				log("schedules_installed", { installed: r.installed, removed: r.removed, ...(unserved.length > 0 && { unserved: unserved.length }) });
			} finally {
				await rq.close().catch(() => {});
			}
		} else {
			log("schedules_installed", { installed: 0, removed: 0, ...(unserved.length > 0 && { unserved: unserved.length }) });
		}

		// DES-CRON-VIA-BULLMQ-SCHEDULER live edit (OQ-008): watch the triggers file and re-reconcile schedulers
		// on change, so an operator's add/edit/delete of a cron trigger takes effect without a worker restart.
		// Only when a triggers file is configured; best-effort; a bad edit keeps the running schedulers. The
		// closer each of the three returns joins `extraClosers`, so the watch stops with the worker (issue #295).
		if (config.triggersFile) {
			extraClosers.push(watchTriggersFile(config, cronQueue, log, schedules, registry, hostTz, config.workerNameDeclared, atBoot.triggers, checkEnvelopePlace));
		}

		// REQ-SCOPED-PAUSE-WINDOWS live edit: watch the pause-windows file and hot-swap the in-memory windows, so
		// an operator's add/delete of a pause window takes effect without a worker restart. A bad edit is kept out.
		if (config.pauseWindowsFile) {
			extraClosers.push(watchPauseWindowsFile(config, pauseWindows, log, atBoot.pauseWindows));
		}

		// Issue #499 part B: the two files a project row joins reload as a pair; the deployment cap rides along so a limits
		// list either reload commits gets the dollar-rows-without-cap warning.
		const projectPair = makeProjectPair(scopedLimits, projects, deploymentMaxCostUsd);
		// Issue #504 part B: the envelope reloads with the pair, since its floors are judged against both files: a committed
		// limits or projects edit re-judges it from disk, and its own edits are judged against the live pair.
		const envelopeCtx = { projects, limits: scopedLimits, maxCostMicros: envelopeCap, jobPaths: envelopeJobPathsNow, onChange: () => void reconcileAllocation("reload") };
		if (config.envelopeFile) {
			projectPair.afterCommit = () => reloadEnvelope(config, envelope, log, envelopeCtx);
			extraClosers.push(watchEnvelopeFn(config, envelope, log, atBoot.envelope, envelopeCtx));
		}
		// Issue #242 live edit: hot-swap the scoped limits on file change, keeping last-good on a bad edit.
		if (config.scopedLimitsFile) {
			extraClosers.push(watchScopedLimitsFn(config, scopedLimits, log, atBoot.scopedLimits, deploymentMaxCostUsd, projectPair));
		}

		// Issue #499 live edit: the projects file, keep-last-good on a bad edit.
		if (config.projectsFile) {
			extraClosers.push(watchProjectsFn(config, projects, log, atBoot.projects, projectPair));
		}

		// Issue #503 live edit: the model endpoints, keep-last-good on a bad edit.
		if (watchModelEndpoints) {
			extraClosers.push(watchModelEndpointsFile(config, modelEndpoints, log, atBoot.modelEndpoints));
		}

		// issue #292 / OQ-007: re-run the three retention sweeps on a timer, because the supported deployment
		// is a service that restarts only on failure, so the healthy worker was the one that never re-swept.
		// Armed HERE, at the end of boot beside the watches: all three closures exist, boot's own sweeps have
		// long finished, and the first tick lands one full interval later rather than during the schedules
		// reconcile, which is Redis-destructive work a small test interval would otherwise land inside.
		//
		// NOT CONSTRUCTED AT ALL when the knob is 0. That is how "0 is byte-identical to before" is a fact
		// rather than a claim: with no object there is no timer, no closer and no reachable second call to any
		// reaper. It is registered in `extraClosers` for issue #295's finding that UNREF'D IS NOT CLEANED UP --
		// this handle holds an `rmSync`, and a tick landing mid-drain could delete a retained workspace behind a
		// worker that already reported a clean shutdown.
		if (config.sweepIntervalHours > 0) {
			const sweep = makeRetentionSweepFn({
				reapers: [
					{ name: "log", reap: reapLogs },
					// Issue #504 part B: where boot runs it, right after the run history it sits beside.
					{ name: "allocation_log", reap: reapAllocationLogs },
					{ name: "sandbox", reap: reapSandboxes },
					{ name: "session", reap: () => sessionStore.reapSessions() },
				],
				intervalMs: config.sweepIntervalHours * 3600000,
				log,
			});
			sweep.start();
			extraClosers.push(sweep);
		}

		log("worker_started", {
			queue: "pi-jobs",
			// Issue #278: the service's OWN answer to which daemon its jobs go to. `doctor` reads its caller's
			// shell, and a service's EnvironmentFile or a systemd User= can resolve differently.
			// Issue #354: all five null with `local` unblessed, where this host's docker CLI was not asked.
			dockerContext: bootEndpoint ? bootEndpoint.context : null,
			dockerEndpointLocal: bootEndpoint ? bootEndpoint.local : null,
			jobUser: bootDecision ? { mode: bootDecision.mode, user: bootDecision.user, cause: bootDecision.cause } : null, // issue #341
			// Issue #345: whether this daemon is observed applying a container's bounds and adding no mounts of its own; null = not read.
			daemonAppliesBounds: bootObserved ? bootObserved.observations.daemonAppliesBounds : null,
			runtimeAddsNoMounts: bootObserved ? bootObserved.observations.runtimeAddsNoMounts : null,
			// Issue #354: the podman venue's own boot answers, all null with `podman` unblessed (no `podman info` was asked):
			// the version it reported, whether it is rootless and whose uid its jobs run as, and its three observations.
			podmanVersion: bootPodmanRead?.answered ? bootPodmanRead.info.version : null,
			podmanRootless: bootPodmanRead?.answered ? bootPodmanRead.info.rootless : null,
			podmanJobUser: bootPodmanDecision ? { mode: bootPodmanDecision.mode, user: bootPodmanDecision.user, cause: bootPodmanDecision.cause, reason: bootPodmanDecision.reason } : null,
			podmanBoundsDelegated: bootPodmanObserved ? bootPodmanObserved.observations[PODMAN_BOUNDS_DELEGATED] : null,
			podmanAddsNoMounts: bootPodmanObserved ? bootPodmanObserved.observations[PODMAN_ADDS_NO_MOUNTS] : null,
			podmanServiceLocal: bootPodmanObserved ? bootPodmanObserved.observations[PODMAN_SERVICE_LOCAL] : null,
			host: config.workerName, // issue #57; `log` stamps it on every line, and the boot line names it where an operator looks first
			imageDigest: bootImage.imageDigest ?? null, // two hosts on two builds of one tag used to emit byte-identical boot lines
			concurrency: bootConcurrency, // the slot count the Worker is actually constructed with (overlay may raise/lower it)
			sweepIntervalHours: config.sweepIntervalHours, // 0 = boot-only sweeps, this version's pre-#292 behaviour
			dailyCap: config.dailyCap,
			weeklyCap: config.weeklyCap, // null when the weekly window is disabled
			monthlyCap: config.monthlyCap, // null when the monthly window is disabled
			softHoldPct: config.softHoldPct, // null when the soft-hold band is disabled
			scopedLimitsFile: config.scopedLimitsFile, // null = no scoped caps/concurrency (the folder mutex holds regardless)
			scopedLimits: scopedLimits.current.length, // row count -- money config deserves boot visibility; the watcher logs only changes
			projectsFile: config.projectsFile, // issue #499: null = no projects
			projects: projects.current.length, // project count, never a name
			envelopeFile: config.envelopeFile, // issue #504: null = no envelope and no delegation
			envelopeDigest: envelope.digest, // the envelope's 16-hex digest, the host row's fpEnvelope; null without one
			modelEndpoints: modelEndpoints.current.length, // issue #503: declared model endpoints, each a slot lease at pickup
			image: config.jobImage,
			valkey: config.valkeyUrl,
			// Issue #464: the literal address every Valkey client of this worker dials, beside the URL as written; null
			// where nothing was pinned (another machine's Valkey, dialled by name).
			valkeyPinned: valkey.pinned ? `${valkey.pinned.address.includes(":") ? `[${valkey.pinned.address}]` : valkey.pinned.address}:${valkey.pinned.port}` : null,
			logsDir: config.logsDir,
			settingsFile: config.settingsFile,
			captureJobLogs: config.captureJobLogs,
			logRetentionDays: config.logRetentionDays,
			sandboxRetentionHours: config.sandboxRetentionHours, // 0 = retention off; a run's directory is deleted as before
		});
		return worker;
	} catch (err) {
		// STOP WHAT WAS BUILT, THEN RETHROW, and both halves carry weight. The stop is the shutdown
		// minus the exit -- the cancel, the close, the closer drain, the client release -- so nothing is
		// left holding the loop and the process drains to the refusal's OWN exit code: entryExitCode
		// turns a tagged configError into EXIT_POLICY 2 and infra into the retryable 1, and a swallow
		// here would hand a supervisor a clean 0 for a boot that refused. `Promise.resolve`, not an
		// optional-chained `.catch`: a test double whose recording `stop` is synchronous would otherwise
		// raise a TypeError OVER the boot's real error, and the exit-code assertion meant to go red
		// under mutation would go green for the wrong reason. A synchronous throw from `stop` itself
		// still escapes, exactly as the closer loop documents for `extraClosers` -- a known bound.
		await Promise.resolve(worker?.stop?.()).catch(() => {});
		throw err;
	}
}

/**
 * The boot refusal text for a job-user decision, or `null` to boot. Exported so its default-venue branch is pinned on the
 * predicate as well as end to end (a podman default reaches it since issue #354 part 2, and must not refuse on local's causes).
 */
export function jobUserBootRefusal(decision, defaultBackend) {
	if (decision?.mode !== "unmappable" || !BOOT_REFUSING_JOB_USER_CAUSES.has(decision.cause)) return null;
	return defaultBackend === DEFAULT_BACKEND ? jobUserRefusal(decision) : null;
}

/**
 * The boot refusal text for a podman job-user decision, or `null` to boot (issue #354): an identity cause no podman job
 * can get past (`PODMAN_BOOT_REFUSING_CAUSES`), and only while `podman` is the DEFAULT venue, `jobUserBootRefusal`'s rule.
 * Kept apart from that function rather than merged into it, because the two venues' causes share a name
 * (`worker-is-root`) and not a remedy, and each venue's text comes from its own map.
 */
export function podmanBootRefusal(decision, defaultBackend) {
	if (defaultBackend !== PODMAN_BACKEND) return null;
	if (decision?.mode !== "unmappable" || !PODMAN_BOOT_REFUSING_CAUSES.has(decision.cause)) return null;
	return podmanJobUserRefusal(decision);
}

/**
 * The boot refusal for a rootful Podman containers.conf that reaches a local job (issue #448), from `observeRootfulConf`'s
 * answer, or `null`: only while `local` is the default venue, and not when the local job user is already refused (that
 * refusal, earlier at boot or per job, is the one to fix first). `transient` (thrown untagged, exit 1, so the supervisor
 * restarts it) is a read that failed for a moment AND, since gate round 1 of PR #473, a service older than its
 * containers.conf or a change time ahead of the clock: each heals by itself, so none may strand a unit with
 * `RestartPreventExitStatus=2`. Exported for the doc test, as `podmanConfBootRefusal` is.
 */
export function localConfBootRefusal(decision, defaultBackend, rootful) {
	if (defaultBackend !== DEFAULT_BACKEND || !rootful?.refusal || decision?.mode === "unmappable") return null;
	return { message: rootfulConfRefusal(rootful.refusal), transient: rootfulConfRetries(rootful.refusal) };
}

/**
 * A rootful finding as the processor's `podmanConfRefused` (issue #448): the podman venue's shape, marked `rootful`.
 * `retry` marks what the processor throws for the queue's retry rather than returns (a moment's read failure, a service
 * older than its containers.conf, a clock behind a change time), with the evidence its retry message names.
 */
function rootfulRefused(found) {
	return {
		reason: found.cause,
		key: found.key ?? null,
		message: rootfulConfRefusal(found),
		rootful: true,
		...(found.restart ? { restart: true } : {}),
		...(found.skew ? { skew: true } : {}),
		...(found.transient ? { transient: true } : {}),
		...(rootfulConfRetries(found) ? { retry: true, evidence: found.evidence } : {}),
	};
}

/**
 * The boot refusal for a widening containers.conf on the podman venue (issue #428), as `{ message, transient }`, or
 * `null` to boot: only while `podman` is the DEFAULT venue, `podmanBootRefusal`'s rule, and not when the identity is
 * already refused (that refusal names the fix that comes first, and with `podman` merely blessed its jobs are refused
 * one by one anyway). `transient` is a read that failed for a moment, which the caller throws untagged.
 */
export function podmanConfBootRefusal(decision, defaultBackend, files) {
	if (defaultBackend !== PODMAN_BACKEND || !decision || decision.mode === "unmappable") return null;
	const widened = podmanConfWidening(files);
	return widened ? { message: podmanConfRefusal(widened), transient: widened.transient === true } : null;
}

/** What makes two job-user decisions the same for the `job_user` log line. */
function jobUserLogKey(decision) {
	return `${decision?.mode}|${decision?.user ?? ""}|${decision?.cause ?? ""}|${decision?.reason ?? ""}`;
}

/** A one-line summary of an endpoint answer, used only to notice that it changed. */
function dockerEndpointState(endpoint) {
	return `${endpoint.local}|${endpoint.context ?? ""}|${endpoint.endpoint ?? ""}|${endpoint.reason ?? ""}`;
}

/**
 * What an endpoint answer shows, for a refusal message. The context name is operator config; the endpoint is
 * the display form, which is the value reduced to `scheme://host` or withheld, never edited (`displayEndpoint`).
 */
function dockerEndpointEvidence(endpoint) {
	if (endpoint.local === null) return `the docker CLI did not say which endpoint it resolves (${endpoint.reason})`;
	return `the docker CLI resolves context ${quotedShown(endpoint.context)} to ${endpointShown(endpoint)}${endpoint.local ? ", on this host" : ", which is not shown to be on this host"}`;
}

/** Log an endpoint answer that is not plainly local; a return to local is logged only as a change. */
function logDockerEndpoint(log, endpoint, { changed = false } = {}) {
	if (endpoint.local === false) log("docker_endpoint_not_local", { context: endpoint.context, endpoint: endpoint.endpoint });
	else if (endpoint.local === null) log("docker_endpoint_unresolved", { reason: endpoint.reason });
	else if (changed) log("docker_endpoint_local", { context: endpoint.context, endpoint: endpoint.endpoint });
}

/**
 * Where the worker's clients stand (issue #464): enforced exactly as its boot judgement was (`valkey.enforce`), so a
 * reconnect is judged by the rule the boot applied, never a looser one; PI_VALKEY_SHARED from the deployment `.env`.
 */
export function workerValkeyContext(valkey, env, { cwd = process.cwd(), readEnv } = {}) {
	return valkeyClientContext({ env, cwd, rootRefused: valkey?.rootRefused === true, ...(readEnv ? { readEnv } : {}) });
}

/**
 * The worker's real Valkey judgement (issue #464, gate round 2): `resolveWorkerValkey` with this host's facts. The
 * deployment `.env` is the one in the working directory (the unit's WorkingDirectory is the deployment folder), read
 * only for PI_VALKEY_SHARED; nothing else of it is loaded into this process.
 */
async function defaultJudgeValkey({ url, venues, env }) {
	const envPath = join(process.cwd(), ".env");
	let envText = null;
	try {
		// Bytes (gate round 3): the hardened reader checks what systemd refuses to load before it decodes.
		envText = readFileSync(envPath);
	} catch (err) {
		// No .env here: nothing opts in. Any other failure is said, never read as "no opt-in" (gate round 3).
		if (err?.code !== "ENOENT") throw configError(`${envPath} could not be read (${err?.code ?? err?.message}), and the worker reads PI_VALKEY_SHARED from it, so it does not start`);
	}
	const fs = { readFileSync };
	const euid = process.geteuid?.();
	let user = null;
	try {
		user = userInfo().username;
	} catch {
		// A uid with no passwd entry: its subordinate ranges are read by uid.
	}
	const valkey = await resolveWorkerValkey({
		url,
		venues,
		platform: process.platform,
		env,
		envText,
		envPath,
		probeTcp: probeTcpAddress,
		lookup: (host, opts) => dnsLookup(host, opts),
		fs,
		euid,
		user,
		ownerName: (uid) => passwdNameFrom(fs, uid),
		interfaces: networkInterfaces,
		subuids: readSubuidRanges({ user, euid, fs }),
		configError,
	});
	await refuseValkeyAuth(valkey, env);
	return valkey;
}

/**
 * Issue #468: the worker's credential asked once at boot, on the judged address, before anything is built on it. A
 * Valkey that requires a password this worker does not send (NOAUTH), or refuses the one it sends (WRONGPASS), is a
 * configError (exit 2, not restarted into the same answer), naming VALKEY_PASSWORD and never its value: left to the
 * clients, it was an endless stream of NOAUTH errors from a worker that looked alive. Nothing answering is left to the
 * clients' own retries, as before. Exported for its test; `authState` is the seam.
 */
export async function refuseValkeyAuth(valkey, env, { cwd = process.cwd(), authState = valkeyAuthState } = {}) {
	const context = workerValkeyContext(valkey, env, { cwd });
	const { state, error } = await authState(valkey.url, { context, servername: valkey.servername ?? null });
	// Gate round 2 of PR #478: a database the server does not have (`/16` on a default Valkey) is a refusal, exit 2.
	if (state === "dbrange") throw configError(error);
	if (state === "noauth" || state === "wrongpass") throw configError(authRefusalFor(state, valkey.url, context));
}
