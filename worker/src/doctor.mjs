/**
 * `pi-dispatch doctor` — preflight the host before the first job. Prints a ✓/⚠/✗ line per prerequisite
 * with a one-line fix, and exits non-zero if any hard check fails, so it is usable in a setup script.
 *
 * Reads the handful of values it needs with config.mjs's own defaults rather than loadConfig, so it
 * runs even when GitHub auth is unset — a local-folder deployment needs none of it. Mirrors the kill
 * switch in cli.mjs, which reads only VALKEY_URL for the same reason (it must work when GitHub is
 * misconfigured). The provider key is checked for presence only and never printed (secrets-and-pii).
 *
 * GitHub auth gets two advisory (never failing) checks: the default GITHUB_AUTH_SOURCE=gh mints from the
 * operator's FULL-scope gh login, which then reaches every token-carrying job container — the opposite of
 * the App path's per-repo short-lived tokens (CONST-TOKEN-SCOPED-PER-JOB) — so doctor names the scopes it
 * carries; and gh is preflighted inside the job image, since a token that works host-side but not
 * in-container fails jobs mid-run, not at submit. Token values travel via the spawn env or stdin, never argv.
 *
 * Issue #80 adds the RECEIVER's half of the preflight. Doctor runs on the worker host, but the triggers
 * file names forges whose deliveries only ever arrive if the receiver can boot -- and the receiver is
 * deliberately fail-loud (receiver/src/config.mjs), so a missing WEBHOOK_SECRET or a half-set forge env
 * block is a refusal the operator otherwise meets at deploy time with no forewarning. Doctor mirrors
 * exactly the variables each forge loader hard-requires and WARNS about what boot will refuse -- never
 * fails, because the worker host may legitimately not be the receiver host, and a deployment can be
 * mid-setup. Secrets are checked for presence only and never printed, same rule as the provider key. The
 * github repos the triggers file names also get a READ-ONLY branch-protection preflight, so
 * REQ-BRANCH-PROTECTION-PRECONDITION surfaces at setup time instead of as a refusal comment on the first
 * paid trigger.
 *
 * The overlay checks (REQ-GLOBAL-PI-OVERLAY, INT-TRIGGERS-FILE-CONTRACT) exist because nothing about the
 * overlay is visible from the worker host once jobs are running. BOTH halves of it -- `extensions/` and the
 * staged `packages/` -- now load by default, so the state worth surfacing is no longer "armed": an armed
 * thing is one the operator just switched on and remembers. The dangerous state now is STAGED AND FORGOTTEN,
 * so doctor's overlay lines answer "what will actually load into my job containers", and the ⚠ marks the
 * live third-party code rather than the switch.
 *
 * The silent-failure checks that outlive the flip are unchanged, because they never depended on the default:
 * a manifest naming a staged dir that is gone, and a trigger that explicitly requires packages nobody staged.
 * Both end the same way -- pi skips an absent local source with no error, and the flow exits 0 without the
 * tools it was written for.
 *
 * `doctor --fix` (issue #80, REQ-DEPLOYMENT-BOOTSTRAP) turns SOME fix lines into offers, per failing check.
 * The tier ladder is deliberate: a silent tier for the two fixes whose decision the operator already made
 * (init's create-only scaffolds; mkdir of a directory an env var already names), a prompt tier (y/N,
 * default No, the exact command shown first) for the rest, and a never tier for everything doctor could
 * only fix by guessing -- see the fixAction comment at its first use below. Offering fixes changes NOTHING
 * about severity: a --fix run still exits by the same failed/ok logic, warns stay warns, and the fix pass
 * happens at most once (check, fix, re-check -- never a loop).
 *
 * `doctor --live` (issue #278, INT-LIVE-PROBE-CONTRACT) reads the backend declarations back off short-lived real
 * containers (`live-probes.mjs`), ONCE, after any fix pass, from the facts the final collection gathered. Its
 * containers, networks and fixture are named before they exist and removed when it ends; it is judged by the same failed/ok rule and carries
 * no fixAction, because what a failed read-back points at is the image or the runtime.
 */
import { accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir, networkInterfaces, release as osRelease, tmpdir, userInfo } from "node:os";
import { NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_START, STACK_KEYS, STARTED_AT_FORMAT, VALKEY_SHARED_KEY, judgeNetnsKeeper, judgeValkeyListeners, netnsKeeperRemedy, pinnedValkeyUrl, podmanNeedsNetnsKeeper, probeTcpAddress, proxyConfCopyPath, readSubuidRanges, proxyRestartAdvice, readLinger, readValkeyKeys, valkeySharedOn, valkeyTarget } from "./podman-stack.mjs";
import { basename, dirname, isAbsolute, join, delimiter, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_VALKEY_URL, accountTempRoot, allowedModelsFrom, defaultLogsDir, defaultSandboxDir, defaultSettingsFile, defaultWorkerName, globalExtensionsEnabled, jobsDirOwnerFix, jobsDirPath, sandboxDirOwnerFix, legacyTempStateDir, logsDirPath, modelEndpointsFilePath, delimitedList, envelopeFilePath, pauseWindowsFilePath, projectsFilePath, safeHomeDir, scopedLimitsFilePath, settingsFilePath, underOsTempDir } from "./config.mjs";
import { SYSTEMD_HAZARD_SHAPES, decodeEnvFile, envFileHazard, envValueShown, quotedRegions, readEnvAssignments, renderEnvValue, envFileWrapperInternal, wrapperInternalSentence } from "./env-file.mjs";
import { canonicalScope, danglingProjectRows, dollarRowsBelowJobCap, dollarRowsWithoutCap, isModelScope, isProjectScope, loadScopedLimits, parseScopedLimits } from "./scoped-limits.mjs";
import { EMPTY_PROJECTS_FINGERPRINT, loadProjects, projectsFingerprint } from "./projects.mjs";
import { parseModelsJson, stripBom, stripJsonComments } from "./models-json.mjs";
import { isTransientOverlayRead, overlayProviderProblem } from "./model-catalog.mjs";
import { EMPTY_USD_FINGERPRINT, usdFingerprint } from "./dollar-fingerprint.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { ignoredOutputCapModels, outputCapView, outputUnboundable } from "./output-cap.mjs";
import { KEYLESS_API_KEY, KEYLESS_HOW, MODEL_ENDPOINTS_FILE_NAME, MODEL_ENDPOINTS_INCLUDE_NAME, MODEL_ENDPOINT_ID_RE, OVERLAY_LINK_FIX, OVERLAY_NOT_A_FILE_FIX, RENAMED_PROVIDERS, baseUrlTarget, keylessVerdict, loadModelEndpoints, providerRenameHint, readOverlayModels, renderEndpointsInclude, unreportedUsageModels } from "./model-endpoints.mjs";
import { declaredEndpointsIn, endpointsDeclaredIn, reloadCommand, rulesFileIncludes, rulesPredateEndpointsLine } from "./egress-cli.mjs";
import { loadPauseWindows, parseScopeString } from "./pause-windows.mjs";
import { WAIT_AFTER_MAX_DEFAULT_MS, afterInstantMs, parseWaitProfiles } from "./wait-for.mjs";
import { isForgeKind } from "./forges.mjs";
import { findLiteralSecret, ADMIN_RE } from "./import-pi.mjs";
import { agentDirFrom, readHostPi } from "./host-pi.mjs";
import { PACKAGES_SUBDIR, readStagedSkills, readStageManifest } from "./packages.mjs";
import { copySkillTree } from "./copy-tree.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";
import { resolveBackendName } from "./backend-registry.mjs";
import { deploymentVenueEnv, sharedShellIgnored } from "./deployment-venue.mjs";
import { readDeploymentEnv, resolveServiceEnv, serviceEnvFileOf, serviceEnvLoader } from "./service-env.mjs";
import { imageRefProblem, jobImageFix, pullOffered } from "./image-ref.mjs";
import { PROXY_STATE_FORMAT, parseProxyState, rulesIncludeEndpoints, shippedProxyDrift } from "./egress-proxy-state.mjs";
import { PACKAGED_EGRESS_PROXY_CONF, judgeProxyConfCopy, packageCopyName, readPackagedProxyConf } from "./egress-conf-copy.mjs";
import { ABSENT, ASSERTED, DAEMON_APPLIES_BOUNDS, DEFAULT_BACKEND, DOCKER_ENDPOINT_LOCAL, OBSERVATION_FIX, OBSERVATIONS, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_ROOTFUL_WIDENING_KEYS, PODMAN_SERVICE_LOCAL, PROPERTY_NAMES, RUNTIME_ADDS_NO_MOUNTS, HOST_ROUTE_LAN, HOST_ROUTE_REFUTED, HOST_ROUTE_WORKS, declarationOf, floorShortfall, hostRouteFor, isProxyLocalHost, parseBackendFloor, parseBackendList, unarmedFloor, unobservedFloor, venuesOf } from "./backends.mjs";
import { PODMAN_BOOT_REFUSING_CAUSES, PODMAN_FIRST_START_TIMEOUT_MS, PODMAN_INFO_TIMEOUT_MS, PODMAN_JOB_USER_FIX, decidePodmanJobUser, makePodmanInfoReader, observePodman, observeRootlessNetns, podmanConfFix, podmanConfWidening, resolvePodmanImageUser } from "./backend-podman.mjs";
import { PODMAN_PINNED_FLAGS, buildPodmanRunArgs, containerSpec, podmanArgsFromSpec } from "./docker-run.mjs";
import { PODMAN_SERVICE_TIMEOUT_MS, PODMAN_SERVICE_UNIT, makePodmanServiceReader, observeHost, observeRootfulConf, readRootfulService, rootfulConfFix, rootfulConfRetries, rootfulConfResidual, rootfulUnreadList } from "./runtime-observations.mjs";
import { endpointShown, makeDockerEndpointResolver, quotedShown } from "./backend-local.mjs";
import { DEFAULT_EGRESS_PROXY, STOPPED_PROXY_STATES, EGRESS_CANARY_NET_PREFIX, EGRESS_CANARY_PROBE_PREFIX, EGRESS_ENDPOINT_PROBE_PREFIX, egressArmed, egressCanaryNetwork, egressCanaryProbe, egressEndpointProbe, egressEnv, egressProxyName, egressProxyUrl, networkEndpoints, removeNetworkOrSay } from "./egress.mjs";
import { detachBlockedSentence, makeDetachGate, runtimeFromFacts } from "./netns-keeper.mjs";
import { runLiveProbes } from "./live-probes.mjs";
import { VALKEY_PASSWORD_KEY, VALKEY_PASSWORD_HOWTO, VALKEY_PORT_KEY, isLoopbackHost, valkeyPasswordProblem, valkeyPortConflict } from "./valkey-auth.mjs";
import { urlShown, valkeyContextFromResolution, valkeyPasswordFor, valkeyUrlProblem } from "./valkey-endpoint.mjs";
import { SANDBOX_TOMBSTONE_STUCK_MS, isSandboxTombstone, sandboxTombstoneAge } from "./sandbox-store.mjs";
import { installedUnitPaths, readUnitSeam, readUnitUser } from "./service.mjs";
import { CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";
import { DEFAULT_JOB_SIZE, formatCpus, formatMemory, hostCpuCeiling, jobSizeDefaults } from "./job-size.mjs";
import { makeImagePreflight, normalizeImageId } from "./image-preflight.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, DAEMON_FACTS_TIMEOUT_MS, JOB_USER_FIX, makeDaemonFactsReader, makeJobUserResolver, relabelsPrivateMounts, resolveImageUser } from "./job-user.mjs";
import { parseSecretProfiles } from "./secret-profiles.mjs";
// The OAuth-suffix rule and the variable it selects live in their own import-free module so the worker
// can share them: doctor NAMES a variable and env-allowlist WRITES one, and they must never differ.
import { apiKeyVariable, nonApiKeyKind } from "./provider-key.mjs";
import { parseTriggers } from "./triggers.mjs";
import { readOverlay, resolveSettings } from "./runtime-settings.mjs";
import { DOLLAR_KEY_PREFIX } from "./dollar-budget.mjs";
import { dayKey, monthKey, weekKey } from "./budget.mjs";
import { DOLLAR_ENV_NAMES, DOLLAR_SETTING_KEYS, checkDollarInvariant, effectiveCostCapMicros, formatMicros, optionalUsdMicros, parseUsdMicros } from "./money.mjs";
import { cronPlacement, envelopeJobPaths } from "./schedules.mjs";
import { envelopeDigest, loadEnvelopeChecked } from "./envelope.mjs";
import { OTHER } from "./priorities.mjs";
import { ALLOC_PLAN_KEY, NO_ENVELOPE_FINGERPRINT } from "./allocation.mjs";

const NODE_FLOOR = [22, 19]; // pi's engine floor (22.19.0)

// gh login scopes that reach well past what a job should ever hold — called out by name in the fix line.
const BROAD_SCOPES = ["admin:org", "delete_repo", "workflow"];

/**
 * What to do when the podman venue's bounds miss for a reason in the account's systemd setup (issue #453, measured on
 * Fedora 44 with Podman 5.8.1), per `observePodman`'s `boundsCause`. Linger leads: it is what keeps the user manager
 * running for a service, where a login session keeps it only while that session lasts (a plain ssh started one,
 * measured, and a `sudo -iu` shell started none). Which manager a doctor sees does not depend on the shell it runs in:
 * with linger off, a `sudo -iu` doctor saw a running manager while another login session of the account was open
 * (gate 456), and that ✓ lasted only as long as the session did.
 */
const PODMAN_BOUNDS_FIX = Object.freeze({
	"no-user-manager": "turn on linger for the worker's account: `sudo loginctl enable-linger <account>` starts its systemd user manager and keeps it running with no one logged in, and `pi-dispatch service install` runs the worker as a systemd user service inside it. A hand-written system unit with `User=` also needs `Wants=user@<uid>.service` and `After=user@<uid>.service` (docs/podman.md); `pi-dispatch doctor --live` reads pids.max and memory.max back off a real container",
	"user-manager-unreachable": "run the worker inside the account's user manager, as a systemd user service (`pi-dispatch service install`, with linger on), where a job's container lands under the manager whichever cgroup manager Podman uses; or let Podman reach the manager over the account's user bus, /run/user/<uid>/bus (on Debian and Ubuntu the dbus-user-session package provides it), with no DBUS_SESSION_BUS_ADDRESS pointing elsewhere and no `cgroup_manager = \"cgroupfs\"` in its containers.conf; `pi-dispatch doctor --live` reads pids.max and memory.max back off a real container",
});

// The podman venue's pull of the deployment's default job image into this account's store (issue #433): the fix line's
// words and `--fix`'s prompt, one string so the two cannot name different commands.
const PODMAN_JOB_IMAGE_PULL = jobImageFix("podman", "pi-job:latest");

// The fix for a trigger-named image without the runner entrypoint, one sentence for either runtime (issue #433).
const TRIGGER_IMAGE_ENTRYPOINT_FIX = "build your job image FROM this repo's image/Dockerfile so it keeps /entrypoint.sh -- an image without the runner can exit 0 without ever starting the agent, and the queue records that as success (docs/job-image.md)";

// The in-image gh probe's argv after the runtime's name, shared by docker and podman (issue #433) so the two cannot
// drift. Not the job builder's argv: the probe asks whether the image's gh can reach the forge with this token, which is
// a question about the image and the network, not about a job's bounds.
//
// The token rides STDIN (issue #521), never the container's environment. It used to ride value-less `-e` flags, which
// kept it out of argv and out of doctor's output but put it in the container create request, and Docker Desktop's
// backend log (`~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log`) writes that request,
// environment included, to disk in plain text. Measured on 2026-10-02 (Docker Desktop 4.37.2, engine 27.4.0): one
// doctor run left a dummy token in that log twice (GH_TOKEN and GITHUB_TOKEN) with `-e`, and zero times with stdin.
// This token is the operator's own, so unlike a job's minted one it does not expire within the hour. `-i` attaches
// stdin, the entrypoint becomes `sh`, and the script reads one line and exports it to the `gh auth status` it execs,
// so the value lives only in that process's memory. Rejected: `--env-file` (the CLI expands it into the same create
// request) and a mounted file (a host temp file that must be written, protected and removed, and on rootless Podman
// made readable across a uid map, to say what one pipe says). An image without `sh` (or `gh`) fails the probe with
// exit 126 or 127, and the line says gh could not be run inside the job image; an image built FROM image/Dockerfile
// has both. `gh auth status` stays separate argv words after the script's `$0`, so the probe still reads as what it
// runs.
//
// EXCEPT the venue's pins, on podman (review round 1): the account's containers.conf may default what the argv does not
// name, and two of those defaults hand the probe far more than the token. `env_host = true` (which the podman venue
// deliberately does not refuse, because every job pins it off) would copy doctor's WHOLE environment into the container,
// provider keys, GITHUB_PAT and WEBHOOK_SECRET with it, and `http_proxy` copies the proxy variables. So a podman probe
// carries `PODMAN_PINNED_FLAGS` whole, the same array every podman job carries: `--env-host=false` and
// `--http-proxy=false` for that, and the private namespaces so the probe is no less contained than a job. docker has no
// such defaults to pin (its CLI forwards only what `-e` names, and the probe names nothing), so its argv carries no pins.
const GH_PROBE_SCRIPT = 'read -r t; export GH_TOKEN="$t" GITHUB_TOKEN="$t"; exec "$@"';
const ghProbeArgs = (image, bin) => ["run", "--rm", "-i", "--pull=never", ...(bin === "podman" ? PODMAN_PINNED_FLAGS : []), "--entrypoint", "sh", image, "-c", GH_PROBE_SCRIPT, "sh", "gh", "auth", "status"];


// Issue #471: `shellVars` is THIS shell's environment and is read in exactly the places a test pins (the venue and
// service-key resolution, the agent dir default, and the environment handed to child processes). Every check judges
// `env`, the resolution, never `shellVars`.
export async function runDoctor(shellVars = process.env, deps = {}) {
	const {
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		spawn = nodeSpawn,
		// The bounds every `runCmd` goes through (issue #397). A seam so a test can drive the timeout path
		// in milliseconds; nothing else passes it.
		runTimeouts = RUN_TIMEOUTS,
		probeValkey = defaultProbeValkey,
		// Issue #468: how the Valkey answers a credential, `{ state, passwordSet, from }` (connection.mjs' `valkeyAuthState`),
		// in-process, through doctor's own client: no program is started and handed the password. Real only where the
		// Valkey probe is, as the owner check: a test that injects `probeValkey` gets none unless it injects this too.
		valkeyAuth,
		readHosts = defaultReadHosts,
		fileExists = existsSync,
		nodeVersion = process.versions.node,
		// --fix (REQ-DEPLOYMENT-BOOTSTRAP): offer to run the exact fixes doctor already prints. The prompt
		// is injectable so tests drive consent hermetically; the default is a readline y/N that answers No
		// on empty input AND on non-TTY stdin -- a piped or CI `doctor --fix` runs nothing from the prompt
		// tier, because nobody was at the keyboard to consent.
		fix = false,
		promptFn = defaultPromptFn,
		// fs seams for the fixActions, injectable for the same hermetic-test reason as fileExists.
		mkdir = mkdirSync,
		chmod = chmodSync,
		rm = rmSync,
		// The operator's pi setup, compared against the staged overlay (issue #102). A seam because the
		// default is a real path in the developer's home directory and the host comparison may spawn their
		// package manager -- neither belongs in a unit test, and "no network, no Docker" is the same rule.
		agentDir = agentDirFrom(shellVars),
		// Where the service manager's units live, and which formats to read them in (issue #216). Seams
		// rather than bare process.platform/homedir() because the --env-setup check has to be exercised
		// for all three unit formats, and only one of them exists on whichever host runs the suite.
		platform = process.platform,
		home = safeHomeDir(),
		// doctor's one contact with pi's package, injectable so a test can drive the could-not-load arm
		// without uninstalling a dependency. Threaded like every other seam: a seam collectChecks honours
		// and runDoctor silently drops is a seam that cannot pin an EXIT CODE, only a check object.
		providerOracle = defaultProviderOracle,
		// Issues #501 and #502: the worker's model catalog and pi's own model loader, both imported lazily. Seams, so a test
		// can drive the not-installed arm and a disagreement without editing pi. Undefined means the defaults.
		modelCatalog,
		piModelLoader,
		dollarKeysExist,
		// Issue #504 part B: the applied split's envelope digest (`alloc:plan`), read once. Undefined means the default.
		readAppliedSplit,
		// --live (issue #278, INT-LIVE-PROBE-CONTRACT): read the backend declarations back off short-lived real containers.
		// STRICTLY `=== true`, so only the CLI's own flag arms it: a truthy string from a caller that forwarded an
		// option bag runs nothing. The fs, PID-liveness and nonce are seams so the sequence is driven without Docker.
		live = false,
		liveFs = { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync },
		// Issue #341: who a job on this host would run as, decided from the same facts the worker reads. Seams because
		// the answer is this process's own ids and a daemon, neither of which belongs in a unit test. `stat` reads the
		// docker socket's owner; `passwd` resolves a system unit's `User=` name to a uid.
		jobUserIdentity = { platform, release: osRelease(), euid: process.geteuid?.(), egid: process.getegid?.() },
		stat = statSync,
		passwd = () => readFileSync("/etc/passwd", "utf8"),
		readUnit = (path) => readFileSync(path, "utf8"),
		// The deployment's own `.env`, read for exactly the keys two checks below NAME (issue #357), and
		// since issue #384 also the read behind the two boot-file loaders, which open the path that `.env`
		// gives them through this same seam. See `envFileKeys` for why any of this is allowed to exist.
		// BYTES since issue #447: systemd refuses to load a `.env` with a NUL or invalid UTF-8 in it, which decoded text
		// cannot show. `envFileKeys` decodes; the boot-file loaders below get text through `seamsForLoad`.
		readEnvFile = (path) => readFileSync(path),
		// Issue #345: the host files the runtime-mounts observation reads (Podman's mounts.conf and containers.conf).
		observationFs = { statSync, readFileSync, readdirSync },
		// Issue #464: the jobs dir check's reads (its owner, whether this account may write it, the old shared default's
		// retained workspaces). Never a write: doctor says what the worker will meet, and the worker creates the dir.
		jobsDirFs = { accessSync, lstatSync, readdirSync, statSync },
		// The uid the worker's files are created as, which is what `ensureJobsDir` compares an owner with: this process's
		// own, not `jobUserIdentity`'s (the job-user decision's facts, which a test fakes for another reason).
		jobsDirUid = process.geteuid?.(),
		// Issue #453: this shell's account name, asked of loginctl for linger on the podman venue; and whether this folder
		// holds the shipped proxy's two files, so its running proxy's mounts can be compared with them.
		userName,
		// Issue #464 (gate round 1): whose Valkey VALKEY_URL reaches, `(url, { shared, user, envPath })` answering as
		// `judgeValkeyListeners`. Defaulted below, not here: see there.
		valkeyOwner,
		proxyFilesExist,
		// PR #488's review: whether a path of the proxy's two files is a DIRECTORY, which docker would mount as the file.
		proxyFileIsDirectory,
		// Issue #503: whether the shipped proxy's third mount is needed (`proxyIncludeNeeds`), for tests.
		includeNeeds,
		// Issue #503 (part 6): the declared model endpoints as the service reads them, and this host's own LAN IPv4
		// addresses for the measured route table, both for tests. The real reads are the defaults where they are used.
		declaredEndpoints,
		hostAddresses,
		// Issue #552: the overlay models.json's read for the credential-free line, for tests that need an errno a real
		// file cannot give (EIO, EMFILE). The real read is the default where it is used.
		readOverlayFile,
		// Issue #556: the overlay models.json's lstat, for tests that need a socket or a device a test cannot make.
		lstatOverlayFile,
		// Issue #484: how a copy of the proxy's rules is read, and the installed package's copy it is compared with.
		readProxyConf,
		readPackagedProxyConf: readPackagedConf,
		isAlive = defaultIsAlive,
		pid = process.pid,
		nonce = randomBytes(6).toString("hex"),
		// The clock a --live pass times its probes with. Forwarded since a caller's `now`/`delay` were silently dropped
		// here, so --live measured the real clock and a pinned "in 0 ms" read "1 ms" under load.
		now,
		delay,
		// Issue #458 (PR #463 round 2): the clock the keeper's age is judged on, epoch ms. Its own name, not `now`: `--live`
		// pairs `now` with `delay`, and a clock that does not advance without its `delay` would never reach a deadline.
		wallClock = Date.now,
		// Issue #448: `systemctl show podman.service`, read only where the local daemon is rootful Podman on this host. A seam
		// so a test decides what the unit says; absent, it spawns systemctl through `spawn`, as the docker reads do.
		readPodmanService,
		// Issue #471 (gate round 1): the account a `.env` and the paths it names must belong to (or root) before doctor lets
		// a value in them steer anything. This process's own; a seam so a test can stand for another account's file.
		trustUid = process.geteuid?.(),
		// The deployment `.env`'s one read through one descriptor (`readDeploymentEnv`, gate round 2).
		envFs = { realpathSync, lstatSync, openSync, fstatSync, readFileSync, closeSync },
	} = deps;
	// The facts a --live pass needs from the collection it follows (the endpoint read, docker and the image, the
	// egress canary's readings), filled by collectChecks rather than re-probed.
	const facts = {};
	// `isAlive` and `pid` ride the SHARED seams since issue #350, not just the `--live` spread below: the egress
	// canary names its network after the doctor PROCESS and now sweeps what an earlier doctor run left,
	// so it needs both, and a test cannot drive that sweep while the names come from `process.pid` directly.
	// `live` rides the shared seams since issue #431 for ONE reader: the podman section, whose allowlist line points at
	// `--live` on a plain run and has nothing to say on a `--live` run, where the read-back's own canary answers it.
	// Issue #453 (gate round 1): the venue keys, decided as `up`, `init` and `service install` decide them. doctor read
	// PI_BACKENDS from its shell alone, so on a podman-only deployment whose `.env` says so (the documented setup) its
	// plain run judged docker, while the service it was checking ran podman. This shell wins where it sets a key; the
	// deployment `.env` fills the rest; a disagreement is its own ✗, and doctor then judges this shell's values.
	//
	// ONE read of the file, shared: a regular file only (a FIFO would hang a synchronous read, as `envFileKeys` guards
	// against), and the text handed to the first `.env` read the checks below make, so a run still reads the file once.
	// A file that is there and cannot be read is said, as `up` says it (gate round 2): the venue then comes from this
	// shell alone. An absent one (ENOENT) is simply absent.
	const envPath = join(cwd, ".env");
	// BYTES (issue #447): what systemd refuses to load is judged before decoding. Through ONE descriptor since gate round
	// 2 (`readDeploymentEnv`, the panel's reader too): judged by `stat` and read by path, a folder another account could
	// write swapped the file between the two.
	const envRead = readDeploymentEnv({ dir: cwd, fs: envFs, uid: trustUid, names: { ownerName: (id) => ownerNameFromPasswd(passwd, id) ?? `uid ${id}`, groupName: (id) => groupNameFromGroup(envFs, id) } });
	const envText = envRead.bytes;
	const envUnread = envRead.unreadable;
	// Issue #471 (gate round 1): a `.env` another account can write decides nothing doctor runs, connects to or writes.
	// Measured: a CONTAINERS_CONF in it naming a containers.conf with a `conmon_path` made doctor's own `podman info` run
	// that program. So from such a file no value is taken at all (the venue keys included), and that is a ✗: the service's
	// loader has no such rule, so the deployment runs on a file someone else chose. The read above still happens, for the
	// two-subject pause and limits reading (`envFileKeys`), which only decides what doctor SAYS.
	const envUntrusted = envText !== null ? envRead.untrusted : null;
	const envValues = envUntrusted ? null : envText;
	let envTextUnused = envText !== null;
	const readEnvFileShared = (path) => {
		if (envTextUnused && path === envPath) {
			envTextUnused = false;
			return envText;
		}
		// The file the one read could not open is not opened a second time by another route.
		if (envUnread && path === envPath) throw Object.assign(new Error(envUnread), { code: envUnread });
		return readEnvFile(path);
	};
	const venueChecks = [];
	if (envUntrusted) {
		venueChecks.push({
			ok: false,
			label: `${envPath} ${envUntrusted}, so doctor took no value from it and judged this shell's values (or the defaults): a value there steers what the service runs and connects to, and a file another account can write is that account's choice`,
			fix: `make the file this account's and writable by it alone (chown to this account, chmod go-w), after reading what is in it; the service reads it as it is`,
		});
	}
	if (envUnread) {
		venueChecks.push({ ok: false, warn: true, label: `${envPath} could not be read (${envUnread}), so PI_BACKENDS, PI_EGRESS and PI_EGRESS_PROXY come from this shell alone, as does every other service setting doctor judges (issue #471)`, fix: "make it a readable regular file, as the service's loader needs it to be" });
	}
	const venue = deploymentVenueEnv({ env: shellVars, fs: { existsSync: () => envValues !== null, readFileSync: () => envValues }, envPath, platform, command: "doctor", loader: serviceEnvLoader(platform), keys: serviceEnvKeys(STACK_KEYS) });
	// The venue keys as decided above, beside this shell's other variables: what doctor hands a child process (`spawnEnv`)
	// and resolves every other service key over (issue #471).
	let venueEnv = shellVars;
	if (venue.error) {
		venueChecks.push({ ok: false, label: `which venue this deployment runs is unknown: ${venue.error}`, fix: "doctor judged this shell's values below; make the shell and the deployment's .env agree, then re-run doctor" });
	} else {
		for (const note of venue.notes) venueChecks.push({ ok: false, warn: true, label: note, fix: "fix that line so the service and this shell read the same venue" });
		const read = Object.entries(venue.fromFile);
		if (read.length > 0) {
			venueEnv = venue.env;
		}
		// Issue #481: an empty venue key is the worker's unset (`parseBackendList`, `egressArmed`, `egressProxyName`), so the
		// line names only the keys the file gives a value; the resolved env keeps the "", which means the same thing.
		const configured = read.filter(([key, value]) => fileConfigures(key, value));
		if (configured.length > 0) {
			venueChecks.push({ ok: true, label: `venue keys read from ${envPath} (${configured.map(([key, value]) => `${key}=${quotedShown(value)}`).join(", ")}), as the service reads them: this shell does not set them` });
		}
	}
	// The Valkey owner rule reads this host's sockets and probes its addresses, so it is real only where the Valkey probe
	// is: a caller that injects `probeValkey` (every test, which must not reach a Valkey on this host, and a CI runner has
	// one on 6379 behind root's docker-proxy) gets no owner check unless it injects `valkeyOwner` too. Linux only: /proc
	// is where the owner is read.
	const valkeyOwnerSeam =
		valkeyOwner !== undefined
			? valkeyOwner
			: deps.probeValkey === undefined && platform === "linux"
				? (url, { shared, user, envPath, rootOk = false }) =>
						judgeValkeyListeners({ url, probeTcp: probeTcpAddress, lookup: (host, opts) => dnsLookup(host, opts), fs: { readFileSync }, euid: process.geteuid?.(), user, shared, rootOk, ownerName: (uid) => ownerNameFromPasswd(passwd, uid), interfaces: networkInterfaces, envPath, subuids: readSubuidRanges({ user, euid: process.geteuid?.(), fs: { readFileSync } }) })
				: null;
	const valkeyAuthSeam =
		valkeyAuth !== undefined
			? valkeyAuth
			: deps.probeValkey === undefined
				? async (url, { context, withoutPassword = false } = {}) => {
						const { valkeyAuthState } = await import("./connection.mjs");
						const sent = valkeyPasswordFor(url, context);
						return { ...(await valkeyAuthState(url, { context, withoutPassword })), passwordSet: Boolean(sent.password), from: sent.from };
					}
				: null;
	const seams = { cwd, out, spawn, probeValkey, valkeyAuth: valkeyAuthSeam, readHosts, ...(modelCatalog ? { modelCatalog } : {}), ...(piModelLoader ? { piModelLoader } : {}), ...(dollarKeysExist ? { dollarKeysExist } : {}), ...(readAppliedSplit ? { readAppliedSplit } : {}), fileExists, nodeVersion, mkdir, chmod, rm, agentDir, platform, home, providerOracle, facts, jobUserIdentity, stat, passwd, readUnit, readEnvFile: readEnvFileShared, observationFs, jobsDirFs, jobsDirUid, valkeyOwner: valkeyOwnerSeam, isAlive, pid, runTimeouts, live: live === true, wallClock, venueChecks, userName, proxyFilesExist, proxyFileIsDirectory, ...(includeNeeds ? { includeNeeds } : {}), ...(declaredEndpoints ? { declaredEndpoints } : {}), ...(readOverlayFile ? { readOverlayFile } : {}), ...(lstatOverlayFile ? { lstatOverlayFile } : {}), ...(hostAddresses ? { hostAddresses } : {}), ...(readProxyConf ? { readProxyConf } : {}), ...(readPackagedConf ? { readPackagedProxyConf: readPackagedConf } : {}), ...(readPodmanService ? { readPodmanService } : {}), serviceEnvFile: envValues === null ? null : serviceEnvFileOf(envValues, envPath, serviceEnvLoader(platform)) };
	// Issue #471: every other service key, resolved ONCE for the whole run (the fix pass's re-collect and `--live` judge the
	// same resolution). THE RULE (PR #474's round cap, after three rounds of trust patches): no program doctor starts is
	// handed anything from `.env`. Every child gets this shell's own environment, the one it had before #471; a `.env`
	// value decides only what doctor judges in-process (reading files runs no code) and what it says.
	seams.spawnEnv = shellVars;
	seams.serviceEnv = resolveDoctorEnv(venueEnv, seams.serviceEnvFile);
	const env = seams.serviceEnv.env;

	let checks = await collectChecks(venueEnv, seams);
	let failed = render(checks, out);

	if (fix) {
		const ran = await applyFixes(checks, seams, promptFn);
		if (ran > 0) {
			// Converge-to-green: the probes are idempotent and cheap, so ONE full re-collect answers "did
			// the fixes take" without bookkeeping about which probe fed which check. At most once,
			// structurally -- the re-check never re-enters the fix pass, so a fix that did not take is
			// reported still-failing rather than retried forever.
			checks = await collectChecks(venueEnv, seams);
			// Three counts, in `render`'s own tiers (PR #466 gate round 1): "N of M pass" counted every ⚠ as not passing,
			// which read as failures on a run that then said "ready".
			const passing = checks.filter((c) => c.ok).length;
			const warnings = checks.filter((c) => !c.ok && c.warn).length;
			out(`\nre-check after fixes: ${passing} pass, ${warnings} warning(s), ${checks.length - passing - warnings} failing\n`);
			for (const c of checks.filter((c) => !c.ok)) {
				out(`${c.warn ? "⚠" : "✗"} ${c.label}\n    → ${c.fix}\n`);
			}
			// Recomputed with the SAME failed/ok logic as the first pass (warn-not-fail): --fix changes
			// what doctor does, never how it judges. A converged run exits 0 because the checks pass now,
			// not because attempting fixes earns credit.
			failed = checks.some((c) => !c.ok && !c.warn);
		}
	}

	// ONCE, and after --fix: the probes read the host as the fix pass left it, so a fix that pulled the job image is
	// read back rather than reported absent. Rendered like every other check and judged by the same rule.
	if (live === true) {
		// Issue #354: one read-back per venue that runs jobs here, each labelled with its venue. `localUsed` is unset only
		// where no collection filled the facts, which reads as the default: local, exactly as before.
		// Each venue's results are rendered BEFORE the next venue announces its containers, so what podman is about to
		// start never lands between local's announcement and local's verdicts.
		const liveSeams = { ...seams, liveFs, isAlive, pid, nonce, ...(now ? { now } : {}), ...(delay ? { delay } : {}) };
		if (facts.localUsed !== false && render(await liveChecks(env, liveSeams, facts), out)) failed = true;
		if (facts.podman && render(await podmanLiveChecks(env, liveSeams, facts), out)) failed = true;
	}

	// Issue #477: whether anything doctor judged came from the deployment's `.env`, which a hand-started worker never reads.
	const fromFile = [venue.error ? {} : venue.fromFile, seams.serviceEnv.fromFile, seams.serviceEnv.extraFromFile];
	// Issue #481: by `fileConfigures`, so a file whose only lines are empty ones (the service reads them as unset) is not
	// "the file decided something", and the line does not send the operator to the service for nothing.
	const tookFromFile = fromFile.some((taken) => Object.entries(taken ?? {}).some(([key, value]) => fileConfigures(key, value)));
	// Issue #481 (review round 3): and whether doctor accepted a credential only because an env-setup script may export it.
	const expected = seams.expectedFromSetup ?? [];
	const fromSetup = expected.length > 0 && seams.envSetupSeen ? { script: seams.envSetupSeen.script, names: [...new Set(expected)] } : null;
	out(failed ? "\ndoctor: some checks failed: fix the above, then re-run.\n" : `\ndoctor: ready. ${startAdvice({ tookFromFile, envPath, platform, fromSetup, unit: tookFromFile || fromSetup ? installedWorkerUnit(seams, cwd) : null })}\n`);
	return failed ? 1 : 0;
}

/**
 * Issue #477: how to start a worker that runs with what doctor judged. `pi-dispatch worker` started by hand reads this
 * shell's environment and no `.env` (docs/secrets.md: the worker parses no `.env` file), so where doctor took any value
 * from the deployment's `.env`, the worker that sees it is the service, whose loader reads the file; the line names that
 * command (restart for a service installed for this folder), and what a hand-started worker needs. Where doctor took
 * nothing from the file, what it judged is this shell's, and a worker started from it runs with the same.
 */
export function startAdvice({ tookFromFile, envPath, unit, platform = process.platform, fromSetup = null }) {
	// Issue #481 (PR #485 review round 3): what doctor accepted only because an --env-setup script may export it
	// (`fromSetup`: `{ script, names }`) reaches the service alone, which runs that script; a worker started by hand runs
	// none, so the line never sends the operator there, whether or not anything came from the file.
	const setupSaid = fromSetup
		? ` The service ${tookFromFile ? "also " : ""}runs the env-setup script ${envValueShown(fromSetup.script)} first, which doctor expects to export ${fromSetup.names.join(", ")}; a worker started by hand (\`pi-dispatch worker\`) runs no env-setup script, so it starts without ${fromSetup.names.length === 1 ? "that" : "those"} unless this shell exports ${fromSetup.names.length === 1 ? "it" : "them"}.`
		: "";
	if (!tookFromFile && !fromSetup) return "Start the worker with `pi-dispatch worker`.";
	if (!tookFromFile) return `Start the worker as the service: ${restartAdvice(unit, platform)}.${setupSaid}`;
	return `Start the worker as the service, whose loader reads ${envPath} as doctor did: ${restartAdvice(unit, platform)}. A worker started by hand (\`pi-dispatch worker\`) reads this shell's environment and not that file, so it runs without the settings doctor read from the file above unless this shell exports them.${setupSaid}`;
}

/**
 * The command that (re)starts the worker service for this folder (issue #477, PR #478's gate): `pi-dispatch service
 * restart` drives only a USER unit (`systemctl --user`, launchctl's `gui/<uid>` domain) or the nssm service, and says
 * `--system is print-only` of a system one, so a system-scope unit gets the root command itself. Windows has no unit
 * file doctor can read (the service is registered with nssm), so there both commands are named.
 */
function restartAdvice(unit, platform) {
	if (platform === "win32") return "`pi-dispatch service install`, or `pi-dispatch service restart` when its nssm service is already installed";
	if (!unit) return "`pi-dispatch service install`";
	const name = basename(unit.path);
	const at = ` (the service installed for this folder, ${unit.path})`;
	if (unit.scope !== "system") return `\`pi-dispatch service restart\`${at}`;
	if (platform === "darwin") return `\`sudo launchctl kickstart -k system/${name.replace(/\.plist$/, "")}\`${at}`;
	return `\`sudo systemctl restart ${name}\`${at}`;
}

/** The ✓/⚠/✗ lines plus each failure's fix, exactly as doctor has always printed them. Returns whether
 *  any HARD check failed (a ⚠ never fails doctor). Exported so a test can pin what an operator SEES.
 *
 *  Three shapes, and `ok` is read FIRST (issue #462): `ok: true` is a ✓ and never prints its fix, whatever `warn`
 *  says, since `warn` there means only "if this fails, it is soft"; `ok: false, warn: true` is a WARNING, a ⚠ with
 *  its fix that leaves the run ready and the exit code 0; `ok: false` alone is a ✗ that fails the run. A check meant
 *  to warn must therefore say `ok: false, warn: true`, and a fact line that has advice carries it in its label. */
export function render(checks, out) {
	let failed = false;
	for (const c of checks) {
		out(`${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}\n`);
		if (!c.ok) {
			out(`    → ${c.fix}\n`);
			if (!c.warn) failed = true;
		}
	}
	return failed;
}

/**
 * The --fix pass (REQ-DEPLOYMENT-BOOTSTRAP): walk the rendered checks IN ORDER and act on each failing one
 * that carries a fixAction. Returns how many fixes actually RAN -- a declined offer counts for nothing, so
 * a decline-everything run re-checks nothing and ends exactly like a fix-less one.
 */
async function applyFixes(checks, seams, promptFn) {
	let ran = 0;
	for (const c of checks) {
		if (c.ok || !c.fixAction) continue;
		const fa = c.fixAction;
		if (fa.tier === "prompt") {
			// The exact command first, then consent, default No. The same philosophy that runs jobs with
			// --pull=never holds here: nothing is fetched or started implicitly -- the y keypress IS the
			// operator running the command themselves, and doctor only saves the retyping after it.
			seams.out(`\nfix available: ${c.label}\n    $ ${fa.describe}\n`);
			if (!(await promptFn("run this? [y/N] "))) {
				seams.out(`skipped: ${c.label}\n`);
				continue;
			}
		}
		ran++;
		let res;
		try {
			res = await fa.run(seams);
		} catch (e) {
			res = { ok: false, note: e?.message ?? String(e) };
		}
		seams.out(`${res.ok ? "fixed" : "fix failed"}: ${c.label}${res.note ? ` — ${res.note}` : ""}\n`);
	}
	return ran;
}

/**
 * The default --fix consent prompt: y/N over readline, No unless the operator typed y/yes. Two refusals
 * are load-bearing: EMPTY input is No (plain enter must never consent), and NON-TTY stdin is No without
 * reading at all -- a piped or CI `doctor --fix` has nobody at the keyboard, so the prompt tier must
 * execute nothing there. Streams are injectable and the function exported so tests exercise both refusals
 * without owning the process's real stdin.
 */
export async function defaultPromptFn(question, { input = process.stdin, output = process.stdout } = {}) {
	if (!input.isTTY) return false;
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input, output });
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

/** What a `readFileSync(path, enc)` caller expects from a seam that may hand back bytes. */
function asText(content, enc) {
	return enc && typeof content !== "string" ? Buffer.from(content).toString(enc) : content;
}

/**
 * The values `<cwd>/.env` sets for NAMED keys, or `{}`. Doctor's first read of a `.env` (issue #357), and the
 * narrowing is what makes it an addition rather than a reversal. It is NOT the only reader: `up` and `service
 * install` read the venue keys since #430 (`readStackKeys`), and since #453 doctor reads `SERVICE_ENV_KEYS` below,
 * whose values DO steer what doctor spawns, connects to and offers as fixes. For these two keys:
 *
 *   - it reads to decide WHAT DOCTOR SAYS, never to configure anything. No value from here reaches a
 *     config, an argv, a container env, or a fix that writes;
 *   - the caller passes the exact keys its own message names, so this cannot grow into "load .env";
 *   - it is best effort, and it says WHICH kind of nothing it has. A file that is not there is `{}` and
 *     changes no message. Something that is there and cannot be read -- a directory, a pipe, a mode this
 *     account cannot open -- is `{ unreadable: true }`, which gets a line of its own, because "the key is
 *     unset, so the worker ignores it" is a positive claim about a file nobody opened. A file that is
 *     there and malformed comes back as records plus a hazard, naming the line that stopped the read.
 *
 * `docs/secrets.md` opens with "the worker parses no `.env` file" and that stays true: doctor is not the
 * worker, and `worker/test/service.test.mjs` still pins that a `PI_ENV_SETUP` line in `./.env` is not
 * honoured. Parsing is `readEnvAssignments`, in the same module as the writer `up` uses, so a key one can
 * set is a key the other reads back the same way -- and it is asked for THIS PLATFORM's loader, because
 * the three loaders of this file disagree and a blended reading is wrong for every deployment at once.
 */
export const ENV_FILE_READABLE_KEYS = Object.freeze(["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_MODEL_ENDPOINTS_FILE", "PI_ENVELOPE_FILE"]);

/**
 * The keys doctor takes from the deployment's `.env` as the SERVICE's values (issue #453, and since issue #471 every key
 * the service reads that doctor judges): the venue keys `up` and `service install` read, the Valkey the worker connects
 * to, the provider, the GitHub auth source and App keys (PR #466 gate round 2, `GITHUB_SERVICE_KEYS`), that provider's
 * key variables (pi's own names for it, passed in, and judged for presence only, never printed), the jobs and sandbox
 * dirs and the TMPDIR the default jobs root lives under (issue #464), PI_VALKEY_SHARED, the opt-in the Valkey owner check
 * reads, and (issue #471) the rest of the worker's settings doctor judges and the receiver's (`WORKER_SERVICE_KEYS`,
 * `RECEIVER_SERVICE_KEYS`). ONE structural allowlist: every `.env` value doctor acts on passes `serviceEnvKeys` first,
 * and `collectChecks` resolves each of them ONCE (`resolveServiceEnv`, shared with the admin panel), so no check reads
 * a service key from this shell alone. Unlike `ENV_FILE_READABLE_KEYS` these values steer what doctor does: which
 * venue it judges and so which runtime it spawns, which Valkey it connects to, which image it inspects and runs, and
 * which fixes it offers; none of them reaches a spawned program's environment (PR #474's round cap). Each of those is judged before use as the worker judges
 * it, or named and not used (`STEERING_SERVICE_KEYS`).
 */
/** The GitHub App keys (PR #466 gate round 2): whose presence and format decide the app-auth lines, which FAIL where
 *  the worker's boot or its token mint would. Judged, never printed, beyond what those lines already print (the ids and
 *  the key's path, neither a secret); the inline key is only ever sniffed for its first bytes. */
export const GITHUB_SERVICE_KEYS = Object.freeze(["GITHUB_AUTH_SOURCE", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_PRIVATE_KEY"]);
/** Issue #471: the worker's settings doctor judges, which it read from this shell alone while the service read them from
 *  `.env`. TEMP is TMPDIR's twin in the worker's temp root; PI_CODING_AGENT_DIR is where the worker reads auth.json. */
export const WORKER_SERVICE_KEYS = Object.freeze(["PI_JOB_IMAGE", "PI_JOB_MEMORY", "PI_JOB_CPUS", "PI_TRIGGERS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_SESSIONS_DIR", "PI_SESSIONS_TTL_DAYS", "PI_SESSION_MAX_AGE_DAYS", "PI_SESSION_MAX_CONTEXT_PCT", "PI_SESSION_MAX_RESUME_CHAIN", "PI_GLOBAL_PI_DIR", "PI_GLOBAL_ALLOW_EXTENSIONS", "PI_FORWARD_ENV", "PI_AUTH_FROM_PI", "PI_CODING_AGENT_DIR", "PI_BACKEND_FLOOR", "PI_SECRET_PROFILES", "PI_SECRET_RESOLVER_ROOTS", "PI_WAIT_PROFILES", "PI_WAIT_AFTER_MAX_MS", "PI_SANDBOX_RETENTION_HOURS", "PI_ALLOWED_MODELS", "PI_DISPATCH_RUN_ROOTS", "GITHUB_PAT_VAR", "TEMP", ...Object.values(DOLLAR_ENV_NAMES)]);
/** Issue #471: the receiver's keys doctor judges its boot by (the receiver's unit reads the same `.env`). */
export const RECEIVER_SERVICE_KEYS = Object.freeze(["WEBHOOK_SECRET", "RECEIVER_PORT", "GITLAB_TOKEN", "GITLAB_URL", "GITLAB_WEBHOOK_MODE", "GITLAB_WEBHOOK_SECRET", "FORGEJO_URL", "FORGEJO_TOKEN", "FORGEJO_WEBHOOK_SECRET", "AZURE_ORG_URL", "AZURE_TOKEN", "AZURE_WEBHOOK_MODE", "AZURE_WEBHOOK_SECRET", "AZURE_WEBHOOK_HEADER"]);
/**
 * Issue #471 (follow-up): the variables the CLIs doctor spawns read from their environment, by the CLI that reads them.
 * The worker starts podman, docker and gh with its OWN environment (no `env` option: `image-preflight.mjs`,
 * `run-container.mjs`, `backend-podman.mjs`, `egress.mjs`, `get-token.mjs`), which under systemd includes `.env`, and
 * its conf-chain checks (#428, #448) read that same environment. So a `.env` CONTAINERS_CONF, DOCKER_HOST or GH_CONFIG_DIR
 * moves the SERVICE's runtime, and doctor, spawning with its shell's, judged another containers.conf chain, another
 * daemon or another gh login. Each is a service key, resolved like the rest, and used where doctor judges IN-PROCESS
 * (the containers.conf chain check reads CONTAINERS_CONF, CONTAINERS_CONF_OVERRIDE and XDG_CONFIG_HOME as the worker
 * does). None is handed to a program doctor starts (PR #474's round cap): three rounds of rules for handing them on
 * safely each had a hole (a flipped link, a missing tail under /tmp another account created in time, a socket held
 * back that should not have been), and a spawn that never sees them has none. Each one the file sets gets its own ⚠
 * (`cliNotHandedLines`): the podman, docker and gh probes describe this shell's view, not the service's.
 */
export const CLI_SERVICE_KEYS = Object.freeze({
	// HOME since #448 (PR #473): rootful Podman's containers.conf chain, as `observeHost` and `observeRootfulConf` read
	// it through podman-docker, includes `$HOME/.config`, so the service's HOME decides a chain doctor judges in-process.
	podman: Object.freeze(["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "CONTAINERS_STORAGE_CONF", "CONTAINERS_REGISTRIES_CONF", "CONTAINER_HOST", "CONTAINER_CONNECTION", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HOME"]),
	docker: Object.freeze(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "HOME"]),
	gh: Object.freeze(["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "XDG_CONFIG_HOME", "HOME"]),
});
const CLI_KEY_NAMES = [...new Set(Object.values(CLI_SERVICE_KEYS).flat())];
export const SERVICE_ENV_KEYS = Object.freeze([...STACK_KEYS, "VALKEY_URL", VALKEY_SHARED_KEY, VALKEY_PASSWORD_KEY, VALKEY_PORT_KEY, "PI_PROVIDER", "PI_MODEL", ...GITHUB_SERVICE_KEYS, "PI_JOBS_DIR", "PI_SANDBOX_DIR", "TMPDIR", "PI_WORKER_NAME", ...WORKER_SERVICE_KEYS, ...RECEIVER_SERVICE_KEYS, ...CLI_KEY_NAMES]);

/** Issue #471 (gate round 1): what a service manager gives every service itself, so a `.env` need not carry it. */
const AMBIENT_SERVICE_KEYS = Object.freeze(["TMPDIR", "TEMP", "XDG_RUNTIME_DIR", "HOME"]);

/**
 * The worker unit installed for the deployment in `cwd` (its WorkingDirectory), as the path doctor read, else null.
 * Read as the job-user check reads units (`installedUnitPaths`, `readUnitSeam`), for the shell-only line.
 */
function serviceUnitFor(seams, cwd) {
	return installedWorkerUnit(seams, cwd)?.path ?? null;
}

/** `serviceUnitFor` with the unit's scope (issue #477): `{ path, scope }`, `scope` "user" or "system", else null. */
function installedWorkerUnit(seams, cwd) {
	const { platform, home, fileExists, readUnit = (path) => readFileSync(path, "utf8") } = seams;
	for (const { path, which, scope } of installedUnitPaths(platform, home)) {
		if (which !== "worker" || !fileExists(path)) continue;
		try {
			if (readUnitSeam(readUnit(path), platform).deployDir === cwd) return { path, scope };
		} catch {}
	}
	return null;
}

/** The CLI variables that name a path, whose value a ⚠ may show; the rest (endpoints, names, tokens) it never shows. */
const CLI_PATH_KEYS = Object.freeze(["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "CONTAINERS_STORAGE_CONF", "CONTAINERS_REGISTRIES_CONF", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DOCKER_CONFIG", "GH_CONFIG_DIR", "HOME"]);
/** The ones the worker's containers.conf chain check reads, which doctor runs in-process on the resolved values. */
const PODMAN_CHAIN_KEYS = Object.freeze(["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "XDG_CONFIG_HOME", "HOME"]);

/**
 * Issue #471 (PR #474's round cap): one ⚠ per CLI variable the deployment `.env` sets, none of which doctor hands to a
 * program it starts. Named always; the value shown only for a path (escaped), never for an endpoint, a connection or
 * context name, or a token. Says that doctor's probes through that CLI describe this shell's view, and, for the keys
 * the containers.conf chain check reads, that the check itself judged the file's value, in-process, as the worker does.
 */
export function cliNotHandedLines(service, envPath) {
	const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
	// Issue #481: an empty value is left out only where the tool's own source reads it as unset (`fileConfigures`).
	return CLI_KEY_NAMES.filter((k) => Object.hasOwn(service.fromFile, k) && fileConfigures(k, service.fromFile[k])).map((k) => {
		const names = Object.entries(CLI_SERVICE_KEYS).filter(([, ks]) => ks.includes(k)).map(([cli]) => cli);
		const clis = listed(names);
		// Grammar by count (round-cap re-review, D2): "podman, docker and gh use it", "podman uses it".
		const verb = names.length > 1 ? "use" : "uses";
		// An empty HOME in quotes, so the line does not read "(" and ")" around nothing.
		const shown = CLI_PATH_KEYS.includes(k) ? ` (${service.fromFile[k] === "" ? '""' : envValueShown(service.fromFile[k])})` : "";
		return {
			ok: false,
			warn: true,
			label: `${k} is set in ${envPath}${shown}, and doctor hands nothing from that file to a program it starts, so its ${clis} probes ran without it and describe this shell's view, not the service's${PODMAN_CHAIN_KEYS.includes(k) ? "; the containers.conf check below read it as the worker does" : ""}`,
			// Not "export it and re-run" alone: what it names may be a program, and the lab's case was another account's.
			fix: `the service's own ${clis} ${verb} it: check what ${k} names and who can change it, then, to see that view, run doctor from a shell that exports the same ${k}`,
		};
	});
}

/**
 * Issue #471: the service keys whose value steers what doctor SPAWNS, CONNECTS TO or WRITES, and how a `.env` value of
 * each is judged before doctor follows it. Every other service key only decides what a line says. A test holds every
 * key here to the allowlist; a key added here says how it is judged, or it is not followed.
 */
export const STEERING_SERVICE_KEYS = Object.freeze({
	PI_BACKENDS: "which runtime doctor spawns: judged by the worker's own list parser, a shell/.env disagreement a ✗ (deploymentVenueEnv)",
	PI_EGRESS: "whether the egress canary runs: the worker's own reading, a disagreement a ✗ (deploymentVenueEnv)",
	PI_EGRESS_PROXY: "which proxy container doctor inspects: the worker's own name resolution, a disagreement a ✗ (deploymentVenueEnv)",
	VALKEY_URL: "which Valkey doctor connects to: the owner rule the worker applies at boot, and a line doctor cannot read makes it contact none",
	PI_JOB_IMAGE: "the image doctor inspects and runs (the canary, the gh probe, --live): the worker's `||` default and the one image rule its boot applies (image-ref.mjs: blank, padded, a leading dash, a control character), a refused value named and not used",
	GITHUB_AUTH_SOURCE: "whether doctor runs gh on this host: the worker's own three values",
	GITHUB_PAT_VAR: "which variable is the service's PAT: resolved and never printed; set by the file (or its PAT only in the file), the in-image gh probe is not run, since no program doctor starts is handed anything from .env",
	PI_GLOBAL_PI_DIR: "the directory `--fix` restages into and removes auth.json from (prompt tier, the command shown first): the worker's rule, unset or empty is off, set must be an absolute path that exists",
	PI_TRIGGERS_FILE: "the file whose images, repos and folders doctor probes: a regular file only, parsed by the worker's own parser before any of its values is used",
	PI_SESSIONS_DIR: "the directory `--fix` creates: silent only for this shell's own value; a value from .env is offered at the prompt tier, shown first",
	PI_JOBS_DIR: "where --live makes its fixture: the jobs dir owner rule the worker applies at boot (#464)",
	PI_SANDBOX_DIR: "the retained-run count doctor reads: the same owner rule (#464)",
	TMPDIR: "the default jobs root: the same owner rule (#464)",
	TEMP: "TMPDIR's twin in the worker's temp root: the same owner rule (#464)",
	CONTAINERS_CONF: "which containers.conf chain the conf-chain check judges, in-process, as the worker reads it (#428, #448); never handed to a program doctor starts",
	CONTAINER_HOST: "which Podman service the SERVICE's podman talks to: never handed to doctor's podman, named in a ⚠",
	DOCKER_HOST: "which daemon the SERVICE's docker talks to: never handed to doctor's docker, named in a ⚠",
	GH_CONFIG_DIR: "which gh login the SERVICE's gh reads: never handed to doctor's gh, named in a ⚠",
});

/**
 * Issue #471: the variables doctor reads from THIS shell on purpose, each with why, so the bolt test can tell a read
 * that went back to the shell from one that was always meant to be there. A name read as `env.NAME` in doctor.mjs is in
 * `SERVICE_ENV_KEYS` or here, never neither.
 */
export const DOCTOR_SHELL_KEYS = Object.freeze({
	PI_ENV_SETUP: "the --env-setup script this shell was started under; the service's comes from its unit, which doctor reads back (envSetupChecks)",
	XDG_DATA_HOME: "where THIS account's Podman keeps its store, which doctor inspects as this account",
	DOCKER_CONTENT_TRUST: "a docker CLI setting of this shell, named for the --live probes this shell's CLI runs",
	PI_PAUSE_WINDOWS_FILE: "read from .env by its own two-subject rule (ENV_FILE_READABLE_KEYS): the service judged from the file, this shell judged as itself",
	PI_SCOPED_LIMITS_FILE: "read from .env by its own two-subject rule (ENV_FILE_READABLE_KEYS)",
	PI_PROJECTS_FILE: "read from .env by its own two-subject rule (ENV_FILE_READABLE_KEYS), #499",
	PI_MODEL_ENDPOINTS_FILE: "read from .env by its own two-subject rule (ENV_FILE_READABLE_KEYS), #503",
	PI_ENVELOPE_FILE: "read from .env by its own two-subject rule (ENV_FILE_READABLE_KEYS), #504",
	[VALKEY_SHARED_KEY]: "read from .env ONLY (#464); a value in this shell is named as ignored",
});

/** Issue #471: the service keys whose values a disagreement line never prints (set or unset only); URLs print as
 *  `urlShown` does. Every other key's two values are shown, quoted. */
const SECRET_SERVICE_KEYS = new Set([VALKEY_PASSWORD_KEY, "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_PRIVATE_KEY", "WEBHOOK_SECRET", "GITLAB_TOKEN", "GITLAB_WEBHOOK_SECRET", "FORGEJO_TOKEN", "FORGEJO_WEBHOOK_SECRET", "AZURE_TOKEN", "AZURE_WEBHOOK_SECRET"]);
const URL_SERVICE_KEYS = new Set(["VALKEY_URL", "GITLAB_URL", "FORGEJO_URL", "AZURE_ORG_URL"]);

/** `keys` narrowed to `SERVICE_ENV_KEYS` plus the provider's own key variables. */
export function serviceEnvKeys(keys, providerKeys = []) {
	return keys.filter((k) => SERVICE_ENV_KEYS.includes(k) || providerKeys.includes(k));
}

/**
 * Issue #471: every service key doctor judges, resolved ONCE by the service's rule (`resolveServiceEnv`): this shell's
 * value where it sets one, else the deployment `.env`'s from a line the service's loader reads as written, a
 * disagreement returned to be reported, and a line doctor cannot read named and never used. Not the venue keys, which
 * `deploymentVenueEnv` decided with `up`'s own reader before this, nor PI_VALKEY_SHARED, which comes from `.env` alone.
 * `extra` resolves keys whose NAMES are only known later (the provider's key variables, the PAT variable) by the same
 * rule, into the same record, so each is said once with the rest.
 */
export function resolveDoctorEnv(venueEnv, file) {
	const keys = serviceEnvKeys(SERVICE_ENV_KEYS.filter((k) => !STACK_KEYS.includes(k) && k !== VALKEY_SHARED_KEY));
	const record = resolveServiceEnv({ env: venueEnv, file, keys });
	// The venue keys only this shell sets (gate round 1): `deploymentVenueEnv` decided them, and says nothing of these.
	record.shellOnly.unshift(...resolveServiceEnv({ env: venueEnv, file, keys: STACK_KEYS }).shellOnly);
	// Issue #477: the keys `extra` took from the file, kept apart from `fromFile` (whose ✓ line each extra's own line
	// already covers), so doctor's closing line knows the file decided something.
	record.extraFromFile = {};
	record.extra = (names) => {
		const more = resolveServiceEnv({ env: venueEnv, file, keys: names });
		Object.assign(record.extraFromFile, more.fromFile);
		for (const k of ["disagreements", "unread", "hazardSkipped", "shellOnly"]) {
			for (const item of more[k]) if (!record[k].some((have) => (have.key ?? have) === (item.key ?? item))) record[k].push(item);
		}
		return more;
	};
	return record;
}

/** Issue #471: one disagreement, in words that print no secret (`SECRET_SERVICE_KEYS`) and no URL's credentials. */
function disagreementShown({ key, shell, file }, path) {
	// A name outside the allowlist is one resolved later by name (the provider's key variables, the PAT): a credential.
	let secret = SECRET_SERVICE_KEYS.has(key) || !SERVICE_ENV_KEYS.includes(key);
	if (!secret && URL_SERVICE_KEYS.has(key)) {
		const [a, b] = [urlShown(shell), urlShown(file)];
		if (a !== b) return `${key} is ${quotedShown(a)} in this shell and ${quotedShown(b)} in ${path}`;
		secret = true;
	}
	if (secret) return `${key} is set differently in this shell and in ${path} (neither value is shown)`;
	return `${key} is ${quotedShown(shell)} in this shell and ${quotedShown(file)} in ${path}`;
}

/**
 * Issue #481: the keys whose EMPTY value in the deployment `.env` every reader of it takes as unset, so a line saying
 * the file set the key would say more than the file does. An ALLOWLIST, never a denylist (PR #485 review round 1): a key
 * is here only where that is PROVEN, and every other key an empty line names is still said, because a reader that takes
 * empty as a value (PI_TRIGGERS_FILE, GITLAB_URL, VALKEY_URL, CONTAINER_HOST) is exactly the key whose empty line decides
 * something. `"blank"` also covers a whitespace-only value, where the reader trims; `"empty"` is the empty string alone.
 *
 * Two kinds of proof, each pinned by `doctor-empty-keys.test.mjs`:
 *   - a worker or receiver key: the real loaders (`loadConfig`, `loadReceiverConfig`) return the same answer for the key
 *     empty (or blank) as for it absent, across a base per forge and GitHub auth source, and the key is one they read.
 *   - a CLI key, which neither loader reads: the tool's own source reads it with `os.Getenv(...) != ""`. docker
 *     (docker/cli `cli/command/cli.go` for DOCKER_HOST and DOCKER_CONTEXT, `cli/config/config.go` `Dir()` for
 *     DOCKER_CONFIG), gh (cli/go-gh `pkg/auth/auth.go` for GH_TOKEN, GITHUB_TOKEN and GH_HOST, `pkg/config/config.go`
 *     for GH_CONFIG_DIR), and Podman's containers.conf pair (containers/common v0.57.4 `pkg/config/new.go`, as the
 *     worker's own chain check reads them). NOT CONTAINER_HOST or CONTAINER_CONNECTION (podman's
 *     `cmd/podman/registry/remote.go` asks `os.LookupEnv`, so an empty one switches it to remote), CONTAINERS_STORAGE_CONF
 *     (LookupEnv, then a stat of ""), XDG_CONFIG_HOME, XDG_RUNTIME_DIR, HOME, TMPDIR or TEMP, each read by more than one
 *     program, some of which take empty as a value (`os.homedir()` returns an empty HOME as it is; containers/common
 *     takes a set TMPDIR by LookupEnv).
 * Where an empty value refuses the boot, the key is not here, and a ✗ of its own names it besides (the boot files,
 * PI_JOBS_DIR, PI_TRIGGERS_FILE, GITHUB_AUTH_SOURCE, the PAT and its variable, the App keys while app is the source).
 * Judged HERE and not in `resolveServiceEnv`, whose `fromFile` must keep the "" so every check judges what the service
 * is given, and whose cmd rule already drops the empty value where the loader unsets the key.
 */
export const EMPTY_READ_AS_UNSET = Object.freeze({
	PI_BACKENDS: "blank",
	PI_EGRESS: "empty",
	PI_EGRESS_PROXY: "empty",
	GITHUB_APP_PRIVATE_KEY: "blank",
	PI_SANDBOX_DIR: "empty",
	PI_WORKER_NAME: "empty",
	PI_JOB_IMAGE: "empty",
	PI_LOGS_DIR: "empty",
	PI_SETTINGS_FILE: "empty",
	PI_SESSIONS_DIR: "empty",
	PI_SESSIONS_TTL_DAYS: "empty",
	PI_SESSION_MAX_AGE_DAYS: "empty",
	PI_SESSION_MAX_CONTEXT_PCT: "empty",
	PI_SESSION_MAX_RESUME_CHAIN: "empty",
	PI_GLOBAL_PI_DIR: "empty",
	PI_GLOBAL_ALLOW_EXTENSIONS: "empty",
	PI_FORWARD_ENV: "blank",
	PI_BACKEND_FLOOR: "blank",
	PI_SECRET_PROFILES: "blank",
	PI_SECRET_RESOLVER_ROOTS: "blank",
	PI_WAIT_PROFILES: "blank",
	PI_WAIT_AFTER_MAX_MS: "empty",
	PI_SANDBOX_RETENTION_HOURS: "empty",
	WEBHOOK_SECRET: "blank",
	RECEIVER_PORT: "empty",
	GITLAB_TOKEN: "empty",
	GITLAB_WEBHOOK_MODE: "empty",
	GITLAB_WEBHOOK_SECRET: "empty",
	FORGEJO_URL: "empty",
	FORGEJO_TOKEN: "empty",
	FORGEJO_WEBHOOK_SECRET: "empty",
	AZURE_ORG_URL: "empty",
	AZURE_TOKEN: "empty",
	AZURE_WEBHOOK_MODE: "empty",
	AZURE_WEBHOOK_SECRET: "empty",
	AZURE_WEBHOOK_HEADER: "blank",
	// The CLI keys, by each tool's source (above).
	DOCKER_HOST: "empty",
	DOCKER_CONTEXT: "empty",
	DOCKER_CONFIG: "empty",
	GH_TOKEN: "empty",
	GITHUB_TOKEN: "empty",
	GH_HOST: "empty",
	GH_CONFIG_DIR: "empty",
	CONTAINERS_CONF: "empty",
	CONTAINERS_CONF_OVERRIDE: "empty",
});

/** Issue #481: whether a value the `.env` supplied configures anything (`EMPTY_READ_AS_UNSET`): unproven keys always do. */
export function fileConfigures(key, value) {
	const rule = Object.hasOwn(EMPTY_READ_AS_UNSET, key) ? EMPTY_READ_AS_UNSET[key] : null;
	if (rule === null || typeof value !== "string") return true;
	return rule === "blank" ? value.trim() !== "" : value !== "";
}

/** Issue #481: the keys of `fromFile` a "settings read from" line may name (`fileConfigures`). */
function settingsRead(fromFile) {
	return Object.keys(fromFile).filter((k) => fileConfigures(k, fromFile[k]));
}

/**
 * Issue #471: what the service-key resolution has to say, as check lines: where the file supplied keys (one ✓, names
 * only), where this shell and the file disagree (one ✗: doctor judged this shell's values, which a worker started by
 * hand from this shell runs, while the service runs the file's), and a line doctor could not read (one ✗, the line
 * named, its value unused). `said` is the keys another line already announces with its own source.
 */
function serviceEnvLines(service, path, { said = [] } = {}) {
	const lines = [];
	const read = settingsRead(service.fromFile).filter((k) => !said.includes(k));
	if (read.length > 0) lines.push({ ok: true, label: `service settings read from ${path}, as the service reads them (this shell does not set them): ${read.join(", ")}` });
	if (service.disagreements.length > 0) {
		lines.push({
			ok: false,
			label: `this shell and ${path} disagree: ${service.disagreements.map((d) => disagreementShown(d, path)).join("; ")}. doctor judged this shell's values below, which a worker started by hand from this shell runs, while the service runs the file's`,
			fix: `make them agree: change ${path} (what the service reads), or unset the key in this shell, then re-run doctor`,
		});
	}
	const unread = service.unread.filter((u) => !u.skip);
	if (unread.length > 0) {
		lines.push({
			ok: false,
			label: `${path} assigns ${unread.map((u) => `${u.key} (line ${u.line})`).join(", ")} in a form the service's loader may read differently from doctor's reader (quotes, a $, a space), so doctor used none of those values and judged ${unread.every((u) => u.shellSet) ? "this shell's" : "this shell's values or the defaults"} instead: the service's own are unknown`,
			fix: "write each value plainly (no quotes, $, backslash or space), or single-quote it, then re-run doctor",
		});
	}
	return lines;
}

/** The loader of the deployment's `.env` on this platform (`service-env.mjs`, shared with the admin panel since issue
 * #471). ONE mapping for every `.env` read doctor makes. */
export { serviceEnvLoader };

export function envFileKeys(path, keys, { fileExists, readEnvFile, statFile = statSync, platform = process.platform }) {
	if (typeof readEnvFile !== "function" || !fileExists(path)) return {};
	// A REGULAR file or nothing. Every other host read in this module is bounded one way or another, and a
	// synchronous read of a FIFO is not: a `.env` that is a named pipe hangs `pi-dispatch doctor` forever,
	// with no output and no check to point at.
	//
	// UNREADABLE, not absent, and the distinction is the whole point of the flag. Something IS at this path
	// -- `fileExists` said so -- and doctor cannot read it, which is a different sentence from "the key is
	// unset, so the worker ignores it". The earlier comment here claimed "a directory throws and is caught
	// below"; it does not, `statFile` answers happily and `isFile()` is false, so a `.env` that is a
	// directory came back as an ordinary absent key and got the unset line. A test even pinned that.
	try {
		if (!statFile(path).isFile()) return { unreadable: true };
	} catch {
		return { unreadable: true };
	}
	// The narrowing is STRUCTURAL rather than a convention the caller keeps. A caller's key list can only
	// narrow this further, never widen it: the licence for reading a `.env` at all is that it decides what
	// two named checks SAY, and "the caller passes the right keys" is the kind of rule that holds until the
	// third check wants the same softening and adds its own key to an array. A `.env` also holds
	// `WEBHOOK_SECRET` and provider keys, and `up.mjs` states the standard for those: a webhook secret in a
	// scrollback is a webhook secret in a pastebin. Add a key here and the addition is the review.
	const allowed = keys.filter((k) => ENV_FILE_READABLE_KEYS.includes(k));
	if (allowed.length === 0) return {};
	try {
		const serviceLoader = serviceEnvLoader(platform);
		const { text, loadHazard } = decodeEnvFile(readEnvFile(path), { loader: serviceLoader });
		// THE SERVICE'S OWN LOADER FIRST, because this file has three and they disagree (issue #384).
		// `service.mjs` renders exactly one per platform: systemd's `EnvironmentFile=` on linux,
		// `worker-env-wrapper.sh` (a sourcing shell) on darwin, `worker-env-wrapper.cmd` on win32. Reporting a
		// reading from a loader this deployment does not use is how doctor told half its operators the wrong
		// file under the previous shape, which asked systemd's grammar on every platform.
		const service = readEnvAssignments(text, allowed, { loader: serviceLoader });
		// The shell reading stays beside it on POSIX, because a `.env` is also sourced by hand
		// (`set -a; . ./.env`) and because the two disagree about an `export` line, which is the third state
		// below. ON WIN32 THERE IS NO SECOND LOADER, and computing one anyway reported a file that assigns the
		// key ONCE as "assigned twice with different values" -- on the very line `renderEnvValue` writes there,
		// since every Windows path carries a backslash that no POSIX loader will vouch for.
		const shell = readEnvAssignments(text, allowed, { loader: serviceLoader === "shell" ? "systemd" : "shell" });
		// One line elsewhere can take the vouch off every reading in the file, and a key with NO record at all
		// is the case that needs this most: a BOM'd line, a `K+=` line or a line the shells simply run leaves
		// this reader silent about a key the loaders do set.
		// A file systemd will not LOAD comes first: nothing else about it reaches the service (issue #447, gate round 1).
		const hazard = loadHazard ?? envFileHazard(text, { loader: serviceLoader });
		// A line INSIDE a multi-line quoted value is part of that value to systemd and to the shells (issue #447), so
		// its fix is about the quote above it, not about the line's own form.
		const regions = serviceLoader === "cmd" ? [] : quotedRegions(text);
		const plain = {};
		const notPlain = {};
		const insideValue = {};
		const exported = {};
		const alsoExported = {};
		const blankInFile = {};
		for (const key of allowed) {
			// An empty value UNSETS under the cmd wrapper (`set "K="`), so on win32 such a line leaves the service
			// WITHOUT the key rather than with a blank one. Treating it as blank failed a Windows deployment that
			// starts, in a sentence that named the .cmd wrapper as the thing keeping the empty value.
			const own = serviceLoader === "cmd" && service[key]?.value === "" ? undefined : service[key];
			const other = shell[key];
			// WHAT THE SERVICE READS, and only when this file can say so. A shape outside the grammar every
			// loader agrees on is reported as a LINE, never as a value (issue #384): the reader's own docblock
			// lists what systemd and the shells do differently, and printing one of those readings as "the
			// value the service reads" is a claim this file cannot support.
			// VOUCHED, which is EQUIVALENT to `plain` here and is written as the question being asked: in a
			// readable file the two are the same value, and an unreadable one never reaches this, because the
			// caller answers that once and says nothing else about the key. Recorded rather than chased, like
			// the same equivalence on the disagreement branch below.
			if (own !== undefined && own.vouched && own.value !== "") plain[key] = own.value;
			else if (own !== undefined && !own.plain) {
				notPlain[key] = own.line;
				const region = regions.find((r) => own.line > r.open && (r.close === null || own.line <= r.close));
				if (region) insideValue[key] = region.open;
			}
			// Export-only means NO bare assignment anywhere, not "none that survived". A file holding both
			// `KEY=/systemd.json` and `export KEY=/wrapper.json` is configured under systemd, and calling it
			// export-only would print a value systemd never sees and advise dropping a prefix, which would
			// change which file the worker loads. The empty case is part of "anywhere": a bare `KEY=` IS an
			// assignment, and systemd reads it as the empty value that refuses the boot.
			// THE FILE's export line, not "this platform's view happens to be undefined". Nulling the cmd
			// reading of an empty value (below) dropped a bare `KEY=` straight into this branch, so doctor
			// quoted `export PI_PAUSE_WINDOWS_FILE=` at a Windows operator whose file contains no such line
			// and told them to drop a prefix that is not there.
			//
			// `other.vouched`, not `other.plain`: this prints the value, and a file with a hazard in it is a
			// file where that value is a guess.
			if (service[key] === undefined && other !== undefined && other.vouched) exported[key] = other.value;
			// BOTH readings plain, or there is nothing to compare. A reading that is not plain carries no value
			// at all, and `?? ""` renamed it "an EMPTY value, which refuses the boot" -- the same "is it set"
			// trap the record shape exists to abolish, reintroduced inside this function.
			// NOT ON WIN32, where no POSIX shell reads this file at all: comparing the cmd reading against one
			// reported a file that assigns the key ONCE as "assigned twice with different values", on the very
			// line `renderEnvValue` writes there. The export-only signal above stays on every platform, because
			// "only a sourcing shell reads this line" is true and useful wherever the line is.
			// `vouched` on both, because this PRINTS two values and a file this command cannot read is one
			// where neither is worth quoting. It is equivalent to `plain` wherever the branch is reachable --
			// the caller stands the service verdicts down entirely when the file carries a hazard -- and it
			// is written as the question actually being asked, so that a later caller cannot reach it from
			// somewhere the equivalence does not hold.
			else if (serviceLoader !== "cmd" && own !== undefined && other !== undefined && own.vouched && other.vouched && own.value !== other.value) alsoExported[key] = other.value;
			// BLANK ALONE, because the file being readable is already decided: the caller answers an
			// unreadable file once and says nothing else about the key, so everything here is about a file
			// whose lines mean what they say. Requiring `vouched` as well looked like the same rule and was
			// not -- `vouched` also demands that THIS line's value be inside the printable grammar, so
			// `KEY=""''`, which is empty to systemd 252 and to all four shells (measured), was reported as a
			// shape doctor could not vouch for and exited 0 on a deployment that cannot start.
			if (own !== undefined && own.blank) blankInFile[key] = true;
		}
		// A line assigning one of the service wrapper's own variables (issue #470 follow-up): no effect, since the wrapper
		// assigns them again after the load, and said as such. The line's NAME, never its value.
		const wrapperInternal = envFileWrapperInternal(text, { loader: serviceLoader });
		return { ...plain, notPlain, insideValue, exported, alsoExported, blankInFile, serviceLoader, hazard, wrapperInternal };
	} catch {
		// COULD NOT READ is not "this key is unset". Returning the same `{}` for both told an operator whose
		// `.env` is a directory, or is not readable by this account, that the worker ignores a key -- a positive
		// claim about a file nobody could open.
		return { unreadable: true };
	}
}

/**
 * The files a worker LOADS at boot, and the one place that knows what each is and how to ask. The model endpoints file
 * (issue #503) defaults to the deployment folder's copy where the other three are off when unset.
 *
 * `load` calls the worker's own loader (issue #384). Doctor used to carry its own parse for scoped limits
 * and nothing at all for pause windows, so "will the worker start" had two answers and one silence. The
 * loaders throw a `configError` on a path that does not exist and on content that does not parse, which is
 * exactly the boot this check is predicting.
 */
const BOOT_FILES = Object.freeze([
	Object.freeze({
		key: "PI_PAUSE_WINDOWS_FILE",
		noun: "scoped pauses",
		scaffold: "pause-windows.json",
		off: "scoped pauses are OFF",
		unsetMeans: "the worker loads no windows at all",
		unit: "window",
		nothing: "quiet hours",
		fails: "REFUSES TO START",
		whenDeleted: "turns scoped pauses off",
		whenEmpty: "turns the worker off",
		emptyCost: "refuses the boot",
		resolve: pauseWindowsFilePath,
		load: (path, io) => loadPauseWindows({ pauseWindowsFile: path }, io),
	}),
	Object.freeze({
		key: "PI_SCOPED_LIMITS_FILE",
		noun: "scoped limits",
		scaffold: "scoped-limits.json",
		off: "scoped caps and concurrency are OFF (the built-in one-job-per-folder mutex stays on)",
		unsetMeans: "the worker enforces no scoped limits at all",
		unit: "limit",
		nothing: "scoped limits",
		fails: "REFUSES TO START",
		whenDeleted: "turns scoped limits off",
		whenEmpty: "turns the worker off",
		emptyCost: "refuses the boot",
		resolve: scopedLimitsFilePath,
		load: (path, io) => loadScopedLimits({ scopedLimitsFile: path }, io),
	}),
	// Issue #499. Off when unset, like the two above: no projects, and every run records `project: null`. The worker
	// loads it at boot (start.mjs, `loadProjects`), so a file that does not load and an empty value refuse the start.
	Object.freeze({
		key: "PI_PROJECTS_FILE",
		noun: "projects",
		scaffold: "projects.json",
		off: "projects are OFF (every run records no project)",
		unsetMeans: "the worker groups no run into a project",
		unit: "project",
		nothing: "projects",
		// No panel writes this file yet (the project tools come with part C of issue #499), so the unset fix line must
		// not say the panel reports a project it wrote as applied live.
		panelWrites: false,
		fails: "REFUSES TO START",
		whenDeleted: "turns projects off",
		whenEmpty: "turns the worker off",
		emptyCost: "refuses the boot",
		resolve: projectsFilePath,
		load: (path, io) => loadProjects({ projectsFile: path }, io),
	}),
	// Issue #503. Not off when unset: the worker then reads the scaffold in the deployment folder, so `defaultsToScaffold`
	// swaps the "exists but unset" warning for a load of that file. The worker loads it at boot exactly like the two
	// above (start.mjs, `loadModelEndpoints`), so a file that does not load, a named file that is missing and an empty
	// value all REFUSE THE START; a live edit that does not load keeps the last good declaration instead
	// (`model_endpoints_reload_invalid`), which is a running worker's posture and not the one predicted here. A valid
	// `{"version":1,"endpoints":[]}` declares none, and only a missing DEFAULT file means the same. The file decides the
	// proxy include, the slot leases at pickup and the keyless credential gate, so a start on a bad one would be a
	// deployment whose rules and bounds the operator believes in and does not have.
	Object.freeze({
		key: "PI_MODEL_ENDPOINTS_FILE",
		noun: "declared model endpoints",
		scaffold: MODEL_ENDPOINTS_FILE_NAME,
		defaultsToScaffold: true,
		unsetMeans: `the worker reads ${MODEL_ENDPOINTS_FILE_NAME} in the deployment folder`,
		unit: "endpoint",
		nothing: "model endpoints",
		fails: "REFUSES TO START",
		whenDeleted: `reads ${MODEL_ENDPOINTS_FILE_NAME} in the deployment folder instead`,
		whenEmpty: "turns the worker off",
		emptyCost: "refuses the boot",
		resolve: modelEndpointsFilePath,
		// The worker's own default when VALKEY_URL is unset, so both refuse an endpoint on 6379 alike.
		load: (path, io, env) => loadModelEndpoints({ modelEndpointsFile: path, valkeyUrl: env?.VALKEY_URL ?? DEFAULT_VALKEY_URL }, io),
	}),
	// Issue #504 part B. Off when unset: no envelope and no delegation, and every cap is what the operator's rows and
	// windows set. The worker loads it at boot (start.mjs, `loadEnvelopeChecked`) against the projects and scoped limits
	// it loaded, with the merged per-job cap, and refuses the start when it lies inside a job path, so this load asks the
	// same three questions through the same function (`loadEnvelopeAsTheWorker`).
	Object.freeze({
		key: "PI_ENVELOPE_FILE",
		noun: "the allocation envelope",
		scaffold: "envelope.json",
		off: "delegated allocation is OFF (every dollar cap is the operator's own)",
		unsetMeans: "no envelope governs any job and no priorities plan applies",
		unit: "envelope",
		nothing: "allocation envelope",
		// The admin writes this file (`dispatch_envelope_set`, issue #504 part C), but only at the path the key names: it
		// has no default path, so the fix line's "the admin panel defaults to this same file" sentence does not apply.
		panelWrites: false,
		fails: "REFUSES TO START",
		whenDeleted: "turns delegated allocation off",
		whenEmpty: "turns the worker off",
		emptyCost: "refuses the boot",
		resolve: envelopeFilePath,
		load: (path, io, env) => loadEnvelopeAsTheWorker(path, io, env),
	}),
]);

/** A key's value when it is a non-empty string, else null: the boot reads an unset key as off. */
function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The envelope as the WORKER would load it (issue #504 part B): against the projects and scoped limits the service
 * names (each loaded by its own loader; one that does not load is its own BOOT_FILES line, so here it counts as none),
 * with the merged per-job cap, and with the containment check against the triggers file's cron folders and skills
 * dirs, the run roots and the global pi dir. Throws what the worker's boot would throw.
 */
export function loadEnvelopeAsTheWorker(path, io = {}, env = {}) {
	return loadEnvelopeChecked({ envelopeFile: path }, { ...envelopeContextOf(env, io), jobPaths: envelopeJobPaths({ triggersFile: nonEmpty(env.PI_TRIGGERS_FILE), dispatchRunRoots: delimitedList(env.PI_DISPATCH_RUN_ROOTS), globalPiDir: nonEmpty(env.PI_GLOBAL_PI_DIR) }, io) }, { io });
}

/** The projects, the scoped limits and the merged per-job cap (micro-dollars, or null) the envelope is judged against. */
function envelopeContextOf(env, io = {}) {
	const quiet = (load) => {
		try {
			return load();
		} catch {
			return [];
		}
	};
	const projects = quiet(() => loadProjects({ projectsFile: nonEmpty(env.PI_PROJECTS_FILE) }, io));
	const limits = quiet(() => loadScopedLimits({ scopedLimitsFile: nonEmpty(env.PI_SCOPED_LIMITS_FILE) }, io));
	let maxCostMicros = null;
	try {
		const settings = deploymentSettingsOf(env, settingsFilePath(env), (p) => (io.existsSync ?? existsSync)(p));
		maxCostMicros = optionalUsdMicros(settings.maxCostUsd, "maxCostUsd");
	} catch {
		// A malformed cap is its own line; the envelope then reads as having none, which it refuses.
	}
	return { projects, limits, maxCostMicros };
}

/**
 * Is anything at `path`, by `statFile`: ENOENT is absence, so a directory or an unreadable entry is judged. A stat that
 * cannot say what the entry is (no `isFile`: a seam answering only an owner) is no evidence of a file either.
 */
function presentAt(statFile, path) {
	try {
		return typeof statFile(path)?.isFile === "function";
	} catch (err) {
		return err?.code !== "ENOENT";
	}
}

/** The number of boot files in words, for the one sentence that counts them. */
function countWord(n) {
	return ["zero", "one", "two", "three", "four", "five"][n] ?? String(n);
}

/**
 * Would the worker load this path? The loader answers, with two guards doctor owes it.
 *
 * A RELATIVE path resolves against the seam `cwd`, not `process.cwd()`, because that is the directory a
 * service's `WorkingDirectory=` names and the one every other check in this file measures from.
 *
 * A FIFO or a device would hang the loader's `readFileSync` forever, with no output and no check to point
 * at. `envFileKeys` already carries that guard for `.env` itself; this is the same hazard one file along,
 * and it arrives here because this check reads a path an operator wrote rather than one doctor chose.
 */
/**
 * The line an operator should WRITE, or a sentence saying why there isn't one. Never throws.
 *
 * `renderEnvValue` refuses a value it cannot render so that no writer silently produces a `.env` line the
 * loaders read as something else -- a single quote has no spelling both systemd and the shells read back,
 * so it is refused rather than escaped. That is right for a writer and fatal for a REPORT: doctor started
 * calling it on labels, and `pi-dispatch doctor` in a deployment folder whose name contains an apostrophe
 * died with `cannot write this value into a .env safely` and printed NOTHING ELSE -- not one check. Worse
 * than the defect this command exists to find, and reached by `init` plus `up` alone, with no `.env`
 * needed, because the scaffolded PATH carries the quote.
 *
 * So the refusal becomes advice. Doctor still never invents a spelling: it says the path cannot be written
 * into a `.env`, shows it escaped, and leaves the operator to move the folder or set the key another way.
 */
function fixLineFor(key, value) {
	try {
		return `${key}=${renderEnvValue(value)}`;
	} catch {
		return `${key}=<this path cannot be written into a .env: ${envValueShown(value)} contains a character no loader of this file reads back the same way, so move it or set ${key} through the service's own environment>`;
	}
}

function loadVerdict(spec, rawPath, cwd, io, platform = process.platform) {
	// ABSOLUTE ON THE TARGET PLATFORM, not on this one. `up.mjs` already draws this distinction for the same
	// kind of value, and without it `C:\pi\pause-windows.json` is "relative" to a POSIX `isAbsolute` and
	// gets joined under doctor's cwd -- so the win32 verdicts were computed against a path shape Windows
	// never produces, and the tests asserting them were asserting the same fiction.
	const isAbsoluteOn = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
	const path = isAbsoluteOn(rawPath) ? rawPath : join(cwd, rawPath);
	// EVERY reason carries the path, so every reason goes through the renderer. The grammar keeps a control
	// byte out of a value read from the FILE, and this is the other end: a path out of the environment is
	// constrained by nothing, and its ESC reached the terminal through this string while the file half was
	// carefully withholding one. The loader's own message is rendered too, because it is built from the path.
	const shown = envValueShown(path);
	try {
		if (!io.statFile(path).isFile()) return { ok: false, reason: `${shown} is not a regular file` };
	} catch (err) {
		return { ok: false, reason: err?.code === "ENOENT" ? `${shown} does not exist` : `${shown} cannot be read: ${envValueShown(err?.message ?? String(err))}` };
	}
	try {
		spec.load(path, io.loaderIo, io.env);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: envValueShown(err?.message ?? String(err)) };
	}
}

/**
 * Run every probe and return the check list without rendering -- runDoctor renders it, and under --fix
 * collects it a second time for the converge re-check. Exported for the never-tier doctrine pin in the
 * tests (githubProtectionPreflight's precedent): the test walks the returned array and fails on any check
 * that grows a `fixAction` outside the allowed set, so the never tier stays a tested contract rather than
 * a comment.
 */
export async function collectChecks(shellVars, seams) {
	// Issue #471: every service key resolved ONCE, before anything reads one: this shell's value where it sets one, else
	// the deployment `.env`'s, read with the service's own loader (`serviceEnvFile`, from runDoctor's one read), a
	// shell/.env disagreement and a line doctor cannot read each said below, never settled in silence. `env` is that
	// resolution and is what every check judges; `shellVars` is read here and nowhere else in this function (a test pins
	// it), so no check can go back to reading a service key from this shell alone. runDoctor resolves once for the run and
	// hands the record over; a caller that does not (a test) gets the same resolution here.
	const { serviceEnvFile = null } = seams;
	const service = seams.serviceEnv ?? resolveDoctorEnv(shellVars, serviceEnvFile);
	const env = service.env;
	// What a child process is handed: this shell's environment, as before #471, so a value from `.env` (a token, a secret)
	// never rides into a process doctor starts unless a check passes it by name.
	const spawnEnv = seams.spawnEnv ?? shellVars;
	// The one by-name read of this shell's own environment, for a value a child is handed by name (the probe's PAT).
	const shellValue = (name) => (Object.hasOwn(spawnEnv, name) ? spawnEnv[name] : undefined);
	// `agentDir` is the operator's OWN pi setup, the one `import-pi` stages from and the host side of the overlay comparison
	// below (issue #471 checked): no worker reads it for the overlay, which is PI_GLOBAL_PI_DIR; `import-pi` runs in this
	// shell and reads this shell's PI_CODING_AGENT_DIR, and the restage offer runs it with this shell's environment. So it
	// is this shell's, never the file's. The one thing the worker does read there, auth.json, follows the resolution
	// (`keyAgentDir`).
	const { cwd, spawn, probeValkey, readHosts = defaultReadHosts, fileExists, nodeVersion, platform, agentDir = agentDirFrom(spawnEnv), readHostPiFn = readHostPi, home = safeHomeDir(), underTemp = underOsTempDir, providerOracle = defaultProviderOracle, facts = null, readEnvFile = null, stat: statSeam = statSync, runTimeouts = RUN_TIMEOUTS } = seams;

	// The job image as the worker takes it (`config.mjs` `jobImageFrom`: `||`, so an empty value is the default, where
	// doctor's `??` inspected an image named ""), and judged BEFORE doctor inspects or runs it (issue #471) by the one
	// image rule the worker's boot applies (`image-ref.mjs`): a refused value is named and never handed to a runtime, and
	// doctor judges the default in its place, and says so.
	const { image: jobImage, refused: jobImageRefused } = jobImageOf(env);
	// Issue #464 (gate round 1): a VALKEY_URL line in the service's `.env` that the loaders read differently (an unquoted
	// [::1], say) gives no value, so `valkeyUrl` below would fall back to the default, while systemd hands the worker the
	// line as written. Doctor then pinged 127.0.0.1:6379, which on a shared host is another account's Valkey (measured on
	// pd-ubuntu: gx469's), and read that Valkey's fleet. Nothing below contacts a Valkey in that case; the line is named
	// instead, by its own reader's words. Only when this shell sets no VALKEY_URL of its own, as for every other key.
	const valkeyUnread = service.unread.find((u) => u.key === "VALKEY_URL" && !u.shellSet);
	const unreadValkey = valkeyUnread ? readValkeyKeys(serviceEnvFile.text, { loader: serviceEnvFile.loader, path: serviceEnvFile.path }).error : null;
	if (unreadValkey) valkeyUnread.skip = true;
	const valkeyUrl = env.VALKEY_URL ?? DEFAULT_VALKEY_URL;
	// PR #478's gate: a VALKEY_URL path that names no database (`/abc`) crashed doctor with an unhandled rejection from
	// ioredis's SELECT. It is a ✗ of its own, the worker's refusal (exit 2), and nothing below contacts a Valkey.
	const valkeyDbProblem = unreadValkey ? null : valkeyUrlProblem(valkeyUrl);
	const provider = env.PI_PROVIDER ?? "anthropic";
	// Issue #464 (gate round 1): this host's declared worker name, resolved with every other service key. Every reader
	// below (the fleet line and its routing warning, the per-host backend wording, which cron triggers are scheduled
	// here) uses this value: read from the shell alone, a deployment whose `.env` names its worker was told host routing
	// is off, and judged as a single host (measured on both lab VMs).
	const declaredWorkerName = env.PI_WORKER_NAME;
	const fromFileNote = (keys) => (keys.length > 0 ? ` -- ${keys.join(" and ")} read from ${serviceEnvFile.path}, as the service reads it; this shell does not set ${keys.length === 1 ? "it" : "them"}` : "");
	const fileSays = (...keys) => keys.filter((k) => Object.hasOwn(service.fromFile, k));
	// Where the image came from, for the lines that judge it, and only when it is the file's (gate round 1): after a
	// refusal the image judged is the default, which no file named.
	const jobImageNote = jobImageRefused ? "" : fromFileNote(fileSays("PI_JOB_IMAGE"));
	// The PAT variable the in-image probe took from the file, if it did (issue #471), for that line's note.
	let patFromFile = null;

	const checks = [];
	checks.push(nodeCheck(nodeVersion));

	checks.push({
		ok: fileExists(join(cwd, ".env")),
		warn: true, // advisory: env may be supplied by a service manager instead of a file
		label: ".env present",
		fix: "run `pi-dispatch init` to scaffold one (or supply env via your service manager)",
		// `fixAction` -- what `doctor --fix` may offer for a failing check (REQ-DEPLOYMENT-BOOTSTRAP):
		// { tier: "silent"|"prompt", describe: <the exact command>, run(seams) }. Silent runs unprompted
		// and is reported after; ONLY two fixes qualify, because in both the operator already made the
		// decision and only the mechanical remainder is left: (1) THIS one, delegating absent config files
		// to init, which is create-only by contract (init.mjs header) and so can overwrite nothing; and
		// (2) mkdir -p + chmod 700 of a directory an env var already names (the session store, below).
		// Prompt shows the exact command and defaults to No. EVERY other check deliberately carries no
		// fixAction -- the never tier: doctor never rewrites malformed JSON, never touches triggers or
		// pause-windows CONTENT, never guesses a semantic env value (PI_GLOBAL_ALLOW_EXTENSIONS and kin),
		// never touches branch protection, and never pulls a trigger-named run.image -- each custom image
		// is a per-flow trust posture the operator chose, so only the deployment's OWN default image ever
		// gains an offer. Fail loud and let the operator decide; the plain fix line still prints as before.
		fixAction: {
			tier: "silent",
			describe: "pi-dispatch init",
			run: async ({ out, platform }) => {
				// Lazy import: a doctor run without --fix (or without this failure) never loads init.
				const { runInit } = await import("./init.mjs");
				// With doctor's environment and platform, so the next steps match the venue (issue #453).
				const code = runInit(cwd, { out, env, platform });
				return { ok: code === 0, note: "scaffolded by `pi-dispatch init` (create-only: existing files were kept)" };
			},
		},
	});

	// Right after `.env present`, because it answers the same question that check raises: where DOES this
	// deployment's environment come from. [] unless a seam is configured (issue #216).
	const services = await installedServices(seams);
	checks.push(...(await envSetupChecks(env, seams, envSetupSources(env, services))));
	// Issue #481 (PR #485's final review): WHICH script may supply a value, by one strict rule. A value missing from this
	// shell and the `.env` is one an --env-setup script may export, invisible to doctor by design (docs/secrets.md), so
	// its refusal is softened to a ⚠ naming the script, but ONLY where every installed service of this folder that READS
	// the value names a USABLE script, and the worker's service is installed wherever the worker reads it (every such
	// value here does). Usable is a regular file, after symlinks, that this account can read: a script the service
	// manager cannot source supplies nothing, and its own ⚠ above says so. This shell's PI_ENV_SETUP never softens
	// anything: the service does not run what this shell names, so the round-2 rule, which fell back to it, turned a boot
	// refusal into a ⚠ and exit 0 on a deployment whose unit names no script. A receiver's script is not the worker's.
	const usableScript = (path) => {
		try {
			if (!statSync(path).isFile()) return false;
			accessSync(path, fsConstants.R_OK);
			return true;
		} catch {
			return false;
		}
	};
	/** `readers` (the services that read the value) -> `[{ script, source }]` supplying it, or null where none may. */
	const setupSupplies = (readers) => {
		if (readers.includes("worker") && !services.some((s) => s.which === "worker")) return null;
		const reading = services.filter((s) => readers.includes(s.which));
		if (reading.length === 0 || !reading.every((s) => s.setup && usableScript(s.setup))) return null;
		return [...new Map(reading.map((s) => [s.setup, { script: s.setup, source: s.source }])).values()];
	};
	// What doctor ACCEPTED only because a worker service's script may supply it, for the closing ready line (review
	// round 3): a worker started by hand runs no env-setup script. Reset per collection (`--fix` re-collects).
	seams.expectedFromSetup = [];
	const workerScript = setupSupplies(["worker"])?.find((s) => services.some((u) => u.which === "worker" && u.setup === s.script)) ?? null;
	seams.envSetupSeen = workerScript;
	// Where no downgrade applies, what the fix line owes the operator: that this shell's PI_ENV_SETUP is not what the
	// service runs, or, where doctor found no service of this folder at all, that it cannot tell.
	const shellSetup = typeof env.PI_ENV_SETUP === "string" && env.PI_ENV_SETUP !== "" ? env.PI_ENV_SETUP : null;
	const notSupplied = (names, readers) => {
		const reading = services.filter((s) => readers.includes(s.which));
		if (shellSetup !== null && !reading.some((s) => s.setup)) return `. PI_ENV_SETUP in this shell is not what the service runs: install with \`pi-dispatch service install --env-setup ${shellSetup}\``;
		if (!services.some((s) => s.which === "worker")) return `. A deployment whose service gets ${names} from an --env-setup script (docs/secrets.md) can ignore this line; doctor found no service installed for this folder to read`;
		return "";
	};
	/**
	 * A credential presence refusal, by whether an env-setup script can supply it: `subject` is what is missing
	 * ("GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset"), `names` the variables the script would export, `readers` the
	 * services that read them, `refusal` what happens without them, `sep` how the refusal's label joins the two (each
	 * check keeps its own), `fix` the usual fix.
	 */
	const credentialAbsent = ({ subject, names, readers = ["worker", "receiver"], refusal, sep = " -- ", fix }) => {
		const supply = setupSupplies(readers);
		if (supply === null) return { ok: false, label: `${subject}${sep}${refusal}`, fix: `${fix}${notSupplied(names, readers)}` };
		seams.expectedFromSetup.push(names);
		const from = supply.map((s) => `${envValueShown(s.script)} (named by ${s.source})`).join(" and ");
		return {
			ok: false,
			warn: true,
			label: `${subject}: not visible to doctor in this shell or .env, and expected from the env-setup script ${from}, which the service runs after .env`,
			fix: `if that script does not export ${names}, ${refusal}: ${fix}`,
		};
	};
	// Where the venue keys came from (issue #453), beside the other answers to "where does this deployment's environment
	// come from". Empty unless the file supplied a key, or the two disagree.
	checks.push(...(seams.venueChecks ?? []));
	// Issue #471: and where every other service key came from, beside them. The keys a line of their own already says the
	// source of are left to that line. Counted, so a key resolved further down (the provider's key, the PAT) that adds a
	// disagreement is said once at the end rather than lost.
	const envPathShown = serviceEnvFile?.path ?? join(cwd, ".env");
	// PR #474's round cap: each CLI variable the file sets, which no program doctor starts is handed.
	checks.push(...cliNotHandedLines(service, envPathShown));
	const saidAtTop = { disagreements: service.disagreements.length, unread: service.unread.length };
	// A CLI variable is not listed as read: no program doctor starts used it, and its own ⚠ says so.
	checks.push(...serviceEnvLines(service, envPathShown, { said: ["VALKEY_URL", "PI_PROVIDER", ...GITHUB_SERVICE_KEYS, "PI_JOBS_DIR", "PI_SANDBOX_DIR", "TMPDIR", ...CLI_KEY_NAMES] }));
	if (jobImageRefused) {
		checks.push({
			ok: false,
			label: `PI_JOB_IMAGE is ${quotedShown(env.PI_JOB_IMAGE)}${fromFileNote(fileSays("PI_JOB_IMAGE"))}, and it ${jobImageRefused}: the worker refuses to boot on it (exit 2), so doctor ran and inspected nothing with it and judged the default ${jobImage} in its place`,
			fix: "set PI_JOB_IMAGE to the image reference itself (no surrounding spaces or control characters, not starting with -), or unset it for pi-job:latest",
		});
	}

	// Issue #354: which venues run jobs here. An unparseable PI_BACKENDS reads as the unset default, so every docker line
	// below is exactly what it always was, and the backend section is what fails on it (the worker refuses to boot).
	const { localUsed, podmanUsed, podmanDefault } = venuesOf(env);
	// THE FIRST DOCKER CALL OF THE RUN, which is why it was the one that hung (issue #397): a daemon that
	// accepts the connection and never answers held doctor here, before it had printed anything. Bounded
	// now, and the three outcomes are three different sentences, because telling someone whose daemon is
	// WEDGED to install Docker is worse than saying nothing.
	//
	// Issue #433: and ASKED ONLY where a job runs on docker. Without `local` in PI_BACKENDS, docker is not spawned at all
	// (no `info`, no endpoint read, no image inspect of any kind), and `dockerRun` is `null`, which means NOT ASKED. It is
	// kept apart from `code: null`, which means ASKED AND NOT FOUND, because the two are opposite facts: every consumer
	// below branches on `null` (or on `localUsed`) rather than deriving a docker verdict from a command that never ran.
	// Rejected: running `docker info` anyway and softening what it said, which is what #354 shipped (each docker line
	// relabelled "not used by any job"). An operator who never installed Docker read a warning about it on every run, and
	// a host that did have it was asked about a store no job of the deployment looks in.
	const dockerRun = localUsed ? await runCmd(spawn, "docker", ["info"], runTimeouts.cmd) : null;
	const dockerCode = dockerRun === null ? null : dockerRun.code;
	if (dockerRun === null) {
		// ✓, because nothing is wrong: the one line that says docker was deliberately left alone, and why. The podman
		// section's own lines (its `podman info`, the image in this account's store) are this deployment's runtime checks.
		checks.push({ ok: true, label: "Docker: not checked -- PI_BACKENDS lists no docker venue (local), so no job here runs on Docker" });
	} else checks.push({
		ok: dockerCode === 0,
		label: dockerRun.ended === "timeout" ? `Docker daemon reachable (no answer in ${Math.round(runTimeouts.cmd / 1000)}s)` : "Docker daemon reachable",
		fix:
			dockerRun.ended === "timeout"
				? "the daemon accepted the connection and did not answer -- `docker info` hangs too; restart Docker. Every docker check below asked the same daemon, so read them as unanswered rather than as findings"
				: dockerRun.ended === "error"
					? "install Docker — `docker` was not found on PATH"
					: "start Docker (the daemon is not responding)",
	});
	// Issue #278: which daemon THIS SHELL's docker CLI resolves, read once and used twice -- by the in-image gh
	// probe below, which would otherwise send the operator's gh token to it, and by the backend section's
	// credentialTransit line. Through the worker's own resolver, so doctor and the worker cannot disagree about
	// what an answer means; only the runner differs, because doctor's spawn is a seam.
	// Issue #433: not read without `local`. `null` is the backend section's own "not given" (nothing observed, nothing
	// credited), and every other reader of it (the gh probe, the egress canary, the job user, `--live` on local) is itself
	// gated on `localUsed`.
	const endpoint = localUsed ? await makeDockerEndpointResolver({ run: dockerRunVia(spawn) })() : null;

	// Read once, used twice, so the triggers file is parsed a single time: `images` drives the per-trigger
	// image checks just below, and `optingOut`/`requiring` colour the staged-packages lines further down.
	// `optingOut` counts the only value that withholds the staged set; `requiring` counts an explicit
	// run.packages: true, which arms nothing any more but is still an operator statement of intent.
	const { requiring, waiting, listing, waitProfiles, waitAfters, optingOut, resuming, replicating, instructing, commands, secreting, onceArmed, onceSpent, secretProfiles, localSecretFolders, secretNames, folders, images, imageRoutes, namedBackends, skillsDirs, forges, repositories, flows, costCaps, modelRuns, parseError, path: triggersFilePath } = readTriggerFacts(env, fileExists, cwd, declaredWorkerName);
	const scopedLimitFacts = readScopedLimitFacts(env, fileExists);
	const pauseWindowFacts = readPauseWindowFacts(env, fileExists);
	// FIRST, and fail rather than warn: every check below this line reads counts that a parse failure
	// zeroed, so a green run here would be reporting on a file nobody could read. The receiver loads this
	// file unconditionally and refuses to start without it, which is the consequence worth naming.
	// Issue #481 (PR #485 review round 1): a PI_TRIGGERS_FILE that is SET and names no file, the empty value included.
	// Both processes refuse to start on it (exit 2): the worker's `loadSchedules` takes any set value as the file to load
	// (only an unset one turns cron off), and the receiver's `loadTriggers` as the file it serves from. Doctor's own read
	// takes a missing file as "no triggers", which is right only for the UNSET default, whose missing ./triggers.json the
	// worker never reads; so a set one is judged here, before that read's silence can pass it.
	const triggersSet = env.PI_TRIGGERS_FILE;
	if (triggersSet !== undefined && !fileExists(triggersPath(env, cwd))) {
		const note = fromFileNote(fileSays("PI_TRIGGERS_FILE"));
		checks.push({
			ok: false,
			label: triggersSet === ""
				? `PI_TRIGGERS_FILE is set to an empty value, which neither process reads as unset: the worker and the receiver refuse to start on it (exit 2)${note}`
				: `PI_TRIGGERS_FILE names ${quotedShown(triggersPath(env, cwd))}, which does not exist: the worker and the receiver refuse to start on it (exit 2)${note}`,
			fix: "run `pi-dispatch init` in this folder to scaffold triggers.json, point PI_TRIGGERS_FILE at yours, or delete the line (the worker then schedules no cron, and the receiver reads ./triggers.json)",
		});
	}
	if (parseError) {
		checks.push({
			ok: false,
			// "is refused at load" rather than "does not parse", because since issue #313 it is no longer
			// only a syntax error: a duplicate key parses perfectly and is refused anyway. The loader's own
			// message says which, and the old wording sent an operator hunting for a syntax error that was
			// not there. It still covers the JSON case, whose message begins "is not valid JSON".
			label: `triggers file is refused at load -- the receiver will refuse to start: ${parseError}`,
			fix: `fix ${triggersFilePath} so it loads (the message above names the entry and the reason), then re-run doctor -- every trigger-derived check below is skipped until it loads`,
		});
	}
	checks.push(...dollarChecks(env, costCaps, triggersSet !== undefined));

	// Only meaningful if docker itself responds; otherwise the image check is noise on top of a down daemon. Issue #433:
	// and never without `local`, where the podman section's line (the image in THIS ACCOUNT'S store) is the image check.
	const imageRun = dockerRun === null ? null : dockerCode === 0 ? await runCmd(spawn, "docker", ["image", "inspect", jobImage], runTimeouts.cmd) : { code: null, ended: "error" };
	const imageCode = imageRun === null ? null : imageRun.code;
	if (imageRun !== null) checks.push({
		ok: imageCode === 0,
		// A timeout says the DAEMON did not answer, not that the image is absent: the fix for the second is
		// a pull, and for the first a pull would hang exactly as this did.
		label: imageRun.ended === "timeout" ? `Job image present (${jobImage})${jobImageNote} -- the daemon did not answer` : `Job image present (${jobImage})${jobImageNote}`,
		fix:
			imageRun.ended === "timeout"
				? "restart Docker first: this asked the same daemon that did not answer above, so whether the image is present is unknown rather than false"
				: jobImage === "pi-job:latest"
					? `${jobImageFix("docker", jobImage)}  (or build image/Dockerfile)`
					: // Issue #523 (review): the image the worker runs, by the rule `up` follows, never ghcr's latest for an
						// overriding name (which would not make THEIR image exist) and never a pull of a short name.
						jobImageFix("docker", jobImage),
		// Prompt tier, and ONLY for the deployment default: a PI_JOB_IMAGE the operator overrode is a trust
		// choice this command cannot honestly satisfy (pulling ghcr's pi-job would not make THEIR image
		// exist), so an overridden name keeps the plain fix line -- the same never-tier reasoning as the
		// trigger-named run.image checks below. Jobs run with --pull=never and that stays true: the y
		// keypress IS the operator pulling the repo's own image themselves.
		//
		// AND NOT WHEN THE DAEMON DID NOT ANSWER (issue #397). Changing only the label left `--fix` offering
		// an operator a `docker pull` against the daemon it had just reported as unresponsive, which would
		// hang for the pull bound -- ten minutes -- and then report a failed fix. A verdict that says "I
		// could not tell" must not carry an action that assumes the answer.
		...(jobImage === "pi-job:latest" && imageRun.ended !== "timeout"
			? {
					fixAction: {
						tier: "prompt",
						describe: "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest",
						run: async ({ spawn }) => {
							// The PULL bound, not the default one: a cold pull of the job image is minutes of real work,
							// and bounding it at the default would turn a working fix into a reported failure.
							const pulled = await runCmd(spawn, "docker", ["pull", "ghcr.io/edgehero/pi-job:latest"], runTimeouts.pull);
							if (pulled.code !== 0) return { ok: false, note: pulled.ended === "timeout" ? `docker pull did not finish within ${Math.round(runTimeouts.pull / 60000)} minutes` : "docker pull failed" };
							if ((await runCmd(spawn, "docker", ["tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"], runTimeouts.cmd)).code !== 0) return { ok: false, note: "docker tag failed" };
							return { ok: true };
						},
					},
				}
			: {}),
	});

	// REQ-PER-TRIGGER-SKILLS (issue #60). Every distinct `run.skillsDir`, checked BEFORE anything fires,
	// because the worker's own gate for these refuses at job time -- correct, but at 03:00 in a log nobody
	// is reading. A deployment naming none adds no lines at all, so its output is byte-identical.
	for (const dir of skillsDirs) {
		const present = dirExists(dir);
		checks.push({
			ok: present,
			label: `Trigger skills dir present (${dir})`,
			fix: `create ${dir} with one <name>/SKILL.md per skill, or drop run.skillsDir from that trigger -- every job of it refuses pre-spend while the path is absent`,
		});
		if (!present) continue;
		// A dry run of the real copier: same walker, same caps, same lstat symlink rule, into a throwaway
		// destination. Anything it would refuse at job time is reported here instead, in the operator's own
		// terminal, with the reason the job would have carried.
		const probe = probeSkillsDir(dir);
		if (probe.refused) {
			checks.push({
				ok: false,
				label: `Trigger skills dir is usable (${dir})`,
				fix: probeFix(probe.refused, dir),
			});
			continue;
		}
		checks.push({ ok: true, label: `Trigger skills dir holds ${probe.dirs} skill(s), ${probe.files} file(s)` });
		// Issue #462: a WARNING (`ok: false, warn: true`, the shape `render` prints as ⚠ with its fix): files the operator
		// put in the skills dir do not reach a job, and replacing the links clears it.
		if (probe.skipped.symlinks > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `${probe.skipped.symlinks} entry(ies) under ${dir} are symlinks and are SKIPPED`,
				fix: "the copier never follows a link (a link out of the tree would put a host file in a job container); replace them with real files if the jobs need them",
			});
		}
		// Gap 5 of issue #60, and the one an operator cannot discover any other way: the ai-trigger gate
		// reads the repo's committed .pi/skills at the pinned sha, so an injected SKILL.md carrying the
		// opt-in is never consulted. Without this line the operator writes it and nothing honours it.
		const chainable = aiTriggerNames(dir);
		// Issue #462: a WARNING, since a setting the operator wrote is never honoured, and committing the flow clears it.
		if (chainable.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `${chainable.length} injected skill(s) under ${dir} set ai-trigger: allow, which is NEVER read`,
				fix: "injected skills are trigger-reachable but not AI-reachable: the gate reads the target repo's committed .pi/skills at the pinned sha, so chain and dispatch_run requests for these flows are refused. Commit the flow to the repo if a model must be able to start it",
			});
		}
	}

	// REQ-PER-TRIGGER-SKILLS (issue #189). One line per distinct (flow, folder, skillsDir, packages)
	// question: does the flow this trigger names resolve in ANY tier this host can see? Probed in the
	// loader's own precedence order (repo > injected > overlay > staged packages), first hit wins the
	// line. ⚠ and NEVER ✗ when nothing resolves -- a forge trigger's repo is not on this host and
	// mid-setup is legal -- and no fixAction (triggers content is the never tier). The runner's
	// flow_not_loaded line is the exact, in-container half of the same answer
	// (DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS): these probes read dir names, and a frontmatter
	// `name:` rename is invisible to them, so a ⚠ here can be wrong in only the loud direction.
	// A deployment with no triggers adds no lines at all, so its output is byte-identical.
	if (flows.length > 0) {
		// One stage read for the whole run; each tuple's staged probe is a lookup on its result.
		const staged = readStagedSkills({ globalPiDir: env.PI_GLOBAL_PI_DIR, readFile: (p) => readFileSync(p, "utf8"), fileExists });
		const groups = new Map();
		for (const f of flows) {
			const key = JSON.stringify([f.flow, f.folder, f.skillsDir, f.packages]);
			if (!groups.has(key)) groups.set(key, { ...f, labels: [] });
			groups.get(key).labels.push(f.label);
		}
		for (const g of groups.values()) {
			const at = g.labels.join(", ");
			// The charset pre-check doubles as the interpolation guard for the git probe below, and it is
			// a finding of its own: a name the skill charset refuses can never materialise in ANY tier
			// (materialize and copy-tree enforce the same RE on the way in).
			if (!SKILL_NAME_RE.test(g.flow)) {
				checks.push({
					ok: false,
					warn: true,
					label: `Trigger flow ${JSON.stringify(g.flow)} fails the skill name charset (${at})`,
					fix: "a flow name must match the skill charset (lowercase alphanumerics, - and _, 64 max), or no tier can ever hold it -- fix run.flow",
				});
				continue;
			}
			let resolved = null;
			const checked = [];
			const unknown = [];
			if (g.folder) {
				const state = await repoFlowAtHead(spawn, g.folder, g.flow);
				if (state === "present") resolved = `repo .pi/skills at HEAD of ${g.folder}`;
				else if (state === "absent") checked.push("repo .pi/skills at HEAD");
				else unknown.push(`repo (${g.folder} is not readable as a git repo here)`);
			} else {
				unknown.push("repo (a forge clone, not on this host)");
			}
			if (!resolved && g.skillsDir) {
				if (fileExists(join(g.skillsDir, g.flow, "SKILL.md"))) resolved = `injected run.skillsDir ${g.skillsDir}`;
				else checked.push("injected run.skillsDir");
			}
			if (!resolved && env.PI_GLOBAL_PI_DIR) {
				if (fileExists(join(env.PI_GLOBAL_PI_DIR, "skills", g.flow, "SKILL.md"))) resolved = "the overlay skills/";
				else checked.push("overlay skills/");
			}
			if (!resolved) {
				if (!g.packages) {
					checked.push("staged packages (withheld: run.packages false)");
				} else {
					const hit = staged.skills.find((s) => s.name === g.flow);
					if (hit) resolved = `staged package ${hit.package}`;
					else if (staged.unenumerable.length > 0) unknown.push(`staged package(s) ${staged.unenumerable.join(", ")} (manifest patterns, not enumerable here)`);
					else checked.push("staged packages");
				}
			}
			if (resolved) {
				checks.push({ ok: true, label: `Trigger flow "${g.flow}" resolves (${at}: ${resolved})` });
			} else {
				checks.push({
					ok: false,
					warn: true,
					label: `Trigger flow "${g.flow}" resolves in NO tier visible here (${at})`,
					fix: `checked: ${checked.join(", ") || "nothing checkable"}${unknown.length > 0 ? `; not checkable here: ${unknown.join(", ")}` : ""} -- commit .pi/skills/${g.flow}/SKILL.md, add the skill to run.skillsDir or the overlay skills/, or stage a package shipping it; a job of this trigger runs without the flow it names (the runner logs flow_not_loaded) and still exits 0`,
				});
			}
		}
	}

	// run.command triggers (issue #189): ONE advisory line, deliberately WITHOUT the per-tier probes the
	// flow block above runs. A command is registered by extension CODE at pi startup -- repo .pi/, the
	// overlay and staged packages all contribute, and none is enumerable host-side without executing the
	// extension, which doctor must never do. The honest line names where the real check lives instead;
	// unlike a missing flow, the failure there is LOUD (a refusal, not a clean exit 0), which is why this
	// is advisory and carries no fixAction (triggers content is the never tier). A deployment with no
	// command triggers adds no line at all, so its output is byte-identical.
	if (commands > 0) {
		checks.push({ ok: true, label: `${commands} command trigger(s): a command is only verifiable in-container -- the runner refuses an unregistered one before the prompt is sent (command-unregistered)` });
	}

	// Issue #41: every DISTINCT image a trigger names in run.image, minus the deployment default already
	// checked above. Two silent-failure modes, and both used to be impossible because there was one image.
	//   1. the image was never built -- a job that refuses pre-spend at 03:00 in a log nobody is reading, and
	//      with --pull=never nothing will fetch it either, so this line is the only warning that arrives first.
	//   2. the image is present but is not a pi-job image. An entrypoint that is not the runner either exits
	//      126/127 or, worse, runs whatever it does have and exits 0 -- a job the queue records as COMPLETED
	//      that never started the agent. Warn, never fail: an operator MAY legitimately ship a wrapper
	//      entrypoint that execs the runner, and a ✗ here is reserved for certainties.
	// A deployment with no run.image anywhere adds no lines at all, so its output is byte-identical.
	//
	// Issue #433: each image is asked of the runtime its triggers' jobs START on, which is knowable here: a job runs on its
	// trigger's run.backend, or on the deployment default (PI_BACKENDS' first entry), by the worker's own rule
	// (`resolveBackendName`). A podman job starts from THIS ACCOUNT'S Podman store, so that is where its image is looked
	// for; asking docker would answer about a store no such job reads, and on a podman-only host would spawn a runtime the
	// deployment never asked for. Every route that is not podman stays docker's, exactly as before (a third venue's own
	// image check is that venue's change), so a deployment whose triggers all run on local prints what it always did.
	// The podman venue's own image read gates its half as `docker info` gates docker's: not asked on top of a runtime that
	// did not answer, off Linux, or past a refusal of every podman job, all of which end the podman section before it.
	const defaultVenue = podmanDefault ? PODMAN_BACKEND : DEFAULT_BACKEND;
	// Issue #433 review round 1: a trigger whose run.backend names a venue PI_BACKENDS does not list. The loader accepts
	// it (PI_BACKENDS is a per-host setting a reviewed file must not be refused over), and the worker refuses every one of
	// its jobs pre-spend as `backend-unblessed`, so without this line such a trigger was silent here: routed nowhere this
	// run looks, its image asked of no runtime. ✗, as for a trigger-named image that is absent: a trigger that can never
	// run is a certainty, not a caution. One line per venue, naming every trigger that asks for it. Said only when the list
	// parses; an unparseable one is the backend section's ✗, and judging triggers against a guessed list would invent one.
	//
	// Review rounds 2 and 3: only a cron trigger this host's worker schedules, and every forge trigger (`served`, from
	// `readTriggerFacts`). A cron trigger the worker never schedules here (no PI_TRIGGERS_FILE, or another machine's
	// folder on a fleet) says nothing about this host's PI_BACKENDS; judging it failed doctor on a host that will never
	// run it. And on a fleet
	// a forge trigger's jobs go to the shared queue, so what this host can promise is only what it does with a job it
	// picks up: the wording says that, while a single host keeps "every job", which is true there.
	const nameDeclared = Boolean(declaredWorkerName);
	let blessedList = null;
	try {
		blessedList = parseBackendList(env.PI_BACKENDS);
	} catch {
		blessedList = null;
	}
	if (blessedList !== null) {
		const unblessed = new Map();
		for (const { label, backend, served } of namedBackends) {
			if (!served || blessedList.includes(backend)) continue;
			if (!unblessed.has(backend)) unblessed.set(backend, []);
			unblessed.get(backend).push(label);
		}
		for (const [backend, labels] of unblessed) {
			checks.push({
				ok: false,
				label: nameDeclared
					? `run.backend "${backend}" is not in this host's PI_BACKENDS (${blessedList.join(",")}), so a job of ${labels.join(", ")} that this host picks up is refused (backend-unblessed)`
					: `run.backend "${backend}" is not in PI_BACKENDS (${blessedList.join(",")}), so every job of ${labels.join(", ")} is refused (backend-unblessed)`,
				fix: `add ${backend} to ${nameDeclared ? "this host's " : ""}PI_BACKENDS, or change run.backend on ${labels.length === 1 ? "that trigger" : "those triggers"} to a venue PI_BACKENDS lists -- ${nameDeclared ? "this host's worker refuses each such job it picks up" : "the worker refuses each such job"} before it spends`,
			});
		}
	}
	const podmanRouted = new Set(imageRoutes.filter((r) => resolveBackendName(r, defaultVenue) === PODMAN_BACKEND).map((r) => r.image));
	const dockerRouted = new Set(imageRoutes.filter((r) => resolveBackendName(r, defaultVenue) !== PODMAN_BACKEND).map((r) => r.image));
	// Issue #354: the podman venue's own reads. Taken HERE, ahead of the per-trigger images (issue #433), because its read
	// of the default image is what gates their podman half; its lines are still printed after the backend section, where
	// they always were, so moving the read changed the order of spawns and not a byte of output.
	const podman = podmanUsed ? await podmanChecks(env, seams, { jobImage, jobImageNote }) : null;
	for (const img of images.filter((i) => i !== jobImage)) {
		if (dockerRun !== null && dockerCode === 0 && dockerRouted.has(img)) {
			const run = await runCmd(spawn, "docker", ["image", "inspect", img], runTimeouts.cmd);
			const code = run.code;
			checks.push({
				ok: code === 0,
				label: run.ended === "timeout" ? `Trigger job image present (${img}) -- the daemon did not answer` : `Trigger job image present (${img})`,
				fix: `docker pull ${img} (or build it) -- a trigger names it in run.image, and jobs run with --pull=never, so the worker never fetches it at job time`,
			});
			if (code === 0) {
				const entry = await runCmdCapture(spawn, "docker", ["image", "inspect", "--format={{json .Config.Entrypoint}}", img]);
				if (entry.code === 0 && !entry.output.includes("entrypoint.sh")) {
					checks.push({
						ok: false,
						warn: true,
						label: `${img} does not appear to carry the pi-dispatch runner entrypoint`,
						fix: TRIGGER_IMAGE_ENTRYPOINT_FIX,
					});
				}
			}
		}
		if (podman?.imagesReadable === true && podmanRouted.has(img)) {
			const run = await runCmd(spawn, "podman", ["image", "inspect", img], runTimeouts.cmd);
			// No fixAction on either runtime: a trigger-named image is a per-flow trust posture (the never tier above).
			checks.push({
				ok: run.code === 0,
				label: run.ended === "timeout" ? `podman: trigger job image present in this account's Podman store (${img}) -- podman did not answer` : `podman: trigger job image present in this account's Podman store (${img})`,
				fix: `pull, load or build it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: podman pull ${img} -- a trigger names it in run.image, and jobs run with --pull=never, so the worker never fetches it at job time`,
			});
			if (run.code !== 0) continue;
			const entry = await runCmdCapture(spawn, "podman", ["image", "inspect", "--format={{json .Config.Entrypoint}}", img]);
			if (entry.code === 0 && !entry.output.includes("entrypoint.sh")) {
				checks.push({ ok: false, warn: true, label: `podman: ${img} does not appear to carry the pi-dispatch runner entrypoint`, fix: TRIGGER_IMAGE_ENTRYPOINT_FIX });
			}
		}
	}

	// REQ-EGRESS-ALLOWLIST (issue #202). [] when PI_EGRESS=0, so a deployment that declined it gets
	// byte-identical output. Gated on docker and the image, because two of these checks run a container and
	// the rest are noise on top of a down daemon.
	// Issue #354: NOT RUN when no job runs on docker. The proxy it reads is docker's, which no job of this deployment is
	// wired to (a podman job's network is joined to a proxy under the same rootless Podman, read in the podman section
	// below), and its canary starts containers on a daemon nothing else here uses. Said there, not silently dropped.
	// Issue #431: that venue's own canary is `runEgressCanary` under podman, run by its `--live` (`podmanLiveChecks`).
	// ONE `docker info` for this doctor run (issue #452, gate round 3), memoised: the job-user section reads it, and the
	// egress canary's detach gate reads which runtime answered from the same answer, rather than asking twice.
	let factsRead = null;
	const readFactsOnce = () => (factsRead ??= makeDaemonFactsReader({ run: dockerRunVia(spawn, DAEMON_FACTS_TIMEOUT_MS) })());
	const egress = localUsed ? await egressChecks(env, { ...seams, readFactsOnce }, { dockerCode, imageCode, jobImage, endpoint }) : [];
	checks.push(...egress);
	// Issue #503: an allowlist naming a host alias, once for every venue (both mount this folder's allowlist). Read only with
	// the policy armed, which is when the file is a policy at all; a file that is not there or cannot be read says nothing.
	let allowlistArmed = false;
	try {
		allowlistArmed = egressArmed(env) === true;
	} catch {
		// A malformed PI_EGRESS: the .env check reports it.
	}
	if (allowlistArmed) {
		let aliases = [];
		try {
			aliases = allowlistHostAliases(readFileSync(join(seams.cwd, "egress-allowlist.conf"), "utf8"));
		} catch {
			// No allowlist in this folder.
		}
		for (const { alias, entry } of aliases) {
			// The entry as written, when it is not the alias itself, is quoted: it is the operator's own file, but still text.
			const named = entry.toLowerCase().replace(/^\./, "") === alias ? alias : `${quotedShown(entry)}, which admits ${alias}`;
			checks.push({
				ok: false,
				warn: true,
				label: `egress-allowlist.conf lists ${named}, which lets a job open a CONNECT to that host's port 443 and send plain HTTP to its port 80, and reaches no model server's port`,
				fix: `remove it, and declare the model server in model-endpoints.json instead, which opens a tunnel to exactly its host and port: docs/egress.md, "Local model servers"`,
			});
		}
	}
	if (facts) {
		let armed;
		try {
			armed = egressArmed(env);
		} catch {
			armed = null; // malformed: the .env check reports it, and the read-back says it was not read
		}
		const proxyState = egress.find((c) => c.proxyState)?.proxyState;
		Object.assign(facts, {
			endpoint,
			dockerCode,
			imageCode,
			jobImage,
			triggerImages: images.filter((i) => i !== jobImage),
			// `proxyRunning` null means not read (the policy off, docker down): only a proxy SEEN down skips the peer probe.
			egress: { armed, results: egress.filter((c) => c.readBack?.property === "egress").map((c) => c.readBack), proxy: proxyState?.proxy ?? egressProxyName(env), proxyRunning: proxyState ? proxyState.running : null },
		});
	}
	// Issue #341: who a local job would run as here, from the facts the worker reads, and what --live runs its probe as.
	// Read BEFORE the backend lines are built (issue #345): the same `docker info` answer is where `isolation` and
	// `mountSet` are observed, so the backend section and the job-user section speak from one read. Printed after them.
	// Issue #354: every line it prints is `local: ...`, about a venue this deployment may not run; without local, none.
	const jobUser = localUsed ? await jobUserChecks(env, { ...seams, readFactsOnce }, { endpoint, dockerCode, imageCode, jobImage }) : { checks: [], forLive: { run: true, user: null }, daemon: null };
	// Issue #354: the podman venue's own reads (taken above, with the per-trigger images) are BEFORE the backend lines for
	// the same reason as the job user's: its observations are what the podman rows of the backend section and the floor judge.
	// No docker binary at all is an ANSWER for the observations, as it is for the worker (exit 2 under a floor, not a retry).
	// A daemon that did not ANSWER is the opposite class, and telling them apart is the whole point of `ended`
	// (issue #397): `docker-not-found` is DETERMINATE in `runtime-observations` -- it resolves to `value: false`,
	// which makes a floor REFUSE and hands the operator "no docker CLI was found on PATH" for a host whose CLI
	// is fine. A timeout resolves to `value: null` instead, which is the transient class `backendChecks` already
	// has the right sentence for ("fix what stops the daemon answering"; the worker exits 1 so the supervisor
	// retries). Before this arm existed both landed on the determinate one, byte-identically.
	// Issue #433: `null` where docker was not asked, which is the backend section's "not given": no local row is printed
	// on such a deployment, and nothing here reads a docker answer out of a command that never ran.
	const daemon =
		jobUser.daemon ??
		(dockerRun === null
			? null
			: dockerRun.ended === "timeout"
				? { answered: false, reason: "docker-no-answer", transient: true }
				: dockerCode === null
					? { answered: false, reason: "docker-not-found", transient: true }
					: null);
	checks.push(...backendChecks(env, { endpoint, daemon, fs: seams.observationFs, unit: jobUser.unit, ...(podman ? { podman: podman.observed } : {}) }));
	// Issue #596: the default job size, and what this host's runtime says about the bounds a size becomes.
	checks.push(...jobSizeChecks(env, { daemon: localUsed ? daemon : null }));
	checks.push(...jobUser.checks);
	if (podman) checks.push(...podman.checks);
	if (facts) facts.jobUser = jobUser.forLive;
	// Issue #355: the same answer, kept for `--live`, which decides from it whether its probes' own mounts carry `:Z`.
	if (facts) facts.daemon = jobUser.daemon;
	// Issue #354: which read-backs `--live` runs, and the podman venue's facts for its own.
	if (facts) Object.assign(facts, { localUsed, podman: podman?.forLive ?? null });
	// Issue #355: on a Podman host that confines containers with SELinux, the directories a job mounts that the worker
	// did NOT make, which it therefore never relabels. Read from the same facts and endpoint as the line above. Issue #354:
	// the podman venue relabels on the same rule (its own directories only), so the same lines, ONCE when both venues do.
	if (relabelsPrivateMounts(jobUser.daemon?.answered ? jobUser.daemon.facts : null, endpoint, seams.jobUserIdentity?.platform ?? seams.platform) || podman?.relabel === true) {
		checks.push(...(await selinuxLabelChecks({ folders, overlay: env.PI_GLOBAL_PI_DIR || null, spawn: seams.spawn })));
	}

	// The receiver itself, when the triggers file names ANY forge (issue #80). Only forge deliveries need
	// the receiver at all, so a cron/local-only deployment gets no receiver noise here. WARNS rather than
	// fails, same doctrine as the gitlab block below: a deployment can legitimately be mid-setup (or run
	// the receiver on another host with its own env), and doctor's job is to say what will not work, not
	// to refuse.
	if (forges.length > 0) {
		// Presence only, value never read out (secrets-and-pii) -- without it the receiver refuses to boot,
		// because a webhook it cannot verify is a forgeable paid-agent trigger (CONST-HMAC-OVER-RAW-BODY).
		const webhookSecret = env.WEBHOOK_SECRET;
		if (typeof webhookSecret !== "string" || webhookSecret.trim() === "") {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has ${forges.join("/")} triggers but WEBHOOK_SECRET is unset -- the receiver will refuse to start`,
				fix: "generate one (`openssl rand -hex 32`) and set WEBHOOK_SECRET in .env -- `pi-dispatch-receiver` verifies every delivery's signature against it and refuses to boot without it",
			});
		} else {
			checks.push({ ok: true, label: "WEBHOOK_SECRET set -- the receiver (`pi-dispatch-receiver`) can verify deliveries" });
		}
		// Validated only WHEN SET: unset (or empty) means the loader's own default of 3000, which needs no
		// line. The malformed value IS echoed -- a port is not a secret, and naming the shape it actually
		// has is what makes the warn actionable. Mirrors `positiveInt` (worker config.mjs) exactly, because
		// that is the parse the receiver refuses to boot on.
		const port = env.RECEIVER_PORT;
		if (port !== undefined && port !== "") {
			const n = Number.parseInt(port, 10);
			if (!Number.isInteger(n) || n < 1 || String(n) !== String(port).trim()) {
				checks.push({
					ok: false,
					warn: true,
					label: `RECEIVER_PORT is ${JSON.stringify(port)}, which is not a positive integer -- the receiver will refuse to start`,
					fix: "set RECEIVER_PORT to a TCP port number, or drop it for the default (3000)",
				});
			}
		}
	}

	// GitLab, when the triggers file names it. WARNS rather than fails, matching the github auth checks
	// below and for the same reason: a deployment can legitimately be mid-setup, and doctor's job is to say
	// what will not work, not to refuse.
	if (forges.includes("gitlab")) {
		const token = env.GITLAB_TOKEN;
		if (typeof token !== "string" || token.trim() === "") {
			checks.push({
				ok: false,
				warn: true,
				label: "triggers.json has gitlab triggers but GITLAB_TOKEN is unset",
				fix: "set GITLAB_TOKEN to a project or group access token with the `api` scope -- gitlab jobs cannot clone, comment, or resolve the actor's access level without it",
			});
		} else {
			checks.push({ ok: true, label: `gitlab triggers configured (${urlShown(env.GITLAB_URL ?? "https://gitlab.com")})` });
			// The scope an operator cannot narrow. Said out loud because it is the one place GitLab is
			// weaker than the github App path and an operator should know which trade they made
			// (CONST-TOKEN-SCOPED-PER-JOB). Issue #462: a FACT LINE, not a warning, because no change clears it (GitLab offers
			// no narrower scope), so the advice lives in the label: an `ok: true` check never prints a fix line.
			checks.push({
				ok: true,
				label: "a GitLab project access token needs the `api` scope to post notes, which grants full project API read/write: scope it to ONE project and rotate it on a schedule (GitLab has no contents-vs-issues split and no short-expiry token)",
			});
		}
		// The receiver-boot half (issue #80), mirrored from receiver/src/config.mjs loadGitLabConfig: once
		// ANY GITLAB_* variable is set, boot refuses without a chosen mode and a secret -- and with NONE
		// set there is no /gitlab route at all, so these triggers can never fire either way. The mode value
		// is echoed (it is a choice, not a secret); the secret is presence-only.
		const glMode = env.GITLAB_WEBHOOK_MODE;
		if (glMode !== "signature" && glMode !== "token") {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has gitlab triggers but GITLAB_WEBHOOK_MODE is ${glMode === undefined ? "unset" : JSON.stringify(glMode)} -- the receiver will refuse to start`,
				fix: 'set it to "signature" (HMAC, GitLab 19.0+) or "token" (X-Gitlab-Token, any version) -- deliberately undefaulted, which verification a deployment runs must be a thing somebody chose (.env.example, docs/gitlab.md)',
			});
		}
		if (typeof env.GITLAB_WEBHOOK_SECRET !== "string" || env.GITLAB_WEBHOOK_SECRET.trim() === "") {
			checks.push({
				ok: false,
				warn: true,
				label: "triggers.json has gitlab triggers but GITLAB_WEBHOOK_SECRET is unset -- the receiver cannot verify deliveries and will refuse to start",
				fix: "set GITLAB_WEBHOOK_SECRET in .env to the secret configured on the project webhook (.env.example, docs/gitlab.md)",
			});
		}
	}

	// Forgejo, when the triggers file names it (issue #80) -- the gitlab block's twin, and previously the
	// gap: a forgejo misconfiguration hard-failed at receiver boot with no preflight warning. The variable
	// set mirrors receiver/src/config.mjs loadForgejoConfig exactly (those three are what boot
	// hard-requires), so this warns about precisely what the receiver will refuse. Presence-only for all
	// three: FORGEJO_URL is no secret, but one rule for the set is one rule to audit.
	if (forges.includes("forgejo")) {
		const missing = ["FORGEJO_URL", "FORGEJO_WEBHOOK_SECRET", "FORGEJO_TOKEN"].filter((k) => typeof env[k] !== "string" || env[k].trim() === "");
		if (missing.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has forgejo triggers but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset -- the receiver will refuse to start (or serve no /forgejo endpoint at all)`,
				fix: "set them in .env (.env.example documents each; docs/forgejo.md walks the webhook setup); FORGEJO_BOT_ID is also needed when FORGEJO_TOKEN is repository-scoped -- a scoped token cannot call GET /user to identify itself",
			});
		} else {
			checks.push({ ok: true, label: `forgejo triggers configured (${urlShown(env.FORGEJO_URL)})` });
		}
	}

	// Issue #508: with the egress policy on, a job reaches a forge only over https on port 443.
	checks.push(...forgeUrlEgressChecks(env, forges));

	// Azure DevOps, when the triggers file names it (issue #80) -- same shape, mirrored from
	// receiver/src/config.mjs loadAzureConfig. AZURE_WEBHOOK_MODE gets its own line because it is
	// required-UNDEFAULTED: Azure offers no HMAC at all, so both modes are shared-secret compares, and
	// which header carries the secret must be a thing somebody decided. AZURE_WEBHOOK_HEADER joins the
	// required set only under mode=header, exactly as boot requires it.
	if (forges.includes("azure")) {
		const azMode = env.AZURE_WEBHOOK_MODE;
		const azModeOk = azMode === "basic" || azMode === "header";
		if (!azModeOk) {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has azure triggers but AZURE_WEBHOOK_MODE is ${azMode === undefined ? "unset" : JSON.stringify(azMode)} -- the receiver will refuse to start`,
				fix: 'set it to "basic" (HTTP Basic on the service hook) or "header" (a custom header) -- deliberately undefaulted, Azure offers no HMAC, so which shared-secret compare gates the endpoint must be a chosen thing (.env.example, docs/azure-devops.md)',
			});
		}
		const azRequired = ["AZURE_WEBHOOK_SECRET", "AZURE_TOKEN", "AZURE_ORG_URL", ...(azMode === "header" ? ["AZURE_WEBHOOK_HEADER"] : [])];
		const azMissing = azRequired.filter((k) => typeof env[k] !== "string" || env[k].trim() === "");
		if (azMissing.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `triggers.json has azure triggers but ${azMissing.join(", ")} ${azMissing.length === 1 ? "is" : "are"} unset -- the receiver will refuse to start (or serve no /azure endpoint at all)`,
				fix: "set them in .env (.env.example documents each; docs/azure-devops.md walks the service-hook setup)",
			});
		} else if (azModeOk) {
			checks.push({ ok: true, label: `azure triggers configured (${urlShown(env.AZURE_ORG_URL)})` });
		}
	}

	// REQ-BRANCH-PROTECTION-PRECONDITION, preflighted (issue #80). The worker refuses a forge-backed job
	// on an unprotected default branch BEFORE any spend -- correct, but that answer arrives at the first
	// paid trigger, as a refusal comment a requester is already waiting on. Doctor asks the same question
	// READ-ONLY at setup time, for each github repo the triggers file NAMES. Warn, never fail: the
	// worker's own gate stays the enforcement, this is the early copy of its answer.
	if (forges.includes("github")) {
		if (repositories.length === 0) {
			// A github label/comment trigger takes its repository from each delivery's payload, and the
			// shared schema admits `run.repository` only on azure triggers today (triggers.mjs,
			// validateRepository) -- so there is nothing here to ask GitHub about. Said in ONE line so a
			// green doctor cannot read as "this REQ was preflighted": it is enforced per job, just not
			// checkable from here.
			checks.push({
				ok: true,
				label: "github triggers take their repository from each delivery -- branch protection cannot be preflighted per repo here, and is enforced per job before any spend (REQ-BRANCH-PROTECTION-PRECONDITION)",
			});
		} else {
			checks.push(...(await githubProtectionPreflight(spawn, repositories, runTimeouts)));
		}
	}

	// The default source `gh` mints job tokens from the operator's gh login, so the FULL-scope login token
	// reaches every token-carrying job container — the opposite of the App path's per-repo short-lived
	// tokens (CONST-TOKEN-SCOPED-PER-JOB). Both checks below warn, never fail: a local-only deployment with
	// the default source is valid, for the same reason the worker's own auth at start is best-effort.
	// The service's GitHub auth settings (PR #466 gate round 2): this shell where it sets one, else the deployment's
	// `.env`, as VALKEY_URL and PI_PROVIDER are read above, so an app-auth ✗ judges the file the worker will load and not
	// a shell that happens to lack it. Said once, by NAME.
	// Each key read as `env.NAME` first, so the environment scan (env-docs.test.mjs) still sees every read.
	const ghSource = env.GITHUB_AUTH_SOURCE ?? "gh"; // config.mjs's own default, read directly, no loadConfig
	// Only the keys that decide a line: the App keys matter only while app is the source.
	const ghRead = GITHUB_SERVICE_KEYS.filter((k) => settingsRead(service.fromFile).includes(k) && (k === "GITHUB_AUTH_SOURCE" || ghSource === "app"));
	if (ghRead.length > 0) checks.push({ ok: true, label: `GitHub auth settings read from ${serviceEnvFile.path}, as the service reads them (this shell does not set them): ${ghRead.join(", ")}` });
	// Issue #481: a source `loadGitHubAuth` refuses, the EMPTY one included, and both the worker and the receiver load it
	// at start. It was said nowhere: every branch below asks for gh, pat or app, so `GITHUB_AUTH_SOURCE=` passed doctor on
	// a deployment that exits 2 at boot. The value is shown only where it is short and plain (PR #485 review round 1): a
	// token pasted into the wrong line is a token, and this line would have printed it in full.
	if (ghSource !== "gh" && ghSource !== "pat" && ghSource !== "app") {
		const sourceShown = /^[A-Za-z0-9_-]{0,12}$/.test(ghSource) ? quotedShown(ghSource) : `an unrecognised value (${ghSource.length} characters, not shown)`;
		checks.push({ ok: false, label: `GITHUB_AUTH_SOURCE is ${sourceShown}, which is none of pat, gh or app: the worker and the receiver refuse to start on it (exit 2)${fromFileNote(fileSays("GITHUB_AUTH_SOURCE"))}`, fix: "set GITHUB_AUTH_SOURCE to pat, gh or app, or delete the line for the default (gh)" });
	}
	// Issue #481 (PR #485 review round 1): the PAT source's own refusal, `GITHUB_AUTH_SOURCE=pat requires a non-empty
	// <var>`, which both processes make at start (the PAT is trimmed there, so blank is missing too). GITHUB_PAT_VAR set
	// to "" names no variable at all. Before this doctor said only that the in-image probe was not run. The PAT is
	// resolved by the service's rule like every other key, by name, and never shown.
	if (ghSource === "pat") {
		const patVar = env.GITHUB_PAT_VAR ?? "GITHUB_PAT"; // config.mjs's patVar default, read directly
		const patValue = patVar === "" ? undefined : service.extra([patVar]).env[patVar];
		if ((patValue ?? "").trim() === "") {
			const what = patVar === "" ? "GITHUB_PAT_VAR is set to an empty value, so it names no variable to take the PAT from" : `${patVar} is ${patValue === undefined ? "unset" : patValue === "" ? "empty" : "whitespace only"}`;
			const note = patVar === "" ? fromFileNote(fileSays("GITHUB_PAT_VAR")) : patValue !== undefined && Object.hasOwn(service.extraFromFile, patVar) ? fromFileNote([patVar]) : "";
			const patCheck = credentialAbsent({
				subject: `GITHUB_AUTH_SOURCE=pat but ${what}`,
				names: patVar === "" ? "GITHUB_PAT_VAR and the PAT it names" : patVar,
				refusal: "the worker and the receiver refuse to start (exit 2)",
				sep: ": ",
				fix: patVar === "" ? "delete the GITHUB_PAT_VAR line to use GITHUB_PAT, or name the variable that holds the PAT" : `set ${patVar} to a fine-grained PAT in .env, or switch GITHUB_AUTH_SOURCE`,
			});
			// Where the file said it, that is part of the subject either way; the seen label already names .env.
			checks.push(patCheck.warn ? patCheck : { ...patCheck, label: `${patCheck.label}${note}` });
		}
	}
	if (ghSource === "gh") {
		// gh writes `auth status` to stdout or stderr depending on version — capture both combined.
		const status = await runCmdCapture(spawn, "gh", ["auth", "status"]);
		if (status.code === 0) {
			const scopes = parseGhTokenScopes(status.output);
			const broad = (scopes ?? []).filter((s) => BROAD_SCOPES.includes(s));
			checks.push({
				ok: false,
				warn: true,
				label: `GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (${
					scopes ? `scopes: ${scopes.join(", ")}` : "scopes not reported (fine-grained token)"
				})`,
				fix:
					(broad.length > 0 ? `this token carries broad scopes (${broad.join(", ")}) -- ` : "") +
					"use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			});
		} else {
			checks.push({
				ok: false,
				warn: true,
				label: "GITHUB_AUTH_SOURCE is gh but `gh auth status` failed",
				fix: "run `gh auth login` (or switch GITHUB_AUTH_SOURCE) -- github jobs and run.github cron triggers will refuse to run",
			});
		}
	}

	// GITHUB_AUTH_SOURCE=app: completeness of the credential triple loadGitHubAuth hard-requires
	// (config.mjs), preflighted here so a half-finished App setup surfaces as doctor lines instead of a
	// boot refusal. Every line the worker's boot or its token mint refuses on FAILS (PR #466 gate round 1): the two ids
	// and the key's presence; the key's hygiene lines still warn, the github block's mid-setup doctrine. The private key gets a hygiene pass on top: presence, POSIX mode, and
	// a first-bytes PEM sniff — but its CONTENTS never reach output: only the leading bytes are read
	// (never the whole key into memory), and nothing from the file is ever echoed. Every fix line points
	// at `pi-dispatch setup github`, which mints all three values and writes the PEM 0600 in one pass.
	if (ghSource === "app") {
		const setupFix = "run `pi-dispatch setup github` -- it mints the App, writes these .env lines, and lands the key mode 0600";
		const numeric = (v) => typeof v === "string" && /^\d+$/.test(v.trim());
		// A FAILURE, not a warning (PR #466 gate round 1): the "mid-setup" doctrine above is about what a deployment may
		// not have reached yet, and choosing GITHUB_AUTH_SOURCE=app is past that point. Unset, `loadGitHubAuth` refuses the
		// worker's boot; set but not a number, the worker boots and every github job fails to mint its token. Only ever
		// reached when app auth is the selected source.
		const ids = { GITHUB_APP_ID: env.GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID };
		for (const name of Object.keys(ids)) {
			// Unset and empty alike (`loadGitHubAuth`'s `!appId`), so the words say both (PR #485 review round 2); and a
			// missing id is one an env-setup script may export (`credentialAbsent`).
			if (!ids[name]) {
				checks.push(credentialAbsent({ subject: `GITHUB_AUTH_SOURCE=app but ${name} is unset or empty`, names: name, refusal: "the worker will refuse to boot", fix: setupFix }));
				continue;
			}
			checks.push({
				ok: numeric(ids[name]),
				label: numeric(ids[name]) ? `${name} set (${ids[name].trim()})` : `GITHUB_AUTH_SOURCE=app but ${name} is not numeric (${JSON.stringify(ids[name])}) -- github jobs cannot mint tokens`,
				fix: setupFix,
			});
		}
		// Two ways to supply the key, exactly one of them at a time (issue #208): a path to a file, or the
		// PEM itself in GITHUB_APP_PRIVATE_KEY for a deployment whose environment comes from a secrets
		// manager. The hygiene pass below belongs to the PATH variant -- there is no mode to check and no
		// file to stat on a value that only ever exists in this process's environment, and whoever supplies
		// that environment owns its hygiene. What survives for both is the shape sniff, and the rule that
		// nothing from the key reaches output.
		const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
		const inlineKey = (env.GITHUB_APP_PRIVATE_KEY ?? "").trim();
		// Blank counts as unset, as `loadGitHubAuth` trims it (PR #466 gate round 2): a path of spaces beside an inline key
		// is not "both set", and alone it is "neither set".
		const keyPathSet = (keyPath ?? "").trim() !== "";
		// The three key lines `loadGitHubAuth` refuses the worker's boot on (both forms set, neither set, a path that does not
		// exist) FAIL, as the two ids do (PR #466 gate round 1); the hygiene lines below (mode, PEM shape) still warn.
		if (inlineKey !== "" && keyPathSet) {
			checks.push({
				ok: false,
				label: "GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are both set -- the worker will refuse to boot",
				fix: "unset one of them: the inline value for a deployment fed by a secrets manager, the path for a key on disk (docs/secrets.md)",
			});
		} else if (inlineKey !== "") {
			// A flattened key still starts with the header -- the `\n` escapes come after it -- so one sniff
			// covers both accepted forms.
			if (inlineKey.startsWith("-----BEGIN")) {
				checks.push({ ok: true, label: "GitHub App private key supplied inline (GITHUB_APP_PRIVATE_KEY)" });
			} else {
				checks.push({
					ok: false,
					warn: true,
					label: `GITHUB_APP_PRIVATE_KEY does not look like a PEM (does not begin "-----BEGIN ...") -- the worker will refuse to boot; contents not shown`,
					fix: "check for a truncated paste, or point GITHUB_APP_PRIVATE_KEY_PATH at the key file instead (docs/secrets.md)",
				});
			}
		} else if (!keyPathSet) {
			checks.push(credentialAbsent({ subject: "GITHUB_AUTH_SOURCE=app but neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set", names: "GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY", refusal: "the worker will refuse to boot", fix: setupFix }));
		} else if (!fileExists(keyPath)) {
			checks.push({ ok: false, label: `GITHUB_APP_PRIVATE_KEY_PATH does not exist (${keyPath}) -- the worker will refuse to boot`, fix: setupFix });
		} else {
			checks.push({ ok: true, label: `GitHub App private key present (${keyPath})` });
			// POSIX mode only -- on win32 stat modes are synthetic (0666-ish for everything), so a warn
			// there would fire on every healthy deployment and teach operators to ignore it.
			if (platform !== "win32") {
				try {
					const loose = statSync(keyPath).mode & 0o077;
					if (loose !== 0) {
						checks.push({
							ok: false,
							warn: true,
							label: `the App private key at ${keyPath} is group/world-readable`,
							fix: `chmod 600 ${keyPath} -- any local user can read the App's signing key right now (\`pi-dispatch setup github\` writes it 0600)`,
						});
					}
				} catch {
					// stat raced a deletion or an exotic fs: the presence line above already covered existence.
				}
			}
			// First bytes only: enough to see "-----BEGIN", never the key material, and never echoed.
			try {
				const fd = openSync(keyPath, "r");
				const head = Buffer.alloc(16);
				let read = 0;
				try {
					read = readSync(fd, head, 0, head.length, 0);
				} finally {
					closeSync(fd);
				}
				if (!head.toString("utf8", 0, read).startsWith("-----BEGIN")) {
					checks.push({
						ok: false,
						warn: true,
						label: `the file at GITHUB_APP_PRIVATE_KEY_PATH does not look like a PEM (first line is not "-----BEGIN ...") -- contents not shown`,
						fix: setupFix,
					});
				}
			} catch {
				checks.push({ ok: false, warn: true, label: `the App private key at ${keyPath} exists but is not readable by this user`, fix: setupFix });
			}
			// Mode 0600 protects the key from other users on this host; it does nothing once the file is in
			// a commit. `setup github` writes the key into the DEPLOYMENT FOLDER, and a deployment folder is
			// very often a checkout -- so the last thing between an App signing key and a public repository
			// can be one `git add -A`. This repo's own .gitignore covers *.pem; the operator's may not, and
			// a key they renamed or brought themselves is the same accident.
			//
			// Exit 1 is the ONLY case that warns: git says "this is a work tree, and that path is not
			// ignored". 0 means covered, 128 means no work tree at all, and null means git could not be
			// launched. Every one of those is silence, because a check nobody can silence must never cry
			// wolf -- the cost of a missed warning here is one operator reading the doc, and the cost of a
			// false one is every operator learning to scroll past doctor.
			// A TIMEOUT is silence too, which is the same answer this comment already argues for `null`: exit 1
			// is the only case that warns, so a git that did not finish cannot cry wolf.
			const ignoreCode = (await runCmd(spawn, "git", [...GIT_READ_FLAGS, "-C", dirname(keyPath), "check-ignore", "-q", keyPath], runTimeouts.cmd)).code;
			if (ignoreCode === 1) {
				checks.push({
					ok: false,
					warn: true,
					label: `the App private key at ${keyPath} is inside a git work tree that does not ignore it`,
					fix: `move it outside that repo, or ignore it there (\`*.pem\`) -- one \`git add -A\` commits the App's signing key, which can mint a token for every repository the App is installed on, and mode 0600 does not survive a commit`,
				});
			}
		}
	}

	// Preflight gh INSIDE the job image: a token that works host-side but not in-container (no egress from
	// containers, stale image) fails jobs mid-run, not at submit. Only meaningful when docker and the image
	// are green; otherwise it is noise on top of the failures already reported above. Issue #354: and only where a job
	// runs on docker at all. On a deployment without `local` it would hand the operator's gh token to a container in a
	// store no job starts from, to answer a question about an image no job uses.
	//
	// Issue #433: a deployment without `local` asks it of the podman venue instead, where its jobs start: the job image in
	// this account's store, through `podman`, with the same argv (`ghProbeArgs`). Only once the podman section has read
	// the image there, decided a job may run, and seen the service as this host's own (`serviceIsRemote: false`), which
	// is podman's answer to the question docker's endpoint read answers below: the token must not ride to another
	// machine. A deployment with `local` probes on docker exactly as before, and only there: one hand-off of the token per
	// doctor run, not one per venue, and that deployment's output unchanged.
	const ghProbeBin = localUsed
		? dockerCode === 0 && imageCode === 0
			? "docker"
			: null
		: podman?.forLive?.run === true && podman.forLive.imagePresent === true && podman.forLive.info?.serviceIsRemote === false
			? "podman"
			: null;
	if (ghProbeBin !== null) {
		if (ghSource === "app") {
			checks.push({ ok: true, label: "in-image gh auth: skipped (GITHUB_AUTH_SOURCE=app mints per-job)" });
		} else {
			let token = "";
			if (ghSource === "gh") {
				const minted = await runCmdCapture(spawn, "gh", ["auth", "token"]);
				if (minted.code === 0) token = minted.output.trim();
				// mint failed → skip: the status check above already warned that gh auth is broken
			} else if (ghSource === "pat") {
				const patVar = env.GITHUB_PAT_VAR ?? "GITHUB_PAT"; // config.mjs's patVar default, read directly
				// Issue #471: the PAT as the service reads it is resolved (a disagreement on it is said, by name), but the probe
				// hands a program a token only from THIS shell (PR #474's round cap: nothing from `.env` reaches a spawn), so a
				// PAT, or the name of its variable, that only the file supplies means the probe is not run, and that is said.
				const pat = service.extra([patVar]);
				// The value from THIS shell alone (round-cap re-review, D1): `env` also holds what the file supplied, the venue
				// keys among them, so a shell GITHUB_PAT_VAR naming PI_EGRESS_PROXY handed the file's value to the probe as its
				// token. Any value doctor would take from the file (the PAT's own key, or anything `env` has that this shell
				// has not) skips the probe instead.
				const shellPat = shellValue(patVar);
				// Issue #481 (PR #485 review round 1): a PAT line the file leaves blank supplies no PAT (`loadGitHubAuth` trims it,
				// and the ✗ above names it), and an empty GITHUB_PAT_VAR names none; neither is "the PAT comes from the file".
				const filePat = Object.hasOwn(pat.fromFile, patVar) && pat.fromFile[patVar].trim() !== "";
				patFromFile = filePat || (env[patVar] !== undefined && shellPat === undefined && env[patVar].trim() !== "") ? patVar : settingsRead(service.fromFile).includes("GITHUB_PAT_VAR") && env.GITHUB_PAT_VAR !== "" ? "GITHUB_PAT_VAR" : null;
				token = patFromFile ? "" : (shellPat ?? "").trim(); // absent → skip; loadConfig fails loud at worker boot anyway
			}
			if (token && ghProbeBin === "docker" && endpoint.local !== true) {
				// NOT RUN on a daemon that is not observed on this host (#278). The probe hands the operator's own gh
				// token -- full scope and non-expiring by default -- to `docker run` (on stdin since #521), and on a redirected CLI that
				// token rides to another machine. A check must not do the thing the credentialTransit line warns
				// about. Only once there IS a token: app mode and an unset PAT never run the probe at all.
				checks.push({
					ok: false,
					warn: true,
					label: `in-image gh auth: not checked, because this shell's docker CLI ${endpoint.local === false ? `resolves ${endpointShown(endpoint)}, which is not shown to be on this host` : `did not say which daemon it uses (${endpoint.reason})`}, and the probe would send your gh token there`,
					fix: "point the docker CLI at this host and re-run doctor to check it",
				});
			} else if (token) {
				// On stdin (issue #521, `ghProbeArgs`): the token never enters argv (visible in `ps`), the container
				// create request (which Docker Desktop logs) or doctor's output, and doctor adds no copy of it to the
				// CLI's environment. That environment may already hold it (a PAT source reads it from this shell's
				// GITHUB_PAT), and that copy stays out of the container because docker forwards nothing `-e` does not
				// name and podman's probe carries `--env-host=false`.
				//
				// The CLI's own environment stays doctor's whole one on both runtimes, and that is deliberate rather than
				// left over (review round 1 asked): what keeps it OUT of the container is the pinned argv above, while
				// what the CLI itself reads from it (CONTAINER_HOST, XDG_RUNTIME_DIR, XDG_CONFIG_HOME, the storage conf
				// variables) is what decides WHICH Podman and which store answer. The podman section read that service
				// with this same environment, so a trimmed one could send the token to a service nothing here checked.
				// An allowlist of what Podman needs was rejected for that reason: it is a list nothing derives.
				const probe = await runCmdCapture(spawn, ghProbeBin, ghProbeArgs(jobImage, ghProbeBin), { env: spawnEnv, input: `${token}\n` });
				const where = ghProbeBin === "podman" ? "podman: " : "";
				// 126 and 127 are the runtime's and the shell's "could not run that program" (measured on docker 27.4: a
				// missing entrypoint and a missing exec target both exit 127, a non-executable one 126); `gh auth status`
				// itself exits 0, 1, 2, 4 or 8. Since the probe's entrypoint became `sh` (#521), an image without one
				// lands here, and naming it as an auth failure would send the operator to check egress for nothing.
				const cannotRun = probe.code === 126 || probe.code === 127;
				checks.push({
					ok: probe.code === 0,
					warn: true,
					label:
						probe.code === 0
							? `${where}gh authenticates inside the job image (${jobImage})`
							: cannotRun
								? `${where}gh could not be run inside the job image (${jobImage}): it has no sh or no gh (exit ${probe.code})`
								: `${where}gh cannot authenticate inside the job image (${jobImage})`,
					fix: cannotRun
						? "rebuild or pull the job image: every image built FROM this repo's image/Dockerfile has both -- jobs that use gh will fail mid-run"
						: "check network egress from containers or rebuild/pull the job image -- jobs that use gh will fail mid-run",
				});
			} else if (patFromFile) {
				// The service's PAT is in `.env`, which hands no program anything (PR #474's round cap): named, not run.
				checks.push({
					ok: false,
					warn: true,
					label: `in-image gh auth: not checked, because ${patFromFile} comes from ${serviceEnvFile?.path ?? join(cwd, ".env")} and doctor hands nothing from that file to a program it starts`,
					fix: `to check it, run doctor from a shell that exports ${patFromFile === "GITHUB_PAT_VAR" ? "GITHUB_PAT_VAR and the variable it names" : patFromFile}`,
				});
			}
		}
	}

	// Issue #464 (gate rounds 1 and 2): WHOSE Valkey that is, on the podman venue, by the one rule the worker applies at
	// boot and `service install` and `up` apply (`judgeValkeyListeners`). Reachable is not enough: on a shared host a
	// VALKEY_URL that reaches another account's Valkey (its port, its ::1 for a `localhost` URL, or 0.0.0.0) passed here,
	// and the worker then took and ran that account's jobs. Judged BEFORE anything talks to Valkey: after a refusal
	// doctor neither PINGs that Valkey nor reads its fleet, and otherwise it talks to the address the worker pins.
	// Gate round 3: on EVERY venue, as the worker and every client now judge it: another account's listener is refused
	// wherever it is; root's (docker-proxy) only where `local` is not blessed, since docker's Valkey is the queue there.
	// Only on Linux, where /proc names the owner (the default seam is null elsewhere). PI_VALKEY_SHARED comes from the
	// deployment `.env` alone, as the worker reads it; one in this shell is named as ignored.
	let ownerVerdict = null;
	const sharedInFile = (() => {
		if (!serviceEnvFile) return undefined;
		const read = readEnvAssignments(serviceEnvFile.text, [VALKEY_SHARED_KEY], { loader: serviceEnvFile.loader })[VALKEY_SHARED_KEY];
		return read?.plain && typeof read.value === "string" ? read.value : undefined;
	})();
	if (!unreadValkey && !valkeyDbProblem && seams.valkeyOwner) {
		if (typeof env[VALKEY_SHARED_KEY] === "string") checks.push({ ok: false, warn: true, label: sharedShellIgnored(env[VALKEY_SHARED_KEY], join(cwd, ".env")), fix: "put PI_VALKEY_SHARED=1 in the deployment's .env if that Valkey is shared on purpose, and unset it in this shell" });
		ownerVerdict = await seams.valkeyOwner(valkeyUrl, { shared: valkeySharedOn(sharedInFile), user: userNameOf(seams), envPath: join(cwd, ".env"), rootOk: !(podmanUsed && !localUsed) });
	}
	// A name that does not resolve here cannot be judged (gate round 3): said, and talked to no more than a refused one.
	const valkeyUnresolved = ownerVerdict?.unresolved ? `VALKEY_URL's host ${ownerVerdict.unresolved} did not resolve here (${ownerVerdict.why}), so whose Valkey it reaches cannot be judged; the worker waits for it and retries` : null;
	const valkeyRefused = Boolean(ownerVerdict?.refusal) || valkeyUnresolved !== null;
	const valkeyTalkUrl = ownerVerdict?.chosen ? pinnedValkeyUrl(valkeyUrl, ownerVerdict.chosen).url : valkeyUrl;
	// Issue #468: how that Valkey answers this deployment's credential, asked only where doctor talks to it at all, by
	// doctor's own in-process client (issue #471's rule: no program doctor starts is handed anything from `.env`). The
	// credential is the resolved one: this shell's VALKEY_PASSWORD, else the file's (for a loopback Valkey only, as every
	// client sends it, `valkeyPasswordFor`), never printed.
	const fileValue = (key) => service.fromFile[key] ?? service.disagreements.find((d) => d.key === key)?.file;
	// This shell's side where it set the key, the file's where the resolution took it from there (sent to a loopback
	// Valkey only), as every client sends it (`valkeyContextFromResolution`).
	const valkeyContext = valkeyContextFromResolution({ service, envPath: serviceEnvFile?.path ?? join(cwd, ".env"), shared: sharedInFile, platform });
	const valkeyAuthVerdict = !valkeyUnresolved && !valkeyRefused && !unreadValkey && !valkeyDbProblem && seams.valkeyAuth ? await seams.valkeyAuth(valkeyTalkUrl, { context: valkeyContext }) : null;
	if (valkeyDbProblem) {
		checks.push({ ok: false, label: `${valkeyDbProblem}: the worker refuses to start on it (exit 2), and doctor contacted no Valkey`, fix: "write VALKEY_URL as redis://host:port, or redis://host:port/<database number>, then re-run doctor" });
	} else if (valkeyUnresolved) {
		checks.push({ ok: false, label: valkeyUnresolved, fix: "fix the name's resolution on this host, or write the address in VALKEY_URL" });
	} else if (valkeyRefused) {
		checks.push({ ok: false, label: `Valkey (${urlShown(valkeyUrl)}) is not this account's: ${ownerVerdict.refusal.short}. The worker refuses to start on it (exit 2); doctor did not talk to it`, fix: ownerVerdict.refusal.fix });
	} else if (unreadValkey) {
		checks.push({
			ok: false,
			label: `${unreadValkey}: doctor contacted no Valkey, since the default it would fall back to (${urlShown(valkeyUrl)}) is not what the service's worker is given, and on a shared host may be another account's`,
			fix: "write that line so every loader reads it the same (the reason above says how), then re-run doctor",
		});
	} else if (valkeyAuthVerdict?.state === "dbrange") {
		// Gate round 2 of PR #478: a database that Valkey does not have. Every client refuses it rather than using
		// database 0 (connection.mjs, `DB_REFUSED`), so it is the worker's refusal too, and nothing more is read from it.
		checks.push({ ok: false, label: `${valkeyAuthVerdict.error}: the worker refuses to start on it (exit 2)`, fix: "write VALKEY_URL with a database that Valkey has (no path is database 0), or raise `databases` in its configuration, then re-run doctor" });
	} else if (valkeyAuthVerdict && (valkeyAuthVerdict.state === "noauth" || valkeyAuthVerdict.state === "wrongpass")) {
		// Issue #468: a Valkey that refuses this deployment's credential answers, so "not reachable" would be the wrong
		// sentence: it is the password, named by its key and where it came from, never its value.
		checks.push({ ok: false, label: `Valkey (${urlShown(valkeyUrl)}) answers, and ${valkeyAuthVerdict.state === "noauth" ? "requires a password this deployment does not send" : `refuses the ${VALKEY_PASSWORD_KEY} this deployment sends`}: the worker refuses to start on it (exit 2)`, fix: valkeyAuthFix(valkeyAuthVerdict.state, { localUsed, podmanUsed, envPath: join(cwd, ".env") }) });
	} else checks.push({
		ok: await probeValkey(valkeyTalkUrl),
		label: `Valkey reachable (${urlShown(valkeyUrl)})${fromFileNote(fileSays("VALKEY_URL"))}`,
		// Issue #433: without `local`, docker is not this deployment's runtime and may not be installed at all. Issue #468
		// with issue #471's rule: doctor starts NO Valkey any more (its `--fix` offered a `docker run`, which since #468 needs
		// the deployment's VALKEY_PASSWORD in the docker CLI's environment, and doctor hands no program anything from
		// `.env`). It names the step: `pi-dispatch up`, which starts it with the password, labels its container and volume
		// with this folder, and asks before it uses a volume it cannot attribute. The words hold on both venues.
		fix: localUsed
			? "run `pi-dispatch up` in the deployment folder: it starts Valkey with the deployment's VALKEY_PASSWORD (or, in a folder /dispatch setup handed to compose, compose's own: `docker compose -p <folder name> --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.valkey.yml up -d valkey`)"
			: "run `pi-dispatch up` (or `pi-dispatch service install`) as this account: on the podman venue both start Valkey as a Quadlet unit under its Podman (docs/podman.md, setup step 6); a Valkey you run yourself, a distribution package say, works too",
	});

	// Round 3 of PR #475's review: PI_VALKEY_PORT is the port compose publishes its Valkey on, and VALKEY_URL's is the one
	// the worker dials; a value that disagrees (in .env, or in this shell, which wins over --env-file) moves the queue off
	// the worker's port on the next compose run (measured). A loopback VALKEY_URL only: another host's port is not compose's.
	{
		const target = valkeyTarget(valkeyUrl);
		const portDisagreement = service.disagreements.find((d) => d.key === VALKEY_PORT_KEY);
		const sources = [
			...(typeof env[VALKEY_PORT_KEY] === "string" && env[VALKEY_PORT_KEY].trim() !== "" ? [[env[VALKEY_PORT_KEY].trim(), fileSays(VALKEY_PORT_KEY).length > 0 ? join(cwd, ".env") : "this shell"]] : []),
			...(portDisagreement && portDisagreement.file.trim() !== "" ? [[portDisagreement.file.trim(), join(cwd, ".env")]] : []),
		];
		if (!target.error && isLoopbackHost(target.host)) {
			for (const [value, where] of sources) {
				if (value !== String(target.port)) checks.push({ ok: false, warn: true, label: valkeyPortConflict(value, target.port, where), fix: `${VALKEY_PORT_KEY}=${target.port} in ${join(cwd, ".env")} (and unset it in this shell if it is set there)` });
			}
		}
	}

	if (ownerVerdict?.heldBy) {
		checks.push({ ok: true, label: `Valkey (${urlShown(valkeyUrl)}) answers from a listener of ${ownerVerdict.heldBy}${ownerVerdict.chosen ? `; the worker connects to ${ownerVerdict.chosen} only` : ""}` });
	}
	checks.push(...(await valkeyPasswordChecks({ verdict: valkeyAuthVerdict, context: valkeyContext, seams, valkeyUrl, valkeyTalkUrl, localUsed, podmanUsed, platform, statSeam, fileValue })));
	for (const other of ownerVerdict?.elsewhere ?? []) {
		checks.push({ ok: false, warn: true, label: `another account also listens on an address VALKEY_URL's host resolves to: ${other}. The worker connects only to the address judged this account's, so it never reaches that one`, fix: "nothing to change for this deployment; a client that resolves the name itself (`pi-dispatch run` from a shell) may still reach it, so prefer VALKEY_URL=redis://127.0.0.1:<port>" });
	}

	// --- the fleet (issue #57) -------------------------------------------------------------------------
	//
	// Every line here is gated on a peer actually existing, so a single-host deployment's output is
	// byte-identical. And every one is a WARN rather than a failure, with one exception noted below: this
	// command runs on ONE machine and must not refuse a deployment for a condition that machine cannot fix.
	// This host's own image id, read through the same seam every other docker probe here uses. Only when
	// the image is actually present -- an absent one is already reported above, and a second line saying
	// its digest is unknown would be noise on a fault the operator has been told about.
	// Not from the default Valkey when the service's VALKEY_URL line could not be read (`unreadValkey`): its fleet is
	// another deployment's.
	const fleet = unreadValkey || valkeyRefused || valkeyDbProblem || valkeyAuthVerdict?.state === "dbrange" ? { hosts: [] } : await readHosts(valkeyTalkUrl);
	// Printable before anything is compared or said (issue #453, gate round 3): since a folder's `.env` now chooses the
	// Valkey doctor reads, a host row is another party's text, and a control byte in a name or zone must not reach the
	// terminal. The registry's own charset already refuses them at the source; this is the reader not relying on it.
	const peers = (fleet.hosts ?? []).map((h) => ({ ...h, name: printable(h.name), tz: h.tz ? printable(h.tz) : h.tz })).filter((h) => h.name !== workerNameOf(declaredWorkerName));
	// The applied split (issue #504 part B): one GET whenever this command may talk to the Valkey, so a single host with
	// no envelope that refuses every job is told why. `{ digest }`, `{ undecodable: true }` for a key that exists and does
	// not decode (the worker's EXISTS still counts it as governed), or null (no split, or no answer: nothing is said).
	const valkeyUsable = !(unreadValkey || valkeyRefused || valkeyDbProblem || valkeyAuthVerdict?.state === "dbrange");
	const appliedSplit = valkeyUsable ? await (seams.readAppliedSplit ?? defaultReadAppliedSplit)(valkeyTalkUrl) : null;
	// Read only when there is a peer to compare against. Every line below is gated on a peer existing, and
	// the SUBPROCESS has to be too: otherwise every `doctor` run on every single-host deployment spawns an
	// extra docker call whose answer nothing reads.
	// Issue #433: without `local`, the id the podman section's own image read already returned, and no spawn: a worker
	// without `local` publishes exactly that one (its default venue's preflight, `start.mjs`), so it is the id to compare.
	const imageDigest =
		peers.length === 0
			? null
			: localUsed
				? imageCode === 0
					? normalizeImageId((await runCmdCapture(spawn, "docker", ["image", "inspect", "--format={{.Id}}", jobImage], { stdoutOnly: true })).output.trim()) || null
					: null
				: (podman?.imageDigest ?? null);
	if (peers.length > 0) {
		const mine = workerNameOf(declaredWorkerName);
		checks.push({ ok: true, label: `Fleet: ${peers.length + 1} worker${peers.length === 0 ? "" : "s"} (${[mine, ...peers.map((h) => h.name)].sort().join(", ")})` });

		// The one thing that is silently WRONG rather than merely undeclared. Without a declared name this
		// host enqueues its own folder work to the SHARED queue, where a peer that has no such folder can
		// pop it -- so the routing that makes a fleet safe is simply off, and nothing else says so.
		if (!declaredWorkerName) {
			checks.push({
				ok: false,
				warn: true,
				label: "This worker has peers but no PI_WORKER_NAME, so host routing is OFF here",
				fix: "set PI_WORKER_NAME in this host's .env and restart: without it, this host's folder work is enqueued where any host can pop it, and its records carry a hostname it never chose",
			});
		}

		// Two hosts on two builds of one tag is the failure Gap 6 names: same flow, different behaviour,
		// undebuggable. A WARN and never a failure, because `{{.Id}}` is the LOCAL image id -- two
		// independent builds of one Dockerfile differ, and under docker's containerd image store it is the
		// manifest digest rather than the config digest, so a mixed-store fleet disagrees about identical
		// content. Suspicious, never wrong.
		const digests = new Set(peers.map((h) => h.imageDigest).filter(Boolean));
		if (digests.size > 0 && imageDigest && !digests.has(imageDigest)) {
			checks.push({
				ok: false,
				warn: true,
				label: `Job image digest differs from ${peers.length === 1 ? "the other host" : "other hosts"}`,
				fix: "rebuild or re-pull so every host runs the same image; digests are identical only when both hosts pulled one tag from one registry, so two local builds differ legitimately",
			});
		}

		// A cron PATTERN carries no timezone and resolves in each worker's LOCAL time, so one pattern is two
		// different instants on two hosts in two zones -- and the cron gate refuses that divergence rather
		// than letting it drift, which is why this reads as an explanation for a refusal an operator has
		// probably already met.
		const zones = new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, ...peers.map((h) => h.tz).filter(Boolean)]);
		if (zones.size > 1) {
			checks.push({
				ok: false,
				warn: true,
				label: `Hosts disagree about the timezone (${[...zones].sort().join(", ")}), so one cron pattern is two different instants`,
				fix: "set the same TZ on every host: a cron trigger carries no timezone of its own, so cron reconcile refuses while they disagree",
			});
		}

		// Clocks. The registry's own heartbeats are the measurement, and skew matters here beyond tidiness:
		// every hold clock, every TTL and the UTC day boundary the budget windows key on are read against
		// whichever host is looking.
		const skewed = peers.filter((h) => Number.isFinite(h.staleMs) && h.staleMs > 5 * 60_000);
		if (skewed.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `${skewed.length} host row${skewed.length === 1 ? " is" : "s are"} stale by more than five minutes (${skewed.map((h) => h.name).join(", ")})`,
				fix: "check that those workers are running and that the clocks agree -- a stale row is either a dead worker or a skewed clock, and both matter",
			});
		}

		// Issue #501 part 6: the dollar counters are shared, the caps they are judged against are per host. This host's
		// fingerprint is computed here from the service's own settings, by the worker's function, never read back from
		// its registry row: doctor answers for the configuration, which a worker that has not restarted may not run yet.
		// The scoped-limits rows are the parsed file's, or none when it does not load (the worker refuses to boot then).
		const dollarsHere = deploymentSettingsOf(env, settingsFilePath(env, home), fileExists);
		let envListHere = null;
		try {
			envListHere = allowedModelsFrom(env);
		} catch {
			// A malformed list is its own line below; the worker refuses to boot on it.
		}
		const usdHere = usdFingerprint(dollarsHere, scopedLimitFacts.parseError === null ? scopedLimitFacts.limits : [], envListHere);
		checks.push(...(await fleetDollarChecks(usdHere, peers, { dollarKeysExist: () => (seams.dollarKeysExist ?? defaultDollarKeysExist)(valkeyTalkUrl) })));
		// Issue #499 part C: each host resolves its jobs' project from its OWN projects.json, while the project rows' counters
		// are shared. This host's `fpProjects` from the file the service names, against every peer's published one. SKIPPED
		// when this host's file does not load (PR #569's review): the BOOT_FILES line already fails on it, and comparing
		// "no projects" against healthy peers would send the operator to the wrong host.
		const projectFactsHere = readProjectFacts(env, fileExists);
		if (projectFactsHere.parseError === null) checks.push(...fleetProjectsChecks(projectsFingerprint(projectFactsHere.projects), peers));
		// Issue #504 part B: one applied split, judged on every host against its own envelope. A host whose envelope digest
		// differs refuses every governed job as `envelope-mismatch`. SKIPPED when this host's file does not load, for the
		// projects check's reason above.
		const envelopeHere = readEnvelopeFacts(env);
		if (envelopeHere.parseError === null && appliedSplit === null) checks.push(...fleetEnvelopeChecks(envelopeHere.envelope ? envelopeDigest(envelopeHere.envelope) : NO_ENVELOPE_FINGERPRINT, peers));
	} else if (fleet.unreachable) {
		// Said, rather than silently absent: "no peers" and "could not ask" are different facts.
		checks.push({ ok: true, label: `Fleet: could not read the host registry (${printable(fleet.unreachable)})` });
	}
	// Issue #504 part B: the APPLIED split names the envelope it was made for, and every host
	// whose envelope differs refuses its governed jobs. Read whenever this command may talk to the Valkey (above), from
	// the same Valkey the fleet was read from; with no split there, or no answer, nothing is said.
	if (appliedSplit !== null) {
		const envelopeHere = readEnvelopeFacts(env);
		if (envelopeHere.parseError === null) checks.push(...appliedSplitChecks(appliedSplit, envelopeHere.envelope ? envelopeDigest(envelopeHere.envelope) : NO_ENVELOPE_FINGERPRINT, workerNameOf(declaredWorkerName), peers));
	}

	// Which variable holds a provider's key is PI'S fact, asked of pi rather than copied (issue #286).
	// The copy this replaced had anthropic's two variables in the WRONG precedence order, invented
	// GOOGLE_API_KEY, and invented a `gemini` provider pi has never had -- three ways for doctor to bless
	// a deployment the worker then refuses, which is the one thing doctor must never do.
	// `checks[0]` is the Node floor, pushed first and deliberately so. The degraded arm needs it: below a
	// floor that already failed hard it warns, and on a green floor it fails, because those are different
	// deployments with different remedies.
	// Resolved ONCE and reused by the trigger-secret clash check further down: one seam call, one answer.
	const oracle = await providerOracle();
	// The key's presence only, from the file where this shell sets none of the provider's variables; never its value.
	const keyCandidates = typeof oracle?.providerKeyCandidates === "function" ? oracle.providerKeyCandidates(provider) : [];
	// Resolved by the same rule as every service key (issue #471), with the names pi gives, and one more condition kept from
	// #453: where this shell sets ANY of the provider's variables none is taken from the file, since pi reads the first
	// present one and a blend of the two sources is a precedence neither the service nor a by-hand worker would see. A
	// disagreement on one of them is said with the rest, never with its value.
	const keyRes = service.extra(serviceEnvKeys(keyCandidates, keyCandidates));
	const keyFromFile = keyCandidates.some((name) => (env[name] ?? "") !== "") ? {} : keyRes.fromFile;
	// And auth.json where the SERVICE's worker reads it: the agent dir the file names, where this shell names none.
	const keyAgentDir = fileSays("PI_CODING_AGENT_DIR").length > 0 ? agentDirFrom(env) : agentDir;
	// Issue #503: a provider pi does not know may be keyless, judged by the worker's own verdict on the declared endpoints
	// and the overlay models.json, read here as the service reads them. Read only for such a provider, and only when an
	// endpoint is declared, which is the worker's own rule (index.mjs reads the overlay only then).
	const unknownToPi = keyCandidates.length === 0 && typeof oracle?.piProviders === "function" && !oracle.piProviders().includes(provider);
	// Through doctor's own seams (the boot-file loader's io), and with the queue port the worker refuses: an endpoint on
	// it refuses the worker's boot, so it must not read as keyless here.
	const keylessIo = { existsSync: (p) => fileExists(p), readFileSync: readEnvFile ? (p, enc) => asText(readEnvFile(p), enc) : readFileSync };
	const keylessValkey = env.VALKEY_URL ?? DEFAULT_VALKEY_URL;
	const keylessEndpoints = unknownToPi ? (seams.declaredEndpoints ?? ((a) => declaredEndpointsIn({ ...a, fs: keylessIo })))({ env, cwd: seams.cwd, platform: seams.platform ?? process.platform, valkeyUrl: keylessValkey }) : [];
	let keylessModels = null;
	let keylessUnreadable = null;
	// The worker's rule (config.mjs `resolveGlobalPiDir`, PR #553's review): only an absolute PI_GLOBAL_PI_DIR is an
	// overlay; a relative one refuses the worker's boot, and the overlay section below says so. Both reads take the
	// value as it is, so they read the same folder.
	if (keylessEndpoints.length > 0 && typeof env.PI_GLOBAL_PI_DIR === "string" && isAbsolute(env.PI_GLOBAL_PI_DIR)) {
		try {
			keylessModels = readOverlayModels(env.PI_GLOBAL_PI_DIR, keylessIo);
		} catch (error) {
			// The reader's one rule (PR #520 round 2): an errno it rethrows is not a verdict on the provider, so doctor
			// names the code rather than calling the provider unknown (retried or refused by `isTransientOverlayRead`).
			// Invalid JSON is the overlay check's line below; here it only means nothing is keyless.
			if (typeof error?.code === "string") keylessUnreadable = error.code;
		}
	}
	// Issue #587's review: the rename hint is judged on the overlay itself, read whenever there is one, endpoint or not.
	let hintModels = keylessModels;
	let hintUnread = false;
	if (unknownToPi && hintModels === null && Object.hasOwn(RENAMED_PROVIDERS, provider) && typeof env.PI_GLOBAL_PI_DIR === "string" && isAbsolute(env.PI_GLOBAL_PI_DIR)) {
		try {
			hintModels = readOverlayModels(env.PI_GLOBAL_PI_DIR, keylessIo);
		} catch {
			hintUnread = true;
		}
	}
	const keyCheck = providerKeyCheck({ provider, env: { ...env, ...keyFromFile }, agentDir: keyAgentDir, oracle, nodeOk: checks[0]?.ok, keyless: { endpoints: keylessEndpoints, models: keylessModels, unreadable: keylessUnreadable, hintModels, hintUnread } });
	const keyNamed = Object.keys(keyFromFile).filter((name) => keyCheck.label?.includes(`: ${name})`));
	// Issue #481 (PR #485 review round 2): a key found nowhere doctor can look is one an env-setup script may export, which
	// is the documented home for a provider key fetched from a secrets manager (docs/secrets.md).
	const { absent: keyAbsent, ...keyShown } = keyCheck;
	const keyNames = keyAbsent ? `one of ${keyAbsent.join(" or ")}` : null;
	const keyLine = !keyAbsent
		? keyShown
		: setupSupplies(["worker"])
			? credentialAbsent({ subject: `Provider key (${provider}: ${keyAbsent.join(" or ")}) not set`, names: keyNames, readers: ["worker"], refusal: "jobs cannot authenticate to the provider", fix: keyShown.fix })
			: { ...keyShown, fix: `${keyShown.fix}${notSupplied(keyNames, ["worker"])}` };
	checks.push({ ...keyLine, label: `${keyLine.label}${fromFileNote([...fileSays("PI_PROVIDER"), ...keyNamed, ...(keyAgentDir !== agentDir ? ["PI_CODING_AGENT_DIR"] : [])])}` });


	// REQ-GLOBAL-PI-OVERLAY: read the extensions opt-out through the WORKER's own parser, so doctor reports
	// the exact posture the worker will boot with and refuses the exact values it refuses. Checked with or
	// without an overlay configured, because a malformed knob stops boot either way -- and a `false` an
	// operator wrote believing it disabled their extensions is precisely the value they need told about.
	let extensionsEnabled = true;
	let extensionsInvalid = false;
	try {
		extensionsEnabled = globalExtensionsEnabled(env);
	} catch {
		extensionsInvalid = true;
		checks.push({
			ok: false,
			label: `PI_GLOBAL_ALLOW_EXTENSIONS is ${JSON.stringify(env.PI_GLOBAL_ALLOW_EXTENSIONS)}, which is neither on nor off`,
			fix: 'set it to exactly "0" to disable the overlay\'s extensions, or leave it unset to load them -- the worker refuses to boot on any other value',
		});
	}

	// Global pi overlay (REQ-GLOBAL-PI-OVERLAY), only when configured. The overlay is mounted :ro into an
	// adversarial-input container, so the load-bearing checks are that it holds NO credential.
	const overlay = env.PI_GLOBAL_PI_DIR;
	if (overlay && !isAbsolute(overlay)) {
		// PR #553's review: the worker refuses to boot on it (config.mjs `resolveGlobalPiDir`), since a relative value is
		// resolved differently by the worker and the container runtime.
		checks.push({
			ok: false,
			label: `PI_GLOBAL_PI_DIR is ${JSON.stringify(overlay)}, which is not an absolute path, so the worker refuses to boot${fromFileNote(fileSays("PI_GLOBAL_PI_DIR"))}`,
			fix: "set PI_GLOBAL_PI_DIR to the overlay folder's absolute path; a relative value is resolved differently by the worker and the container runtime",
		});
	} else if (overlay) {
		const dirOk = fileExists(overlay);
		checks.push({ ok: dirOk, label: `Global overlay dir exists (${envValueShown(overlay)})${fromFileNote(fileSays("PI_GLOBAL_PI_DIR"))}`, fix: "run `pi-dispatch import-pi`, or fix PI_GLOBAL_PI_DIR" });
		if (dirOk) {
			const overlayAuth = join(overlay, "auth.json");
			checks.push({
				ok: !fileExists(overlayAuth),
				label: "Overlay is credential-free (no auth.json)",
				fix: "delete auth.json from the overlay — the provider key belongs in env, never a mounted file",
				// Prompt, not silent, even though deleting it is always right for the OVERLAY: the file may
				// be the operator's only copy of a credential they meant to keep elsewhere, and doctor
				// deleting an operator's file unasked is a line not worth crossing for one saved keypress.
				fixAction: {
					tier: "prompt",
					describe: `rm ${overlayAuth}`,
					run: async ({ rm }) => {
						rm(overlayAuth);
						return { ok: true };
					},
				},
			});
			const modelsPath = join(overlay, "models.json");
			// Through the one reader (`readOverlayModels`, PR #520): an exists test answered false for a file under an
			// unreadable directory, so this line passed in silence on a file nobody had read. Absent is a pass (nothing to
			// leak); a transient errno (`isTransientOverlayRead`) is ⚠ naming the code, a read the worker retries once; any
			// other errno, EACCES among them, is ✗, since the job loads none of the file and the worker refuses every job
			// (issue #552); so is a models.json that is a link (PR #553's review) or a named pipe, socket or device, which
			// the reader judges from its `lstat` and never opens (issue #556); text that does not parse, or is not an
			// object, is ✗.
			let overlayModels = null;
			let modelsRead = null;
			try {
				overlayModels = readOverlayModels(overlay, { readFileSync: seams.readOverlayFile ?? ((p, enc) => readFileSync(p, enc)), ...(seams.lstatOverlayFile ? { lstatSync: seams.lstatOverlayFile } : {}) });
			} catch (error) {
				modelsRead = error;
			}
			if (modelsRead?.overlayLink === true) {
				// PR #553's review: the job's read-only mount does not resolve a link the way the host does.
				checks.push({
					ok: false,
					label: "Overlay models.json is a link, so every job is refused as model-unknown (overlay-link)",
					fix: `${OVERLAY_LINK_FIX}: ${modelsPath}; no job runs until then`,
				});
			} else if (modelsRead?.overlayNotAFile === true) {
				// Issue #556: judged by the reader's `lstat` and never opened, so doctor cannot hang on a FIFO with no writer.
				checks.push({
					ok: false,
					label: "Overlay models.json is not a regular file (a named pipe, socket or device), so every job is refused as model-unknown (overlay-not-a-file)",
					fix: `${OVERLAY_NOT_A_FILE_FIX}: ${modelsPath}; no job runs until then`,
				});
			} else if (modelsRead?.code === "EISDIR") {
				// Issue #539: pi fails to read a directory the same way, so it loads no models.json, and the worker refuses
				// every job (not retried: no retry turns a directory into a file).
				checks.push({
					ok: false,
					label: "Overlay models.json is a directory, so pi loads none of it and every job is refused as model-unknown (overlay-is-a-directory)",
					fix: `replace ${modelsPath} with a models.json file, or remove it; no job runs until then`,
				});
			} else if (isTransientOverlayRead(modelsRead?.code)) {
				checks.push({
					ok: false,
					warn: true,
					label: `Overlay models.json could not be read just now (${modelsRead.code}), so whether it is credential-free is not known; the worker retries each job once, then fails it`,
					fix: `check the disk or file handles behind ${modelsPath}, then re-run doctor`,
				});
			} else if (typeof modelsRead?.code === "string") {
				// Issue #552: the job reads the file through the read-only mount, and pi in the job loads none of it (the
				// existence check in image/runner/run-job.mjs, or pi's own read, fails), so a builtin provider the
				// file routes would go to its public endpoint. The worker refuses every job instead.
				const permission = modelsRead.code === "EACCES" || modelsRead.code === "EPERM";
				checks.push({
					ok: false,
					label: `Overlay models.json cannot be read by the worker (${modelsRead.code}), so a job loads none of it and every job is refused as model-unknown (overlay-unreadable)`,
					fix: permission ? `make ${modelsPath} and its folder readable by the account the worker runs as; every job is refused until then` : `check ${modelsPath} on the worker host (the read failed with ${modelsRead.code}); every job is refused until the worker can read it`,
				});
			} else {
				let modelsOk = true;
				let modelsFix = "";
				if (modelsRead !== null) {
					modelsOk = false;
					// Issue #539: pi then drops every entry, so a builtin model of a provider the file routes would run against
					// that provider's public endpoint. The worker refuses every job until the file is fixed, for either cause.
					const cause = /not valid JSON/.test(String(modelsRead?.message)) ? "is not valid JSON" : "does not match pi's models.json schema";
					modelsFix = `overlay models.json ${cause}, so pi loads none of it: every job is refused as model-unknown (overlay-unparseable) until the file is fixed, since pi would run even a builtin model against its provider's public endpoint instead of the route the file sets`;
				} else if (overlayModels !== null) {
					const leak = findLiteralSecret(overlayModels);
					if (leak) {
						modelsOk = false;
						modelsFix = `literal secret at ${leak} — move it to env/auth.json or a "$VAR" reference`;
					}
				}
				checks.push({ ok: modelsOk, label: "Overlay models.json is credential-free", fix: modelsFix });
				// Issue #539: an entry the file loads with but pi will not compose (the model gate's own rule,
				// `overlayProviderProblem`). pi drops that whole entry, so the worker refuses every job on the provider.
				const providers = overlayModels?.providers;
				for (const name of providers !== null && typeof providers === "object" && !Array.isArray(providers) ? Object.keys(providers) : []) {
					// Issue #587: an entry under an id pi renamed that lacks what a provider of its own needs (an api, a baseUrl
					// and models). It was an override of the builtin provider; under the new pi it is a custom provider with no
					// models, so it overrides nothing, and the builtin models it meant run with their own (empty) baseUrl.
					const entry = providers[name];
					if (Object.hasOwn(RENAMED_PROVIDERS, name) && entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry.api === undefined || entry.baseUrl === undefined || !Array.isArray(entry.models))) {
						const renamedTo = RENAMED_PROVIDERS[name];
						checks.push({
							ok: false,
							warn: true,
							label: `Overlay models.json entry ${JSON.stringify(name)} no longer overrides anything: pi 1.0.3 renamed that provider to ${JSON.stringify(renamedTo)}, so this entry is now a provider of its own, holding only what it declares itself, and the ${renamedTo} models do not get its settings`,
							fix: `rename the entry to ${JSON.stringify(renamedTo)} in ${modelsPath} (and every ${name}/ model reference in the triggers to ${renamedTo}/), then re-run doctor`,
						});
					}
					const problem = overlayProviderProblem(entry, name);
					if (problem === null) continue;
					checks.push({
						ok: false,
						label: `Overlay models.json entry ${JSON.stringify(name)} is one pi will not compose (${problem}), so pi drops all of it, its baseUrl and headers included`,
						fix: `every job that runs or lists a model of ${JSON.stringify(name)} is refused as model-unknown (overlay-provider-invalid): give each model an api and a baseUrl (its own or the provider's), a contextWindow and maxTokens above zero, and set a baseUrl beside oauth`,
					});
				}
			}
			// Issue #502's open question: pi's own loader against the worker's catalog, on the file as it is, whenever the reader
			// found one (a file the worker refuses is the first case worth comparing). `pi-model-loader.mjs` says why it is
			// the pi beside the worker rather than a container of the job image. Only a file that was READ: one the worker
			// refuses for its text (unparseable, or against pi's schema) is compared, while a link, an unreadable file or
			// anything else the reader refuses before reading (PR #553: overlay-link, overlay-unreadable; PR #557:
			// overlay-not-a-file) is not, since the job never loads it and the line above already says every job is refused.
			const refusedForText = modelsRead?.piDispatchConfig === true && typeof modelsRead.code !== "string" && modelsRead.overlayLink !== true && modelsRead.overlayNotAFile !== true && /^overlay models\.json (is not valid JSON|does not match)/.test(String(modelsRead.message));
			if (overlayModels !== null || refusedForText) {
				const catalog = await (seams.modelCatalog ?? defaultModelCatalog)();
				if (catalog) checks.push(...(await overlayLoaderParityChecks(modelsPath, { pi: await (seams.piModelLoader ?? defaultPiModelLoader)(), checkModelsKnown: catalog.checkModelsKnown })));
			}
			// Issue #503: a model whose baseUrl is localhost or a loopback literal can never be reached from a job, egress on
			// or off, because inside a job that address is the job's own container. Said whatever is declared: an overlay
			// pointed at localhost is the first thing an operator tries, and the fix is the declaration. Nothing when the file
			// is absent, does not parse, or is a file the job does not load (the line above names that): judged on the one
			// reader's result, so a models.json link is not read here around it.
			if (overlayModels !== null) {
				const loopback = overlayLoopbackModels(overlayModels);
				if (loopback.length > 0) {
					checks.push({
						ok: false,
						warn: true,
						label: `Overlay models.json points ${loopback.join(", ")} at a loopback address, which inside a job is the job's own container, so no job reaches that server`,
						fix: "serve the model on an address the egress proxy reaches, declare it in model-endpoints.json (host.docker.internal on Docker, host.containers.internal on Podman), and point the baseUrl there: docs/egress.md, \"Local model servers\"",
					});
				}
				// Issue #571: a model that costs money but asks for no usage in the stream. pi records each of its calls as
				// zeros, so the meter counts it `costUnreported` and every job on it settles at the floor (`≥` in the cost
				// views). Judged on the same reader's result: the overlay's own models, and the builtin models a provider-level
				// compat or a modelOverrides entry turns off, priced from the worker's catalog (none when it cannot load).
				const usageCatalog = await (seams.modelCatalog ?? defaultModelCatalog)();
				const unreported = unreportedUsageModels(overlayModels, { builtinModel: usageCatalog?.builtinModel, builtinChatModels: usageCatalog?.builtinChatModels });
				if (unreported.length > 0) {
					const SHOWN = 5;
					const named = unreported.slice(0, SHOWN).map((m) => `${quotedShown(m.provider)}/${quotedShown(m.modelId)}`).join(", ");
					const more = unreported.length > SHOWN ? ` and ${unreported.length - SHOWN} more` : "";
					checks.push({
						ok: false,
						warn: true,
						label: `Overlay models.json sets compat.supportsUsageInStreaming to false on ${named}${more} with a nonzero cost table, so those calls report no usage: each counts as costUnreported, and every job that calls one settles at the floor`,
						fix: "remove supportsUsageInStreaming: false if the server sends usage when asked (stream_options.include_usage), or set the model's cost to zeros if it is free: docs/costs.md, \"A call that reports no usage\"",
					});
				}
				// Issue #507: a priced model on a declared endpoint whose output cap would travel as max_completion_tokens,
				// which Ollama ignores. The runner's cost guard counts every such call unboundable, so a job under a dollar
				// cap is refused at its first call. The endpoints as the service reads them, through the keyless line's io.
				// A model a capped job may use is named by the cost-cap line below (`costCapFitChecks`), which runs on the
				// same catalog seam, so this line names only the rest: one line per model.
				const capEndpoints = (seams.declaredEndpoints ?? ((a) => declaredEndpointsIn({ ...a, fs: keylessIo })))({ env, cwd: seams.cwd, platform: seams.platform ?? process.platform, valkeyUrl: keylessValkey });
				const capped = usageCatalog ? cappedModelNames(env, { runs: parseError ? [] : modelRuns, deployment: deploymentSettingsOf(env, settingsFilePath(env, home), fileExists) }) : new Set();
				const uncapped = ignoredOutputCapModels({ models: overlayModels, endpoints: capEndpoints, builtinModel: usageCatalog?.builtinModel, builtinChatModels: usageCatalog?.builtinChatModels }).filter((m) => !capped.has(`${m.provider}/${m.modelId}`));
				if (uncapped.length > 0) {
					const SHOWN = 5;
					const named = uncapped.slice(0, SHOWN).map((m) => `${quotedShown(m.provider)}/${quotedShown(m.modelId)}`).join(", ");
					const more = uncapped.length > SHOWN ? ` and ${uncapped.length - SHOWN} more` : "";
					checks.push({
						ok: false,
						warn: true,
						label: `Overlay models.json sends the output cap of ${named}${more} as max_completion_tokens to a declared model endpoint, which a local server may ignore (Ollama does), so under a dollar cap every call to it is refused as unboundable`,
						fix: "set \"compat\": { \"maxTokensField\": \"max_tokens\" } on the model or its provider in models.json, or set its cost to zeros if it is free: docs/egress.md, \"Local model servers\"",
					});
				}
			}
			// Staged extensions load unless the operator opted out, so this pair reports what WILL run, not
			// what is switched on. The ⚠ sits on the loading case: it is the one where code the operator may
			// have staged months ago is executing against adversarial input right now. It stays a warning and
			// never a failure -- a vetted overlay that loads is the intended deployment, not a fault.
			// Suppressed when the knob is malformed: the ✗ above already says the worker will not boot, and a
			// second line guessing which way it would have resolved would be worse than silence.
			if (fileExists(join(overlay, "extensions")) && !extensionsInvalid) {
				if (extensionsEnabled) {
					checks.push({
						ok: false,
						warn: true,
						label: "Overlay extensions LOAD in every job (PI_GLOBAL_ALLOW_EXTENSIONS is not 0)",
						fix: "they run code against adversarial input with open egress — vet each; set PI_GLOBAL_ALLOW_EXTENSIONS=0 in .env to disable them",
					});
				} else {
					checks.push({ ok: true, label: "Overlay extensions present but disabled (PI_GLOBAL_ALLOW_EXTENSIONS=0)" });
				}
			}

			// Staged pi packages (REQ-GLOBAL-PI-OVERLAY): pinned third-party code the operator staged with
			// `import-pi --with-packages`, loaded by every job whose trigger did not set `run.packages: false`.
			// Keyed on the dir the same way the extensions pair above is, so a deployment that stages none
			// prints nothing here.
			const packagesDir = join(overlay, PACKAGES_SUBDIR);
			if (fileExists(packagesDir)) {
				// The restage offer shared by the two staleness checks below (prompt tier: it fetches and
				// runs npm on this host). A child process through the injected spawn rather than an
				// in-process call, so import-pi's own gates run unmodified -- the literal-secret abort, the
				// admin-extension block, the printed-names vetting -- and its output is forwarded so the
				// operator still reads the names of exactly what will load into their job containers.
				//
				// `--no-host-packages` is load-bearing (issue #102). Since discovery landed, a bare
				// `--with-packages` also stages whatever the operator installed in pi, and this is the ONE
				// path where staging happens without them typing the command. Accepting a repair prompt must
				// stay a repair: it restores what the overlay already had, it never performs a first-time
				// import of the operator's laptop into every job container. Importing is always something
				// they asked for.
				const restageFixAction = {
					tier: "prompt",
					describe: `pi-dispatch import-pi --with-packages --no-host-packages --to ${overlay}`,
					run: async ({ spawn, out }) => {
						const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
						// npm staging can be slow, so 10 minutes rather than runCmdCapture's default 30s.
						const res = await runCmdCapture(spawn, process.execPath, [cli, "import-pi", "--with-packages", "--no-host-packages", "--to", overlay], { env: spawnEnv, cwd, timeoutMs: 600000 });
						if (res.output) out(res.output);
						return { ok: res.code === 0 };
					},
				};
				const manifest = readStageManifest({ globalPiDir: overlay, readFile: (p) => readFileSync(p, "utf8"), fileExists });
				if (!manifest) {
					checks.push({
						ok: false,
						label: `Staged packages manifest readable (${PACKAGES_SUBDIR}/packages.json)`,
						fix: "re-run `pi-dispatch import-pi --with-packages` -- without the manifest nothing knows what is staged, so no package is ever loaded",
						fixAction: restageFixAction,
					});
				} else {
					// A manifest entry whose dir is gone loads nothing, and pi reports no error for a package
					// it was never told about -- the stage is only as real as the dirs behind the names.
					const missing = manifest.packages.filter((p) => !fileExists(join(packagesDir, p.dir))).map((p) => p.name);
					checks.push({
						ok: missing.length === 0,
						label: `Staged packages present (${manifest.packages.map((p) => `${p.name}@${p.version}`).join(", ")})`,
						fix: `staged dir missing for ${missing.join(", ")} -- re-run \`pi-dispatch import-pi --with-packages\` to restage`,
						fixAction: restageFixAction,
					});
					// The admin extension's twin, and blocked for the same reason import-pi blocks that one.
					const admin = manifest.packages.filter((p) => ADMIN_RE.test(p.name) || ADMIN_RE.test(p.dir)).map((p) => p.name);
					if (admin.length > 0) {
						checks.push({
							ok: false,
							label: `Staged package looks like the dispatch admin (${admin.join(", ")})`,
							fix: "remove it from the overlay -- a package that can enqueue paid jobs from INSIDE a job container is a recursion vector",
						});
					}
					// There is no dormant state left to report: a staged, manifested package loads into every
					// job whose trigger did not opt out -- INCLUDING jobs no trigger file describes at all
					// (a matched webhook, `dispatch_run`, the CLI). So "staged" IS "loading", and the honest
					// line says so and names how much of the trigger file withholds it. Warn, never fail: this
					// is the intended posture, and it is stated so a forgotten stage cannot read as inert.
					// Sits inside the manifest branch because an unreadable manifest loads NOTHING -- the ✗
					// above is that case, and claiming these load there would be the opposite of the truth.
					checks.push({
						ok: false,
						warn: true,
						label: `Staged packages LOAD in every job (${optingOut} trigger(s) opt out with run.packages: false)`,
						fix: "they run third-party code against adversarial input with open egress -- vet each, keep every version exactly pinned, and set run.packages: false on any trigger that must not load them",
					});

					// A staged package whose --ignore-scripts build never ran (issue #102, comment 1). The
					// stager warns once, at stage time, and then nothing mentions it again -- so the symptom
					// is every job on that trigger failing INSIDE the container, after taking a daily-cap
					// slot. Warn rather than fail: a package may declare a build script and still work.
					const unbuilt = manifest.packages
						.map((p) => ({ name: p.name, scripts: buildScriptsOf(join(packagesDir, p.dir), fileExists) }))
						.filter((p) => p.scripts.length > 0);
					if (unbuilt.length > 0) {
						checks.push({
							ok: false,
							warn: true,
							label: `Staged package declares a build step that did NOT run (${unbuilt.map((p) => `${p.name}: ${p.scripts.join(", ")}`).join("; ")})`,
							fix: "staging is always --ignore-scripts, so such a package is staged INCOMPLETE and may fail at run time -- check it works in a job, or stage a prebuilt version",
						});
					}
				}
			} else if (requiring > 0) {
				// The silently-package-less job, and the one check the flip does NOT touch: `run.packages:
				// true` is no longer an arming switch, but it is still an operator asserting "this flow needs
				// the staged packages". Nothing staged means PI_PACKAGES is never emitted and the flow runs
				// WITHOUT the tools it was written for -- on a clean exit 0.
				checks.push({
					ok: false,
					label: `${requiring} trigger(s) require staged packages (run.packages: true) but nothing is staged in ${packagesDir}`,
					fix: "declare them in pi-packages.json and run `pi-dispatch import-pi --with-packages`, or drop run.packages from the trigger -- otherwise the flow runs without its tools and still exits 0",
				});
			}

			// Compare the operator's OWN pi setup against what is staged (issue #102). Until this landed,
			// doctor reported a healthy overlay while N host packages would never load in a job, and it had
			// every fact it needed to say so. All three are WARNINGS: a deployment may deliberately run a
			// narrower set than the operator's laptop, and that is a choice, not a fault.
			//
			// NONE of them carries a fixAction, and that is doctrine rather than omission. Now that
			// `--with-packages` discovers, an offered "restage for me" would stop meaning "restore what you
			// declared" and start meaning "import whatever is on your laptop into every job container". That
			// is a different consent class and it does not belong behind a y/N prompt.
			const staged = readStageManifest({ globalPiDir: overlay, readFile: (p) => readFileSync(p, "utf8"), fileExists });
			const stagedByName = new Map((staged?.packages ?? []).map((p) => [p.name, p]));
			const hostPi = await readHostPiFn({
				agentDir,
				fs: { existsSync: fileExists, readFileSync, readdirSync, statSync },
				// doctor's seam is `spawn`, host-pi's is an execFile-shaped call, so this adapts one to the
				// other rather than giving doctor a second process seam to inject in tests.
				exec: async (file, args) => {
					const res = await runCmdCapture(spawn, file, args, { env: spawnEnv, cwd, timeoutMs: 15000 });
					if (res.code !== 0) throw new Error(`${file} exited ${res.code ?? "without a code"}`);
					return { stdout: res.output };
				},
				withPackages: true,
			});

			const unstaged = hostPi.packages.filter((p) => !p.skip && !stagedByName.has(p.name));
			if (unstaged.length > 0) {
				// The label names the path it enumerated. An operator whose package lives somewhere this did
				// not look needs to know WHERE it looked, or "auto-import is broken" is the only conclusion
				// available to them.
				checks.push({
					ok: false,
					warn: true,
					label: `${unstaged.length} package(s) in your pi setup are NOT staged (${unstaged.map((p) => `${p.name}@${p.version}`).join(", ")})`,
					fix: `re-run \`pi-dispatch import-pi --with-packages --to ${overlay}\` to stage them, or leave them out if this deployment runs a narrower set than your host`,
				});
			}

			// Version drift. Today nothing notices, and the symptom is a flow behaving differently in a job
			// than it does interactively, which is the hardest kind of difference to chase.
			const drifted = hostPi.packages.filter((p) => !p.skip && stagedByName.has(p.name) && stagedByName.get(p.name).version !== p.version);
			if (drifted.length > 0) {
				checks.push({
					ok: false,
					warn: true,
					label: `${drifted.length} staged package(s) differ from your pi setup (${drifted.map((p) => `${p.name}: overlay ${stagedByName.get(p.name).version}, host ${p.version}`).join("; ")})`,
					fix: "re-run `pi-dispatch import-pi --with-packages` to move the overlay to your host's versions, or pin the version you want in pi-packages.json (an explicit pin wins over discovery)",
				});
			}

			// Named rather than silent: a git-sourced host package cannot be expressed in pi-packages.json at
			// all (it validates an npm name plus an exact semver, and a ref is neither), so its absence would
			// otherwise be a mystery rather than a limitation.
			const gitSourced = hostPi.packages.filter((p) => p.kind === "git");
			if (gitSourced.length > 0) {
				checks.push({
					ok: false,
					warn: true,
					label: `${gitSourced.length} package(s) in your pi setup are git-sourced and cannot be staged (${gitSourced.map((p) => p.name).join(", ")})`,
					fix: "pi-packages.json pins an npm name plus an exact version, and a git ref is neither -- publish the package to a registry, or accept that jobs run without it",
				});
			}
		}
	} else if (requiring > 0) {
		// Same silent failure one level up: the staged set lives INSIDE the overlay, so no overlay means the
		// packages are not mounted at all, however carefully they were staged.
		checks.push({
			ok: false,
			label: `${requiring} trigger(s) require staged packages (run.packages: true) but PI_GLOBAL_PI_DIR is unset`,
			fix: "set PI_GLOBAL_PI_DIR -- staged packages live inside the overlay and are mounted with it, so with no overlay there is nothing to load",
		});
	}

	// Issue #230, `run.waitFor`. The PARSE is asked unconditionally, and the rest only when something waits.
	// That split is not the usual "only report what this deployment uses": `loadConfig` calls
	// `parseWaitProfiles` on every boot whether or not a trigger holds anything, so a garbled variable is a
	// worker that will not START, and gating that behind `waiting > 0` would have hidden it from precisely
	// the operator this check exists for. The ordinary sequence produces that state: declare the variable,
	// restart, then write the trigger -- doctor is run in the middle, and would have said nothing at all.
	const { profiles: declaredWaits, error: waitParseFailure } = parseWaitProfilesSafe(env.PI_WAIT_PROFILES);
	if (waitParseFailure) {
		checks.push({ ok: false, label: "PI_WAIT_PROFILES does not parse", fix: `${waitParseFailure} -- the worker refuses to BOOT until this is fixed, rather than dropping the entry and leaving you a check you believe is wired` });
	}
	// Everything below is about triggers, so it is asked only when a trigger holds something: a deployment
	// that waits on nothing must not carry a line about a feature it does not use, which is the always-on
	// advisory this file avoids everywhere else.
	if (waiting > 0 && !waitParseFailure) {
		// A HARD FAIL, `secretProfiles`' twin and for its reason: these jobs refuse pre-spend until the
		// profile is declared, deliberately, rather than starting without ever asking the question.
		const missing = waitProfiles.filter((name) => !(name in declaredWaits));
		checks.push({
			ok: missing.length === 0,
			label: missing.length === 0 ? `${waiting} trigger(s) hold their jobs, and every wait profile they name is declared` : `${waiting} trigger(s) hold their jobs, but ${missing.length} named wait profile(s) are not declared: ${missing.join(", ")}`,
			fix: `declare them in PI_WAIT_PROFILES as name:/absolute/path pairs (a check is one line, and its exit code is the answer: 0 go, 3 not yet, 2 never, 1 could not tell) -- these jobs refuse pre-spend until you do`,
		});
		// Each declared check is stat'd, exactly as a resolver is: absent, a directory, or not executable is a
		// check that can never answer. NAMED profiles fail; declared-but-unnamed ones only warn, because no
		// job looks them up -- a retired entry left in `.env` is untidy, not a deployment that refuses
		// deliveries, and failing the whole command on it is the same over-reporting the `waiting > 0` gate
		// exists to prevent. The probe is `wait-check.mjs`'s own, symlinks and all, so doctor and the gate
		// cannot disagree about what will run. Issue #462: the unnamed one is a WARNING (`ok: false, warn: true`), not a
		// pass, because its path is broken and fixing or dropping the entry clears it; an `ok: true` never printed that fix.
		const named = new Set(waitProfiles);
		for (const name of Object.keys(declaredWaits).sort()) {
			const path = declaredWaits[name];
			const st = statPath(path);
			const used = named.has(name);
			checks.push({
				ok: st.ok,
				...(st.ok ? { label: `Wait profile ${name} -> ${path}${used ? "" : " (declared, named by no trigger)"}` } : {}),
				...(st.ok
					? {}
					: used
						? { label: `Wait profile ${name} -> ${path} ${st.why}`, fix: "every job naming this profile refuses pre-spend as wait-profile-unknown until the path resolves to an executable file" }
						: { warn: true, label: `Wait profile ${name} -> ${path} ${st.why}, and no trigger names it`, fix: "no job looks this up, so nothing refuses today -- fix the path or drop the entry before a trigger starts naming it" }),
			});
		}
		// An `after` further out than the ceiling refuses EVERY delivery at first pickup, and doctor holds
		// both halves of that arithmetic, so it is the same class of finding as an undeclared profile: a
		// trigger that cannot deliver, knowable before anything is enqueued. Measured from now, exactly as
		// the gate measures it.
		const afterMax = Number(env.PI_WAIT_AFTER_MAX_MS ?? "") > 0 ? Number(env.PI_WAIT_AFTER_MAX_MS) : WAIT_AFTER_MAX_DEFAULT_MS;
		const beyond = waitAfters.filter((iso) => {
			const ms = afterInstantMs(iso);
			return ms !== null && ms - Date.now() > afterMax;
		});
		if (beyond.length > 0) {
			checks.push({
				ok: false,
				label: `${beyond.length} wait condition(s) name an instant beyond PI_WAIT_AFTER_MAX_MS: ${beyond.join(", ")}`,
				fix: "every delivery refuses pre-spend as wait-after-beyond-max at first pickup -- bring the instant inside the ceiling or raise PI_WAIT_AFTER_MAX_MS",
			});
		}
		// The version-floor disclosure. Stated ONCE, as a fact rather than a warning, because it is not a
		// defect: it is the one thing about this feature an operator cannot check from here. `doctor` runs
		// on the worker host and cannot see the receiver's installed version, so an unconditional warning
		// would be the always-on amber the panel's own design rejects -- and the worker's own skew check
		// already refuses a job that arrives without conditions it should have had.
		checks.push({
			ok: true,
			label: `run.waitFor needs worker >= 1.6.0, receiver >= 1.4.0 and admin >= 1.6.0 (a service below the floor drops the field silently; the worker refuses such a job as wait-skew rather than running it unheld)`,
		});
	}

	// Issue #502, allowed-model lists. The deployment list is judged unconditionally, `PI_WAIT_PROFILES`' rule: a
	// malformed or spaced value is a worker that will not boot. Its grammar is the worker's own (`allowedModelsFrom`).
	// The value doctor reads is the SERVICE's (`WORKER_SERVICE_KEYS`), so a spaced value in a `.env` a shell sources is
	// already named above as a line that loader reads differently, which is the case where the list silently vanishes.
	if (typeof env.PI_ALLOWED_MODELS === "string" && env.PI_ALLOWED_MODELS !== "") {
		let list = null;
		let why = null;
		try {
			list = allowedModelsFrom(env);
		} catch (err) {
			why = err?.message ?? "invalid";
		}
		checks.push(
			why === null
				? { ok: true, label: `PI_ALLOWED_MODELS limits every job whose trigger names no run.models to ${list.length} model(s): ${list.join(", ")}` }
				: { ok: false, label: "PI_ALLOWED_MODELS is not a valid list", fix: `${why} -- the worker refuses to boot until this is fixed` },
		);
	}
	if (listing > 0) {
		// The version-floor disclosure, the run.waitFor line's twin and for its reason: doctor cannot see the
		// receiver's version from here, and the worker's own skew check refuses a job that arrives without its list.
		checks.push({
			ok: true,
			label: `${listing} trigger(s) name run.models, which needs a worker and a receiver that carry issue #502 (a service below that drops the list silently; the worker refuses such a job as trigger-skew rather than running it unrestricted, and only when it can read the triggers file itself)`,
		});
	}
	if (costCaps.length > 0) {
		// Issue #540: the run.models line's twin for run.maxCostUsd (#501), for its reason. A service below the floor
		// tolerated the key as unknown and dropped it, so the job would run under the deployment's cap, or none.
		checks.push({
			ok: true,
			label: `${costCaps.length} trigger(s) set run.maxCostUsd, which needs a worker and a receiver that carry issue #501 (a service below that drops the cap silently; the worker refuses such a job as trigger-skew rather than running it under the deployment's cap or none, and only when it can read the triggers file itself)`,
		});
	}

	// Issues #501 and #502 (the round's doctor half): three lines about the models a job may use, asked of the worker's
	// own catalog (model-catalog.mjs, imported lazily: it loads pi-ai, which this module never does at load) with the
	// overlay models.json the worker reads and the deployment's settings resolved as a job resolves them. Nothing when
	// pi-ai does not load: the provider key line below already fails on that. A triggers file that did not load
	// contributes no trigger (its own line says so), and the deployment's default is still judged for its cap.
	{
		const catalog = await (seams.modelCatalog ?? defaultModelCatalog)();
		if (catalog) {
			const overlayDir = typeof env.PI_GLOBAL_PI_DIR === "string" && env.PI_GLOBAL_PI_DIR !== "" ? resolve(cwd, env.PI_GLOBAL_PI_DIR) : null;
			const readOverlayDoc = () => (overlayDir === null ? null : readOverlayModels(overlayDir, { readFileSync: seams.readOverlayFile ?? ((p, enc) => readFileSync(p, enc)), ...(seams.lstatOverlayFile ? { lstatSync: seams.lstatOverlayFile } : {}) }));
			let overlayDoc = null;
			try {
				overlayDoc = readOverlayDoc();
			} catch {
				// Unreadable or refused: the overlay lines say which. The checks below then judge builtin models only.
			}
			let envList = null;
			try {
				envList = allowedModelsFrom(env);
			} catch {
				// A malformed PI_ALLOWED_MODELS is its own line above (the worker refuses to boot on it).
			}
			const subjects = modelSubjects({ runs: parseError ? [] : modelRuns, deployment: deploymentSettingsOf(env, settingsFilePath(env, home), fileExists), envList });
			checks.push(...unknownModelChecks(subjects, catalog.checkModelsKnown, readOverlayDoc));
			checks.push(...costCapFitChecks(subjects, (ref) => boundModelOf(ref, { builtinModel: catalog.builtinModel, overlay: overlayDoc }), { unboundable: (ref) => outputUnboundable(outputCapView({ models: overlayDoc, provider: ref.provider, modelId: ref.id, builtinModel: catalog.builtinModel, builtinChatModels: catalog.builtinChatModels })) }));
			checks.push(
				...listedProviderCredentialChecks(subjects, {
					candidatesOf: (name) => (typeof oracle?.providerKeyCandidates === "function" ? oracle.providerKeyCandidates(name) : []),
					forwarded: (env.PI_FORWARD_ENV ?? "").split(",").map((name) => name.trim()).filter((name) => name !== ""),
					env,
					overlay: overlayDoc,
				}),
			);
		}
	}

	// REQ-TRIGGER-SECRETS. Only reported when a trigger actually binds one, on the run.resume block's
	// reasoning below: a deployment that uses no secrets should not be told about a variable it has no
	// reason to set.
	if (secreting > 0) {
		const { profiles: declared, error: parseFailure } = parseSecretProfilesSafe(env.PI_SECRET_PROFILES);
		const names = Object.keys(declared).sort();
		if (parseFailure) {
			checks.push({ ok: false, label: "PI_SECRET_PROFILES does not parse", fix: `${parseFailure} -- the worker refuses to boot until this is fixed, rather than dropping the entry and leaving you a profile you believe is wired` });
		} else {
			// A HARD FAIL, not a warning, and worded like the run.resume/PI_SESSIONS_DIR check below for the
			// same reason: these jobs refuse pre-spend until it is set, deliberately, rather than running
			// without their secrets and looking like they worked.
			const missing = secretProfiles.filter((name) => !(name in declared));
			checks.push({
				ok: missing.length === 0,
				label: missing.length === 0 ? `${secreting} trigger(s) bind secrets, and every profile they name is declared` : `${secreting} trigger(s) bind secrets, but ${missing.length} named profile(s) are not declared: ${missing.join(", ")}`,
				fix: `declare them in PI_SECRET_PROFILES as name:/absolute/path pairs (a resolver is one line, e.g. \`exec op read --no-newline "$1"\`) -- these jobs refuse pre-spend until you do`,
			});
			// The declared table, so an operator sees what is wired without reading .env. NAMES and paths only:
			// this is doctor's own stdout on the operator's host, not a public issue comment.
			if (names.length > 0) {
				checks.push({ ok: true, label: `Secret resolver profiles declared: ${names.map((n) => `${n} -> ${declared[n]}`).join(", ")}` });
			}
			// The panel-authoring bound. Unset is the SAFE default rather than a defect, so this is a fact line
			// when closed and a disclosure when open. Issue #462: the disclosure is a FACT LINE too, since the operator opened
			// it on purpose and nothing but closing it again clears it, so its advice lives in the label (an `ok: true` check
			// never prints a fix line).
			const roots = (env.PI_SECRET_RESOLVER_ROOTS ?? "").split(delimiter).map((r) => r.trim()).filter(Boolean);
			checks.push({
				ok: true,
				...(roots.length === 0
					? { label: "PI_SECRET_RESOLVER_ROOTS is unset, so only PI_SECRET_PROFILES declares resolvers (the panel can declare none)" }
					: { label: `PI_SECRET_RESOLVER_ROOTS admits panel-declared resolvers under: ${roots.join(", ")} -- keep those directories writable by nobody but the account the worker runs as: whoever can write a resolver there can run code as the worker` }),
			});
		}
		// The local-workspace disclosure. Not a failure: a nightly deploy binding a secret is exactly what
		// this feature is for. But a local job's /workspace IS the folder, read-write and un-cloned, so an
		// agent that persists a credential to make its next command simpler writes it into a real repository.
		// Issue #309: a trigger binding a variable pi reads for this deployment's provider. The worker refuses
		// that pre-spend, and this is the same question asked at setup, which is `REQ-DEPLOYMENT-BOOTSTRAP`'s
		// own rule applied one field over: the operator should not learn it from a public refusal on a live
		// delivery. Answerable here only BECAUSE the gate stopped depending on host state -- the presence
		// filtered version's answer would have changed with the machine doctor happened to run on.
		//
		// The provider is read the same way the provider-key check reads it, and the candidate list comes from
		// the same oracle the gate uses, through the same dynamic import: one derivation, or this becomes the
		// hand-copied table issue #286 was about.
		// Guarded on the FUNCTION, the way providerKeyCheck guards, not on an `ok` flag: the oracle returns
		// `{ piProviders, providerKeyCandidates }` or `{ loadError }` and never an `ok`, so a truthiness test on
		// one would be permanently false and this check would silently never run. It is skipped rather than
		// failed when pi did not load, because providerKeyCheck above has already reported that as its own ✗
		// and one root cause should print one line.
		if (secretNames.length > 0 && oracle?.providerKeyCandidates) {
			const candidates = oracle.providerKeyCandidates(provider);
			const clashing = secretNames.filter((n) => candidates.includes(n));
			checks.push({
				ok: clashing.length === 0,
				label:
					clashing.length === 0
						? `No trigger binds a variable pi reads for ${provider}`
						: `${clashing.length} trigger secret(s) bind a variable pi reads for ${provider}: ${clashing.join(", ")}`,
				fix: "rename them in the triggers file: the worker writes this deployment's own credential into those variables, so every job of those triggers refuses pre-spend as secret-name-reserved",
			});
		}
		// Issue #462: a FACT LINE, not a warning. It is the feature working as chosen and nothing clears it but unbinding the
		// secrets, so what the operator must know lives in the label: an `ok: true` check never prints a fix line.
		if (localSecretFolders.length > 0) {
			checks.push({
				ok: true,
				label: `${localSecretFolders.length} local trigger(s) bind secrets and run IN the operator's own folder: ${localSecretFolders.join(", ")} -- a credential the agent writes to .env, .netrc or .git-credentials there lands in your real repository (and in a retained sandbox). Nothing scans for that: keep those folders out of anything you push`,
			});
		}
	}

	// REQ-RESUMABLE-SESSION. Only reported when a trigger actually asked for it: a deployment that does
	// not use resume should not be told about a directory it has no reason to create.
	if (resuming > 0) {
		const sessionsDir = env.PI_SESSIONS_DIR;
		if (!sessionsDir) {
			checks.push({
				ok: false,
				label: `${resuming} trigger(s) set run.resume but PI_SESSIONS_DIR is unset`,
				fix: "set PI_SESSIONS_DIR to a private directory (mode 0700, OUTSIDE any git repo) -- these jobs refuse pre-spend until you do, deliberately, rather than running unpersisted and looking like they worked",
			});
		} else {
			const exists = fileExists(sessionsDir);
			// Issue #471: a store the deployment's `.env` names rather than this shell (resolved above).
			const sessionsFromFile = fileSays("PI_SESSIONS_DIR").length > 0;
			checks.push({
				ok: exists,
				// Escaped (issue #471): a path out of the environment is constrained by nothing, and its ESC reached the terminal
				// here, where every other path doctor prints goes through `envValueShown`.
				label: `Session store ${exists ? "exists" : "does not exist"} (${envValueShown(sessionsDir)})${fromFileNote(fileSays("PI_SESSIONS_DIR"))}`,
				fix: `create it: mkdir -p ${envValueShown(sessionsDir)} && chmod 700 ${envValueShown(sessionsDir)}`,
				// Silent tier: setting PI_SESSIONS_DIR WAS the decision, and it has already been made -- the
				// mkdir is the mechanical remainder, creates only the path the env var names, and 0700 is
				// the mode the fix line already prescribes (transcripts are PII-bearing, host-only).
				// PROMPT tier for a path doctor read from `.env` (issue #471): a value from a file doctor did not start in is
				// never followed silently, so the directory it would create is shown and asked for, default No.
				fixAction: {
					tier: sessionsFromFile ? "prompt" : "silent",
					describe: `mkdir -p ${envValueShown(sessionsDir)} && chmod 700 ${envValueShown(sessionsDir)}`,
					run: async ({ mkdir, chmod }) => {
						mkdir(sessionsDir, { recursive: true });
						chmod(sessionsDir, 0o700);
						return { ok: true, note: "mode 0700" };
					},
				},
			});
			// Not a failure: a disclosure the operator accepted by setting run.resume. A transcript holds tool output, file
			// contents and the agent's own reasoning, which is strictly more than logs/<jobId>.log holds, and that one is
			// opt-in for this reason. Issue #462: a FACT LINE, not a warning, because nothing clears it but turning resume
			// off, so the advice lives in the label (an `ok: true` check never prints a fix line); the bounds it once
			// listed are the fact line right below.
			checks.push({
				ok: true,
				label: `${resuming} trigger(s) persist agent transcripts to ${envValueShown(sessionsDir)} -- PII-bearing, host-only, never committed: keep it outside every git repo, on a disk you would put issue text on (docs/sessions.md)`,
			});
			// Which of the four bounds are actually on, as a FACT LINE rather than a warning: how long a
			// lineage may run is an operator's call, not a defect, and doctor's warnings are for things that
			// need a decision. The line exists because these knobs are unset by default and silent when
			// unset, so the only way to tell a deliberate "no bound" from a forgotten one is to print it.
			const bounds = [
				["PI_SESSIONS_TTL_DAYS", env.PI_SESSIONS_TTL_DAYS, "14"],
				["PI_SESSION_MAX_AGE_DAYS", env.PI_SESSION_MAX_AGE_DAYS, "off"],
				["PI_SESSION_MAX_RESUME_CHAIN", env.PI_SESSION_MAX_RESUME_CHAIN, "off"],
				["PI_SESSION_MAX_CONTEXT_PCT", env.PI_SESSION_MAX_CONTEXT_PCT, "off"],
			];
			checks.push({
				ok: true,
				label: `Resume bounds: ${bounds.map(([name, value, fallback]) => `${name}=${value === undefined || value === "" ? fallback : envValueShown(value)}`).join(", ")}`,
			});
			// The one bound that can be set and still do nothing, and the operator cannot see it from here.
			// Its measurement is reported by the JOB IMAGE's runner (INT-RUNNER-EXIT-CODE-PROTOCOL), so an
			// image older than that field reports none, the gate passes on no measurement by design, and the
			// bound is inert with nothing anywhere saying so. There is deliberately no image capability to
			// check against -- capabilities are an inclusion list for what the host DEMANDS of an image, and
			// telemetry is not that -- so this line is the whole detection surface, which is exactly why
			// it exists rather than being left to a doc. Issue #462 (gate round 1): a FACT LINE, with the older-image caveat in
			// the label, because nothing doctor can see would ever clear a warning here: with no capability to check, a
			// current image that does report the reading would carry the ⚠ forever. As `ok: true` with the caveat in a fix
			// line (the shape before #462), `render` dropped the caveat entirely.
			if (env.PI_SESSION_MAX_CONTEXT_PCT) {
				checks.push({
					ok: true,
					label: `PI_SESSION_MAX_CONTEXT_PCT=${envValueShown(env.PI_SESSION_MAX_CONTEXT_PCT)} needs a job image whose runner reports context usage: an older image reports none, and a bound with no measurement passes, so there it does nothing. Each run's record (${env.PI_LOGS_DIR ? envValueShown(env.PI_LOGS_DIR) : "the logs directory"}/<jobId>.json) carries session.reason, which names the gate that refused`,
				});
			}
		}
	}

	// REQ-PER-TRIGGER-INSTRUCTION. A plain fact line, not a warning: standing text is an ordinary operator
	// choice. It is reported at all because it changes what EVERY job of that trigger is told, and unlike a
	// flow (which lives in the repo, reviewed by a merge) it lives only in triggers.json, so nothing else
	// would put it in front of the operator. The COUNT only -- the text itself is theirs and may be long.
	if (instructing > 0) {
		checks.push({
			ok: true,
			label: `${instructing} trigger(s) attach a standing instruction to every job's prompt`,
		});
	}

	// REQ-REPLICA-RUNS. A fact line, never a failure -- replicas are an opt-in an operator chose in a reviewed file,
	// and the harness is doing exactly what was asked (issue #462: so not a warning either, which no change clears).
	// What is worth saying is the arithmetic: each replica reserves its OWN budget slot before its own tokens
	// (CONST-BUDGET-BEFORE-TOKENS), so a delivery on a `replicas: 2` trigger consumes two, and the daily cap divides
	// accordingly. Only reported when a trigger actually asked for it.
	if (replicating > 0) {
		checks.push({
			ok: true,
			// Both facts live in the LABEL, because an `ok: true` check never prints a fix line (`render`) -- and the
			// concurrency half is the one an operator most often has wrong: replicas above PI_CONCURRENCY queue instead
			// of racing, which looks like the feature silently not working. PI_CONCURRENCY is not judged here, since the
			// panel's settings overlay can change it after doctor reads the env.
			label: `${replicating} trigger(s) set run.replicas -- one delivery reserves one budget slot PER replica, so the daily/weekly/monthly caps divide by it; PI_CONCURRENCY bounds how many actually race, so keep it at least the largest run.replicas`,
		});
	}

	// One-shot close triggers (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE). Advisory only -- doctor
	// never touches triggers -- and counted from the RAW file (readTriggerFacts says why). Two lines
	// with different lives: the armed line names the count and, when PI_TRIGGERS_FILE is unset, warns
	// that the disarm resolves ./triggers.json against the WORKER SERVICE's working directory -- a
	// service unit whose WorkingDirectory differs from the receiver's would disarm a file nobody
	// matches against, the split-file hazard no mechanism can detect. The spent line states the
	// deliberate degradation: a spent entry counts toward NO parsed fact above (forges, flows,
	// webhook-secret), mirroring what the receiver serves at its next boot.
	if (onceArmed > 0) {
		// Issue #462: a WARNING while PI_TRIGGERS_FILE is unset, since setting it clears the split-file hazard, and its fix
		// line prints only in the `ok: false, warn: true` shape; a plain fact line once it is set.
		checks.push({
			ok: env.PI_TRIGGERS_FILE !== undefined,
			warn: env.PI_TRIGGERS_FILE === undefined,
			label: `${onceArmed} one-shot trigger(s) armed (on.once) -- the worker disarms the entry in ${env.PI_TRIGGERS_FILE === undefined ? "./triggers.json resolved against the worker service's working directory" : "PI_TRIGGERS_FILE"} after the run record exists`,
			fix: "set PI_TRIGGERS_FILE to an absolute path in both services' environments, so worker and receiver name the same file from anywhere",
		});
	}
	if (onceSpent > 0) {
		checks.push({
			ok: true,
			warn: false,
			label: `${onceSpent} one-shot trigger(s) already spent (on.disarmed) -- spent entries match nothing and count toward no credential or flow check; delete on.disarmed to re-arm, or delete the entry once its history no longer matters`,
			fix: "",
		});
	}

	// REQ-SCOPED-PAUSE-WINDOWS, the panel-writes-what-the-worker-ignores trap (issue #99). Three defaults
	// that are individually defensible and together silent:
	//
	//   - `pi-dispatch init` SCAFFOLDS ./pause-windows.json and leaves PI_PAUSE_WINDOWS_FILE commented out;
	//   - the admin panel defaults to ./pause-windows.json in its OWN cwd, so `w` reads and WRITES that file
	//     and reports every window it adds as applied live;
	//   - the worker has NO cwd default (config.mjs: `?? null`, and null means the feature is off).
	//
	// So an operator adds quiet hours in the panel, is told it is live, and nothing ever pauses -- the one
	// failure mode where the UI actively asserts the opposite of the truth. The worker's fail-closed default
	// is deliberate and is NOT changed here: a worker must not start honouring a file nobody pointed it at,
	// least of all one that stops paid work. The mismatch is a deployment fact, so doctor is where it
	// belongs. Warn, never fail, like every other setup-shaped check: a deployment can legitimately be
	// mid-setup, and a scaffolded file the operator never intended to use is not a fault.
	//
	// Empty is NOT unset, and the citation this comment used to carry was the wrong line:
	// `if (config.pauseWindowsFile)` at `start.mjs` is the LIVE-RELOAD WATCHER, unreachable on this path
	// because `loadPauseWindows(config)` runs unconditionally before it and throws on an empty path. A blank
	// value is a refused boot; the branches below say so and no longer share the unset sentence (issue #365).
	//
	// NEVER TIER, deliberately no fixAction: doctor cannot know which path the operator meant. This cwd is
	// doctor's, not necessarily the worker's (a service manager sets its own), and writing an env line into
	// .env would be doctor guessing a semantic value -- the same refusal PI_GLOBAL_ALLOW_EXTENSIONS gets.
	// The fix line names the variable and the absolute path, and the operator decides.
	//
	// SUBSCRIPTIONS GET NO SUCH CHECK, checked rather than assumed: ./subscriptions.json is scaffolded by the
	// same init and PI_SUBSCRIPTIONS_FILE is commented out the same way, but the admin extension is its ONLY
	// reader and writer (nothing reads it at job time), and the admin's own default IS ./subscriptions.json
	// (admin/src/read-model.mjs) -- so with the variable unset the one component that cares already finds the
	// scaffolded file. There is no second reader to disagree with, hence no trap, hence no warn: a line that
	// fires where nothing is broken teaches operators to skim past the ones that matter.
	//
	// AND ONE NARROWING, added with `pi-dispatch up`'s four env lines (issue #357). Both checks above fire
	// on the PROCESS environment, which is the only thing the worker reads. But `up` writes these two keys
	// into `<cwd>/.env`, which configures the SERVICE through `EnvironmentFile=` and the wrappers and
	// configures nothing about a shell an operator later types `pi-dispatch doctor` into. Unqualified, the
	// warning then cries wolf at a correctly configured deployment, and this module's own rule is that a
	// check nobody can silence must never do that.
	//
	// So doctor reads `<cwd>/.env` for EXACTLY the key each check names, and never to configure anything.
	// That narrowing is the whole licence: the project's stance is that nothing parses `.env`
	// (`docs/secrets.md`), and `worker/test/service.test.mjs` pins that a `PI_ENV_SETUP` line in `./.env` is
	// deliberately NOT honoured. Both stay true.
	//
	// WHAT CHANGED SINCE, and this comment said otherwise for a round: the read no longer only softens a
	// sentence. Where the file leaves the SERVICE unable to start, doctor fails on it (issue #384), because
	// a deployment whose unit exits 1 in a restart loop is not a deployment that is merely unconfigured in
	// this shell. Where the file merely configures what this shell does not, the line still says which
	// process would honour it, and is still a warning.
	const envFile = envFileKeys(join(cwd, ".env"), BOOT_FILES.map((spec) => spec.key), { fileExists, readEnvFile, platform });
	// ONE RULE FOR BOTH BOOT FILES, and it asks the worker's own loader rather than a second opinion
	// (issue #384). Before this there were two hand-written copies of a shell-shaped check for
	// `PI_PAUSE_WINDOWS_FILE`, a THIRD rule for a scoped-limits file that does not parse, and no rule at all
	// for a pause-windows file that does not parse. The shapes they disagreed about were not exotic:
	//
	//   - A BLANK value warned where its sibling failed. Both refuse the boot; one was a warn, one a fail.
	//   - A blank value with no scaffolded file printed NOTHING and exited 0, on a deployment whose worker
	//     cannot start.
	//   - The blank branch's fix line still said "unset means the worker loads no windows at all", which is
	//     advice for a different deployment than the one being described.
	//
	// TWO SUBJECTS, judged separately, because a `.env` and a shell are read by different things. The SERVICE
	// reads the file: `deploy/worker.service` hands it to systemd, the wrappers source it, and the shell this
	// command runs in never reaches it. A FOREGROUND `pi-dispatch worker` reads this shell and not the file.
	// Judging only the shell is what let scenario G pass: a good path here, a blank line there, and a service
	// that cannot start.
	// The IO the load verdict uses, injected like everything else this file touches: `statFile` for the
	// regular-file guard and the loaders' own two reads. A test drives a whole deployment through these
	// without a real file, which is how the fixtures below stay honest about content.
	const seamsForLoad = { env, statFile: statSeam, loaderIo: { existsSync: (p) => fileExists(p), readFileSync: readEnvFile ? (p, enc) => asText(readEnvFile(p), enc) : readFileSync } };
	// ONCE PER FILE, not once per key (issue #396). This is a fact about the FILE -- one line the reader
	// cannot model -- and it was announced inside the per-key loop, so a `.env` with one such line produced
	// two near-identical warnings differing only in which key they named. The keys it prevents a verdict
	// about are listed IN the line instead, which is what the reader actually knows.
	//
	// ITS LIMIT, stated because the wording would otherwise imply more: this command reads two keys, so the
	// line says what it cannot answer about THOSE. The same hazard may also stop a sourcing shell reaching
	// `WEBHOOK_SECRET`, which the receiver refuses to start without, and nothing here says so -- widening
	// the read is how a narrow reader grows into "load the .env", which `envFileKeys`' own docblock and
	// `docs/secrets.md` both refuse.
	// Beside the readings, not in place of them: the line changes no other key (issue #470 follow-up).
	if (envFile.wrapperInternal != null) {
		checks.push({ ok: false, warn: true, label: `${join(cwd, ".env")}: ${wrapperInternalSentence(envFile.wrapperInternal).replace(/\. To fix it, .*$/, "")}`, fix: `${wrapperInternalSentence(envFile.wrapperInternal).replace(/^.*\. To fix it, /, "")}, then run doctor again` });
	}
	if (envFile.hazard != null) {
		const named = BOOT_FILES.map((spec) => spec.key).join(" or ");
		// A SHAPE comes from systemd's own line structure (issue #447): the line is one systemd reads differently from
		// this command, and the table names it and what to change -- the same words `service install` refuses with.
		const shape = envFile.hazard.shape ? SYSTEMD_HAZARD_SHAPES[envFile.hazard.shape] : null;
		const limit = `Other keys in the same file are affected too and are not checked here: this command reads only the ${countWord(BOOT_FILES.length)} it names`;
		// A file systemd will not LOAD is a service that does not start (measured on systemd 259), which is a failure
		// rather than a doubt about one reading (issue #447, gate round 1).
		const unloadable = envFile.hazard.shape === "nul" || envFile.hazard.shape === "invalid-utf8" || envFile.hazard.shape === "exec-too-large";
		checks.push({
			ok: false,
			warn: !unloadable,
			label: `whether ${named} reaches the service cannot be read off ${join(cwd, ".env")}: line ${envFile.hazard.line} ${shape ? `has ${shape.what}${envFile.hazard.detail ? ` (${envFile.hazard.detail})` : ""}` : "is not one this command can read"}`,
			fix: shape
				? `on line ${envFile.hazard.line} of that file, ${shape.fix}, then run doctor again. ${limit}`
				: `fix line ${envFile.hazard.line} of that file and run doctor again -- a line that is not an assignment is RUN by the wrappers that source this file, an unclosed quote or a trailing backslash makes the line below it part of that value, and a value that can run a command or end the shell leaves every key in the file unset. ${limit}`,
		});
	}

	for (const spec of BOOT_FILES) {
		const scaffolded = join(cwd, spec.scaffold);
		const shellRaw = spec.resolve(env);
		const fileRaw = envFile[spec.key];
		const notPlainLine = envFile.notPlain?.[spec.key];
		const insideAt = envFile.insideValue?.[spec.key];
		const blankInFile = envFile.blankInFile?.[spec.key] === true;
		const onlyExported = envFile.exported?.[spec.key];
		const alsoExported = envFile.alsoExported?.[spec.key];
		const loaderName = envFile.serviceLoader === "systemd" ? "systemd's EnvironmentFile=" : envFile.serviceLoader === "cmd" ? "the .cmd wrapper" : "the wrapper's `set -a; . ./.env`";
		// The OTHER POSIX loader, named for what it is rather than as "a shell that sources the file": on darwin
		// the service IS the sourcing shell, and the reading it disagrees with is systemd's.
		const otherName = envFile.serviceLoader === "shell" ? "systemd's EnvironmentFile=" : "a shell that sources the file";
		// A setup script runs AFTER the file on every platform (`service.mjs`, `worker-env-wrapper.sh`,
		// `.cmd`), so it can supply or replace what the file says. Where one is configured, a refusal this
		// check would otherwise report is a WARNING naming the script: doctor cannot run it, and failing a
		// working `--env-setup` deployment is the crying wolf this file refuses elsewhere.
		//
		// WHICH script, by the one strict rule the credential checks use (issue #481, PR #485's final review;
		// `setupSupplies`): the script the worker's installed service for this folder names, when every such unit names
		// one this account can read as a regular file. This used to read PI_ENV_SETUP from this shell alone, so a unit's
		// script went unseen and a script the service never runs softened a boot refusal; the shell's PI_ENV_SETUP now
		// softens nothing. A script that is missing or unreadable cannot replace anything, so downgrading on it would print
		// two contradicting lines in one run: one saying the unit restart-loops until the script is back, the next saying
		// a blank key is only a warning because that same script may replace it.
		const envSetup = setupSupplies(["worker"])?.[0]?.script ?? null;

		// A FILE THIS COMMAND CANNOT READ IS ANSWERED ONCE, and then nothing else is said about the key.
		// Three adversarial passes found what the alternative costs: with a verdict computed beside the
		// warning, doctor printed "line 1 reaches into the line below it" and "✓ and loads" about the same key
		// in the same run, hard-failed deployments that boot (a `KEY=` inside a heredoc body, which no shell
		// executes), and passed ones that cannot. A reader that will not model a shell cannot hold an opinion
		// about a file only a shell can resolve, and saying so beats guessing in either direction.
		// A FILE THIS COMMAND CANNOT READ IS ANSWERED ONCE for the SERVICE, and the two words matter. The
		// first version of this `continue`d, which jumped past the SHELL block below as well -- so one
		// unreadable line in a `.env` silently deleted doctor's verdict about a key this shell sets, on a
		// subject that never reads that file at all. That is the first row of this issue's own defect table,
		// reinstated behind a condition, and `REQ-DEPLOYMENT-BOOTSTRAP` is normative: a refusal on EITHER
		// subject fails the command.
		// THE SERVICE, judged on what the file gives its loader.
		if (envFile.hazard == null && blankInFile) {
			checks.push({
				ok: false,
				warn: envSetup !== null,
				label: `${spec.key} is assigned an EMPTY value in ${join(cwd, ".env")}, which is not unset: ${loaderName} keeps it, the worker tries to load "" and ${spec.fails}${alsoExported === undefined ? "" : `, while ${otherName} would take ${envValueShown(alsoExported)}, so two deployments of this one file disagree`}`,
				fix: envSetup !== null
					? `${envSetup} runs after that file and may replace it, which is why this is a warning: if it does not, delete the ${spec.key} line, or give it the absolute path (${scaffolded})`
					: `delete the ${spec.key} line from that .env, or give it a path: ${fixLineFor(spec.key, scaffolded)}. Deleting it ${spec.whenDeleted}; an empty value ${spec.whenEmpty}`,
			});
		} else if (envFile.hazard == null && notPlainLine !== undefined) {
			// NAMED, NEVER QUOTED. The value is outside the grammar every loader reads the same way, so this
			// file cannot say what the service gets -- and printing a guess is what the previous reader did.
			checks.push({
				ok: false,
				warn: true,
				label: insideAt === undefined
					? `${spec.key} on line ${notPlainLine} of ${join(cwd, ".env")} is not in the form every loader reads the same way, so the service may read something other than what the line appears to say`
					: `${spec.key} on line ${notPlainLine} of ${join(cwd, ".env")} lies inside the quoted value that opens on line ${insideAt}, so the service reads it as part of that value and not as ${spec.key}`,
				fix: insideAt === undefined
					? `rewrite it as ${fixLineFor(spec.key, scaffolded)} with any comment on its own line above it, which is the form \`pi-dispatch up\` writes`
					: `close the quote that opens on line ${insideAt} before line ${notPlainLine}, or write that value's newlines as \\n escapes`,
			});
		} else if (envFile.hazard == null && onlyExported !== undefined) {
			// The loader that reads an `export` line is a SOURCING SHELL, and naming it "this platform's loader"
			// was false on win32, where the cmd wrapper splits on the first `=` and makes `export KEY` a variable
			// name -- so neither loader on that platform reads the line the label said it read.
			checks.push({
				ok: false,
				warn: true,
				label: `${spec.key} is set in ${join(cwd, ".env")} as \`export ${spec.key}=${envValueShown(onlyExported)}\`, which only a shell that SOURCES this file reads${envFile.serviceLoader === "shell" ? "" : `, and ${loaderName} does not`}`,
				fix: `drop the \`export \` prefix if this deployment runs under systemd or the Windows wrapper (both want a bare KEY=value); keep it if the worker starts through a wrapper that sources the file`,
			});
		} else if (envFile.hazard == null && alsoExported !== undefined) {
			checks.push({
				ok: false,
				warn: true,
				label: `${spec.key} is assigned TWICE in ${join(cwd, ".env")} with different values: ${loaderName} takes ${envValueShown(fileRaw)}, ${otherName} would take ${alsoExported === "" ? `an EMPTY value, which ${spec.emptyCost}` : envValueShown(alsoExported)}`,
				fix: `keep one assignment. Which one is in force depends on how the worker starts, so two of them means two deployments of the same file disagree`,
			});
		}
		// WHETHER IT LOADS IS A SECOND QUESTION, asked whenever the service has a value at all. It used to sit
		// inside the `fileRaw` branch, so a file assigning the key twice got the disagreement warning and exit
		// 0 even when BOTH values name a file the worker cannot load -- a deployment that cannot boot, reported
		// as a tidiness problem.
		// WHENEVER THE SERVICE HAS A VALUE, and the two exclusions this used to carry were how a deployment
		// that cannot boot came back exit 0: a file with any hazard in it got the ⚠ about the hazard and its
		// boot key was never opened. `fileRaw` is set only for a line this reader vouches for the TEXT of, so
		// there is always a real path here; whether it loads is a fact about the filesystem, not about the
		// rest of the file.
		if (envFile.hazard == null && fileRaw !== undefined && !blankInFile) {
			const verdict = loadVerdict(spec, fileRaw, cwd, seamsForLoad, platform);
			checks.push(
				verdict.ok
					? { ok: true, label: `${spec.key} is set in ${join(cwd, ".env")} (${envValueShown(fileRaw)})${alsoExported === undefined ? "" : ", for this platform's loader,"} and loads: the service reads that file, this shell does not` }
					: {
							ok: false,
							warn: envSetup !== null,
							label: `${spec.key} is set in ${join(cwd, ".env")} (${envValueShown(fileRaw)}) to a file the worker cannot load, so a service started from it ${spec.fails}: ${verdict.reason}`,
							fix: envSetup !== null ? `${envSetup} runs after that file and may replace it; if it does not, fix ${envValueShown(fileRaw)} or point the key at a file that loads` : `fix ${envValueShown(fileRaw)}, or point ${spec.key} at a file that loads`,
						},
			);
		}

		// THE SHELL, judged on what a foreground `pi-dispatch worker` started from here would get.
		if (typeof shellRaw === "string" && shellRaw.trim() === "") {
			checks.push({
				ok: false,
				label: `${spec.key} is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and ${spec.fails}`,
				fix: `unset ${spec.key} in this shell (that ${spec.whenDeleted}), or give it the absolute path: export ${fixLineFor(spec.key, scaffolded)}`,
			});
		} else if (typeof shellRaw === "string") {
			const verdict = loadVerdict(spec, shellRaw, cwd, seamsForLoad, platform);
			if (!verdict.ok) {
				checks.push({
					ok: false,
					label: `${spec.key} is set in this shell to a file the worker cannot load, so it ${spec.fails}: ${verdict.reason}`,
					fix: `fix ${envValueShown(shellRaw)}, or point ${spec.key} at a file that loads`,
				});
			}
		} else if (spec.defaultsToScaffold) {
			// Issue #503: unset is the scaffold, so it is that file which is judged, when nothing in .env says otherwise and it
			// is there at all (a missing default file declares nothing, which is valid). Silent when it loads. Before the
			// unreadable-.env line, which asks whether the service is configured for a feature unset turns off: unset turns
			// nothing off here.
			// Asked of `statFile`, the seam the load itself uses, so "missing" is ENOENT from the same place and a missing
			// default stays silent however `fileExists` is seamed.
			if (fileRaw === undefined && onlyExported === undefined && alsoExported === undefined && notPlainLine === undefined && !blankInFile && envFile.hazard == null && presentAt(statSeam, scaffolded)) {
				const verdict = loadVerdict(spec, scaffolded, cwd, seamsForLoad, platform);
				if (!verdict.ok) {
					checks.push({
						ok: false,
						label: `${spec.key} is unset, so ${spec.unsetMeans}, and it does not load: the worker ${spec.fails}: ${verdict.reason}`,
						fix: `fix ${envValueShown(scaffolded)}, or empty its "endpoints" list`,
					});
				}
			}
		} else if (envFile.unreadable === true) {
			// COULD NOT READ, said as itself. The alternative -- the "unset" line below -- is a positive claim
			// about a key in a file nobody could open.
			checks.push({
				ok: false,
				warn: true,
				label: `${spec.key} is unset in this shell, and ${join(cwd, ".env")} could not be read, so whether the service is configured for ${spec.noun} cannot be answered here`,
				fix: `make ${join(cwd, ".env")} a readable regular file, or run doctor from the deployment folder`,
			});
		} else if (fileRaw === undefined && onlyExported === undefined && alsoExported === undefined && notPlainLine === undefined && !blankInFile && envFile.hazard == null && fileExists(scaffolded)) {
			// The scaffold decides only THIS line, and only this one: a file sitting there that nothing reads.
			// Guarded on there being no hazard, because "the key is unset" is a claim about a file this reader
			// could not finish: a line the shells RUN leaves no record for the key while the loaders may well
			// set it.
			checks.push({
				ok: false,
				warn: true,
				label: `${scaffolded} exists but ${spec.key} is unset -- the worker ignores it, so ${spec.off}`,
				fix: `set ${fixLineFor(spec.key, scaffolded)} in .env and restart the worker -- unset means ${spec.unsetMeans}${spec.panelWrites === false ? "" : `, while the admin panel defaults to this same file and reports each ${spec.unit} it writes as applied live`}; delete the file if this deployment has no ${spec.nothing}`,
			});
		}
	}

	// A scope that can only ever be a folder (issue #242's dead-scope rule): a forge repo always contains "/" and never
	// begins "/", "./" or "../" or carries a backslash. A forge-qualified row (issue #498) names a repo by construction,
	// so it is never one. Shared by the dead-scope advisory and the bare-repo one below, so one row is never called a
	// dead folder by one line and a bare repo by the other.
	const folderOnly = (s) => scopeFormOf(s) !== "qualified" && (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.includes("\\") || !s.includes("/") || /^[A-Za-z]:/.test(s));

	// The dead-scope advisory (issue #242), honest about what doctor can actually judge. A forge repo
	// always contains "/" and never begins "/", "./" or "../" or carries a backslash, so a scope in any
	// of THOSE shapes can only ever be a folder -- and a folder row that matches no trigger's canonical
	// run.folder guards nothing. Rows that COULD be a repo (an "a/b" shape) stay silent, not caveated:
	// webhook jobs carry their repo in the delivery, which triggers.json cannot enumerate, so a line on
	// every legitimate repo cap would be standing noise that teaches skimming (`repositories` is empty
	// for every valid file today -- run.repository is azure-only, its own fact says so). Guarded on the
	// TRIGGERS facts being readable too: a zeroed `folders` from an absent or unparseable triggers file
	// has no honest claim to make (readTriggerFacts' own rule). Issue #462: a WARNING (`ok: false, warn: true`), never a
	// failure: a cap that guards nothing is a mistake the operator can clear by fixing or deleting the row, and in this
	// shape `render` prints the fix line too, which the old `ok: true` never did.
	if (scopedLimitFacts.parseError === null && scopedLimitFacts.limits.length > 0 && parseError === null && triggersFilePath !== null) {
		const folderSet = new Set(folders);
		// A model row (version 2) names a model, never a folder, so it is never "a folder no trigger runs in"; nor is a
		// project row (issue #499 part B), which names a project.
		const dead = scopedLimitFacts.limits.map((l) => l.scope).filter((s) => !isModelScope(s) && !isProjectScope(s) && folderOnly(s) && !folderSet.has(s));
		if (dead.length > 0) {
			checks.push({
				ok: false,
				warn: true,
				label: `${dead.length} scoped limit(s) name a folder no trigger runs in (${dead.join(", ")}) -- no trigger runs there, so unless a CLI or local job does, the cap guards nothing; scopes match exactly (no globs, folders by resolved ABSOLUTE path), so check the spelling against triggers.json run.folder or delete the entry`,
				fix: `edit ${scopedLimitFacts.path} by hand or via dispatch_limit_edit/_delete -- repo-shaped scopes are never flagged here, because a webhook job's repo comes from the delivery, which triggers.json cannot enumerate`,
			});
		}
	}

	// Issue #499 part B: a `project:<id>` row whose id is not in projects.json. The worker refuses to start on it
	// (start.mjs, `checkProjectRows`), so this is a FAILURE naming the row and the id. Skipped when either file does not
	// load: that is the BOOT_FILES line's, and a zeroed list here would name every project row as dangling.
	if (scopedLimitFacts.parseError === null && scopedLimitFacts.limits.length > 0) {
		const projectFacts = readProjectFacts(env, fileExists);
		if (projectFacts.parseError === null) checks.push(...projectRowChecks(scopedLimitFacts.limits, projectFacts.projects, scopedLimitFacts.path));
	}

	// Issue #504 part B: the envelope's advisories, on the file the service names, when it loads (a file that does not is
	// the BOOT_FILES line's). Warnings only: the worker boots on both.
	const envelopeFactsHere = readEnvelopeFacts(env);
	if (envelopeFactsHere.envelope) checks.push(...envelopeChecks(envelopeFactsHere.envelope, envelopeFactsHere.projects, envelopeFactsHere.maxCostMicros));

	// Issue #498: a BARE repo scope (`acme/web`) matches that repo on every forge, so with triggers on more than one forge
	// kind a bare row is one cap (one lease, one count) shared by GitHub's acme/web and Forgejo's, and a bare pause window
	// pauses both. That may be meant, so this is a WARNING naming the qualified spellings, never a failure: refusing bare
	// rows would stop existing workers from booting. Guarded like the dead-scope advisory, on readable triggers.
	if (parseError === null && triggersFilePath !== null && forges.length > 1) {
		const bareRows = scopedLimitFacts.parseError === null ? scopedLimitFacts.limits.map((l) => l.scope).filter((s) => !isModelScope(s) && !isProjectScope(s) && scopeFormOf(s) === "bare" && !folderOnly(s)) : [];
		const bareWindows = pauseWindowFacts.parseError === null ? [...new Set(pauseWindowFacts.windows.map((w) => w.scope).filter((s) => s !== "*" && scopeFormOf(s) === "bare" && !folderOnly(s)))] : [];
		const named = [...new Set([...bareRows, ...bareWindows])];
		if (named.length > 0) {
			const what = [bareRows.length > 0 ? `${bareRows.length} scoped limit(s)` : null, bareWindows.length > 0 ? `${bareWindows.length} pause window(s)` : null].filter(Boolean).join(" and ");
			checks.push({
				ok: false,
				warn: true,
				label: `${what} name a bare repo (${named.join(", ")}) while triggers run on ${forges.join(" and ")}: a bare scope matches that repo on EVERY forge, so one cap, lease or pause covers all of them`,
				fix: `if each forge should count on its own, write the scope forge-qualified: ${named.map((s) => forges.map((k) => `${k}:${s}`).join(" or ")).join("; ")} (a qualified row starts a new count, and a bare and a qualified row for one repo cannot both exist); keep the bare form if one shared cap is what you meant`,
			});
		}
	}

	// Issue #464: the jobs dir is this account's to write. PI_JOBS_DIR, PI_SANDBOX_DIR and TMPDIR as the service reads them
	// (TMPDIR in .env is a documented way out of a squatted default root, so doctor judges the root the service will use).
	let dirRefused = false;
	if (seams.jobsDirFs) {
		const uid = seams.jobsDirUid;
		const ownerName = (id) => ownerNameFromPasswd(seams.passwd, id);
		const dirChecks = jobsDirChecks(env, { uid, fs: seams.jobsDirFs, ownerName, note: fromFileNote(fileSays("PI_JOBS_DIR", "PI_SANDBOX_DIR", "TMPDIR", "TEMP")) });
		dirRefused = dirChecks.some((c) => c.ok === false && !c.warn);
		checks.push(...dirChecks);
	}

	// REQ-RESURRECTABLE-SANDBOX. A fact line, never a failure: retention is a convenience, and the only thing
	// worth surfacing is that finished runs' directories -- a repository clone plus the run's prompt.md and
	// event.json, so issue text -- are sitting on disk, and how many. An operator who never opens a sandbox
	// should still know they are being kept. Issue #462: not a warning either, since retention on is the default and
	// nothing needs changing, so what each holds and how to turn it off live in the label (`ok: true` prints no fix).
	// Issue #464 (gate round 1): the sandbox dir the SERVICE uses (`env`, resolved), and nothing at all after a ✗ above on the
	// jobs dir, its root or the sandbox dir: that worker does not start, and a ✓ counting what sits in a directory another
	// account made would read as this account's.
	if (!dirRefused) {
		const retentionHours = nonNegativeEnvInt(env.PI_SANDBOX_RETENTION_HOURS, 24);
		const sandboxDir = env.PI_SANDBOX_DIR || defaultSandboxDir(env);
		// Counted in BOTH branches (gate round 1): a tombstone the worker cannot delete does not go away because retention
		// was turned off, and turning it off is exactly when an operator expects the disk back.
		const kept = countRetained(sandboxDir, fileExists);
		if (retentionHours === 0) {
			checks.push({ ok: true, label: "Workspace retention off (PI_SANDBOX_RETENTION_HOURS=0) — finished runs are deleted, none are re-openable" });
		} else {
			checks.push({
				ok: true,
				label: `${kept.count} retained workspace(s) in ${sandboxDir}, swept after ${retentionHours}h, re-open one with \`pi-dispatch sandbox <jobId>\`${kept.count > 0 ? "; each holds the run's clone plus its prompt.md/event.json (issue text), and PI_SANDBOX_RETENTION_HOURS=0 turns retention off" : ""}`,
			});
		}
		checks.push(...sandboxTombstoneChecks(sandboxDir, kept));
	}

	// issue #290. The two DURABLE stores -- the run history everything folds over, and the overlay holding
	// every cap the operator tuned from the panel -- used to default under the OS temp dir, which macOS
	// sweeps on its own schedule and which is tmpfs (RAM) on several Linux distros. They now default under
	// ~/.pi-dispatch, so this block is normally one green line; it warns only when a path RESOLVES under a
	// temp dir, which after the move means an operator put it there.
	//
	// Deliberately NOT checked HERE: PI_JOBS_DIR, PI_SANDBOX_DIR and PI_GRAPH_DIR. Those are per-run,
	// retention-bounded and regenerable respectively, and they stay under temp on purpose. Warning about a
	// directory that is SUPPOSED to be swept is how an operator learns to skim this section, which costs
	// more than it buys. Whose the jobs dir is, is checked above (`jobsDirChecks`, issue #464): that is a
	// different question, and the one that failed every job of a second account on a shared host.
	{
		// The home SEAM, not the real homedir: this block must answer for the deployment doctor is
		// describing, and the no-home case has to be exercisable on a host that has one.
		const logsDir = logsDirPath(env, home);
		const settingsFile = settingsFilePath(env, home);
		const stores = [
			{ key: "PI_LOGS_DIR", path: logsDir, explicit: Boolean(env.PI_LOGS_DIR) },
			{ key: "PI_SETTINGS_FILE", path: settingsFile, explicit: Boolean(env.PI_SETTINGS_FILE) },
		];
		const swept = stores.filter((st) => underTemp(st.path, env));
		// Computed BEFORE the green line, because it is a reason not to print one. The two used to be
		// independent, so a homeless host was told "both survive a reboot" and then, one line later, that
		// the directory cannot be created.
		const homeless = stores.filter((st) => !st.explicit && !underTemp(st.path, env));
		const noHome = homeless.length > 0 && !fileExists(home);

		if (swept.length === 0 && !noHome) {
			checks.push({ ok: true, label: `Durable state: run history ${logsDir}, settings ${settingsFile} — both survive a reboot (docs/backup.md)` });
		} else if (swept.length > 0) {
			// ok:false + warn:true is the tier that renders a ⚠ WITHOUT failing doctor and still prints its
			// fix line; an ok:true check's fix is never rendered (see render() above). No fixAction, which
			// is the never tier working as designed: choosing a durable path is a semantic env value, and
			// doctor does not move an operator's records for them.
			//
			// The two cases below say DIFFERENT things, and collapsing them was a real defect: naming a
			// variable that is not set states something false, and telling an operator to "unset" a
			// variable they never set points them back at the path being complained about.
			const explicit = swept.filter((st) => st.explicit);
			if (explicit.length > 0) {
				const plural = explicit.length > 1;
				checks.push({
					ok: false,
					warn: true,
					label: `${explicit.map((st) => `${st.key} (${st.path})`).join(" and ")} ${plural ? "point" : "points"} into the OS temp dir, which the OS may sweep — a reboot can take your run history and your caps with it`,
					fix: `point ${plural ? "them" : "it"} at a durable path and move the existing files there; unsetting ${plural ? "them" : "it"} falls back to ${explicit.map((st) => (st.key === "PI_LOGS_DIR" ? defaultLogsDir(env, home) : defaultSettingsFile(env, home))).join(" and ")}`,
				});
			}
			const defaulted = swept.filter((st) => !st.explicit);
			if (defaulted.length > 0) {
				// The default itself landed under a swept directory, which means this account's home IS one
				// (a service account homed under /tmp, or no home at all, where defaultStateDir falls back to
				// the pre-#290 temp path on purpose so that it lands here rather than nowhere).
				checks.push({
					ok: false,
					warn: true,
					label: `durable state defaults under the OS temp dir on this host (${defaulted.map((st) => st.path).join(", ")}), because this account's home directory is there or cannot be resolved — the OS may sweep it, and a reboot can take your run history and your caps with it`,
					fix: `set ${defaulted.map((st) => st.key).join(" and ")} to a path outside the temp dir that this account can write`,
				});
			}
		}

		// The failure mode the MOVE introduces, which the temp default did not have: under <OS temp> the
		// mkdir always succeeded, under <home> it can fail. makeRecordWriter and makeLogSink both swallow
		// that into a `logs_dir_error` line and keep running, so the worker drains jobs perfectly and
		// records nothing. A systemd system unit whose User= has /nonexistent as its passwd home is the
		// concrete case, and deploy/worker.service ships User=pi.
		//
		// Asked for BOTH stores, not just the run history: a settings overlay that cannot be written is the
		// quieter half of the same fault, since readOverlay treats an absent file as an empty overlay and
		// every cap silently widens to the env default.
		// Issue #464: with no home, the two stores default into the per-account temp root, which the worker (and the panel,
		// for the overlay) refuses when it is not this account's. Said once: a root the jobs dir line already refused is not
		// repeated here.
		const uid = seams.jobsDirUid;
		if (Number.isInteger(uid) && seams.jobsDirFs) {
			const root = accountTempRoot(env, uid);
			const inRoot = stores.filter((st) => !st.explicit && (st.path === root || st.path.startsWith(`${root}/`)));
			const said = checks.some((c) => c.ok === false && typeof c.label === "string" && c.label.startsWith(`${root}, `));
			const refused = inRoot.length > 0 && !said ? accountRootRefusal(root, { uid, fs: seams.jobsDirFs, ownerName: (id) => ownerNameFromPasswd(seams.passwd, id), what: `this account's ${inRoot.map((st) => (st.key === "PI_LOGS_DIR" ? "run history" : "settings overlay")).join(" and ")} (no home directory, so the default is here)` }) : null;
			if (refused) checks.push({ ok: false, label: refused.label, fix: `${refused.fix}; or set ${inRoot.map((st) => st.key).join(" and ")} to a path this account owns` });
		}
		// Issue #501: the overlay itself, read by the worker's own reader. A present-but-invalid file refuses EVERY job
		// (`settings-overlay-invalid`) while the worker otherwise runs clean, and since #501 a file that loaded before can
		// become invalid on upgrade: a duplicate key, which used to take the last value, is now refused. The reason names
		// keys only, never values. Absent is the normal empty overlay and says nothing.
		if (fileExists(settingsFile)) {
			const overlay = readOverlay(settingsFile);
			if (overlay.invalid) {
				checks.push({
					ok: false,
					label: `settings overlay ${settingsFile} is invalid (${overlay.invalid}) -- the worker refuses every job as settings-overlay-invalid until it is fixed, and the panel refuses to write over it`,
					// The fix follows the reason: only a duplicate key gets the upgrade note, since only it loaded before #501.
					fix: /duplicate key/.test(overlay.invalid)
						? "remove the repeated key from that file, keeping the value you mean (a duplicate key is refused since issue #501; it used to take the last value), or delete the file to start from an empty overlay"
						: "fix what the reason names in that file, or delete the file to start from an empty overlay",
				});
			} else {
				// Issue #501 (PR #542's review): a VALID overlay can still break the dollar invariant once merged over env
				// (a window in one, no maxCostUsd in either), which the worker checks per job and answers by refusing every
				// job. The env-only half is `dollarChecks`; this is the merged half, said only when env alone is fine.
				const merged = overlayDollarProblem(overlay.overlay, env);
				if (merged) checks.push({ ok: false, label: `settings overlay ${settingsFile}: ${merged} -- the worker refuses every job as settings-overlay-invalid`, fix: "set maxCostUsd in the overlay (or PI_MAX_COST_USD in .env), or remove the dollar window" });
			}
		}
		// PR #549's review: the scoped-limits dollar rows against the deployment's per-job cap, env and overlay merged
		// the worker's way (an overlay value wins; an invalid overlay leaves env).
		if (scopedLimitFacts.parseError === null && scopedLimitFacts.limits.length > 0) {
			const overlay = fileExists(settingsFile) ? readOverlay(settingsFile) : { overlay: {} };
			const fromOverlay = overlay.invalid ? undefined : overlay.overlay?.maxCostUsd;
			const envCap = env.PI_MAX_COST_USD === undefined || env.PI_MAX_COST_USD === "" ? undefined : env.PI_MAX_COST_USD;
			checks.push(...scopedDollarRowChecks(scopedLimitFacts.limits, fromOverlay ?? envCap, scopedLimitFacts.path));
		}
		if (noHome) {
			checks.push({
				ok: false,
				warn: true,
				label: `this account has no home directory on disk (${home}), so ${homeless.map((st) => st.path).join(" and ")} cannot be created`,
				fix: `set ${homeless.map((st) => st.key).join(" and ")} to a path this account can write; without it the worker logs logs_dir_error at boot, drops every run record, and reads an empty settings overlay, which widens every cap to the .env default`,
			});
		}

		// The migration hints. ⚠ rather than ✓, because render() draws ok:true as a green tick whatever
		// `warn` says, and "your run history is stranded at the old path" is not good news. Gated on three
		// facts so each retires itself: only while the variable is unset (an explicit path means there is
		// nothing to migrate), only while the OLD path still holds records, and only while the NEW one holds
		// none. A warning that cannot go away is a warning nobody reads.
		//
		// Both commands lead with `mkdir -p`, because the very condition that prints them -- the new store
		// is empty -- is usually the condition in which its directory does not exist yet, and a bare `mv`
		// into a missing directory fails.
		const legacy = legacyTempStateDir(env);
		if (!env.PI_LOGS_DIR && !underTemp(logsDir, env)) {
			const old = recordCount(`${legacy}/logs`, fileExists);
			if (old > 0 && recordCount(logsDir, fileExists) === 0) {
				const shared = sharedDirectory(`${legacy}/logs`);
				checks.push({
					ok: false,
					warn: true,
					label: `${legacy}/logs holds ${old} run record(s) while ${logsDir} is empty — an older pi-dispatch defaulted there, and the OS may sweep it`,
					// mtime is what the log reaper ages a record by, and `mv` preserves it, so anything already
					// past PI_LOG_RETENTION_DAYS is deleted by the next boot sweep rather than rescued. Say so:
					// an operator who wanted those records would otherwise learn it by losing them.
					fix: shared
						? `that directory is writable by every local account, so confirm those files are yours before adopting them, then: mkdir -p ${logsDir} && mv ${legacy}/logs/* ${logsDir}/ (records already past PI_LOG_RETENTION_DAYS are swept by the next sweep, which no longer waits for a restart; mv keeps their timestamps)`
						: `mkdir -p ${logsDir} && mv ${legacy}/logs/* ${logsDir}/ (records already past PI_LOG_RETENTION_DAYS are swept by the next sweep, which no longer waits for a restart; mv keeps their timestamps)`,
				});
			}
		}
		if (!env.PI_SETTINGS_FILE && !underTemp(settingsFile, env) && fileExists(`${legacy}/settings.json`) && !fileExists(settingsFile)) {
			// The overlay outranks .env, so adopting one is handing it your caps, your model and your
			// secret-profile declarations. On a world-writable legacy directory that file may not be yours
			// at all, and doctor must not hand an operator a one-line command that installs a stranger's
			// spend limits. There, the remedy is to READ it first and no command is offered.
			const shared = sharedDirectory(legacy);
			checks.push({
				ok: false,
				warn: true,
				label: `a settings overlay is still at ${legacy}/settings.json while ${settingsFile} does not exist — until it moves, every cap, the model and any secret profiles fall back to .env and the built-in defaults, which may be wider than what you last set`,
				fix: shared
					? `${legacy} is writable by every local account, so that file is not necessarily yours: read it before adopting it (an overlay outranks .env), then copy it to ${settingsFile} yourself`
					: `mkdir -p ${dirname(settingsFile)} && mv ${legacy}/settings.json ${settingsFile}`,
			});
		}
	}

	// Issue #471: what a key resolved above this point (the provider's variables, the PAT) added to the record.
	checks.push(...serviceEnvLines({ fromFile: {}, disagreements: service.disagreements.slice(saidAtTop.disagreements), unread: service.unread.slice(saidAtTop.unread) }, envPathShown));
	// Issue #471 (gate round 1): a key only this shell sets was taken in silence. Where a service for this folder is
	// installed, it runs without that value (its unit loads the file, not this shell), so the keys are named, never their
	// values. Not the ones a service manager gives every service itself (a temp dir, the runtime dir), which the file need
	// not repeat. Advisory: the unit's --env-setup script may supply them, which doctor cannot run to find out.
	// env-internal XDG_CONFIG_HOME: the XDG base directory the CLIs doctor starts read, compared here with its default only.
	// Nor XDG_CONFIG_HOME at its own default (`~/.config`, which a login shell often exports): unset, every CLI that
	// reads it falls back to that same directory, so the service runs with the same value (measured on pd-fedora: the
	// named line otherwise flagged the default).
	const shellOnly = service.shellOnly.filter((k) => !AMBIENT_SERVICE_KEYS.includes(k) && !(k === "XDG_CONFIG_HOME" && typeof home === "string" && env.XDG_CONFIG_HOME === join(home, ".config")));
	const unit = shellOnly.length > 0 ? serviceUnitFor(seams, cwd) : null;
	if (unit) {
		checks.push({
			ok: false,
			warn: true,
			label: `${shellOnly.join(", ")} ${shellOnly.length === 1 ? "is" : "are"} set in this shell only: the service installed for this folder (${unit}) loads ${serviceEnvFile?.path ?? join(cwd, ".env")}, not this shell, so it runs without ${shellOnly.length === 1 ? "that value unless its --env-setup script sets it" : "those values unless its --env-setup script sets them"}, while doctor judged this shell's`,
			fix: `put ${shellOnly.length === 1 ? "it" : "them"} in ${serviceEnvFile?.path ?? join(cwd, ".env")} if the service needs ${shellOnly.length === 1 ? "it" : "them"}, or unset ${shellOnly.length === 1 ? "it" : "them"} in this shell to judge what the service runs`,
		});
	}
	if (service.hazardSkipped.length > 0) {
		const { hazard } = serviceEnvFile;
		checks.push({ ok: false, label: `${serviceEnvFile.path} line ${hazard.line} ${hazard.what}, so doctor read none of ${service.hazardSkipped.join(", ")} from it and judged this shell's values (or the defaults) instead: the service's own are unknown`, fix: hazard.fix });
	}
	return checks;
}

/**
 * How many retained workspaces are sitting in the retention root.
 *
 * Reads its OWN env rather than loadConfig, like every other doctor check (`doctor.mjs` header): a broken
 * GitHub auth must not stop the operator finding out how much disk this is using. Never throws -- an
 * unreadable or absent root reports zero, which is the honest answer to "how many can I open".
 */
export function countRetained(sandboxDir, fileExists, { readdir = readdirSync, now = Date.now, readFile = readFileSync } = {}) {
	if (!fileExists(sandboxDir)) return { count: 0, tombstones: 0, stuck: [], pinned: [] };
	try {
		// Issue #446: a TOMBSTONE (`.reap-...`) is a run the sweep has already decided to delete, so it is not one an
		// operator can open and is not counted as one. Counted apart instead, and the ones older than a delete takes
		// (`SANDBOX_TOMBSTONE_STUCK_MS`) are named: a tree the worker cannot delete (root-owned files under a non-root
		// worker, the ordinary shape) stays a tombstone, and every pass retries it with a line a day, so this is where an
		// operator sees one. A name this module did not write (no parseable age) is stuck by definition.
		const names = readdir(sandboxDir);
		const tombs = names.filter((n) => isSandboxTombstone(n));
		const at = now();
		// A negative age (a name stamped by a clock that ran ahead) is unknowable, and counts as old, as the sweep reads it.
		const old = tombs.filter((n) => {
			const age = sandboxTombstoneAge(n, at);
			return age === null || age < 0 || age >= SANDBOX_TOMBSTONE_STUCK_MS;
		});
		// TWO stories, and NEVER told apart by the pid in the name (gate round 3): after any worker restart the pid is
		// dead whether or not a delete has failed, so a pid rule called the ordinary stuck tombstone a harmless crash
		// leftover and dropped its fix, and a pid means nothing across pid namespaces anyway. A tombstone holding a pin
		// that has not run out is HELD by the sweep, never deleted, and goes back under its run's name once that is free;
		// calling it stuck, with a removal command beside it, would have an operator delete a run someone was told was
		// pinned. Its manifest is read for that one field; one that cannot be read is not called pinned. Every other old
		// tombstone is one the sweep has not removed, whatever the reason, and gets its exact-path removal.
		const pinned = old.filter((n) => {
			try {
				const keepUntil = Date.parse(JSON.parse(String(readFile(join(sandboxDir, n, "manifest.json"), "utf8")))?.keepUntil ?? "");
				return Number.isFinite(keepUntil) && keepUntil > at;
			} catch {
				return false;
			}
		});
		const stuck = old.filter((n) => !pinned.includes(n));
		return { count: names.length - tombs.length, tombstones: tombs.length, stuck, pinned };
	} catch {
		return { count: 0, tombstones: 0, stuck: [], pinned: [] };
	}
}

/**
 * The warnings for old tombstones (issue #446): pinned ones held aside, and every other one, or [] when there are none.
 * Never a failure, since nothing is at risk, and in the WARNING shape, `ok: false, warn: true` (gate round 2): `render`
 * prints a ⚠ and the fix line only for `!ok`, and the first version's `ok: true` rendered as a green tick with no fix.
 */
export function sandboxTombstoneChecks(sandboxDir, kept) {
	const out = [];
	const list = (names) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}`;
	if (kept?.pinned?.length > 0) {
		out.push({
			ok: false,
			warn: true,
			label: `${kept.pinned.length} pinned workspace(s) in ${sandboxDir} are held aside by the retention sweep (${list(kept.pinned)}) because their run's name was taken when they were put back`,
			fix: "do NOT remove them: each holds a pinned run, and the sweep puts it back under its run's name as soon as that name is free (move away whatever now holds the name, if it is not a run you want)",
		});
	}
	if (kept?.stuck?.length > 0) out.push(stuckCheck(sandboxDir, kept, list));
	return out;
}

function stuckCheck(sandboxDir, kept, list) {
	const n = kept.stuck.length;
	return {
		ok: false,
		warn: true,
		label: `${n} deleted workspace(s) in ${sandboxDir} are still on disk (${list(kept.stuck)}) -- the sweep could not remove them; if the worker is running it retries each pass`,
		// Each one BY NAME, never a `.reap-*` glob (gate round 2): a glob would take a pinned tombstone, or one being
		// deleted right now, with it.
		fix: `the usual cause is files the worker's account cannot delete (root-owned files a job left in its clone); remove each as their owner: ${kept.stuck.map((n) => `\`sudo rm -rf ${join(sandboxDir, n)}\``).join(", ")}. They are no longer re-openable either way`,
	};
}

/**
 * Is this directory one any local account can write, or one owned by somebody else?
 *
 * The legacy state root is `<OS temp>/pi-dispatch`, and on POSIX the OS temp dir is mode 1777. So the
 * files doctor finds there were not necessarily written by this operator, or even by pi-dispatch: on a
 * shared host another account can create them. That matters because the migration hint would otherwise
 * offer a one-line command adopting a settings overlay, and an overlay OUTRANKS `.env` for every spend
 * cap. Answers false when it cannot tell (Windows has no meaningful mode here, and an unreadable
 * directory is not a claim), because this only ever softens advice and never gates anything.
 */
function sharedDirectory(dir) {
	try {
		const st = statSync(dir);
		if ((st.mode & 0o002) !== 0) return true; // world-writable, sticky or not
		const uid = process.getuid?.();
		return typeof uid === "number" && st.uid !== uid;
	} catch {
		return false;
	}
}

/**
 * How many run records a directory holds (issue #290's migration hint).
 *
 * Filtered by the LOG REAPER's own rule (`.log` or `.json`, run-history.mjs), so the hint and the reaper
 * agree on what counts as a record rather than each having an opinion. Never throws, on countRetained's
 * posture above: an absent or unreadable directory holds zero, which is the honest answer here.
 */
function recordCount(dir, fileExists) {
	if (!fileExists(dir)) return 0;
	try {
		return readdirSync(dir).filter((n) => n.endsWith(".log") || n.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/** PI_SANDBOX_RETENTION_HOURS, parsed the same permissive way the admin's own env reads are. */
function nonNegativeEnvInt(raw, fallback) {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isInteger(n) && n >= 0 && String(n) === String(raw).trim() ? n : fallback;
}

/**
 * doctor's ONLY contact with pi's own package, deliberately lazy and failure-tolerant.
 *
 * `env-allowlist.mjs` imports `@earendil-works/pi-ai`. A STATIC import here would run pi at doctor's
 * MODULE load -- before the Node-floor check that is deliberately doctor's FIRST line has said anything
 * -- on precisely the below-floor or dependency-less host doctor exists to diagnose. `.env present`
 * reaches `init.mjs` through `await import` for the same reason.
 *
 * Returns null rather than throwing, so a host where pi will not load still gets every other check.
 */
async function defaultProviderOracle() {
	try {
		const { piProviders, providerKeyCandidates } = await import("./env-allowlist.mjs");
		return { piProviders, providerKeyCandidates };
	} catch (error) {
		// The error is CARRIED, never swallowed. A missing dependency is the case this seam exists for; a
		// SyntaxError or a broken export in our OWN module is a defect wearing a missing-dependency costume,
		// and a bare `catch {}` would report it as "pi did not load" while doctor went on to say ready.
		return { loadError: error };
	}
}

/**
 * Does this deployment hold a credential the worker can actually spend? Three questions, in this order
 * because each has a different answer to give:
 *
 *   1. WHICH variables pi reads for this provider -- pi's own list, in pi's own order. Asked even when
 *      none is set, which `findEnvKeys` alone cannot answer: a failure that cannot name the variable to
 *      set is not a fix line.
 *   2. Whether any of them is set HERE. Answered against `env` by this function and NOT by pi's
 *      `findEnvKeys`, because `getProviderEnvValue` falls back to the real `process.env` for any name the
 *      injected env lacks -- so asking pi would report a key that exists on the operator's laptop and not
 *      on the host they are diagnosing, and would make every test in doctor.test.mjs non-hermetic. The
 *      candidate list is pi's; the presence test is ours, and must be.
 *   3. Failing both, whether pi's own auth.json holds one -- the same fallback, read the same way, that
 *      `resolveProviderCredential` will take at job time.
 *
 * Never carries a fixAction (the never tier): doctor cannot know which provider an operator meant, and
 * never mints a credential.
 */
function providerKeyCheck({ provider, env, agentDir, oracle, nodeOk, keyless = null }) {
	if (!oracle?.providerKeyCandidates) {
		// pi did not load: below-floor Node, or a tree with no dependencies installed.
		//
		// It WARNS only when the Node-floor check -- which runs first and is right there in the same array
		// -- already failed hard, because then one root cause is printing one ✗ and a second would read as
		// two problems. Otherwise it FAILS, and that distinction is the whole point: a tree with no
		// `node_modules` leaves the floor green, doctor's own graph has no external imports so it still
		// runs, and a warn here would let doctor print "ready" and exit 0 on a deployment whose worker
		// cannot even boot. REQ-DEPLOYMENT-BOOTSTRAP now says doctor never reports green on a credential
		// the worker cannot spend, and this arm is the one that would have broken that rule first.
		//
		// Names no variable in either case: guessing one is the defect this whole check exists to stop.
		const loadError = oracle?.loadError;
		const missingDep = loadError?.code === "ERR_MODULE_NOT_FOUND" || loadError?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
		return {
			ok: false,
			warn: nodeOk === false,
			label: loadError && !missingDep
				// A defect in our own module, said in those words rather than blamed on the dependency.
				? `Provider key: not checked (loading the provider table failed: ${loadError.message})`
				: `Provider key: not checked (pi did not load, so the variable ${JSON.stringify(provider)} needs cannot be asked for)`,
			fix: "install the worker's dependencies (`npm ci` in the deployment directory) on a Node meeting the floor above, then re-run doctor",
		};
	}
	const candidates = oracle.providerKeyCandidates(provider);
	if (candidates.length === 0) return noKeyVariableCheck(provider, oracle, keyless);

	// Presence by PI'S truthiness, not a stricter one. This used to trim, and trimming made doctor pick a
	// DIFFERENT variable than the worker will: with a whitespace `ANTHROPIC_OAUTH_TOKEN` beside a real
	// `ANTHROPIC_API_KEY`, a trimming filter drops the token and reports the API key green, while pi reads
	// the token (non-empty to it), wins precedence with it, and fails auth on every job. Whitespace is
	// still refused -- one step further down, against the variable pi actually reads, where it is a fact
	// about THAT credential rather than a reason to pretend the variable is unset.
	const set = candidates.filter((name) => (env[name] ?? "") !== "");
	// The variable to TELL an operator to set is never the OAuth token or the bearer token, and it is the
	// SAME choice the worker makes when it writes an `auth.json` key into a container (issue #311; the
	// bearer half is issue #509). One function, one module, so a doctor line cannot name a variable the job
	// path does not use.
	const apiKeyVar = apiKeyVariable(candidates);

	if (set.length > 0) {
		// `set[0]`, not "one of these": pi reads the FIRST present name and ignores the rest, so this names
		// the credential the deployment will actually spend. The old line named variables that were not set,
		// which is half of what made it misleading.
		const using = set[0];
		// Judged on the variable pi will read, after precedence rather than before it. A value that is all
		// whitespace is a credential the worker forwards and the provider rejects: a paid failure per job,
		// refused here for free. Hard, not a warn -- unlike the OAuth case below, nothing about this
		// deployment can work.
		if ((env[using] ?? "").trim() === "") {
			return {
				ok: false,
				label: `Provider key set (${provider}: ${using}) -- but the value is whitespace`,
				fix: `set a real value for ${using}, or unset it: pi reads it as present, so every job spends a container to fail auth`,
			};
		}
		const kind = nonApiKeyKind(using);
		if (kind === null && isOAuthTokenValue(provider, env[using])) {
			// The variable is the API key's, the VALUE is a subscription login: pi decides by the value
			// (anthropic-messages.js `isOAuthToken`, a substring test for "sk-ant-oat"), not by the name, and
			// sends it as `Authorization: Bearer` with Claude Code's identity headers. So it is the OAuth
			// case under the API key's name, and it gets that warning rather than a green line.
			return {
				ok: false,
				warn: true,
				label: `Provider key set (${provider}: ${using}) -- but the value is an OAuth/subscription token, not an API key`,
				fix: `put a real API key in ${using}: pi recognises the value as a subscription login whatever variable holds it and sends it as an Authorization: Bearer header; it expires, and the container cannot refresh it`,
			};
		}
		if (kind === null) return { ok: true, label: `Provider key set (${provider}: ${using})` };
		// Warn, not fail, and the choice is deliberate: the worker forwards this variable and the job WILL
		// run, so failing here would put doctor in disagreement with the worker -- the exact disease this
		// issue is about. What doctor must stop doing is what it did before: pass in silence, as though a
		// subscription login were a service credential.
		const shadowed = set[1] ?? null;
		// The pi login this token silently displaces. The worker takes the ENVIRONMENT first and reads
		// auth.json only when the environment holds no candidate, while pi on this host takes a stored
		// api_key credential FIRST (pi-ai/dist/auth/helpers.js: "a stored credential key wins"). So with both
		// present the job spends the token and pi on the host spends the stored key, and without this line
		// nothing says so. Appended only to the fix lines for a token with no other env candidate beside it:
		// with one, that env key is the ignored credential and the line already names it.
		const ignoredLogin = env.PI_AUTH_FROM_PI !== "0" && usablePiLoginKey(agentDir, provider) !== null
			? `; the API key in pi auth.json is NOT used while ${using} is set (the worker reads the environment first, although pi on this host would use the stored key): unset ${using} to spend the pi login, or keep it only if this token is the credential you mean jobs to spend`
			: "";
		if (kind === "bearer") {
			// The bearer token (ANTHROPIC_AUTH_TOKEN at the pi 0.99.1 pin, issue #509) gets the OAuth token's
			// treatment, a forwarded variable and a warning, and a line of its own because the hazard is a
			// different one: it is often a real gateway credential rather than a login that expires, but pi
			// reads it BEFORE the API key and sends it as `Authorization: Bearer`, so while it is set the API
			// key is ignored. The API-key variable is named whether or not it is set, because an operator who
			// sets it later without unsetting this one gets no change at all.
			return {
				ok: false,
				warn: true,
				label: `Provider key set (${provider}: ${using}) -- a bearer token, not an API key`,
				fix: shadowed
					? `unset ${using}: pi reads it BEFORE ${shadowed} and sends it as an Authorization: Bearer header, so every job spends it and ${shadowed} is ignored`
					: `set ${apiKeyVar} and unset ${using}: pi reads ${using} BEFORE ${apiKeyVar} and sends it as an Authorization: Bearer header, so while it is set ${apiKeyVar} is ignored${ignoredLogin}`,
			};
		}
		return {
			ok: false,
			warn: true,
			label: `Provider key set (${provider}: ${using}) -- an OAuth/subscription login, not an API key`,
			fix: shadowed
				? `unset ${using}: pi reads it BEFORE ${shadowed}, so every job spends the subscription login and your API key is ignored`
				: `set ${apiKeyVar} instead -- an OAuth/subscription token expires, the container cannot refresh it, and it is not the credential for an unattended service${ignoredLogin}`,
		};
	}

	// Nothing in the env. The key may still come from pi's auth.json (ON by default; PI_AUTH_FROM_PI=0
	// forces env-only), so don't report it missing yet.
	const authFromPi = env.PI_AUTH_FROM_PI !== "0";
	let note = "";
	if (authFromPi) {
		let cred;
		try {
			cred = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))?.[provider];
		} catch {}
		// `typeof` before `.trim()`: a hand-edited auth.json can hold a number or an object here, and this
		// line sits OUTSIDE the try above (which wraps only the JSON.parse), so `cred.key?.trim` on a non
		// string threw a TypeError and took the whole doctor run down. The worker refuses that credential
		// (issue #311); doctor has to survive long enough to say so.
		const key = typeof cred?.key === "string" ? cred.key : null;
		// Same whitespace rule as the env arm above, and for the same reason: credentialFromPiAuth accepts a
		// blank key, so doctor and the worker AGREE -- they agree on a credential that cannot buy anything.
		// The command/variable-reference form is the worker's refusal restated: pi resolves "!cmd" and "$VAR"
		// itself when IT reads auth.json, but this service forwards the value into a container where it is
		// read raw, so a login stored that way is not a key this deployment can spend.
		if (cred?.type === "api_key" && key && !key.startsWith("!") && !key.includes("$") && key.trim()) {
			if (isOAuthTokenValue(provider, key)) {
				// The env arm's value rule, for the same reason: the worker writes this under the API key's
				// name and pi sends it as a subscription login anyway.
				return {
					ok: false,
					warn: true,
					label: `Provider key set (${provider}) -- from pi auth.json, but the stored key is an OAuth/subscription token, not an API key`,
					fix: `run \`pi login\` with a real API key for ${provider}: pi recognises the stored value as a subscription login and sends it as an Authorization: Bearer header; it expires, and the container cannot refresh it`,
				};
			}
			return { ok: true, label: `Provider key set (${provider}) -- from pi auth.json` };
		}
		if (cred?.type === "api_key" && key && (key.startsWith("!") || key.includes("$")))
			note = " -- but the pi login is a command or variable reference, which pi resolves itself and a job container cannot";
		else if (cred?.type === "api_key" && !key) note = " -- but the key in pi auth.json is not a string, so no job could use it";
		else if (cred?.type === "api_key") note = " -- but the key in pi auth.json is whitespace, so every job would spend a container to fail auth";
		if (cred?.type === "oauth") note = " -- pi login is OAuth/subscription: not usable for an unattended service, configure an API key";
	}
	return {
		ok: false,
		label: `Provider key set (${provider}: ${candidates.join(" or ")})${note}`,
		fix: authFromPi ? `run \`pi login\` with an API key for ${provider}, or set ${apiKeyVar} in .env` : `set ${apiKeyVar} in .env`,
		// Issue #481: the names no environment doctor can see supplies, for the caller's env-setup rule; never printed.
		absent: candidates,
	};
}

/**
 * pi's own test for a subscription token in an API-key slot, restated: `isOAuthToken` in
 * pi-ai/dist/api/anthropic-messages.js is `apiKey.includes("sk-ant-oat")`, applied to the value whatever
 * variable carried it. Restricted to `anthropic`, the provider whose credential this is; the value itself is
 * never printed.
 */
function isOAuthTokenValue(provider, value) {
	return provider === "anthropic" && typeof value === "string" && value.includes("sk-ant-oat");
}

/**
 * The API key a pi login holds for `provider`, when it is one the worker would forward (a non-blank string
 * that is not pi's command or variable-reference form), else null. The same acceptance the auth.json arm of
 * providerKeyCheck applies; never throws, never printed.
 */
function usablePiLoginKey(agentDir, provider) {
	let cred;
	try {
		cred = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))?.[provider];
	} catch {
		return null;
	}
	const key = cred?.type === "api_key" && typeof cred.key === "string" ? cred.key : null;
	return key && key.trim() && !key.startsWith("!") && !key.includes("$") ? key : null;
}

/**
 * pi reads no API-key variable for this id, and the two reasons need different fixes -- which is exactly
 * the distinction `findEnvKeys`'s single `undefined` cannot make, and the reason issue #286 needed a
 * second question at all.
 */
function noKeyVariableCheck(provider, oracle, keyless = null) {
	if (oracle.piProviders().includes(provider)) {
		// `amazon-bedrock` wants AWS credentials or a profile, `openai-codex` an OAuth login. Both are
		// credential SOURCES the closed container env has no door for, so buildContainerEnv refuses every
		// such job pre-spend. Doctor says so at setup time rather than at 03:00.
		return {
			ok: false,
			label: `PI_PROVIDER is ${JSON.stringify(provider)}, which pi authenticates without an API-key variable`,
			fix: "pick a provider whose credential is a single environment variable -- the container env is a closed set of variables, so a credential file, an AWS profile or an OAuth login has no way in (docs/secrets.md)",
		};
	}
	// The did-you-mean is DERIVED like everything else here: ask pi which provider reads
	// `<PROVIDER>_API_KEY`. For the case that motivated this -- PI_PROVIDER=gemini -- GEMINI_API_KEY is
	// `google`'s variable, so the answer is exact. Nothing edit-distance-based would find it (gemini and
	// google differ by five characters), which is why this matches on the VARIABLE, not on the name.
	// Issue #503: the worker's own keyless verdict (model-endpoints.mjs), on the same predicate and in the same order as
	// the credential gate (no key variable, not in pi's catalog), so this line and the worker cannot disagree.
	const endpoints = Array.isArray(keyless?.endpoints) ? keyless.endpoints : [];
	if (endpoints.length > 0 && typeof keyless?.unreadable === "string") {
		// Issue #552: only a transient errno is retried; any other refuses every job at the model gate, before this one.
		const retried = isTransientOverlayRead(keyless.unreadable);
		return {
			ok: false,
			warn: retried,
			label: `Provider key: could not read models.json (${keyless.unreadable}), so whether ${JSON.stringify(provider)} is keyless is not known; ${retried ? "the worker retries such a job once, then fails it" : "the worker refuses every job until it can read it (overlay-unreadable)"}`,
			fix: "make the overlay's models.json readable by the account the worker runs as, then re-run doctor",
		};
	}
	const verdict = endpoints.length > 0 ? keylessVerdict({ models: keyless.models, provider, endpoints }) : { keyless: false, why: null };
	if (verdict.keyless) {
		return { ok: true, label: `Provider key: none needed (${provider} is keyless: served by declared endpoint ${verdict.endpoints.join(", ")})` };
	}
	const wanted = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
	const owner = oracle.piProviders().find((id) => oracle.providerKeyCandidates(id).includes(wanted));
	// Why a custom provider the overlay defines is not keyless, when it is one: the one fact the operator has to change.
	const why = verdict.why ? `; it is not keyless because ${verdict.why}` : "";
	// Issue #587: an id pi renamed (azure-openai-responses is `azure` since pi 1.0.3), named, unless the overlay declares it.
	const renamed = providerRenameHint(provider, { models: keyless?.hintModels ?? keyless?.models ?? null, overlayUnread: keyless?.hintUnread === true, piProviders: oracle.piProviders() });
	return {
		ok: false,
		label: `PI_PROVIDER is ${JSON.stringify(provider)}, which is not a provider pi has${why}${renamed ? `;${renamed}` : ""}`,
		fix: renamed
			? `set PI_PROVIDER=${RENAMED_PROVIDERS[provider]}, and rename the provider in every trigger's model and allowed-models entries and in models.json the same way (docs/triggers.md)`
			: owner
			? `set PI_PROVIDER=${owner}, the provider pi reads ${wanted} from -- or unset it for the default \`anthropic\`; or, ${KEYLESS_HOW}`
			: `set PI_PROVIDER to a provider id pi has, or unset it for the default \`anthropic\`: ${oracle.piProviders().join(", ")}; or, ${KEYLESS_HOW}`,
	};
}

function nodeCheck(version) {
	const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10));
	const ok = maj > NODE_FLOOR[0] || (maj === NODE_FLOOR[0] && min >= NODE_FLOOR[1]);
	return {
		ok,
		label: `Node ≥ ${NODE_FLOOR[0]}.${NODE_FLOOR[1]} (have ${version})`,
		fix: `upgrade Node to ${NODE_FLOOR[0]}.${NODE_FLOOR[1]} or newer`,
	};
}

/**
 * What does the trigger file say about the staged packages (INT-TRIGGERS-FILE-CONTRACT)?
 *
 * `images` is the sorted set of distinct `run.image` values across the file (issue #41), so doctor can check
 * that every image a trigger names is actually on this host -- with `--pull=never` nothing will fetch one at
 * job time, so this is the only warning that arrives BEFORE the trigger fires at 03:00.
 *
 * `optingOut` counts `run.packages: false` -- the only thing that now withholds the staged set from a job.
 * `requiring` counts explicit `run.packages: true`, which arms nothing any more but is still an operator
 * asserting "this flow needs those packages"; that assertion is what makes an empty stage a hard failure.
 *
 * `repositories` is the sorted set of distinct `run.repository` values on github-kind triggers, feeding the
 * branch-protection preflight (issue #80). Note the shared schema currently ADMITS `run.repository` only on
 * azure label/comment triggers (triggers.mjs, validateRepository), so this set is empty today for every
 * valid file -- collected here anyway, rather than hard-coded empty, so the preflight lights up the day the
 * schema grows the field for github instead of silently never running.
 *
 * Parsed with the SHARED `parseTriggers`, so doctor counts exactly the entries the worker and receiver will
 * act on -- a truthy `"true"` string is rejected there and therefore never counted here.
 *
 * A missing file still reads as zeroes and says nothing: that is an ordinary cron-less deployment. A file
 * that EXISTS and does not parse is reported instead, with the reason. The old justification here -- that
 * such a file "already fails LOUD at worker boot" -- was false for the deployment that needs doctor most:
 * the worker reads this file only when PI_TRIGGERS_FILE is set, so on a receiver-only host nothing else
 * says a word, while the zeroes quietly disarm every forge, image and flow check below.
 */
/** lstat, so a symlinked skillsDir is judged on its own inode -- copy-tree.mjs's rule, restated. */
function dirExists(dir) {
	try {
		return lstatSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Dry-run the REAL copier against a skills dir, into a throwaway destination that is removed again.
 *
 * Deliberately the same function the job path calls rather than a reimplementation of its rules: a
 * second, agreeing-by-hand checker is how doctor comes to report green on a directory the worker then
 * refuses. The cost is one copy of a bounded tree, on a command an operator runs by hand.
 */
function probeSkillsDir(dir) {
	const scratch = mkdtempSync(join(tmpdir(), "pi-doctor-skills-"));
	try {
		return copySkillTree(dir, scratch);
	} catch {
		return { refused: "skills-dir-unreadable" };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The operator-facing fix line for each refusal the copier can return. */
function probeFix(reason, dir) {
	if (reason === "skills-dir-empty") {
		return `${dir} holds no usable <name>/SKILL.md, so every job of that trigger refuses as skills-dir-empty -- point run.skillsDir at the directory whose CHILDREN are skill dirs (the ~/.pi/agent/skills layout)`;
	}
	if (reason === "skills-dir-too-deep") return `${dir} nests deeper than the copier walks -- flatten it`;
	if (reason === "skills-dir-too-many-files") return `${dir} holds more files than one job may carry -- split the set across triggers`;
	if (reason === "skills-dir-unreadable") return `${dir} could not be read -- check its permissions on the worker host`;
	return `${dir} is over the injection size caps -- trim it, or split the set across triggers`;
}

/**
 * The injected skills that carry `ai-trigger: allow`, which is the opt-in that will never be honoured.
 *
 * Reads only `<dir>/<name>/SKILL.md`, and never throws: this is a warning, and a doctor line must not be
 * the thing that fails a doctor run. The frontmatter test mirrors flow-gate.mjs's -- deliberately a
 * loose one here, because over-reporting a skill that would not have opened the gate anyway is harmless
 * while missing one leaves the operator's opt-in silently dead.
 */
function aiTriggerNames(dir) {
	const names = [];
	try {
		for (const name of readdirSync(dir)) {
			try {
				const text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
				if (/^ai-trigger:\s*("?)allow\1\s*$/m.test(text)) names.push(name);
			} catch {
				// no SKILL.md, or unreadable: not a skill that could have opted in.
			}
		}
	} catch {
		// unreadable dir: the presence check above already reported it.
	}
	return names;
}

/**
 * Does `.pi/skills/<flow>/SKILL.md` exist at HEAD of a local folder? "present" | "absent" | "unknown".
 *
 * Deliberately NOT readFlowGate: that module answers WHO may fire a flow (the ai-trigger frontmatter,
 * at a caller-pinned sha) and its catch collapses ANY git failure into deny -- fail-closed is right
 * for a gate and exactly wrong here, where deny-because-git-broke would print a confident wrong
 * answer on an advisory line. Doctor resolving HEAD itself is also fine: the gate's no-ref rule
 * defends against an agent self-authorizing mid-run, and a host-side preflight has no agent. What IS
 * the gate's, verbatim, is the ls-tree read and the 100644-blob requirement -- so the two readers cannot
 * disagree about what "a committed skill file" means. The hardening flags used to be restated here from
 * flow-gate.mjs's defaultGit and are now imported from git-hardening.mjs, so "restated" is retired: both
 * readers spread the same constant and a hostile repo config cannot run code during either read.
 */
async function repoFlowAtHead(spawn, folder, flow) {
	if (!SKILL_NAME_RE.test(flow)) return "unknown"; // the caller pre-checks; belt against interpolation
	const head = await runCmdCapture(spawn, "git", [...GIT_READ_FLAGS, "-C", folder, "rev-parse", "HEAD"]);
	const sha = head.code === 0 ? head.output.trim() : null;
	if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return "unknown";
	const tree = await runCmdCapture(spawn, "git", [...GIT_READ_FLAGS, "-C", folder, "ls-tree", "-z", sha, `.pi/skills/${flow}/SKILL.md`]);
	if (tree.code !== 0) return "unknown";
	const record = tree.output.split("\0").find((r) => r);
	if (!record) return "absent"; // valid sha, path absent at that commit
	const tab = record.indexOf("\t");
	const [mode, type] = tab === -1 ? [] : record.slice(0, tab).split(/\s+/);
	// A symlink/gitlink entry is "absent" for this question too: the gate would refuse it, and the
	// materialiser never copies it, so nothing downstream treats it as a skill file.
	return mode === "100644" && type === "blob" ? "present" : "absent";
}

/**
 * `parseWaitProfiles`, but doctor never throws: a malformed variable is a finding to REPORT, not a reason
 * for the diagnostic tool to die, since the operator running doctor is very likely running it BECAUSE the
 * worker refused to boot on that exact line.
 *
 * Returns an ENVELOPE, `{ profiles, error }`, rather than the table with an `error` key beside the profiles.
 * The flat shape reads better and is wrong: `error` is a legal profile name, so `PI_WAIT_PROFILES=error:/x.sh`
 * declares a profile whose PATH then reads as a parse failure -- doctor reports the variable as unparseable,
 * quoting the path as the message, and skips every check below it on a deployment that is perfectly fine.
 */
function parseWaitProfilesSafe(raw) {
	try {
		return { profiles: parseWaitProfiles(raw), error: null };
	} catch (err) {
		return { profiles: Object.create(null), error: err?.message ?? String(err) };
	}
}

/** Is this path something the worker could actually execute? The resolver's probe, reused verbatim. */
function statPath(path) {
	try {
		const real = realpathSync(path);
		const st = statSync(real);
		if (!st.isFile()) return { ok: false, why: "(not a regular file)" };
		if ((st.mode & 0o111) === 0) return { ok: false, why: "(not executable)" };
		return { ok: true };
	} catch (err) {
		return { ok: false, why: `(${err?.code ?? "unreadable"})` };
	}
}

/**
 * `parseSecretProfiles`, but doctor never throws, for `parseWaitProfilesSafe`'s reason and returning the
 * same envelope. The `error`-is-a-legal-profile-name defect was found in the wait copy and fixed in both:
 * the flat shape let one declared profile's PATH read as a parse failure and hide every check below it.
 */
function parseSecretProfilesSafe(raw) {
	try {
		return { profiles: parseSecretProfiles(raw), error: null };
	} catch (err) {
		return { profiles: Object.create(null), error: err?.message ?? "unparseable" };
	}
}

/**
 * The scoped-limits facts (issue #242): the parsed rows when PI_SCOPED_LIMITS_FILE is set, or the
 * boot-blocking reason when it will not load. Unset is `none` -- the worker enforces no scoped limits
 * and doctor has nothing to say (the mutex is code and needs no check). A configured-but-missing file
 * IS a parseError here: loadScopedLimits refuses boot on it, so doctor must too. Raw fs errors
 * (EACCES, EISDIR) are reported the same way, deliberately unlike readTriggerFacts' tagged-only
 * filter: the worker's own boot load is an unguarded readFileSync, so those throws refuse startup
 * exactly as a parse failure does, and the check's claim is "will the worker start", not "is the
 * content valid".
 */
function readScopedLimitFacts(env, fileExists) {
	const none = { limits: [], parseError: null, path: null };
	const path = env.PI_SCOPED_LIMITS_FILE;
	if (typeof path !== "string" || path.trim() === "") return none;
	if (!fileExists(path)) return { limits: [], parseError: `scoped-limits file does not exist: ${path}`, path };
	try {
		// A REGULAR FILE or nothing, the same guard `loadVerdict` carries, and this site needs it MORE: it
		// runs earlier, so a FIFO or a device named by this key hung `pi-dispatch doctor` forever before the
		// guarded read was ever reached. `readFileSync` is synchronous, so no test timeout can interrupt it
		// -- the failure mode is a job that never ends rather than one that goes red.
		if (!statSync(path).isFile()) return { limits: [], parseError: `scoped-limits file is not a regular file: ${path}`, path };
		return { limits: parseScopedLimits(readFileSync(path, "utf8"), path), parseError: null, path };
	} catch (e) {
		return { limits: [], parseError: e?.message ?? String(e), path };
	}
}

/**
 * The projects facts (issue #499 part B): the parsed projects when PI_PROJECTS_FILE is set, `[]` when it is unset (no
 * projects, so every project row dangles), or a parse error when it is set and does not load (the BOOT_FILES line's).
 */
function readProjectFacts(env, fileExists) {
	const path = env.PI_PROJECTS_FILE;
	if (typeof path !== "string" || path.trim() === "") return { projects: [], parseError: null };
	try {
		if (!fileExists(path) || !statSync(path).isFile()) return { projects: [], parseError: "unreadable" };
		return { projects: loadProjects({ projectsFile: path }, { readFileSync, existsSync: fileExists }), parseError: null };
	} catch (e) {
		return { projects: [], parseError: e?.message ?? String(e) };
	}
}

/**
 * The envelope facts (issue #504 part B): the envelope as the worker would load it, the projects and the per-job cap it
 * was judged against, or a parse error when `PI_ENVELOPE_FILE` is set and does not load (the BOOT_FILES line's).
 * `envelope` is null when the key is unset.
 */
function readEnvelopeFacts(env) {
	const path = nonEmpty(env.PI_ENVELOPE_FILE);
	if (path === null) return { envelope: null, projects: [], maxCostMicros: null, parseError: null };
	const io = { readFileSync, existsSync };
	try {
		const context = envelopeContextOf(env, io);
		return { envelope: loadEnvelopeAsTheWorker(path, io, env), projects: context.projects, maxCostMicros: context.maxCostMicros, parseError: null };
	} catch (e) {
		return { envelope: null, projects: [], maxCostMicros: null, parseError: e?.message ?? String(e) };
	}
}

/**
 * The envelope's advisories (issue #504 part B, INT-ENVELOPE-FILE-CONTRACT), WARNINGS the worker boots on:
 *   - a floor above 0 and below the per-job cost cap: every governed job reserves its per-job cap against its share, so a
 *     floor that small admits no job of its own (it still counts toward the total);
 *   - a project in projects.json that the envelope does not name: its jobs count in `_other`'s share.
 * Plus one line of facts: the digest (what `fpEnvelope` and `alloc:envelope:expected` hold), the window, the total and
 * whether delegation is on. Ids and amounts only.
 */
export function envelopeChecks(envelope, projects, maxCostMicros) {
	const checks = [{ ok: true, label: `Allocation envelope ${envelopeDigest(envelope)}: ${formatMicros(envelope.totalMicros)} a ${envelope.window}, ${Object.keys(envelope.floors).length} entries, delegation ${envelope.delegation?.enabled ? `ON (writers ${envelope.delegation.writers.join(", ")}, step ${envelope.delegation.maxStepPct}%, interval ${envelope.delegation.minIntervalHours}h)` : "OFF"}` }];
	const low = Object.entries(envelope.floors).filter(([, floor]) => floor > 0 && Number.isSafeInteger(maxCostMicros) && floor < maxCostMicros);
	if (low.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `envelope floor(s) ${low.map(([id, floor]) => `${id} (${formatMicros(floor)})`).join(", ")} are below the per-job cost cap (${formatMicros(maxCostMicros)}): each governed job reserves its whole cap against its share, so a floor that small admits no job of its own`,
			fix: "raise the floor to at least the per-job cap (PI_MAX_COST_USD), lower the cap, or set the floor to 0 if the project needs no guaranteed share",
		});
	}
	const absent = (Array.isArray(projects) ? projects : []).map((p) => p?.id).filter((id) => typeof id === "string" && id !== OTHER && envelope.floors[id] === undefined);
	if (absent.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `project(s) ${absent.join(", ")} are in projects.json and not in the envelope, so their jobs count in ${OTHER}'s share of the split`,
			fix: "add each to the envelope's floorsUsd (0 is a floor) if it should have a share of its own; leave it out if counting it with the work in no project is what you meant",
		});
	}
	return checks;
}

/**
 * Issue #504 part B: do this host's envelope and its peers' agree? `mine` is this host's `fpEnvelope` as doctor computes
 * it from the service's envelope file (`envelopeDigest`, or `none`), `peers` the registry rows of every OTHER host.
 * WARNINGS only, the fleet block's rule, but the consequence is named: a host whose digest is not the applied split's
 * refuses every governed job as `envelope-mismatch`.
 *
 *   - A peer whose `fpEnvelope` differs: the hosts judge one shared split against two envelopes, so one side refuses.
 *   - A peer with no `fpEnvelope`: a worker from before the envelope, which enforces no split at all. Said only when an
 *     envelope is in use somewhere, so a fleet without one hears nothing new on upgrade.
 * Hosts are named, never a value: the registry carries a digest.
 */
export function fleetEnvelopeChecks(mine, peers) {
	const checks = [];
	const opinions = peers.filter((h) => typeof h.fpEnvelope === "string" && h.fpEnvelope !== "");
	const differing = opinions.filter((h) => h.fpEnvelope !== mine);
	if (differing.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `Hosts disagree about the allocation envelope: ${differing.map((h) => h.name).join(", ")} ${differing.length === 1 ? "has" : "have"} ${differing.every((h) => h.fpEnvelope === NO_ENVELOPE_FINGERPRINT) ? "no envelope" : "an envelope with other numbers"}, and this host ${mine === NO_ENVELOPE_FINGERPRINT ? "has none" : `has ${mine}`}, so the hosts whose envelope is not the applied split's refuse every governed job as envelope-mismatch`,
			fix: "copy the same envelope.json to every host (PI_ENVELOPE_FILE), or unset it on every host and DEL alloc:plan alloc:envelope:expected; to make a hand edit the fleet's, copy it to every host and SET alloc:envelope:expected to its digest (doctor prints it)",
		});
	}
	const silent = peers.filter((h) => typeof h.fpEnvelope !== "string" || h.fpEnvelope === "");
	const inUse = mine !== NO_ENVELOPE_FINGERPRINT || opinions.some((h) => h.fpEnvelope !== NO_ENVELOPE_FINGERPRINT);
	if (silent.length > 0 && inUse) {
		checks.push({
			ok: false,
			warn: true,
			label: `${silent.map((h) => h.name).join(", ")} ${silent.length === 1 ? "publishes" : "publish"} no envelope digest, so ${silent.length === 1 ? "it enforces" : "they enforce"} no allocation split while the rest of the fleet does`,
			fix: "upgrade every worker on this Valkey to the same release: a worker from before the envelope reserves against the operator's caps alone",
		});
	}
	return checks;
}

/**
 * The applied split against every host (issue #504 part B). `applied` is `{ digest }`, the
 * envelope digest `alloc:plan` was made for; `mine` this host's (`none` without an envelope); `peers` the registry rows.
 * One line of facts naming the hosts that match it, and a FAILURE for this host and for each peer that does not: such a
 * host refuses every governed job as `envelope-mismatch` (a host with no envelope in a governed fleet included).
 */
export function appliedSplitChecks(applied, mine, myName, peers) {
	const TURN_OFF = "remove PI_ENVELOPE_FILE from every host, then `valkey-cli DEL alloc:plan alloc:envelope:expected`";
	// Named as the peer lines name theirs (issue #507): on a fleet each host's doctor says "this host", and the line read
	// beside another host's output did not say which host refuses.
	const me = typeof myName === "string" && myName !== "" ? `this host (${myName})` : "this host";
	const noEnvelopeHere = { ok: false, label: `${me} has no envelope while the fleet has an applied budget split (alloc:plan), so it refuses every job as envelope-mismatch`, fix: `install the fleet's envelope here (PI_ENVELOPE_FILE), or turn delegation off for the whole fleet: ${TURN_OFF}` };
	if (applied.undecodable) {
		// The key exists and is no split this build can read: a host with an envelope replaces it with the neutral split at
		// its next job, while a host without one counts it as governed and refuses.
		const checks = [{ ok: false, warn: true, label: "alloc:plan exists but is not a budget split this build can read; a host with an envelope replaces it with the neutral split at its next job", fix: `if delegation is meant to be off: ${TURN_OFF}` }];
		if (mine === NO_ENVELOPE_FINGERPRINT) checks.push(noEnvelopeHere);
		return checks;
	}
	const d = applied.digest;
	const matching = [...(mine === d ? [myName] : []), ...peers.filter((h) => h.fpEnvelope === d).map((h) => h.name)].sort();
	// Green only while some host matches: a split no host carries the envelope of refuses every governed job everywhere.
	const checks = [
		matching.length > 0
			? { ok: true, label: `Applied budget split (alloc:plan) was made for envelope ${d}: ${matching.join(", ")} ${matching.length === 1 ? "matches" : "match"} it` }
			: { ok: false, warn: true, label: `Applied budget split (alloc:plan) was made for envelope ${d}, and no host matches it`, fix: `copy that envelope to the hosts, or make another one the fleet's (copy it to every host, then \`valkey-cli SET alloc:envelope:expected <its digest>\`), or turn delegation off: ${TURN_OFF}` },
	];
	if (mine !== d) {
		checks.push(
			mine === NO_ENVELOPE_FINGERPRINT
				? noEnvelopeHere
				: { ok: false, label: `${me} carries envelope ${mine}, not the one the applied budget split was made for (${d}), so it refuses every governed job as envelope-mismatch`, fix: `copy the fleet's envelope here; or, to make this one the fleet's, copy it to every host and run \`valkey-cli SET alloc:envelope:expected ${mine}\`` },
		);
	}
	const off = peers.filter((h) => typeof h.fpEnvelope === "string" && h.fpEnvelope !== "" && h.fpEnvelope !== d);
	if (off.length > 0) {
		checks.push({
			ok: false,
			label: `${off.map((h) => h.name).join(", ")} ${off.length === 1 ? "carries" : "carry"} ${off.every((h) => h.fpEnvelope === NO_ENVELOPE_FINGERPRINT) ? "no envelope" : "another envelope"}, not the one the applied budget split was made for (${d}), so ${off.length === 1 ? "it refuses" : "they refuse"} every governed job as envelope-mismatch`,
			fix: `copy the fleet's envelope to those hosts (PI_ENVELOPE_FILE), or turn delegation off for the whole fleet: ${TURN_OFF}`,
		});
	}
	return checks;
}

/**
 * The applied split from Valkey (`alloc:plan`): `{ digest }`, `{ undecodable: true }` when the key exists and holds no
 * readable split, or null with no key or no answer.
 */
export async function defaultReadAppliedSplit(url) {
	try {
		const { makeRedisClient } = await import("./connection.mjs");
		const client = makeRedisClient(url, { failFast: true, lazyConnect: true });
		client.on("error", () => {});
		try {
			await client.connect();
			const text = await client.get(ALLOC_PLAN_KEY);
			if (text === null || text === undefined) return null;
			let digest = null;
			try {
				digest = JSON.parse(text)?.envelopeDigest;
			} catch {}
			return typeof digest === "string" && /^[0-9a-f]{16}$/.test(digest) ? { digest } : { undecodable: true };
		} finally {
			client.disconnect();
		}
	} catch {
		return null;
	}
}

/**
 * A FAILURE per scoped-limits file that holds a `project:<id>` row whose id is not a project in `projects` (issue #499
 * part B): the worker refuses to start on it, and a live reload that would create one is kept out. Rows are named by
 * index and their scope (`project:<id>`, an operator id, never a path or a name).
 */
export function projectRowChecks(limits, projects, path) {
	const dangling = danglingProjectRows(limits, projects);
	if (dangling.length === 0) return [];
	return [
		{
			ok: false,
			label: `scoped limit(s) ${dangling.map((d) => `#${d.index} (project:${d.id})`).join(", ")} in ${path} name a project that is not in the projects file -- the worker refuses to start`,
			fix: "add the project to the file PI_PROJECTS_FILE names (set the key if it is unset), or remove the row",
		},
	];
}

/**
 * The pause-windows facts (issue #498): the parsed windows when PI_PAUSE_WINDOWS_FILE is set, else none. A file that
 * does not load is the BOOT_FILES check's line, so here it only silences the advisories that read the windows.
 */
function readPauseWindowFacts(env, fileExists) {
	const path = env.PI_PAUSE_WINDOWS_FILE;
	if (typeof path !== "string" || path.trim() === "") return { windows: [], parseError: null };
	try {
		if (!fileExists(path) || !statSync(path).isFile()) return { windows: [], parseError: "unreadable" };
		return { windows: loadPauseWindows({ pauseWindowsFile: path }, { readFileSync, existsSync: fileExists }), parseError: null };
	} catch (e) {
		return { windows: [], parseError: e?.message ?? String(e) };
	}
}

/** A written scope's form (`parseScopeString`), or null for one it refuses: a fact reader classifies, never throws. */
function scopeFormOf(scope) {
	try {
		return parseScopeString(scope).type;
	} catch {
		return null;
	}
}

/**
 * The dollar settings (issue #501), read from env with the worker's own parser (`money.mjs`), so doctor and
 * the boot refusal cannot disagree. Silent when nothing is set. Each setting that does not parse, a window
 * without the per-job cap, and every trigger
 * whose `run.maxCostUsd` is above `PI_MAX_COST_USD`: a FAILURE when the worker loads the triggers file
 * (`workerReadsTriggers`, it refuses to start on it), a warning otherwise (the job still runs under the
 * smaller cap, so the higher one is a value that reads as allowed and is not).
 */
/**
 * The merged-values half of the dollar invariant (issue #501, PR #542's review): `overlay` over `env`, the worker's
 * own merge, checked by the worker's own rule. Returns the reason, or null when it holds, or when env ALONE already
 * breaks it (that is `dollarChecks`' line, and the worker refuses to start on it).
 */
export function overlayDollarProblem(overlay, env) {
	const fromEnv = {};
	for (const key of DOLLAR_SETTING_KEYS) {
		const raw = env?.[DOLLAR_ENV_NAMES[key]];
		if (raw !== undefined && raw !== "") fromEnv[key] = raw;
	}
	if (checkDollarInvariant(fromEnv) !== null) return null;
	const merged = { ...fromEnv };
	for (const key of DOLLAR_SETTING_KEYS) if (overlay?.[key] !== undefined && overlay[key] !== null) merged[key] = overlay[key];
	return checkDollarInvariant(merged)?.invalid ?? null;
}

/**
 * The scoped-limits dollar rows (issues #501 part 5, #502 part 6) against the deployment's per-job cap, WARNINGS only
 * (PR #549's review). With no per-job cap, a dollar row refuses every job it applies to as `config-refused` unless the
 * job's trigger sets `run.maxCostUsd`. With one, a row window BELOW it refuses every job it applies to, every time
 * (a job reserves its whole cap), until one of the two changes. Rows are named by index and kind, and only the caps
 * are compared, never a scope string (a folder scope is a host path). `maxCostUsd` is the merged value or undefined;
 * one that does not parse is `dollarChecks`' line, so this says nothing more.
 */
export function scopedDollarRowChecks(limits, maxCostUsd, path) {
	const checks = [];
	const label = (r) => `#${r.index} (${r.kind === "model" ? "a model row" : r.kind === "project" ? "a project row" : "a repo or folder row"})`;
	const missing = dollarRowsWithoutCap(limits, maxCostUsd);
	if (missing.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `scoped limit(s) ${missing.map(label).join(", ")} in ${path} set a dollar window, but the deployment has no per-job cost cap (maxCostUsd) -- every job such a row applies to is refused as config-refused unless its trigger sets run.maxCostUsd`,
			fix: "set PI_MAX_COST_USD in .env (or maxCostUsd in the overlay), or give each trigger that reaches the row a run.maxCostUsd",
		});
	}
	let below = [];
	try {
		below = dollarRowsBelowJobCap(limits, maxCostUsd);
	} catch {
		return checks;
	}
	if (below.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `scoped limit window(s) ${below.map((r) => `${label(r)} ${r.window}`).join(", ")} in ${path} are below the per-job cost cap (maxCostUsd) -- a job reserves its whole cap, so every job that reaches such a window is refused dollar-cap, every time`,
			fix: "raise the window to at least maxCostUsd, or lower maxCostUsd (a trigger's smaller run.maxCostUsd also fits)",
		});
	}
	return checks;
}

export function dollarChecks(env, costCaps, workerReadsTriggers) {
	const envName = DOLLAR_ENV_NAMES;
	const checks = [];
	const values = {};
	for (const key of DOLLAR_SETTING_KEYS) {
		const raw = env[envName[key]];
		if (raw === undefined || raw === "") continue;
		try {
			optionalUsdMicros(raw, envName[key]);
			values[key] = raw;
		} catch (error) {
			checks.push({ ok: false, label: `${error.message} -- the worker refuses to start`, fix: `set ${envName[key]} to a plain dollar amount such as 2.50, or remove it` });
		}
	}
	const broken = checkDollarInvariant(values);
	if (broken) {
		const window = DOLLAR_SETTING_KEYS.find((key) => key !== "maxCostUsd" && values[key] !== undefined);
		checks.push({ ok: false, label: `${envName[window]} is set without PI_MAX_COST_USD -- the worker refuses to start`, fix: "a dollar window reserves each job's per-job cap, so set PI_MAX_COST_USD too" });
	}
	if (values.maxCostUsd !== undefined) {
		const deployment = parseUsdMicros(values.maxCostUsd, "PI_MAX_COST_USD");
		for (const cap of costCaps.filter((c) => parseUsdMicros(c.maxCostUsd, "run.maxCostUsd") > deployment)) {
			checks.push({
				ok: false,
				...(workerReadsTriggers ? {} : { warn: true }),
				label: workerReadsTriggers
					? `${cap.label}: run.maxCostUsd is above PI_MAX_COST_USD -- the worker refuses to start (a trigger can only narrow the per-job cost cap)`
					: `${cap.label}: run.maxCostUsd is above PI_MAX_COST_USD -- its jobs run under PI_MAX_COST_USD anyway (a trigger can only narrow the per-job cost cap)`,
				fix: "lower that trigger's run.maxCostUsd to PI_MAX_COST_USD or below, or remove it",
			});
		}
	}
	return checks;
}

/**
 * Issue #501 part 6: do this host's dollar caps match its peers'? `mine` is this host's `fpUsd` as doctor computes it
 * from the service's settings (`deploymentSettingsOf`, `usdFingerprint`), `peers` the registry rows of every OTHER
 * host. WARNINGS only, never a failure, the fleet block's rule: this command runs on one machine and must not refuse
 * a deployment for a condition that machine cannot fix.
 *
 *   - A peer whose `fpUsd` differs: the dollar counters are shared, so the host with the larger cap admits a job the
 *     other would refuse, and each host's view of "full" is its own.
 *   - A peer with no `fpUsd` (or an empty one): it runs a worker from before hosts published one, so whether it holds
 *     the same caps is unknown. Said only when dollar caps are in use somewhere: this host's fingerprint, or any
 *     peer's, is not the empty one, or else a dollar counter (`budget:usd:*`) exists on this Valkey
 *     (`dollarKeysExist`, asked only then). The counters are the one trace a capped host that publishes nothing
 *     leaves (PR #551's review: an old capped host beside a new uncapped one was silent). A fleet that never used a
 *     dollar setting hears nothing new on upgrade.
 *
 * Hosts are named, never their caps: the registry carries a digest, so "different" is all a reader can know.
 */
export async function fleetDollarChecks(mine, peers, { dollarKeysExist = async () => false } = {}) {
	const checks = [];
	const opinions = peers.filter((h) => typeof h.fpUsd === "string" && h.fpUsd !== "");
	const differing = opinions.filter((h) => h.fpUsd !== mine);
	if (differing.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `Hosts disagree about the dollar caps: ${differing.map((h) => h.name).join(", ")} ${differing.length === 1 ? "judges" : "judge"} the shared dollar counters against a different per-job cap, dollar windows, scoped-limits dollar rows or PI_ALLOWED_MODELS than this host's settings`,
			fix: "set PI_MAX_COST_USD, PI_DAILY_COST_USD, PI_WEEKLY_COST_USD, PI_MONTHLY_COST_USD, the overlay's dollar keys, the scoped-limits file's dollar rows and PI_ALLOWED_MODELS (it picks the model rows a job without its own list reserves in) alike on every host: the counters are shared, so a host with a larger cap admits a job another would refuse. An env change needs a restart; an overlay or scoped-limits edit shows within one beat",
		});
	}
	const silent = peers.filter((h) => typeof h.fpUsd !== "string" || h.fpUsd === "");
	if (silent.length === 0) return checks;
	let inUse = mine !== EMPTY_USD_FINGERPRINT || opinions.some((h) => h.fpUsd !== EMPTY_USD_FINGERPRINT);
	let byCounters = false;
	if (!inUse) {
		byCounters = (await Promise.resolve().then(dollarKeysExist).catch(() => false)) === true;
		inUse = byCounters;
	}
	if (inUse) {
		checks.push({
			ok: false,
			warn: true,
			label: `${silent.map((h) => h.name).join(", ")} ${silent.length === 1 ? "publishes no fingerprint of its" : "publish no fingerprint of their"} dollar caps, so whether ${silent.length === 1 ? "it holds" : "they hold"} the same caps as this host is unknown${byCounters ? " (no host that publishes one sets a dollar cap, but dollar counters exist on this Valkey, so some host reserved dollars recently)" : ""}`,
			fix: "upgrade every worker on this Valkey to the same release: a worker from before hosts compared their dollar caps may judge the shared dollar counters against other caps, or reserve no dollars at all",
		});
	}
	return checks;
}

/**
 * Issue #499 part C: do this host's projects match its peers'? `mine` is this host's `fpProjects` as doctor computes it
 * from the service's projects file (`projectsFingerprint`), `peers` the registry rows of every OTHER host. WARNINGS
 * only, the fleet block's rule.
 *
 *   - A peer whose `fpProjects` differs: each host resolves a job's project from its own copy, so one repo can be in
 *     two projects, or in a project on one host and in none on another, depending on which host ran the job. Its runs
 *     are then recorded under two ids and counted against two project rows (or none), while the counters are shared.
 *   - A peer with no `fpProjects` (or an empty one): it runs a worker from before hosts published one. Said only when
 *     projects are in use somewhere (this host's fingerprint, or any peer's, is not the one of no projects), so a
 *     fleet that never used a projects file hears nothing new on upgrade.
 *
 * Hosts are named, never a project's members or name: the registry carries a digest, so "different" is all a reader
 * can know.
 */
export function fleetProjectsChecks(mine, peers) {
	const checks = [];
	const opinions = peers.filter((h) => typeof h.fpProjects === "string" && h.fpProjects !== "");
	const differing = opinions.filter((h) => h.fpProjects !== mine);
	if (differing.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `Hosts disagree about the projects: ${differing.map((h) => h.name).join(", ")} ${differing.length === 1 ? "reads" : "read"} a projects.json with other ids or members than this host's, so a run is recorded under, and counted against, a different project depending on which host ran it`,
			fix: "copy the same projects.json to every host (PI_PROJECTS_FILE): the project rows' counters are shared, and each host decides a job's project from its own copy. An edit shows within one beat",
		});
	}
	const silent = peers.filter((h) => typeof h.fpProjects !== "string" || h.fpProjects === "");
	const inUse = mine !== EMPTY_PROJECTS_FINGERPRINT || opinions.some((h) => h.fpProjects !== EMPTY_PROJECTS_FINGERPRINT);
	if (silent.length > 0 && inUse) {
		checks.push({
			ok: false,
			warn: true,
			label: `${silent.map((h) => h.name).join(", ")} ${silent.length === 1 ? "publishes no fingerprint of its" : "publish no fingerprint of their"} projects, so whether ${silent.length === 1 ? "it reads" : "they read"} the same projects.json as this host is unknown`,
			fix: "upgrade every worker on this Valkey to the same release: a worker from before hosts compared their projects records no project and counts no project row",
		});
	}
	return checks;
}

/**
 * The runner's own input overhead (`BOUND_OVERHEAD_TOKENS`, image/runner/src/usage-meter.mjs), which its bound adds to
 * every call. Copied, because the worker package does not ship the runner; `doctor.test.mjs` holds the two equal.
 */
export const FIRST_CALL_OVERHEAD_TOKENS = 8192;
/**
 * The least a job's FIRST call carries before its task, in bytes: pi 0.99.1's default system prompt (1,753 bytes) and
 * the schemas of its four default tools (2,712 bytes) serialise to 4,465 bytes, and PR #542's lab measured 10,667 for
 * a short task. 4,096 is below both, so the bound below stays a lower bound for a job that adds nothing.
 */
export const FIRST_CALL_MIN_CONTEXT_BYTES = 4096;

/**
 * A LOWER BOUND, in integer micro-dollars, on what the runner's cost guard (`callCostBound`) reserves for a job's
 * first call on `model`, or null when this cannot say. The guard refuses a call when its bound would pass the cap, so
 * a per-job cap below this number can never admit a call on the model: with the main model, the job makes no call at
 * all (PR #542's lab: the default model's first call was bounded at $1.03 under a $1 cap).
 *
 * The guard's bound is (request bytes + 8,192) x the dearest input rate + the output limit x the dearest output rate,
 * times a service-tier multiplier, over the model's table, its tiers and its fallbacks. This takes the parts of that
 * which cannot be smaller: the model's own table (not its tiers or fallbacks, which only raise the bound), the output
 * limit `model.maxTokens` (pi sends none of its own, so the guard uses the model's), an input of the overhead plus
 * `FIRST_CALL_MIN_CONTEXT_BYTES`, and the runner's own service-tier multiplier (`serviceTierMultiplier`). The input
 * rate is the guard's: the highest of input, cache read and cache write (not the 1h write, which needs long
 * retention). Null for a table or limit it cannot read.
 */
export function firstCallFloorMicros(model) {
	const cost = model?.cost;
	const usable = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
	if (!cost || !["input", "output", "cacheRead", "cacheWrite"].every((field) => usable(cost[field]))) return null;
	const maxTokens = model.maxTokens;
	if (!(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0)) return null;
	const inputRate = Math.max(cost.input, cost.cacheRead, cost.cacheWrite);
	return Math.ceil(((FIRST_CALL_OVERHEAD_TOKENS + FIRST_CALL_MIN_CONTEXT_BYTES) * inputRate + maxTokens * cost.output) * serviceTierMultiplier(model));
}

/**
 * The runner's service-tier multiplier (`callCostBound` step 7, image/runner/src/usage-meter.mjs), copied like the
 * overhead above: pi multiplies a settled cost by the tier the RESPONSE reports on these two apis, which can be the
 * account's default rather than the request's, so the runner always bounds at the dearest tier. Leaving it out
 * (PR #551's review) let doctor stay silent on a cap the runner refuses every call under: openai/gpt-5.5 under $5.
 * `fleet-dollars.test.mjs` derives the runner's multiplier from its own bound for every priced api and holds this
 * equal to it.
 */
export function serviceTierMultiplier(model) {
	if (model?.api !== "openai-responses" && model?.api !== "openai-codex-responses") return 1;
	return model.id === "gpt-5.5" ? 2.5 : 2;
}

/**
 * The model object the floor above is computed from: the builtin catalog's (`builtinModel`, model-catalog.mjs), or a
 * CUSTOM model the overlay `models.json` defines (its own `cost` and `maxTokens`). Null, so the model is not judged,
 * when the overlay redefines or overrides a builtin model: pi composes the two, and this does not copy that rule.
 */
export function boundModelOf({ provider, id }, { builtinModel, overlay = null }) {
	const providers = overlay?.providers;
	const entry = providers !== null && typeof providers === "object" && !Array.isArray(providers) && Object.hasOwn(providers, provider) ? providers[provider] : null;
	const builtin = builtinModel(provider, id);
	if (entry !== null && typeof entry === "object") {
		const overrides = entry.modelOverrides;
		if (overrides !== null && typeof overrides === "object" && Object.hasOwn(overrides, id)) return null;
		const definition = Array.isArray(entry.models) ? entry.models.find((m) => m !== null && typeof m === "object" && m.id === id) : undefined;
		if (definition !== undefined) return builtin ? null : definition;
	}
	return builtin;
}

/**
 * Who runs on which models under which cap (issues #501 and #502), as the worker resolves a job: the deployment's own
 * default, then every trigger. `deployment` is `{ provider, model, maxCostUsd }` (overlay over env,
 * `deploymentSettingsOf`); `runs` the trigger facts; `envList` the parsed `PI_ALLOWED_MODELS`, or null. Each subject
 * is `{ label, main, list, cap, secretNames, named }`: `main` and `list` are `{ provider, id }`, `list` is the
 * trigger's `run.models` or else the env list, `cap` the effective per-job cap in micro-dollars (the smaller of the
 * trigger's and the deployment's, `effectiveCostCapMicros`) or null, and `named` says the trigger names a provider, a
 * model or a list of its own.
 */
export function modelSubjects({ runs = [], deployment, envList = null }) {
	const listOf = (list) => (Array.isArray(list) ? list.map(splitModelEntry).filter((ref) => ref !== null).map((ref) => ({ provider: ref.provider, id: ref.model })) : []);
	const capOf = (triggerValue) => {
		try {
			return effectiveCostCapMicros(triggerValue, deployment.maxCostUsd);
		} catch {
			return null; // a deployment cap that does not parse is `dollarChecks`' line
		}
	};
	const subjects = [{ label: "the deployment default", main: { provider: deployment.provider, id: deployment.model }, list: listOf(envList), cap: capOf(undefined), secretNames: [], named: false, deployment: true }];
	for (const run of runs) {
		subjects.push({
			label: run.label,
			main: { provider: run.provider ?? deployment.provider, id: run.model ?? deployment.model },
			list: listOf(run.models ?? envList),
			cap: capOf(run.maxCostUsd),
			secretNames: run.secretNames ?? [],
			named: run.provider !== undefined || run.model !== undefined || run.models !== undefined,
		});
	}
	return subjects;
}

/**
 * The `provider/id` of every model a job under a per-job dollar cap may use (the main model and the list, as
 * `modelSubjects` resolves them), for the overlay's output-cap line to leave to `costCapFitChecks` (issue #507). Empty
 * when the settings cannot be read.
 */
export function cappedModelNames(env, { runs, deployment }) {
	let envList = null;
	try {
		envList = allowedModelsFrom(env);
	} catch {
		// A malformed PI_ALLOWED_MODELS is its own line.
	}
	const names = new Set();
	for (const s of modelSubjects({ runs, deployment, envList })) {
		if (s.cap === null || s.cap === undefined) continue;
		for (const ref of [s.main, ...s.list]) names.add(`${ref.provider}/${ref.id}`);
	}
	return names;
}

/**
 * Issue #501's open question, answered with a warning: a per-job cap below one full-output call of the main model,
 * or of a listed model, is a cap the runner can never admit that call under (`firstCallFloorMicros`). One line,
 * grouped by model and cap so a deployment default every trigger inherits is named once.
 *
 * Issue #507: `unboundable(ref)` says the runner cannot bound the model's output at all (`outputUnboundable`,
 * output-cap.mjs: openai-completions to a server off the trusted hosts without `compat.maxTokensField: "max_tokens"`),
 * so every call to it is refused under any cap. Such a model gets a line of its own, grouped by model, and no floor.
 */
export function costCapFitChecks(subjects, modelOf, { unboundable = () => false } = {}) {
	const groups = new Map();
	const unbounded = new Map();
	for (const s of subjects) {
		if (s.cap === null || s.cap === undefined) continue;
		const seen = new Set();
		for (const ref of [s.main, ...s.list]) {
			const name = `${ref.provider}/${ref.id}`;
			if (seen.has(name)) continue;
			seen.add(name);
			if (unboundable(ref)) {
				if (!unbounded.has(name)) unbounded.set(name, { main: false, labels: [] });
				const u = unbounded.get(name);
				u.main ||= ref === s.main;
				u.labels.push(s.label);
				continue;
			}
			const floor = firstCallFloorMicros(modelOf(ref));
			if (floor === null || s.cap >= floor) continue;
			const main = ref === s.main;
			const key = `${name}\u0000${s.cap}\u0000${main}`;
			if (!groups.has(key)) groups.set(key, { name, floor, cap: s.cap, main, labels: [] });
			groups.get(key).labels.push(s.label);
		}
	}
	const out = [];
	if (unbounded.size > 0) {
		const items = [...unbounded].map(([name, u]) => `${printable(name)}${u.main ? " (the main model, so such a job makes no call at all)" : ""} (${u.labels.join(", ")})`);
		out.push({
			ok: false,
			warn: true,
			label: `A job under a per-job cost cap may use a model whose output cap travels as max_completion_tokens to a server that may ignore it (one outside pi's own hosted providers), so the runner counts every call to it unboundable and refuses it under the cap: ${items.join("; ")}`,
			fix: "set \"compat\": { \"maxTokensField\": \"max_tokens\" } on the model or its provider in models.json, or set its cost to zeros if it is free: docs/egress.md, \"Local model servers\"",
		});
	}
	if (groups.size === 0) return out;
	const items = [...groups.values()].map((g) => `${printable(g.name)}${g.main ? " (the main model, so such a job makes no call at all)" : ""} needs at least $${formatMicros(g.floor)} a call under a $${formatMicros(g.cap)} cap (${g.labels.join(", ")})`);
	return [
		...out,
		{
			ok: false,
			warn: true,
			label: `The per-job cost cap is below one full-output call of a model a job may use, so the runner refuses every call to that model before it is sent: ${items.join("; ")}`,
			fix: "raise PI_MAX_COST_USD (or the trigger's run.maxCostUsd) above the amount named, or use a model with a smaller output limit. The amount is a lower bound: the runner's own bound adds the whole request, so a cap just above it can still refuse a call",
		},
	];
}

/**
 * Issue #502 part 2: a trigger whose model, or a model on its list, the worker's free gate would refuse, asked of the
 * worker's own gate (`checkModelsKnown`, model-catalog.mjs) with the overlay `models.json` it reads. Every trigger kind,
 * cron included, and only triggers that name a provider, a model or a list of their own: a trigger that names none
 * runs on the deployment's settings, which get one line of their own (the deployment subject). An overlay that cannot be read just now
 * (`unavailable`) says nothing: the worker retries such a job.
 */
export function unknownModelChecks(subjects, checkModelsKnown, readOverlay) {
	const unknown = [];
	const fallbacks = [];
	const checks = [];
	// The deployment's own default model and PI_ALLOWED_MODELS (PR #551's review): a typo there refuses every job
	// whose trigger names neither, so it gets a line of its own, worded for the settings that hold it.
	for (const s of subjects.filter((x) => x.deployment === true)) {
		const verdict = checkModelsKnown([{ ...s.main, main: true }, ...s.list], { readOverlay });
		const ref = verdict?.unknown ?? verdict?.fallbackUnlisted;
		if (!ref) continue;
		// A broken overlay is the overlay lines' to name (they say every job is refused); blaming .env here would send
		// the operator to the wrong file (PR #551's review, round 2).
		if (verdict.unknown && typeof verdict.why === "string" && verdict.why.startsWith("overlay-")) continue;
		checks.push({
			ok: false,
			warn: true,
			label: verdict.unknown
				? `The deployment's default model (PI_PROVIDER/PI_MODEL, or the panel's provider/model) or a model on PI_ALLOWED_MODELS is one this deployment does not know: ${printable(`${ref.provider}/${ref.id}`)} (${verdict.why}), so every job whose trigger names no model of its own is refused before it starts (model-unknown)`
				: `A model on PI_ALLOWED_MODELS declares server-side fallbacks the list does not name: ${printable(`${ref.provider}/${ref.id}`)}, so every job whose trigger names no list of its own is refused before it starts (model-not-allowed)`,
			fix: verdict.unknown ? "fix the id in .env (or the panel's model setting): the worker knows pi's builtin catalog at its pin and the models the overlay models.json declares" : "add that model's fallback models to PI_ALLOWED_MODELS, under the same provider, or remove it",
		});
	}
	for (const s of subjects) {
		if (!s.named) continue;
		const verdict = checkModelsKnown([{ ...s.main, main: true }, ...s.list], { readOverlay });
		if (verdict?.unknown) unknown.push(`${s.label}: ${printable(`${verdict.unknown.provider}/${verdict.unknown.id}`)} (${verdict.why})`);
		else if (verdict?.fallbackUnlisted) fallbacks.push(`${s.label}: ${printable(`${verdict.fallbackUnlisted.provider}/${verdict.fallbackUnlisted.id}`)}`);
	}
	if (unknown.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `${unknown.length} trigger(s) name a model this deployment does not know, so every job of them is refused before it starts (model-unknown): ${unknown.join("; ")}`,
			fix: "fix the provider or model id: the worker knows pi's builtin catalog at its pin and the models the overlay models.json declares. not-in-catalog is a typo or a model only an extension defines (declare it in the overlay models.json); an overlay reason names the file as the problem",
		});
	}
	if (fallbacks.length > 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `${fallbacks.length} trigger(s) list a model whose server-side fallbacks are not on the list, so every job of them is refused before it starts (model-not-allowed): ${fallbacks.join("; ")}`,
			fix: "list that model's fallback models too, under the same provider, or remove it from the list",
		});
	}
	return checks;
}

/**
 * Issue #502's open question, answered with a warning: only the main provider's key is resolved for a job; any other
 * provider on its list needs a key that arrives by `run.secrets` or `PI_FORWARD_ENV`. A listed provider with neither
 * starts the job and then fails the first call to it, after the budget is reserved. The names looked for are pi's
 * own (`candidatesOf`, the provider oracle), or the variable the overlay's `apiKey` for that provider references.
 * Said nothing about a provider it cannot judge: no names at all (Bedrock reads the AWS chain), the keyless marker
 * (#503), or an `apiKey` that is not a variable reference.
 */
export function listedProviderCredentialChecks(subjects, { candidatesOf, forwarded = [], env = {}, overlay = null }) {
	const providers = overlay?.providers;
	const namesFor = (provider) => {
		const entry = providers !== null && typeof providers === "object" && !Array.isArray(providers) && Object.hasOwn(providers, provider) ? providers[provider] : null;
		const apiKey = entry !== null && typeof entry === "object" ? entry.apiKey : undefined;
		if (typeof apiKey === "string" && apiKey !== "") {
			if (apiKey === KEYLESS_API_KEY) return [];
			const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(apiKey);
			return ref ? [ref[1]] : [];
		}
		return candidatesOf(provider) ?? [];
	};
	const missing = new Map();
	for (const s of subjects) {
		for (const provider of new Set(s.list.map((ref) => ref.provider))) {
			if (provider === s.main.provider) continue;
			const names = namesFor(provider);
			if (names.length === 0) continue;
			if (names.some((n) => s.secretNames.includes(n) || (forwarded.includes(n) && typeof env[n] === "string" && env[n] !== ""))) continue;
			if (!missing.has(provider)) missing.set(provider, { names, labels: [] });
			missing.get(provider).labels.push(s.label);
		}
	}
	if (missing.size === 0) return [];
	const items = [...missing.entries()].map(([provider, m]) => `${printable(provider)} (${m.labels.join(", ")}; looked for ${m.names.join(" or ")})`);
	return [
		{
			ok: false,
			warn: true,
			label: `A provider on an allowed-model list, other than the job's main one, has no credential this deployment hands its jobs, so a call to it fails inside the container, after the job started: ${items.join("; ")}`,
			fix: "only the main provider's key is resolved for a job. Bind another provider's key with run.secrets on the trigger, or name it in PI_FORWARD_ENV and set it in .env; or take the provider off the list",
		},
	];
}

/**
 * The deployment's provider, model and dollar settings as the worker resolves them for a job: the overlay over env
 * (`resolveSettings`), falling back to env when the overlay is invalid or the merged dollar values break the
 * invariant, which is the fallback `start.mjs` takes for its slot count and its `fpUsd`. Values as written; nothing
 * here throws.
 */
export function deploymentSettingsOf(env, settingsFile, fileExists) {
	const fromEnv = { provider: env.PI_PROVIDER ?? DEFAULT_PROVIDER, model: env.PI_MODEL ?? DEFAULT_MODEL };
	for (const key of DOLLAR_SETTING_KEYS) {
		const raw = env[DOLLAR_ENV_NAMES[key]];
		fromEnv[key] = raw === undefined || raw === "" ? null : raw;
	}
	let read;
	try {
		read = fileExists(settingsFile) ? readOverlay(settingsFile) : { overlay: {} };
	} catch {
		return fromEnv;
	}
	const resolved = resolveSettings(fromEnv, read);
	if (resolved.invalid) return fromEnv;
	return Object.fromEntries(Object.keys(fromEnv).map((key) => [key, resolved[key] ?? null]));
}

/** The worker's model catalog (model-catalog.mjs), imported lazily for `defaultProviderOracle`'s reason, or null. */
async function defaultModelCatalog() {
	try {
		return await import("./model-catalog.mjs");
	} catch {
		return null;
	}
}

/** pi's own model loader (pi-model-loader.mjs), imported lazily like the catalog, or null. */
async function defaultPiModelLoader() {
	try {
		const { loadPiModelLoader } = await import("./pi-model-loader.mjs");
		return await loadPiModelLoader();
	} catch {
		return null;
	}
}

/** The `provider/id` pairs a models.json text declares, read leniently: a file pi drops still names ids worth asking about. */
function declaredOverlayModels(text) {
	// Read as pi reads text (BOM, comments and trailing commas stripped; PR #551's review: plain JSON.parse found no
	// model in a JSONC overlay), without pi's schema, so a file pi refuses still names ids worth asking about.
	let doc = parseModelsJson(text).value;
	if (doc === undefined || doc === null) {
		try {
			doc = JSON.parse(stripJsonComments(stripBom(text)));
		} catch {
			return [];
		}
	}
	const out = [];
	const providers = doc?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return out;
	for (const [provider, entry] of Object.entries(providers)) {
		if (entry === null || typeof entry !== "object") continue;
		for (const m of Array.isArray(entry.models) ? entry.models : []) if (typeof m?.id === "string" && m.id !== "") out.push([provider, m.id]);
	}
	return out;
}

/**
 * Issue #502's open question: does pi's own loader read the overlay `models.json` as the worker's catalog does? The
 * worker admits or refuses a job by its copy of pi's rules (`parseModelsJson`, `checkModelsKnown`); pi decides what
 * runs. A disagreement is a model the worker calls known that pi lacks (a paid job that exits 2) or the reverse (a
 * working model refused), and either is a defect in the copy or a pi beside the worker that is not the image's. Asked
 * per file (loads or not) and per declared model. `pi` is `defaultPiModelLoader`'s answer, or null.
 */
export async function overlayLoaderParityChecks(modelsPath, { pi, checkModelsKnown, readText = (p) => readFileSync(p, "utf8") }) {
	if (pi === null || pi === undefined) {
		return [{ ok: true, label: "Overlay models.json was not compared with pi's own loader: pi-coding-agent is not installed beside the worker (a checkout of this repository has it after npm ci)" }];
	}
	// Only the pinned pi speaks for the job image (PR #551's review): a global layout can put any pi beside the worker.
	if (typeof pi.pinned !== "string" || pi.version !== pi.pinned) {
		return [{ ok: true, label: `Overlay models.json was not compared with pi's own loader: pi ${printable(String(pi.version))} beside the worker is not the worker's pinned pi-ai ${typeof pi.pinned === "string" ? printable(pi.pinned) : "(pin unknown)"}` }];
	}
	let text;
	let theirs;
	try {
		text = readText(modelsPath);
		theirs = await pi.read(modelsPath);
	} catch (error) {
		return [{ ok: false, warn: true, label: `Overlay models.json could not be compared with pi ${printable(String(pi.version))}'s own loader (${printable(String(error?.code ?? error?.message ?? "error"))})`, fix: "re-run doctor; if it persists, report it with the error" }];
	}
	const parsed = parseModelsJson(text);
	const ours = parsed.error === undefined;
	const readOverlay = () => {
		if (parsed.error !== undefined) throw Object.assign(new Error(parsed.error), { piDispatchConfig: true });
		return parsed.value;
	};
	const items = [];
	if (theirs.loads !== ours) items.push(`pi ${theirs.loads ? "loads the file and the worker refuses it" : "drops the file and the worker reads it"}`);
	const declared = declaredOverlayModels(text);
	for (const [provider, id] of declared) {
		const piHas = theirs.has(provider, id) === true;
		const workerHas = checkModelsKnown([{ provider, id, main: true }], { readOverlay })?.ok === true;
		if (piHas !== workerHas) items.push(`${printable(`${provider}/${id}`)}: pi ${piHas ? "has it" : "lacks it"}, the worker calls it ${workerHas ? "known" : "unknown"}`);
	}
	if (items.length > 0) {
		return [
			{
				ok: false,
				warn: true,
				label: `pi ${printable(String(pi.version))}'s own loader and the worker's model catalog disagree about overlay models.json: ${items.join("; ")}`,
				fix: "the worker gates jobs by its own reading of this file and pi decides what runs, so a model the worker knows and pi lacks is a paid job that exits 2, and the reverse is a working model refused. Report it with the file's shape (not its keys); until then, avoid the construct named",
			},
		];
	}
	return [{ ok: true, label: `Overlay models.json reads the same in pi ${printable(String(pi.version))}'s own loader as in the worker's model catalog (${declared.length} declared model(s))` }];
}

/**
 * How a line names its trigger: cron entries by their id, id-less webhook entries by raw file position (the admin's
 * trigger:<index> identity). One function, because the flow lines and the venue lines must name a trigger alike.
 */
function triggerLabel(t, index) {
	return t.on.type === "cron" ? `cron "${t.on.id}"` : `${t.on.type} trigger #${index}`;
}

function readTriggerFacts(env, fileExists, cwd, declaredWorkerName) {
	const none = { requiring: 0, waiting: 0, listing: 0, waitProfiles: [], waitAfters: [], optingOut: 0, resuming: 0, replicating: 0, instructing: 0, commands: 0, secreting: 0, onceArmed: 0, onceSpent: 0, secretProfiles: [], localSecretFolders: [], secretNames: [], folders: [], images: [], imageRoutes: [], namedBackends: [], skillsDirs: [], forges: [], repositories: [], flows: [], costCaps: [], modelRuns: [], parseError: null, path: null };
	try {
		// Unset falls back to ./triggers.json in cwd, MIRRORING the receiver's own default
		// (receiver/src/config.mjs) -- the two must read the same file, or doctor preflights a deployment
		// the receiver will not boot. An absent file still means "no triggers at all", exactly as before.
		const path = triggersPath(env, cwd);
		if (!fileExists(path)) return none;
		// The same regular-file guard, for the same reason: this read is unbounded too, and a triggers path
		// naming a FIFO hangs the command with no output and no timeout that can reach it.
		if (!statSync(path).isFile()) return { ...none, parseError: `triggers file is not a regular file: ${path}`, path };
		const text = readFileSync(path, "utf8");
		const triggers = parseTriggers(text, path);
		// The one-shot facts are counted from the RAW entries, not the parsed records, because the
		// validator collapses a disarmed entry to a sentinel that carries neither `once` nor
		// `disarmed` -- exactly so nothing can match it -- which also erases it from every parsed
		// count above. Doctor is the surface that must still SEE the spent entry: "why did nothing
		// fire" is answered by a spent row, and only the raw file still holds it. Safe unguarded:
		// parseTriggers just accepted this same text, so JSON.parse cannot throw here.
		const rawEntries = JSON.parse(text)?.triggers ?? [];
		// Issue #433 review rounds 2 and 3: whether THIS HOST'S WORKER schedules a cron trigger, for the unblessed-venue
		// line, by the worker's two conditions and nothing else. (a) The worker schedules cron only from a PI_TRIGGERS_FILE
		// it was given (`config.triggersFile` is null without one, and `loadSchedules` then returns []), while doctor
		// falls back to ./triggers.json for everything else it reads; so without the variable no cron trigger is judged.
		// (b) Its placement, by the worker's own predicate (`cronPlacement`): judged unless it is `"elsewhere"`, another
		// machine's folder on a fleet. A single host's absent folder is `"refused"`, the worker's boot refusal, and is
		// still judged. Round 2 ran the whole `loadSchedules` instead and caught its throw as "judge everything", which let
		// one served trigger's bad skillsDir bring back the false line for another machine's trigger: a predicate per
		// trigger cannot be derailed by a sibling.
		// The name collectChecks resolved (issue #464), never this shell's alone.
		const fleet = Boolean(declaredWorkerName);
		const cronScheduledHere = (t) => env.PI_TRIGGERS_FILE !== undefined && cronPlacement(t.run, { existsSync: fileExists, fleet }) !== "elsewhere";
		return {
			onceArmed: rawEntries.filter((t) => t?.on?.once === true && t.on.disarmed === undefined).length,
			onceSpent: rawEntries.filter((t) => t?.on?.disarmed !== undefined).length,
			requiring: triggers.filter((t) => t.run.packages === true).length,
			resuming: triggers.filter((t) => t.run.resume === true).length,
			// REQ-PER-TRIGGER-INSTRUCTION. Counted beside `resuming` for the same reason: it is a per-trigger
			// choice that changes what every job of it is told, and an operator should see it before it fires.
			instructing: triggers.filter((t) => typeof t.run.instructions === "string").length,
			// REQ-REPLICA-RUNS. `> 1` rather than `!== undefined` because the loader already refuses anything
			// else -- this counts triggers that will actually multiply spend, which is the only reason to say so.
			replicating: triggers.filter((t) => t.run.replicas > 1).length,
			// run.command triggers (issue #189), counted for the one advisory line below. The `flows`
			// tuple list already filters to `typeof f.flow === "string"`, so a command trigger drops out
			// of the flow-tier probes naturally -- no exclusion needed there.
			commands: triggers.filter((t) => typeof t.run.command === "string").length,
			// REQ-TRIGGER-SECRETS. Counted beside `instructing` for its reason: a per-trigger choice that
			// changes what every job of it can reach, and one that lives only in triggers.json.
			secreting: triggers.filter((t) => t.run.secrets !== undefined).length,
			// The distinct profile NAMES the file selects, deduped like `images`/`skillsDirs`: the checks below
			// cost a stat each, and two triggers naming one profile are one question. `default` is substituted
			// for an absent field so the table answers what the worker will actually look up.
			secretProfiles: [...new Set(triggers.filter((t) => t.run.secrets !== undefined).map((t) => t.run.secretsProfile ?? "default"))].sort(),
			// LOCAL triggers that bind secrets, by folder. A local job's /workspace IS this folder, bind-mounted
			// read-write with no clone, so a credential an agent writes into .env lands in the operator's real
			// repository rather than a temp dir that gets swept. Deduped for skillsDirs' reason.
			localSecretFolders: [...new Set(triggers.filter((t) => t.run.secrets !== undefined && t.run.kind === "local" && typeof t.run.folder === "string").map((t) => t.run.folder))].sort(),
			// Issue #309. The distinct variable NAMES the file binds, deduped like the profiles above. The
			// pre-spend gate refuses a name pi reads for the job's provider, and unlike the version that gate
			// replaced, that question no longer needs host state to answer -- so doctor can answer it at setup
			// rather than leaving the operator to meet it as a public refusal on a live job.
			secretNames: [...new Set(triggers.filter((t) => t.run.secrets !== undefined).flatMap((t) => Object.keys(t.run.secrets)))].sort(),
			// Issue #242: every local run.folder, CANONICALIZED the way the scoped-limits matcher
			// canonicalizes a job's folder (one derivation -- canonicalScope, never re-spelled here), so
			// the unreferenced-scope advisory compares like with like across spelling variants.
			folders: [...new Set(triggers.filter((t) => t.run.kind === "local" && typeof t.run.folder === "string").map((t) => canonicalScope({ kind: "local", folder: t.run.folder })))].sort(),
			// Issue #230. How many triggers hold their jobs, and the distinct profile NAMES they select --
			// deduped like `secretProfiles` and for its reason: each name costs a lookup, and two triggers
			// waiting on one profile are one question.
			waiting: triggers.filter((t) => Array.isArray(t.run.waitFor) && t.run.waitFor.length > 0).length,
			// Issue #502: how many triggers name an allowed-model list, for the version-floor line.
			listing: triggers.filter((t) => Array.isArray(t.run.models) && t.run.models.length > 0).length,
			// The `after` instants as WRITTEN, deduped. Not parsed here: `readTriggerFacts` is a fact reader and
			// the ceiling it is measured against is env, which belongs at the check. Two triggers naming one
			// instant are one finding, and the raw string is what the operator has to go and edit.
			waitAfters: [...new Set(triggers.flatMap((t) => (Array.isArray(t.run.waitFor) ? t.run.waitFor : [])).map((c) => c?.after).filter((v) => typeof v === "string"))].sort(),
			waitProfiles: [
				...new Set(
					triggers
						.filter((t) => Array.isArray(t.run.waitFor))
						.flatMap((t) => t.run.waitFor.map((c) => c?.profile).filter((n) => typeof n === "string")),
				),
			].sort(),
			optingOut: triggers.filter((t) => t.run.packages === false).length,
			images: [...new Set(triggers.map((t) => t.run.image).filter((i) => typeof i === "string"))].sort(),
			// Issue #433: each image with the venue its trigger names (undefined: the deployment default), so the image is
			// asked of the runtime its jobs start on. The worker's own shape (`{ backend }`), for `resolveBackendName`.
			imageRoutes: triggers.filter((t) => typeof t.run.image === "string").map((t) => ({ image: t.run.image, backend: t.run.backend })),
			// Issue #433 review round 1: every trigger that NAMES a venue, with the label the lines below name it by, so
			// doctor can say which of them this deployment does not bless (the worker refuses each of their jobs).
			namedBackends: triggers
				.map((t, index) => ({ label: triggerLabel(t, index), backend: t.run.backend, served: t.on.type !== "cron" || cronScheduledHere(t) }))
				.filter((r) => typeof r.backend === "string"),
			// REQ-PER-TRIGGER-SKILLS. The distinct host directories the file names, deduped like `images`,
			// because the checks below cost a filesystem walk each and two triggers sharing a directory are one
			// question.
			skillsDirs: [...new Set(triggers.map((t) => t.run.skillsDir).filter((d) => typeof d === "string"))].sort(),
			// The forges this file actually needs credentials for. Read from the triggers rather than from
			// the env, so the check answers "is what you configured enough for what you wrote" instead of
			// "did you set some variables".
			//
			// `isForgeKind` rather than a written-out pair: this whole function is wrapped in `catch { return
			// none }`, so a forge missing from a hand-written filter would not merely be unchecked -- doctor
			// would report all-green and never mention that the credential it needs was never looked for.
			forges: [...new Set(triggers.map((t) => t.run.kind).filter(isForgeKind))].sort(),
			repositories: [...new Set(triggers.filter((t) => t.run.kind === "github" && typeof t.run.repository === "string").map((t) => t.run.repository))].sort(),
			// REQ-PER-TRIGGER-SKILLS (issue #189). Per-trigger TUPLES, unlike every deduped set above,
			// because a flow-resolution answer depends on the trigger's own folder/skillsDir/packages --
			// two triggers naming the same flow with different skillsDirs are two different questions.
			// The label is how a line names its trigger: cron entries by their id, id-less webhook
			// entries by raw file position (the admin's trigger:<index> identity).
			flows: triggers
				.map((t, index) => ({
					label: triggerLabel(t, index),
					flow: t.run.flow,
					kind: t.run.kind,
					folder: typeof t.run.folder === "string" ? t.run.folder : null,
					skillsDir: typeof t.run.skillsDir === "string" ? t.run.skillsDir : null,
					packages: t.run.packages !== false,
				}))
				.filter((f) => typeof f.flow === "string"),
			// Issue #501: every trigger that sets run.maxCostUsd, with the label the cap check names it by. The value
			// already parsed (the loader validated it), so the check below only compares.
			costCaps: triggers.map((t, index) => ({ label: triggerLabel(t, index), maxCostUsd: t.run.maxCostUsd })).filter((r) => r.maxCostUsd !== undefined && r.maxCostUsd !== null),
			// Issues #501 and #502 (PR 9 of that round): every trigger's model choice, list, cap and bound secret NAMES, for the
			// unknown-model, cap-fit and listed-provider credential lines. Every kind, cron included, whatever host serves it:
			// a model the worker does not know is refused wherever the job runs.
			modelRuns: triggers.map((t, index) => ({
				label: triggerLabel(t, index),
				provider: typeof t.run.provider === "string" ? t.run.provider : undefined,
				model: typeof t.run.model === "string" ? t.run.model : undefined,
				models: Array.isArray(t.run.models) ? t.run.models : undefined,
				maxCostUsd: t.run.maxCostUsd ?? undefined,
				secretNames: t.run.secrets !== undefined && t.run.secrets !== null ? Object.keys(t.run.secrets) : [],
			})),
			// Explicit on the success path too (issue #242): the dead-scope advisory distinguishes
			// "facts read clean" (path set, no error) from the zeroed `none` -- an implicit undefined
			// here made that test silently false for every deployment.
			parseError: null,
			path,
		};
	} catch (e) {
		// REPORTED, not swallowed. This catch used to justify itself with "a malformed triggers file already
		// fails LOUD at worker boot", and that premise does not hold: the worker reads the file only when
		// PI_TRIGGERS_FILE is set, so a receiver-only deployment gets no loud failure anywhere. Worse, the
		// zeroes below silently disarm the WEBHOOK_SECRET check, every per-forge credential check, the
		// per-image checks and the flow-tier probes -- so doctor came back GREENER than a healthy
		// deployment, which is the one direction a preflight must never fail in.
		//
		// The counts stay zero, because every downstream check reads them and a half-parsed file has no
		// honest counts to give. What changes is that the reason travels with them.
		// Only a TAGGED config refusal is reported. parseTriggers throws `piDispatchConfig` errors; anything
		// else here is an fs failure on a path the guard above already said existed (a race, a permission,
		// a directory), which is not a statement about the file's CONTENT and has no fix an operator can act
		// on from this line. Those keep the old silent zeroes.
		if (e?.piDispatchConfig !== true) return none;
		return { ...none, parseError: e.message, path: triggersPath(env, cwd) };
	}
}

/**
 * The triggers file the worker reads, and the path a parse failure names. Unset is `./triggers.json` in the deployment
 * folder (the receiver's default). A RELATIVE PI_TRIGGERS_FILE resolves against doctor's `cwd`, the deployment folder,
 * exactly as the worker's own read does (issue #471): `loadSchedules` hands the value to `readFileSync` as written, so
 * it lands under the process's working directory, which is the service's `WorkingDirectory=`, the deployment folder.
 * Doctor resolved it against its own process's directory instead, so a `cwd` seam aimed elsewhere judged another file.
 * An empty value stays empty: the worker refuses to boot on it (no such file), and doctor then finds no file either.
 */
export function triggersPath(env, cwd) {
	const raw = env.PI_TRIGGERS_FILE;
	if (raw === undefined) return join(cwd, "triggers.json");
	return raw === "" || isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * EVERY LINE THIS SWEEP CAN PRINT, in one frozen table, with its tier, its fix and its wording.
 *
 * What this replaces (issue #379, item 3) is a test that COUNTED occurrences of ``label: `Egress canary: ``
 * in this file's source and required `docs/egress.md` to carry a matching number. Its own comment recorded
 * why it was written that way and what it could not see: a constant holding the prefix, a plain
 * double-quoted string, `label:` on its own line, an interpolation inside the phrase, or a label built in
 * another module -- all invisible. It could also go FALSE RED, because this file's house style quotes its
 * own output in comments, so a comment naming the prefix told its author to rewrite their prose. Two
 * cleverer versions were tried and recorded there: a raw-source count introduced the false red at scale, and
 * stripping comments to fix that introduced a false GREEN at thirty times the scale, because the
 * block-comment regex treated the `/*` inside `mv ${legacy}/logs/*` as an opener and deleted 88 lines of
 * live code before counting.
 *
 * A doc test that PARSES a page or a source file is an arms race the page wins. So a test rebuilds the
 * page's rows FROM this table and requires them to match between markers, exactly as `PODMAN-REFUSAL-TEXTS`
 * is checked -- and the checks themselves carry `canary: { shape, params }`, so another test drives the real
 * sweep and compares each line to what this table would have produced for it. Neither reads source text.
 */
export const CANARY_LINES = Object.freeze({
	unlisted: {
		tier: "warn",
		fix: () => CANARY_LEFTOVER_FIX,
		label: ({ prefix, bin = "docker" }) => `leftovers from an EARLIER doctor run could not be listed: ${bin} network ls --filter name=${prefix}`,
	},
	foreign: {
		tier: "warn",
		fix: () => CANARY_FOREIGN_FIX,
		label: ({ name, cliSays, bin = "docker" }) => `${name} may be left over from an EARLIER doctor run, and is not swept because this shell's ${bin} CLI ${cliSays}, so a pid that is dead here may be alive there`,
	},
	unreadable: {
		tier: "warn",
		fix: () => CANARY_LEFTOVER_FIX,
		// The READ that failed, per runtime (issue #452): Podman's members come from `ps -a --filter network=`, since 4.9's
		// `network inspect` renders no member list, so pointing a Podman operator at the inspect would show them nothing.
		label: ({ name, bin = "docker" }) => `the network ${name} could not be read: ${bin === "podman" ? `${bin} ps -a --filter network=${name}` : `${bin} network inspect ${name}`}`,
	},
	kept: {
		tier: "warn",
		fix: () => CANARY_LEFTOVER_FIX,
		label: ({ name, stuck, bin = "docker" }) => `${name} is kept, because the probe ${stuck.join(", ")} could not be removed and the network is the only way left to find it: ${bin} rm -f ${stuck.join(" ")}`,
	},
	removed: {
		tier: "ok",
		fix: () => null,
		label: ({ name, after }) => `removed ${name}${after ? ` (${after})` : ""}, left by an EARLIER doctor run`,
	},
	gone: {
		tier: "ok",
		fix: () => null,
		label: ({ name, did }) => `${did} on ${name}, left by an EARLIER doctor run; the network itself is gone`,
	},
	notRemoved: {
		tier: "warn",
		fix: () => CANARY_LEFTOVER_FIX,
		label: ({ name, command }) => `the network ${name} could not be removed: ${command}`,
	},
	// Issue #452, gate round 3: the detach gate refused, so nothing was detached and the network is left whole. `because` is
	// `detachBlockedSentence`'s clause, which names the runtime's CLI.
	held: {
		tier: "warn",
		fix: () => CANARY_HELD_FIX,
		label: ({ name, because }) => `${name} is kept with what is running on it, because ${because}`,
	},
});

/** What to do about a `held` leftover: the keeper first, then doctor again, which removes it. */
const CANARY_HELD_FIX = "start the rootless network keeper as docs/podman.md step 6 shows (pi-dispatch service install or pi-dispatch up installs it), then re-run doctor, which removes the network once the keeper holds";

/**
 * One canary check, built from the table and CARRYING what it was built from.
 *
 * `canary: { shape, params }` is the seam the tests use: they drive the real sweep over the real scenarios
 * and compare every `Egress canary:` line to `CANARY_LINES[shape].label(params)`, so a line that drifts from
 * the table is caught by construction rather than by a regex over prose.
 *
 * `venue` (issue #431) is the runtime the canary ran on. docker's is the default and adds nothing, so its params, its
 * line and its fix are exactly what they were; another runtime's CLI name rides the params (the table's labels read
 * `bin`, defaulting to docker, which is also what `docs/egress.md`'s generated rows are built with) and its prefix leads
 * the line, so a podman line is never mistaken for one about docker's proxy.
 */
function canaryCheck(shape, params, venue = CANARY_DOCKER) {
	const spec = CANARY_LINES[shape];
	const fix = spec.fix();
	const carried = venue.bin === "docker" ? params : { ...params, bin: venue.bin };
	return { ok: spec.tier === "ok", ...(spec.tier === "warn" ? { warn: true } : {}), label: `${venue.prefix}Egress canary: ${spec.label(carried)}`, ...(fix ? { fix: forRuntime(fix, venue.bin) } : {}), canary: { shape, params: carried } };
}

/**
 * The argv that removes a canary probe container by name, per runtime (issue #431, review).
 *
 * podman's carries `--time=0`: its `rm -f` of a running container first waits the container's stop timeout, 10 s by
 * default, before SIGKILL (measured 10.1 s on Podman 5.8.1, with its "resorting to SIGKILL" warning), which is the
 * whole of `CANARY_STEP_TIMEOUT_MS`. So a wedged probe read as "could not be removed" and its network was kept, on
 * exactly the path the removal exists for. `-t, --time` is in `podman rm` 4.9.3 (cmd/podman/containers/rm.go, "Seconds
 * to wait for stop before killing the container", accepted only beside `--force`), the oldest Podman this project runs
 * on in CI. Not a longer step bound instead: the teardown must not be the slow part of a doctor run, and a probe here
 * is doctor's own throwaway container, so there is nothing a grace period could let it finish.
 *
 * docker's is what it always was: `docker rm -f` sends SIGKILL at once, and its argv is pinned byte for byte.
 */
function canaryProbeRemoval(bin, name) {
	return bin === "podman" ? ["rm", "-f", "--time=0", name] : ["rm", "-f", name];
}

/** The docker venue's canary words: its CLI, and no prefix, which is every canary line as it was before issue #431. */
const CANARY_DOCKER = Object.freeze({ bin: "docker", prefix: "" });
/** The podman venue's (issue #431): its CLI, and the `podman: ` its section's lines all carry. */
const CANARY_PODMAN = Object.freeze({ bin: "podman", prefix: "podman: " });

/** A CLI's canary words: the two above by name, and any other runtime's CLI as the prefix of its own lines. */
function canaryVenueFor(bin) {
	return bin === "podman" ? CANARY_PODMAN : bin === "docker" ? CANARY_DOCKER : { bin, prefix: `${bin}: ` };
}

/**
 * A fix written for docker, for another runtime: its CLI's name wherever the text names a command. The same rule as
 * `liveFailFix`, and docker's text is returned untouched.
 */
function forRuntime(text, bin) {
	return bin === "docker" ? text : text.replace(/\bdocker\b/g, bin);
}

/**
 * Canary networks an EARLIER doctor run left behind (issue #350), for a PID no longer alive. Not "a run that
 * did not finish": a run that finishes normally leaves one whenever its own teardown `network rm` fails, and
 * #360 item 5 records a second producer. What this sweep knows is that the pid in the name is not alive.
 *
 * UNLIKE `sweepStaleNetworks` in live-probes.mjs, an attached PROBE here is not a run in progress, and that
 * inversion is the whole of this function. There, a live-probe container on a peer network means a read-back
 * that has not ended, so the network is left alone. Here the process that would have been watching it is
 * already dead, so a probe still on the network IS the leak: the measured shape is a wedged proxy holding the
 * probe past the 30 s bound, the bound killing the docker CLI rather than the container, and the container
 * keeping the network alive forever after.
 *
 * Anchored on the name, and only for a dead pid: a network this doctor made is its own business, and one whose
 * pid is still alive belongs to a doctor that is still running.
 *
 * EXPORTED for `.github/scripts/podman-conformance.mjs` (issue #452), which leaves a canary network behind on a real
 * rootless Podman and runs THIS sweep over it, so the member read it depends on is exercised on the Podman the
 * required CI job runs rather than only on the lab's. `bin` names the runtime for a caller outside this file, which
 * has no venue constant to hand in; doctor's own two callers pass `venue`.
 */
export async function sweepStaleCanaryNetworks({ run, pid, isAlive, endpoint, bin = "docker", venue = canaryVenueFor(bin), gate = makeDetachGate(run, { bin: venue.bin }) }) {
	// ONE QUESTION: can this shell show the daemon is on this host? Only `local === true` can, so remote and
	// unknown take the same branch. The whole endpoint is passed rather than that boolean because the line
	// this sweep prints for a daemon it will not touch now NAMES what the CLI resolved, the way
	// `credentialTransit` and the in-image `gh` probe already do, and a boolean cannot carry that.
	const owned = endpoint?.local === true;
	// NO CREDENTIAL, because `endpoint` is what `makeDockerEndpointResolver` stored, which is
	// `classifyDockerEndpoint`'s `display` and therefore already through `displayEndpoint` (issue #340). The
	// raw `DOCKER_HOST` can carry `user:password@`, and this is a doctor line an operator pastes into a
	// support thread. If a future resolver ever stores the raw host, this leaks: pinned by a test that hands
	// the sweep an endpoint with a password in it.
	//
	// THAT IS THE ONLY THING `displayEndpoint` GUARANTEES, and it is not the only thing this line needs: it
	// returns a host with no `@` VERBATIM, so nothing upstream keeps a carriage return, a CSI sequence or a
	// right-to-left override out of an operator's terminal. `endpointShown` is what does, by QUOTING rather
	// than removing, and its own docblock carries the two measurements that rule out stripping. An earlier
	// comment here credited docker's URL parser instead, having measured the write path while doctor reads.
	const cliSays = endpoint?.local === false ? `resolves ${endpointShown(endpoint)}, which is not shown to be on this host` : `did not say which daemon it uses (${endpoint?.reason ?? "not asked"})`;
	const listed = await run(["network", "ls", "--filter", `name=${EGRESS_CANARY_NET_PREFIX}`, "--format", "{{.Name}}"]);
	// THE LISTING ALWAYS RUNS, on any daemon. The reason the sweep is confined to a daemon this host owns is
	// `isAlive`, whose answer is about THIS process table -- reading a list is not. Asking first is what lets
	// this say nothing at all on the overwhelmingly common case of a host with no leftovers, instead of a
	// warning about a category of object it never looked for. `doctor`'s own doctrine: a check nobody can
	// silence must never cry wolf, and "could not ask" is not "misconfigured".
	if (listed?.code !== 0) return [canaryCheck("unlisted", { prefix: EGRESS_CANARY_NET_PREFIX }, venue)];
	const shape = new RegExp(`^${EGRESS_CANARY_NET_PREFIX}(\\d+)$`);
	// The slug is a CLOSED set, not free text: accepting `\\S+` there would `rm -f` any container under this
	// prefix that happened to end in the dead pid. Escaped into the pattern because the pid reached it as a
	// string from a name we matched, and a name is not a number. The set is read from CANARY_PROBE_SLUGS,
	// which the probe loop names its own containers from: two literals in two places is how a third direction
	// gets added to the producer and not to the reaper.
	//
	// ASYMMETRY ON PURPOSE, recorded because it looks like an oversight three characters apart: the OWNER is
	// escaped and the slugs are interpolated raw. `CANARY_PROBE_SLUGS` is a frozen literal of three plain words
	// three lines below, so today there is nothing to escape and escaping it would say the set is untrusted
	// when it is this file's own. It is here so that whoever adds a slug with a `.` or a `-` in it sees the
	// obligation: a metacharacter there widens what this `rm -f` matches (issue #360, item 6).
	//
	// The model endpoint probes (issue #503) are matched the same way, their slugs from `ENDPOINT_PROBE_SLUGS` and the id
	// by the parser's own rule (`MODEL_ENDPOINT_ID_RE`, its anchors dropped), never `\\S+`: a name that matches is one
	// this file builds, and the class cannot drift from what the parser accepts.
	const probeOf = (owner) => new RegExp(`^(?:${EGRESS_CANARY_PROBE_PREFIX}(?:${CANARY_PROBE_SLUGS.join("|")})|${EGRESS_ENDPOINT_PROBE_PREFIX}(?:${ENDPOINT_PROBE_SLUGS.join("|")})-${ENDPOINT_ID_CLASS})-${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
	const checks = [];
	for (const name of String(listed.stdout ?? "").split("\n").map((n) => n.trim()).filter(Boolean)) {
		const m = shape.exec(name);
		if (!m) continue;
		// The matched TEXT is the identity for the probe names; the number is only for the liveness ask. A pid
		// with leading zeros, or one long enough that `Number` renders it in exponential form, must not become
		// a different string on the way to a regex.
		const ownerText = m[1];
		const owner = Number(ownerText);
		// Not ours to judge: `isAlive` would be answering about a different machine's process table. Say what
		// is there, once something IS there, and leave it to the doctor that owns that daemon.
		if (!owned) {
			// MAY be left over, not IS: the clause four words later already says the pid may be alive there, so
			// the sentence used to assert a thing and then walk it back inside itself. This is a network whose
			// owner this shell cannot ask about at all, which is exactly the case where doctor states less.
			checks.push(canaryCheck("foreign", { name, cliSays }, venue));
			continue;
		}
		// pid 0 is the process GROUP to `kill(0)`, so it always reads alive; such a network is left, not taken.
		//
		// OUR OWN PID IS SWEPT, and that is not a contradiction. This runs BEFORE the canary creates anything,
		// and one host cannot have two live processes under one pid, so a network already carrying our pid
		// cannot be ours: it was left by an earlier process that the OS has since reused the number for. It is
		// in fact the ONE value here that is certainly stale. Skipping it, which the first draft did in the
		// belief it was protecting a concurrent run, left that network to block our own `network create` and
		// take the whole egress read-back down silently, measured.
		if (!Number.isSafeInteger(owner) || (owner !== pid && isAlive(owner))) continue;
		const { ok, names, absent, parked = [] } = await networkEndpoints(run, name, { bin: venue.bin });
		if (absent) continue;
		if (!ok) {
			// The command that FAILED, which is this file's convention for a label, and it was the wrong one
			// here: a `network rm` is advice, it never ran, and it is advice about a network whose membership
			// is by definition unknown -- removing it could strand a probe nothing else can find. The advice
			// stays in the fix, where advice belongs.
			checks.push(canaryCheck("unreadable", { name }, venue));
			continue;
		}
		// The dead run's own probes are REMOVED, everything else is merely detached -- the proxy is shared and
		// long-lived, and a stranger on a network in this namespace is not ours to delete.
		// RESIDUAL ON DOCKER, same as `live-probes.mjs`'s and measured under #337: `names` holds RUNNING endpoints,
		// so a probe in `created` state is missing from it and the removal below would succeed and strand it. Not
		// guarded, and the reason is the line above: only a DEAD pid's network is touched here, and a dead
		// process is not mid-launch.
		//
		// CLOSED ON PODMAN (issue #452): its read also returns `parked`, the members in every other state, and they
		// are handled exactly as the running ones are -- a parked probe of this run removed, anything else parked
		// detached. Both halves are needed there and not on docker, because Podman's `network rm` refuses while a
		// member in ANY state remains (measured on 4.9.3 and 5.8.1): a stopped probe, or a proxy that has since
		// stopped, would otherwise hold the network and print `notRemoved` on every run. Docker's read carries no
		// `parked`, so its pass is what it was.
		const members = [...names, ...parked];
		// Recorded only when it TOOK, the same rule `removeNetworkOrSay` applies to `detached` -- a ✓ claiming a
		// probe was removed while it is still running is worse than no line. One that did NOT go stays in the
		// detach list, so it is at least taken off the network rather than falling between the two.
		const removed = [];
		const stuck = [];
		for (const endpoint of members.filter((n) => probeOf(ownerText).test(n))) {
			if ((await run(canaryProbeRemoval(venue.bin, endpoint)))?.code === 0) removed.push(endpoint);
			else stuck.push(endpoint);
		}
		// THE NETWORK IS THE ONLY HANDLE. Nothing in this project ever enumerates `pi-dispatch-egress-probe-`
		// containers -- the name exists to be built and matched, not searched for -- so removing the network
		// out from under a probe we could not kill orphans that container permanently, and an earlier draft
		// did exactly that behind a ✓. Detaching it first is no better: it is still running, and now nothing
		// points at it. So the network stays, and the line names the container to remove by hand.
		if (stuck.length > 0) {
			checks.push(canaryCheck("kept", { name, stuck }, venue));
			continue;
		}
		// Through the ONE detach helper (issue #452, gate round 3), with `names` as the running members: a refusal leaves
		// the network whole and is said as `held`, on every venue and through every route to Podman.
		const outcome = await removeNetworkOrSay(run, { network: name, detach: members.filter((n) => !removed.includes(n)), running: names, bin: venue.bin, gate });
		if (outcome.blocked) {
			checks.push(canaryCheck("held", { name, because: detachBlockedSentence(outcome.blocked, venue.bin) }, venue));
			continue;
		}
		// `" and "` between the two clauses, for the reason given at the vanished-network line below: each half
		// is itself a comma-separated list, so a comma between them marks no boundary. This is the COMMON
		// line, and it kept the defect for a round after its rarer sibling was fixed.
		const after = [removed.length > 0 ? `after removing ${removed.join(", ")}` : null, outcome.detached.length > 0 ? `detaching ${outcome.detached.join(", ")}` : null].filter(Boolean).join(" and ");
		// "an EARLIER run", not "a run that did not finish", which both of these lines used to say and neither
		// could support: a doctor run that finishes normally leaves this network behind whenever its own
		// teardown `network rm` fails, and says so in a warning of its own, and issue #360 item 5 records a
		// second producer (a `network create` killed by a signal after the daemon had already made it). The
		// only thing the sweep knows is that the pid in the name is not alive now.
		if (outcome.removed && !outcome.absent) checks.push(canaryCheck("removed", { name, after }, venue));
		// THE NETWORK WENT BETWEEN OUR OWN COMMANDS, and the silence that covers is only a silence about the
		// NETWORK: one the daemon says is not there is not worth a line, which is the rule this sweep shares
		// with the boot reaper. What this pass DID is a different fact. It existed, we did it, and saying
		// nothing left an operator with probes gone and endpoints cut loose and no line accounting for either
		// (issue #360).
		//
		// BOTH VERBS, not just the removals. The first version of this branch named `removed` alone, so a
		// stranger force-detached off the network -- which is the act `INT-EGRESS-POLICY-CONTRACT` promises
		// is always named -- went unreported, and with no probe of ours to remove there was no line at all.
		// `${name}` is the OBJECT of the sentence rather than its subject, because it is the one thing here
		// that is not news. "IS gone", not "was ALREADY gone": this pass may be the reason. `liveRunVia`
		// answers `{ code: null }` when the 10 s bound kills the CLI, which `removeNetworkOrSay` reads as a
		// removal that did not happen even though the daemon may already have acted, so "already" would
		// attribute this run's own work to somebody else. And a detach is recorded only on exit 0, so naming
		// one asserts the network was there while this pass worked on it.
		else if (outcome.absent) {
			// JOINED WITH "and", not a comma: both halves are themselves comma-separated lists, so a comma
			// between them gave `removed a, b, detached c, d` with nothing marking where one list ended.
			const did = [removed.length > 0 ? `removed ${removed.join(", ")}` : null, outcome.detached.length > 0 ? `detached ${outcome.detached.join(", ")}` : null].filter(Boolean).join(" and ");
			if (did) checks.push(canaryCheck("gone", { name, did }, venue));
		} else checks.push(canaryCheck("notRemoved", { name, command: outcome.command }, venue));
	}
	return checks;
}

/**
 * Issue #508: with the egress policy on, a forge must be served over https on port 443, the one shape a job's git reaches
 * it by. git never uses the job's proxy for an `http://` remote: the job gets the proxy variables in UPPERCASE only, and
 * libcurl ignores `HTTP_PROXY` for `http://` (measured in the job image, git 2.39.5: `git ls-remote http://...` went to
 * DNS, and the proxy saw nothing), so an http:// forge fails behind the `--internal` network on ANY port, 80 included.
 * An `https://` remote is a CONNECT, which the proxy refuses to any port but 443 (a rule older than #508). The clone
 * itself runs on the host before the container exists, so it is the job's git push and fetch that fail, and its API
 * calls too unless the forge is on port 80: glab and tea (Go) do use `HTTP_PROXY` for `http://`, and the proxy passes
 * plain HTTP to a listed host on port 80 (round 3 of #508's review). Any other scheme reaches nothing. One ⚠
 * per such URL, for a forge the triggers file names; nothing with the policy off or unreadable (the .env check reports
 * a malformed PI_EGRESS).
 */
export function forgeUrlEgressChecks(env, forges = []) {
	let armed;
	try {
		armed = egressArmed(env);
	} catch {
		return [];
	}
	if (armed !== true) return [];
	const checks = [];
	for (const [forge, key] of [["gitlab", "GITLAB_URL"], ["forgejo", "FORGEJO_URL"]]) {
		if (!forges.includes(forge) || typeof env[key] !== "string") continue;
		let url;
		try {
			url = new URL(env[key].trim());
		} catch {
			continue;
		}
		// The WHATWG parser drops a default port, so an empty port on https: is 443.
		if (url.protocol === "https:" && url.port === "") continue;
		const why =
			url.protocol === "https:"
				? `https:// on port ${url.port}, and the egress proxy refuses a CONNECT to any port but 443, so with the egress policy on every job's push, fetch and API call to it fails`
				: url.protocol === "http:"
					? `http://, so with the egress policy on a job's git push and fetch fail (git never sends http:// through the proxy)${url.port === "" ? "" : `, and on port ${url.port}, not 80, its API calls fail too`}`
					: "not an https:// URL, so with the egress policy on a job cannot reach it";
		checks.push({
			ok: false,
			warn: true,
			label: `${key} (${urlShown(env[key])}) is ${why} (issue #508)`,
			fix: `serve the forge over https:// on port 443 and point ${key} there, or set PI_EGRESS=0 if you accept jobs without the policy (docs/egress.md)`,
		});
	}
	return checks;
}

/** The canary's three probes. ONE list: the loop names its containers from it and the sweep matches on it. */
export const CANARY_PROBE_SLUGS = Object.freeze(["provider", "unlisted", "plainhttp"]);

/** Where the job image's runner keeps the module its own provider call goes through (issue #427). */
export const EGRESS_CANARY_RUNNER_MODULE = "/app/image/runner/src/env-proxy.mjs";
/** The canary's exit code for an image with no such module: a runner from before issue #427, or not this project's. */
export const EGRESS_CANARY_STALE_RUNNER = 4;

/**
 * The canary's in-container script: the RUNNER's path to the network, then one request. It was a plain `fetch`, which
 * proved the operator's image honours NODE_USE_ENV_PROXY and nothing about the runner: loading pi takes that proxy
 * away again, and a plain `fetch` never loads pi, so this line read "reaches the provider" while every egress-armed job
 * went direct and died at its first turn (issue #427). Now it loads pi exactly as the runner does and lets the runner's
 * own module restore the proxy. Exit 0 reached, 3 blocked, 4 an image with no such module (neither direction is then a
 * reading of the policy), anything else not run: a module that is there but fails to load is 5, never 4, so a broken
 * image is not told it is merely old. What this proves is that the runner's module and pi together route a request
 * through the proxy, not that `run-job.mjs` calls it, or calls it early enough: the job image contract job runs the real
 * entrypoint for that, and `image/runner/test/env-proxy.test.mjs` pins where the call sits. The URL rides argv, not the spawn env,
 * and the difference from the in-image `gh` probe is deliberate: that one carries a TOKEN, which must never be visible
 * in `ps`. This carries a public hostname, so argv is the honest place for it.
 */
export function egressCanaryScript(url) {
	return `import(${JSON.stringify(EGRESS_CANARY_RUNNER_MODULE)}).then(m=>m.loadPiThenRestore(),e=>{console.log("error",e.code??e.message);process.exit(e.code==="ERR_MODULE_NOT_FOUND"?${EGRESS_CANARY_STALE_RUNNER}:5)}).then(()=>fetch(${JSON.stringify(url)},{method:"POST"}).then(r=>{console.log("reached",r.status);process.exit(0)},e=>{console.log("blocked",e.cause?.code??e.message);process.exit(3)}),e=>{console.log("error",e.message);process.exit(5)})`;
}

/**
 * The third probe's in-container script (issue #508): ONE plain forward request, `GET <absolute url>`, written straight
 * to `proxyUrl`, which the caller passes as `egressProxyUrl(proxy)`: the value both venues' probe argv put in
 * HTTPS_PROXY. Passed rather than read from the container's environment because this file's text is pinned to read no
 * environment by name outside the resolver (issue #471), and a script string is text. Raw `node:http` with `agent: false`, and NOT the
 * runner's route (`loadPiThenRestore`, `fetch`): those tunnel every origin, so they would send a CONNECT, which is
 * the path the other two probes read, never the plain one a curl or a package manager takes. Exit 3 only for squid's
 * own refusal (403 with an `X-Squid-Error` of ERR_ACCESS_DENIED), 0 for any other answer (the request went on: a 400
 * from a TLS port spoken to in clear, or squid's 502 when the far end hung up, both mean the proxy let it through),
 * and 5 for a proxy that could not be spoken to or never answered, which is no reading at all.
 */
export function egressCanaryPlainScript(url, { proxyUrl, timeoutMs = 15_000 } = {}) {
	return `import("node:http").then(h=>{let p,u;try{p=new URL(${JSON.stringify(String(proxyUrl))});u=new URL(${JSON.stringify(url)})}catch(e){console.log("error",e.message);process.exit(5)}const q=h.request({host:p.hostname,port:p.port||80,method:"GET",path:u.href,headers:{Host:u.host},agent:false,timeout:${Number(timeoutMs)}},r=>{const x=String(r.headers["x-squid-error"]??"");r.resume();if(r.statusCode===403&&x.startsWith("ERR_ACCESS_DENIED")){console.log("blocked",r.statusCode,x);process.exit(3)}console.log("reached",r.statusCode,x);process.exit(0)});q.on("timeout",()=>{console.log("error","timeout");process.exit(5)});q.on("error",e=>{console.log("error",e.code??e.message);process.exit(5)});q.end()},e=>{console.log("error",e.message);process.exit(5)})`;
}

/**
 * The bound on one canary docker step. Shorter than the 30 s the PROBES get, because these are `network`
 * calls that either answer at once or are wedged, and the teardown must not be the slow part of a doctor run.
 */
const CANARY_STEP_TIMEOUT_MS = 10_000;

/** A leftover on a daemon this host cannot show it owns: the operator decides, because only they know the estate. */
const CANARY_FOREIGN_FIX = "check whether that process is still running on the host that daemon belongs to, and remove the network there once it is not: `docker network rm <name>`";

/** One fixed text for a canary that could not start. The policy may be fine; what is missing is the PROOF. */
const CANARY_UNPROVED_FIX = "re-run doctor; the policy itself may be fine, but nothing here has shown that it is. `docker network ls --filter name=pi-dispatch-egress-doctor-` lists any leftover blocking it";

/** One fixed text for a canary leftover, because the COMMAND is in the label and only the advice belongs here. */
const CANARY_LEFTOVER_FIX = "remove whatever is still on it first (a probe container under `pi-dispatch-egress-probe-`), then the network. A later `pi-dispatch doctor` on this host clears a leftover whose process has exited, but not one a container is still holding: that one waits for you";

function statIsDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Issue #484: one copy of the proxy's rules against the installed package's (`judgeProxyConfCopy`), as the line doctor
 * prints, or null for nothing to say. SILENT when the two are identical, and when the copy is absent, since whatever
 * mounts it reports that already (docker: the missing-file and directory lines; podman: the proxy's own state line).
 *
 * ⚠, never ✗, for a copy that differs: a differing copy still starts a proxy that enforces the allowlist, and the
 * difference may be an edit the operator made on purpose, which nothing here can tell from an upgrade that left the
 * file behind. The fix therefore names both readings: the refresh, and `diff` to see which one this is.
 *
 * Seams: `readProxyConf(path)` reads the copy (the real disk by default, as `proxyFilesExist` does, since the shared
 * `fileExists` answers yes to everything in most tests) and `readPackagedProxyConf()` the package's.
 */
function proxyConfCopyCheck({ path, name, seams, skip = () => false, refresh }) {
	const { readProxyConf = (p) => readFileSync(p, "utf8"), readPackagedProxyConf: readPackaged = readPackagedProxyConf } = seams;
	if (skip()) return null;
	const judged = judgeProxyConfCopy({ path, read: readProxyConf, readPackaged });
	if (judged.state === "absent" || judged.state === "same") return null;
	if (judged.state === "no-package") {
		return { ok: false, warn: true, label: `${name} could not be compared with the package's copy, which could not be read (${PACKAGED_EGRESS_PROXY_CONF}: ${judged.error})`, fix: "the installed package is missing a file it ships; reinstall it (`npm i -g @edgehero/pi-dispatch`, or the way it was installed), then re-run doctor" };
	}
	if (judged.state === "unreadable") {
		return { ok: false, warn: true, label: `${name} could not be read (${judged.error}), so whether it matches ${packageCopyName()} is not known`, fix: `make ${path} readable by this account, then re-run doctor` };
	}
	return {
		ok: false,
		warn: true,
		label: `${name} differs from ${packageCopyName()} (${judged.summary}), so the egress proxy runs rules this version did not ship`,
		fix: `an upgrade does not rewrite it, so this is either an older version's rules or your own edit: \`diff ${path} ${PACKAGED_EGRESS_PROXY_CONF}\` shows which. To take this version's, ${refresh}. Leave it if the difference is yours (hosts belong in egress-allowlist.conf, which no refresh touches)`,
	};
}

/**
 * REQ-EGRESS-ALLOWLIST. What the shipped egress policy actually is on this host, read back from docker
 * rather than assumed from the compose file that was supposed to create it.
 *
 * Returns [] when `PI_EGRESS=0`, so a deployment that declined the policy gets byte-identical output --
 * the same convention envSetupChecks follows one feature over. Armed is the DEFAULT, so most deployments
 * see these lines.
 *
 * TIERING, and it is the whole editorial judgement here. The proxy's PRESENCE is a hard failure when the
 * policy is armed: the worker refuses every job pre-spend without it, so a ✓ would be a lie and a ⚠ would
 * under-report a deployment that cannot run anything. Everything that needs the NETWORK to answer is
 * warn-tier, on doctor's own rule that a ✗ is reserved for certainties: a custom provider base URL, a
 * corporate egress path or a transient provider blip each make a red here a false alarm, and an operator
 * who learns to scroll past doctor costs more than a missed warning does.
 *
 * DOCKER'S VENUE (issue #431). The proxy's state and health are read here with `docker inspect`, and the canary and its
 * sweep run on docker's runner. The podman venue reads its own proxy in `podmanChecks` (stdout `true` only, since an
 * exited container prints `false` with exit 0 and Podman's warnings go to stderr) and runs the same canary and sweep
 * under podman from `podmanLiveChecks`; what is shared is `runEgressCanary` and `sweepStaleCanaryNetworks`, and this
 * docker path spawns and prints exactly what it did before they were (pinned in doctor.test.mjs).
 *
 * NOTHING here carries a `fixAction` -- the never tier (REQ-DEPLOYMENT-BOOTSTRAP). One candidate was
 * considered and refused: a prompt-tier offer to start the proxy, on the Valkey precedent. That offer
 * starts a QUEUE, whose failure mode is that nothing runs. This one would stand up a SECURITY CONTROL
 * whose allowlist the operator has not written yet, turning "no policy" into "a policy that fails every
 * job inside a paid container". It is also not one argv but a compose profile and a file that must already
 * exist, and doctor "never guesses a semantic env value".
 */
async function egressChecks(env, seams, { dockerCode, imageCode, jobImage, endpoint = { local: null, reason: "not resolved" } }) {
	// `pid` and `isAlive` default here as well as riding the seams, so a caller that predates issue #350 still
	// gets the process's own answer rather than a name ending in `undefined`.
	// `proxyFilesExist` asks whether this folder holds the proxy's two files, which is what makes it a deployment folder
	// whose mounts the running proxy can be compared with. A seam of its own, on the real disk by default: the shared
	// `fileExists` answers yes to everything in most tests, and "doctor run from some other folder" is the common case.
	const { spawn, pid = process.pid, isAlive = defaultIsAlive, proxyFilesExist = existsSync, proxyFileIsDirectory = statIsDirectory } = seams;
	// The SAME parse the worker boots with (egress.mjs), never a second `=== "1"`: doctor reporting a
	// policy that is off, or nothing about one that is on, is worse than doctor not checking at all.
	// A malformed value is the worker's boot failure to report, not doctor's to guess at, so it reads as
	// armed here and the `.env` check above is what fails.
	let armed;
	try {
		armed = egressArmed(env);
	} catch {
		armed = true;
	}
	if (!armed) return [];
	const proxy = egressProxyName(env);
	const checks = [];
	// Issue #484: this folder's copy of the proxy's rules against the installed package's, before the daemon is asked,
	// since it is a file compare and holds whatever docker answers. Only for the shipped proxy, which is the one that
	// mounts this folder's copy; a proxy PI_EGRESS_PROXY names runs whatever rules its operator gave it.
	if (proxy === DEFAULT_EGRESS_PROXY) {
		const stale = proxyConfCopyCheck({
			path: join(seams.cwd, "deploy/egress-proxy.conf"),
			name: "deploy/egress-proxy.conf in this folder",
			seams,
			skip: () => proxyFileIsDirectory(join(seams.cwd, "deploy/egress-proxy.conf")),
			refresh: `\`pi-dispatch up\` from this folder offers to replace it with the package's copy, keeping this one as a backup, and then to restart the proxy, since squid reads its rules only at start; a proxy made before #503, which lacks the model-endpoints.conf mount the new rules need, is REPLACED in the same step instead, asked once`,
		});
		if (stale) checks.push(stale);
	}

	if (dockerCode !== 0) {
		checks.push({
			ok: false,
			warn: true,
			label: "Egress policy: not checked (the Docker daemon did not answer)",
			fix: "start Docker, then re-run doctor -- the policy lives in docker's own networks and containers, so none of it can be read from here",
		});
		return checks;
	}

	// What a doctor run that did NOT finish left behind (issue #350). BEFORE the proxy read on purpose: a host
	// whose proxy has since been stopped or removed still has leftovers to clear, and neither the proxy's state
	// nor the image's presence is a reason to leave a network on the daemon.
	//
	// THE CANARY OWNS THIS, not `doctor --live`. The module that makes an object sweeps it, which is
	// `live-probes.mjs`'s own arrangement rather than "--live sweeps everything"; and this runs on EVERY doctor
	// on an armed deployment, where `--live` is opt-in by typing a flag, so putting it there would let the
	// operators who never ask for a container read-back accumulate networks forever. The accepted cost, stated:
	// a deployment that turns egress OFF returns above and never sweeps its old canary networks.
	// ONLY ON A DAEMON THIS HOST OWNS. `isAlive` reads THIS process table while the name came from the
	// DAEMON, so on a redirected DOCKER_HOST or a shared daemon another doctor's live pid reads as dead here
	// and its probe and network would be taken out from under it. The in-image `gh` probe already refuses on
	// exactly this test, and `live-probes.mjs`'s sibling sweep -- which keeps a second guard this one
	// deliberately inverts -- records the same PID-namespace caveat.
	//
	// WHAT THIS TEST DOES NOT COVER, and the list above used to claim it did (issue #360): a doctor IN A
	// CONTAINER with the socket bind-mounted. `classifyDockerEndpoint` answers `local: true` for any `unix:`
	// endpoint unconditionally, which is right for what it is asked -- a socket is on this machine's
	// filesystem -- and says nothing about PID namespaces. So two containerised doctors on one daemon read as
	// owned, and if they collide on a pid each can `rm -f` the other's probe and remove its network. Not data
	// loss: the objects are doctor's own ephemera and the victim degrades to a `probe did not run` with
	// `reached: null`, never a false verdict. Stated in `INT-EGRESS-POLICY-CONTRACT` beside the sibling's,
	// rather than guarded, because nothing this shell can ask distinguishes the two containers.
	const canaryDocker = (args, opts) => liveRunVia(spawn)(args, { timeoutMs: opts?.timeoutMs ?? CANARY_STEP_TIMEOUT_MS });
	// ONE detach gate for this doctor run (issue #452, gate round 3), shared by the sweep and the canary: `local` can be a
	// rootless Podman 4.x reached as `docker`, where both of them detach the running proxy.
	const gate = makeDetachGate(canaryDocker, { bin: "docker", ...(seams.readFactsOnce ? { readRuntime: async () => runtimeFromFacts(await seams.readFactsOnce()) } : {}) });
	checks.push(...(await sweepStaleCanaryNetworks({ run: canaryDocker, pid, isAlive, endpoint, gate })));

	// `docker inspect` on the container, not `ps`: it answers present-vs-absent and running-vs-stopped in
	// one call, and those are two different fixes. The FIELD_SEP habit is image-preflight.mjs's -- neither
	// a boolean nor a health word can contain "|".
	//
	// Issue #453 (gate rounds 1 and 2): RUNNING is `.State.Status` "running", and for the SHIPPED name the container
	// must be CURRENT, the pinned squid with its own entrypoint and command and this deployment folder's two files
	// mounted, or its policy is not this deployment's (`egress-proxy-state.mjs`). One inspect, as `up` reads it, with the
	// health word in the same answer.
	const state = await runCmdCapture(spawn, "docker", ["inspect", PROXY_STATE_FORMAT, proxy], { stdoutOnly: true });
	const parsed = state.code === 0 ? parseProxyState(state.output) : null;
	const health = parsed?.health ?? "none";
	const up = parsed?.status === "running";
	const custom = proxy !== DEFAULT_EGRESS_PROXY;
	// CURRENT, for the shipped name, judged whether it runs or not (gate round 2): a stopped proxy of another folder is
	// one `up` offers to replace, so its fix must say that, not compose, which would start it as it is. The mounts are
	// compared only where this folder holds the two files, which is a deployment folder (run elsewhere, doctor cannot
	// know which folder the service uses), and only where every bind source resolves on this host; otherwise that half
	// is said to be unknown, never stale.
	const inFolder = ["egress-allowlist.conf", "deploy/egress-proxy.conf"].every((f) => proxyFilesExist(join(seams.cwd, f)));
	// A DIRECTORY at any of its paths (PR #488's review): docker bind-mounts it where squid reads a file, and the proxy
	// cannot start from it. Said for the shipped proxy, whose run and compose file mount this folder's paths. The model
	// endpoints' include (issue #503) is one of them: a directory there parses as NO rules with no warning (measured on
	// Docker Desktop), and `egress render` refuses to write it.
	if (!custom) {
		for (const f of ["egress-allowlist.conf", "deploy/egress-proxy.conf", MODEL_ENDPOINTS_INCLUDE_NAME]) {
			if (proxyFileIsDirectory(join(seams.cwd, f))) {
				checks.push({ ok: false, label: `${f} in this folder is a directory, not a file`, fix: `the egress proxy mounts it where squid reads a file, so it cannot start from this folder: remove the directory, then \`pi-dispatch init\` writes the file (create-only)` });
			}
		}
	}
	// Issue #503's governing rule: what the third mount and the include file cost is decided by whether the rules this
	// proxy runs (the folder's deploy/egress-proxy.conf) include the file. `includeNeeds` is a seam for tests.
	const { includeNeeds = ({ env: e, cwd, platform }) => ({ rulesInclude: rulesFileIncludes(join(cwd, "deploy/egress-proxy.conf"), { readFileSync }), endpointsDeclared: endpointsDeclaredIn({ env: e, cwd, fs: { readFileSync, existsSync }, platform }) }) } = seams;
	const needs = !custom && inFolder ? includeNeeds({ env, cwd: seams.cwd, platform: seams.platform ?? process.platform }) : { rulesInclude: false, endpointsDeclared: false };
	if (!custom && inFolder) {
		// MISSING in a deployment folder: ✗ when the rules include it, since squid then refuses to start (measured); ⚠
		// otherwise, since a proxy on rules from before #503 runs without it, and the rules refresh needs it.
		if (!proxyFilesExist(join(seams.cwd, MODEL_ENDPOINTS_INCLUDE_NAME))) {
			checks.push(
				needs.rulesInclude
					? { ok: false, label: `${MODEL_ENDPOINTS_INCLUDE_NAME} is not in this folder`, fix: `the egress proxy mounts it and its rules include it, and squid will not start without it: \`pi-dispatch init\` writes it (create-only), then \`pi-dispatch up\` starts the proxy` }
					: { ok: false, warn: true, label: `${MODEL_ENDPOINTS_INCLUDE_NAME} is not in this folder`, fix: "the proxy's rules here predate #503 and run without it, but the next rules refresh includes it and the proxy will not start without it then: `pi-dispatch init` writes it (create-only)" },
			);
		}
		// Endpoints declared under rules that predate #503: the one line up, doctor and egress render share.
		if (needs.endpointsDeclared && !needs.rulesInclude) checks.push({ ok: false, warn: true, label: rulesPredateEndpointsLine("docker"), fix: "a reload or a proxy replace changes nothing here: the rules themselves must include the file, and the refresh `pi-dispatch up` offers replaces the proxy with them" });
	}
	// Issue #503: the declared model endpoints, read as the service reads them. None declared is no line and no container,
	// so a deployment without them prints what it always did. Under rules that predate the include the line just above is
	// the whole story (a probe would only fail it again), so nothing more is said there. A proxy PI_EGRESS_PROXY names
	// must include the file itself, and is read like the shipped one.
	const { declaredEndpoints = ({ env: e, cwd, platform }) => declaredEndpointsIn({ env: e, cwd, fs: { readFileSync, existsSync }, platform }), hostAddresses = () => lanIPv4Addresses(networkInterfaces()) } = seams;
	const declared = declaredEndpoints({ env, cwd: seams.cwd, platform: seams.platform ?? process.platform });
	const endpoints = declared.length > 0 && !(!custom && inFolder && !needs.rulesInclude) ? declared : [];
	if (endpoints.length > 0) {
		const runtime = routeRuntimeFromFacts(seams.readFactsOnce ? await seams.readFactsOnce() : null, seams.platform ?? process.platform);
		const addresses = hostAddresses();
		checks.push(...endpointRouteChecks({ runtime: runtime && addresses ? { ...runtime, hostAddresses: addresses } : runtime, endpoints, prefix: "", proof: "The endpoint probes below are the proof, once the proxy runs and the job image is here." }));
	}
	const judged = !custom && parsed ? shippedProxyDrift(parsed, { cwd: seams.cwd, platform: seams.platform ?? process.platform, realpath: (p) => realpathSync(p), compareMounts: inFolder, rulesInclude: needs.rulesInclude }) : { drift: [], unknown: null };
	// What `up` does with it, told the way `up` decides it (PR #456's final check): a proxy stale by its image, entrypoint
	// or command is offered for replacement whatever its mounts; one stale on its mounts alone is not while one of its own
	// two mounts is unknown, so the fix names the commands rather than an offer that `up` would not make.
	const mountsOnly = judged.unknown !== null && judged.drift.length > 0 && shippedProxyDrift(parsed, { cwd: seams.cwd, compareMounts: false }).drift.length === 0;
	const replaceFix = mountsOnly
		? `check its mounts (\`docker inspect --format '{{json .Mounts}}' ${proxy}\`), then \`docker rm -f -v ${proxy}\` and \`pi-dispatch up\` from the deployment folder replace it with the shipped one; \`up\` does not offer to on its own while one of its mounts cannot be compared here`
		: `\`pi-dispatch up\` from the deployment folder offers to replace it with the shipped one (docker rm -f -v ${proxy}, then the shipped run)`;
	// The worker's simple rule (egress.mjs): paused, exited, dead and created (`STOPPED_PROXY_STATES`) refuse every job,
	// so ✗; any other state is one the worker retries through (restarting, stopping, removing, ...), so ⚠, and the fix
	// says jobs wait rather than fail. `restarting` is a crash loop that fails every job (one retry, then failed), so ✗;
	// ⚠ only for a transient word.
	const retried = parsed !== null && !up && !STOPPED_PROXY_STATES.has(parsed.status) && parsed.status !== "restarting";
	// A RUNNING stale proxy (exec round 3) gets no "✓ running" line: the ✗ below says what it is, and carries the state
	// `--live` reads, so the output never reads healthy right before saying the proxy is not this deployment's.
	const staleRunning = up && !custom && judged.drift.length > 0;
	const proxyCheck = {
		ok: up,
		...(retried ? { warn: true } : {}),
		label: up
			? `Egress proxy running (${proxy})`
			: state.code === 0
				? parsed
					? `Egress proxy is ${parsed.status !== "exited" ? parsed.status : "stopped"} (${proxy})`
					: `Egress proxy exists but its state could not be read (${proxy})`
				: `Egress proxy is not on this host (${proxy})`,
		// PI_EGRESS_PROXY names the operator's own proxy, which neither compose nor `up` starts (they start the shipped
		// name), so its fix is to start that container, not to run compose.
		fix: retried
			? `a job meanwhile is retried once, then failed (the worker does not refuse it outright on this state); if it stays ${parsed.status}, \`docker logs ${proxy}\` says why`
			: parsed?.status === "restarting"
			? `its squid keeps exiting and its restart policy keeps bringing it back, so every job is retried once, then failed; \`docker logs ${proxy}\` says why`
			: custom
			? `PI_EGRESS_PROXY names your own proxy, which neither compose nor \`pi-dispatch up\` starts: ${state.code === 0 ? `\`docker ${parsed?.status === "paused" ? "unpause" : "start"} ${proxy}\`` : `create and start ${proxy} yourself`} -- the egress policy refuses every job pre-spend while it is down, which costs no budget but runs nothing (PI_EGRESS=0 opts out)`
			: judged.drift.length > 0
				? `${judged.outOfDate ? "it is this deployment's proxy but out of date" : "it is not this deployment's either"} (${judged.drift.join("; ")}): ${replaceFix} -- the egress policy refuses every job pre-spend while it is down, which costs no budget but runs nothing (PI_EGRESS=0 opts out)`
				: parsed?.status === "paused"
					? `docker unpause ${proxy}  -- as \`pi-dispatch up\` offers; the egress policy refuses every job pre-spend while it is paused, which costs no budget but runs nothing (PI_EGRESS=0 opts out)`
					: "`pi-dispatch up` from the deployment folder starts it  -- the egress policy refuses every job pre-spend while this is down, which costs no budget but runs nothing (PI_EGRESS=0 opts out)",
		// Not rendered: `--live`'s peer probe (issue #344) needs the proxy's name and whether it is up, and reads them here
		// rather than asking docker a second time.
		proxyState: { proxy, running: up },
	};
	if (!staleRunning) checks.push(proxyCheck);
	if (!up) return checks;
	if (!custom) {
		if (judged.drift.length > 0) {
			checks.push({
				ok: false,
				label: judged.outOfDate ? `Egress proxy is this deployment's proxy but out of date (${proxy}): ${judged.drift.join("; ")}` : `Egress proxy is running but is not this deployment's (${proxy}): ${judged.drift.join("; ")}`,
				fix: `${replaceFix}; until then every job's egress runs through a policy this deployment did not ship`,
				proxyState: proxyCheck.proxyState,
			});
		}
		if (judged.unknown) {
			checks.push({
				ok: false,
				warn: true,
				label: `Egress proxy's mounts could not be compared on this host (${proxy}): ${judged.unknown}`,
				fix: "its image, entrypoint and command were compared; check its mounts by hand (`docker inspect --format '{{json .Mounts}}' " + proxy + "`): /etc/squid/squid.conf must be this deployment's deploy/egress-proxy.conf, /etc/pi-dispatch/allowlist.conf its egress-allowlist.conf, and /etc/pi-dispatch/model-endpoints.conf its model-endpoints.conf",
			});
		}
	}

	// Advisory on purpose, and deliberately NOT what the money gate reads. A healthcheck can flap, and a
	// pre-spend gate that refuses on a flapping signal drops real work while one that retries on it burns
	// the second budget slot this whole requirement exists to save. Here a human is reading, so it is worth
	// saying: a squid that parsed its config and then wedged looks identical to a healthy one from outside.
	if (health && health !== "none") {
		checks.push({
			ok: health === "healthy",
			warn: true,
			label: `Egress proxy health: ${health}`,
			fix: `docker logs ${proxy} -- the container is up but its listener is not answering, so jobs will start and then fail to reach anything`,
		});
	}

	// The end-to-end probe, and the only place in this codebase that proves the policy rather than
	// inspecting it. Three containers, on a throwaway network built exactly like a job's, gated on the image
	// being present because it uses the job image's own node and runner module -- which is the point: it proves the
	// operator's OWN image routes a request through the proxy the way its runner does (pi loaded, then the runner's
	// restore), the property a stale image would silently lack and the one whose absence turns the whole policy into an
	// outage (`egressCanaryScript`, #427).
	//
	// Credential-free by construction: `api.anthropic.com` answers 401 to an unauthenticated request, so
	// reaching the provider and being refused for the key proves the entire path and costs nothing. That is
	// docs/egress.md's own method, promoted from prose to a check.
	// Issue #503: the include as the running proxy sees it. Not for a shipped proxy already judged stale above: its mounts
	// are that line's to name, and a two-mount proxy has no include to read.
	if (endpoints.length > 0 && !(!custom && judged.drift.length > 0)) {
		const inside = await runCmdCapture(spawn, "docker", ["exec", proxy, "cat", ENDPOINTS_INCLUDE_IN_PROXY], { stdoutOnly: true, timeoutMs: CANARY_STEP_TIMEOUT_MS });
		// The file the proxy ACTUALLY mounts there, by its bind source from the inspect above, for the shipped proxy and
		// an operator's alike: never this folder's, which may not be the one mounted (gate round 2).
		const mounted = readIncludeBindSource(parsed?.mounts);
		checks.push(endpointsIncludeCheck({ answer: inside, endpoints, bin: "docker", proxy, prefix: "", mounted, recreate: custom ? `recreate ${proxy} so it mounts the file anew` : `\`docker rm -f -v ${proxy}\`, then \`pi-dispatch up\` starts it on the file anew (a restart cuts running jobs' tunnels)` }));
	}
	if (imageCode !== 0) return checks;
	// Issue #431: the canary itself is `runEgressCanary`, shared with the podman venue's `--live` and the conformance
	// script. docker's probes keep `runCmdCapture` (its 30 s bound, stderr merged, SIGTERM at the bound) rather than the
	// bounded step runner, so docker's spawns, and what a probe that never launched leaves for the teardown, are exactly
	// what they were: pinned in doctor.test.mjs against the output and argv captured before the move.
	const canary = await runEgressCanary({ run: liveRunVia(spawn), probeRun: (args) => runCmdCapture(spawn, "docker", args), proxy, image: jobImage, pid, gate, endpoints });
	// Through a stale proxy the canary reads THAT proxy's policy (exec round 3): a failure is the proxy's to fix, never
	// this deployment's allowlist, which it may not even mount.
	checks.push(...(staleRunning ? canary.checks.map((c) => (c.ok ? c : { ...c, fix: `the canary ran through ${proxy}, which is not this deployment's proxy (above), so this says nothing about egress-allowlist.conf: ${replaceFix}, then re-run doctor` })) : canary.checks));
	return checks;
}

/**
 * The canary's probe containers' argv after the runtime's name (issue #431), per direction.
 *
 * docker's is what it always was: a plain `docker run` on the canary network with the two proxy variables, which is
 * pinned byte for byte and not widened here, because moving it is its own change with its own review.
 *
 * `script` is what the container runs, the runner's route (`egressCanaryScript`) unless a probe says otherwise: the
 * plain HTTP probe (issue #508) passes `egressCanaryPlainScript`, and its argv differs from the others in nothing else.
 * A model endpoint's probe (issue #503) passes its own `name` and `httpProxy`, which adds the job's HTTP_PROXY on docker.
 *
 * podman's is a JOB's, built by the podman venue's own builder (`podmanArgsFromSpec` over `containerSpec`, the path
 * `buildPodmanRunArgs` takes), never a hand-rolled argv: `ISOLATION_FLAGS`, the job's memory and cpu bounds,
 * the job user this host decides as `--user`, `--userns=keep-id` and `PODMAN_PINNED_FLAGS`, and a job's own egress
 * environment (`egressEnv`, the four variables a podman job gets) with a job's HOME. That is what makes its answer one
 * about a JOB. A hand-rolled argv like docker's would be weaker than a job's in exactly the places the account's
 * containers.conf can reach (#428): with no `--env-host=false` an `env_host = true` default copies doctor's
 * environment, provider key with it, into the probe, and with no `--http-proxy=false` this shell's proxy variables
 * (lowercase spellings and `no_proxy` among them) would ride beside the ones under test, so what a pass proved would
 * depend on the shell doctor ran in rather than on what a job gets. Rejected for that reason, as was
 * "PODMAN_PINNED_FLAGS plus the user" alone, which is still a second argv for a job-shaped container that can drift.
 *
 * NO MOUNT, and that is the one departure from a job: the canary reads nothing from the host, and a mount only ever adds
 * reach. `containerSpec` requires a workspace (every job has one), so a placeholder is named and the spec's mounts are
 * then replaced by none; `CANARY_NO_WORKSPACE` is a path nothing creates, so if a later edit ever kept the mount, the
 * run would fail on a missing source rather than bind a real directory.
 */
export function egressCanaryProbeArgs({ bin = "docker", slug, pid, network, proxy, image, url, user = null, script = egressCanaryScript(url), name = egressCanaryProbe(slug, pid), httpProxy = false, size = DEFAULT_JOB_SIZE, hostCpus = null }) {
	if (bin !== "podman") {
		return [
			"run",
			"--rm",
			// Named, and outside the boot reaper's `pi-job-` filter by construction. `--rm` disposes of it,
			// so the name exists for the operator watching `docker ps` during a doctor run and for the one
			// reading `ps` afterwards to find out what a wedged probe was doing.
			"--name",
			// The PID too, so two doctor runs at once do not collide on a name and read the loser's exit 125 as a deny.
			name,
			"--pull=never",
			`--network=${network}`,
			"-e",
			`HTTPS_PROXY=http://${proxy}:3128`,
			// Only for a model endpoint's probe (issue #503), whose URL is `http://`: the runner's dispatcher sends that to
			// HTTP_PROXY, as a job's does. The canary's own three argv are unchanged.
			...(httpProxy ? ["-e", `HTTP_PROXY=http://${proxy}:3128`] : []),
			"-e",
			"NODE_USE_ENV_PROXY=1",
			"--entrypoint",
			"node",
			image,
			"-e",
			script,
		];
	}
	// HOME as a podman job gets it (`resolvePodmanImageUser` always answers CONTAINER_HOME): under keep-id the job user's
	// passwd entry otherwise names this host's home path, which does not exist in the image, and the canary loads pi as
	// that user. No credential rides along: the canary proves the route, and a 401 from the provider is its success.
	// Issue #596: at a job's size (the deployment's default, which doctor reads from the same settings the worker does) and
	// under the same `--cpus` ceiling, so the canary's container is a job's in its bounds as well as its flags.
	const { mounts: _placeholder, ...spec } = containerSpec({ image, name, env: { HOME: CONTAINER_HOME, ...egressEnv({ proxy, armed: true }) }, workspace: CANARY_NO_WORKSPACE, network, user, userns: "keep-id", extraFlags: ["--entrypoint", "node"], size, hostCpus });
	return [...podmanArgsFromSpec({ ...spec, mounts: [] }), "-e", script];
}

/** The workspace `containerSpec` requires and the canary never mounts (see `egressCanaryProbeArgs`). */
const CANARY_NO_WORKSPACE = "/nonexistent/pi-dispatch-egress-canary-mounts-nothing";

/**
 * The egress canary (REQ-EGRESS-ALLOWLIST, issue #431): a throwaway `--internal` network built like a job's, the proxy
 * attached, three probe containers, and a teardown that removes everything it made or names what it could not. Two run
 * `egressCanaryScript` (the runner's own route to the network, #427): one must reach the provider and one must not reach
 * an unlisted host. The third runs `egressCanaryPlainScript` and must not get plain HTTP through to a listed host on a
 * port other than 80 (issue #508). Returns `{ checks, results }`: the lines to print, and the
 * `[{ property, want, reached, probe }]` readings `egressVerdict` folds into `--live`, `probe` being the slug.
 *
 * ONE canary for every caller: docker's `doctor` (`egressChecks`), the podman venue's `doctor --live`
 * (`podmanLiveChecks`) and `.github/scripts/podman-conformance.mjs`. The conformance script used to carry a canary of
 * its own with a plain `fetch`, which proved the network and the allowlist but not the runner's provider call, the
 * exact gap #427 found in doctor's; sharing this one closes it there too.
 *
 * `run(args, { timeoutMs })` is the venue's bounded runner (`liveRunVia` shape) for the network steps and the removals;
 * `probeRun(args)` runs a probe container, by default through `run` under the venue's probe bound: docker's 30 s, and on
 * podman `PODMAN_FIRST_START_TIMEOUT_MS`, because the first keep-id start of an image copies its layers (27 to 32 s
 * measured), which a 30 s bound would read as a probe that did not run. `user` is the job user, required on podman,
 * whose builder refuses a keep-id argv without one. What it does NOT check is the proxy: every caller has read the
 * proxy's state on its own runtime first, and runs this only when it is up and the job image is present.
 *
 * `endpoints` (issue #503) are the declared model endpoints to prove on the same network after the three
 * (`runEndpointProbes`), `[]` by default, so the conformance script and a deployment with none run exactly the three.
 */
export async function runEgressCanary({ run, bin = "docker", proxy, image, pid = process.pid, user = null, probeRun = null, endpoints = [], size = DEFAULT_JOB_SIZE, hostCpus = null, gate = makeDetachGate((args, opts) => run(args, { timeoutMs: opts?.timeoutMs ?? CANARY_STEP_TIMEOUT_MS }), { bin }) }) {
	const venue = canaryVenueFor(bin);
	const probe = probeRun ?? ((args) => run(args, { timeoutMs: bin === "podman" ? PODMAN_FIRST_START_TIMEOUT_MS : RUN_TIMEOUTS.cmd }));
	const checks = [];
	const net = egressCanaryNetwork(pid);
	// A runner that captures BOTH streams and is bounded: `runCmd` answers with an exit code only and `stdio:
	// "ignore"`, so the "network is not there" rule -- whose wording the daemon puts on stderr with stdout
	// empty when `--format` is passed -- could not read it. `liveRunVia` is already exactly this shape in this
	// file; a fourth runner would be a fourth place for the bound to be wrong.
	const docker = (args) => run(args, { timeoutMs: CANARY_STEP_TIMEOUT_MS });
	// Probe containers this run may have left BEHIND its CLI, see the `code === null` branch below.
	const unfinished = [];
	let created = false;
	// The canary stopped on an image with no runner module: the endpoint probes take the same route, so they are not run.
	let staleRunner = false;
	// FIRST, before anything exists (issue #452, gate round 3): this canary's own teardown detaches the running proxy, which
	// on a rootless Podman 4.x without a holding keeper cuts its route out, through `podman`, `podman-docker` or the Docker
	// API alike (measured). So the detach gate every teardown goes through is asked up front, and a refusal runs nothing:
	// a read-back that breaks what it reads is worse than none. The teardown asks the SAME gate, whose answer is memoised.
	const blockedBy = await gate({ running: true });
	if (blockedBy) {
		// ✗ where the runtime is KNOWN to be a rootless Podman 4.x with no keeper, which the podman section's keeper line
		// also fails; ⚠ where it could not be read at all, the class doctor warns on everywhere else.
		const unread = blockedBy === "runtime-unreadable";
		checks.push({ ok: false, ...(unread ? { warn: true } : {}), label: `${venue.prefix}Egress policy: not proved, and no egress canary was run, because ${detachBlockedSentence(blockedBy, bin)}`, fix: `${unread ? `fix what stops \`${bin} info\` answering (which runtime it is decides whether a keeper is needed at all), or ` : ""}${NETNS_KEEPER_FIX}, then re-run doctor` });
		return { checks, results: readingsOf(checks) };
	}
	try {
		// OWNED BEFORE THE CREATE, and inside the try, which is the change issue #350 asked for: the create used
		// to sit above the `try`, so a create that timed out having actually landed skipped the teardown
		// entirely. `checks` is returned by reference on every early path here, so a line pushed in the
		// `finally` still reaches the operator -- including on the `network connect` failure below, where the
		// network exists and nothing else would say so.
		// From the create's OWN answer, not set blindly: `true` first meant the flag could never be false, so the
		// teardown also ran for a create that cleanly refused and emitted a `could not be removed` instruction
		// for a network that never existed.
		//
		// Both of these go through the BOUNDED runner. `runCmd` has no timeout at all, and a wedged daemon
		// hanging `docker network create` holds doctor with nothing printed -- the same hazard the probes
		// were moved off for in issue #350, one call earlier.

		const create = await docker(["network", "create", "--internal", net]);
		// CREATED, and the rule is `dockerRunVia`'s own distinction rather than "exit 0" (issue #379, item 4).
		// `liveRunVia` resolves `{ code: null }` for two different things: a CLI that could not be LAUNCHED,
		// where nothing was created, and a child killed by the TIMEOUT or a signal, which can land after the
		// daemon has already made the network. Treating both as "not created" leaks a network this run will
		// not clean; treating both as created cries wolf on every unlaunchable docker and turns
		// `doctor.test.mjs`'s ENOENT case red, which is a decision recorded right here. So: exit 0, or a
		// timeout or signal -- never a spawn error.
		created = create.code === 0 || (create.code === null && create.ended !== "error");
		// SAID, not returned into silence. Both of these used to leave `doctor` with no egress reading at all
		// and no line explaining the absence, which is the shape this whole slice exists to remove: a reader
		// cannot tell "the policy was proved" from "nothing was tried".
		if (create.code !== 0) {
			checks.push({ ok: false, warn: true, label: `${venue.prefix}Egress policy: not proved, because the canary network ${net} could not be created${create.code === null && create.ended !== "error" ? " and the create did not finish, so it may exist" : ""}`, fix: forRuntime(CANARY_UNPROVED_FIX, bin) });
			return { checks, results: readingsOf(checks) };
		}
		// Attached HERE, by name, on every run, as a job's network is (`createJobNetworkWith`): never a connection kept from
		// an earlier run. That is what makes a proxy that was REPLACED safe to read, which on the podman venue is routine
		// since issue #430: a `systemctl --user restart` of the Quadlet unit starts a new container under the same
		// `ContainerName` and drops every per-job connection the old one had. The next canary connects the new one.
		if ((await docker(["network", "connect", net, proxy])).code !== 0) {
			checks.push({ ok: false, warn: true, label: `${venue.prefix}Egress policy: not proved, because ${proxy} could not be attached to the canary network`, fix: forRuntime(CANARY_UNPROVED_FIX, bin) });
			return { checks, results: readingsOf(checks) };
		}
		// The unlisted host must be one that RESOLVES and answers. The first version used a reserved `.example` name,
		// which no proxy can reach, so a proxy allowing every host still read as denying this one (measured: an
		// allow-all squid answered 503 for it and let `example.com` through). `example.com` is reserved for documentation
		// (RFC 2606), answers everywhere, and is contacted only when the proxy lets the request out, which is the finding.
		//
		// The THIRD probe (issue #508) asks the proxy for plain HTTP to a LISTED host on a port other than 80, as a client
		// that forwards rather than tunnels would (npm undici's EnvHttpProxyAgent without proxyTunnel, a package manager). Port 443 of the provider because it is a
		// port that host certainly listens on, so a proxy that lets it through gets an answer (a 400 for clear text on a
		// TLS port) rather than a timeout, and no second host has to be listed for the canary.
		for (const [slug, host, url, want, script] of [
			[CANARY_PROBE_SLUGS[0], "the provider", "https://api.anthropic.com/v1/messages", true],
			[CANARY_PROBE_SLUGS[1], "an unlisted host", "https://example.com/", false],
			[CANARY_PROBE_SLUGS[2], "plain HTTP to a listed host off port 80", "http://api.anthropic.com:443/", false, egressCanaryPlainScript("http://api.anthropic.com:443/", { proxyUrl: egressProxyUrl(proxy) })],
		]) {
			const answer = await probe(egressCanaryProbeArgs({ bin, slug, pid, network: net, proxy, image, url, user, size, hostCpus, ...(script ? { script } : {}) }));
			// The script exits 0 (reached) or 3 (blocked). Anything else is the container not running it -- a name clash,
			// the image, the daemon -- which is no reading at all, and must not pass for a deny.
			// `code === null` is the ONE case where a container may still be RUNNING under a name we chose: the
			// bound killed the docker CLI, which is not the container it started (that is the whole of #350), or
			// the CLI never launched. 125 is the OPPOSITE case -- the name is taken by ANOTHER doctor's probe --
			// and removing that one would kill a live doctor's read. 0, 3, 126 and 127 all mean the container ran,
			// so `--rm` has already disposed of it.
			// The SAME distinction the create uses: a CLI that never launched started no container, so there is
			// nothing of ours to remove. Harmless either way today (`docker rm -f <missing>` exits 0, measured),
			// and written out because the conflation it removes is the one this item is about.
			if (answer.code === null && answer.ended !== "error") unfinished.push(egressCanaryProbe(slug, pid));
			// Said ONCE and the later probes not run: the unlisted host's "blocked" would come from the internal network
			// refusing a runner that never tried the proxy, which reads exactly like a policy that denies it.
			if (answer.code === EGRESS_CANARY_STALE_RUNNER) {
				checks.push({
					ok: false,
					warn: true,
					label: `${venue.prefix}Egress policy: not proved, because the job image could not find ${EGRESS_CANARY_RUNNER_MODULE} (or an import of it): its runner predates issue #427, whose provider call goes around the proxy so that with egress armed every job fails at its first turn, or the image is not built from this project's`,
					fix: `use a job image built after issue #427 (ghcr.io/edgehero/pi-job:latest, or rebuild yours FROM it), or set PI_EGRESS=0 until you can`,
					readBack: { property: "egress", want, reached: null, probe: slug },
				});
				staleRunner = true;
				break;
			}
			if (answer.code !== 0 && answer.code !== 3) {
				checks.push({
					ok: false,
					warn: true,
					label: `${venue.prefix}Egress policy probe for ${host} did not run (${answer.code === null ? `${bin} run did not finish` : `${bin} run exited ${answer.code}`})`,
					fix: "re-run doctor; if it persists, run the job image by hand to see why a container on this network will not start",
					readBack: { property: "egress", want, reached: null, probe: slug },
				});
				continue;
			}
			const reached = answer.code === 0;
			if (slug === CANARY_PROBE_SLUGS[2]) {
				checks.push({
					ok: reached === want,
					warn: true,
					readBack: { property: "egress", want, reached, probe: slug },
					label: `${venue.prefix}${
						reached === want
							? "Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)"
							: "Egress policy lets plain HTTP through to api.anthropic.com on port 443, so a client that does not tunnel reaches every port of a listed host"
					}`,
					fix: `the proxy runs rules from before issue #508: restart it on the current egress-proxy.conf (\`pi-dispatch up\`; on the podman venue \`pi-dispatch service install --force\`; for a proxy you started by hand, update the egress-proxy.conf it mounts, then \`${bin} restart ${proxy}\`); a copy you keep by hand must add "http_access deny !Safe_ports !CONNECT" right before "http_access allow allowed"`,
				});
				continue;
			}
			checks.push({
				ok: reached === want,
				warn: true,
				// NOT rendered: what `doctor --live` folds into its egress read-back (live-probes.mjs), so the canary is
				// run once and read twice rather than a second canary built beside it.
				readBack: { property: "egress", want, reached, probe: slug },
				label: `${venue.prefix}${
					reached === want
						? want
							? `Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)`
							: `Egress policy denies ${host} (the deny direction is the half an allowlist can silently lose)`
						: want
							? `Egress policy does NOT reach the provider (api.anthropic.com)`
							: `Egress policy ALLOWS ${host} that is not on your allowlist`
				}`,
				fix: want
					? `add api.anthropic.com to egress-allowlist.conf and restart the proxy -- until then every job starts, fails at its first turn, and spends two budget slots proving it (docs/egress.md)`
					: `check egress-allowlist.conf: a rule wider than you meant (a bare domain where you wanted a subdomain) lets a job reach hosts you did not list`,
			});
		}
		// Issue #503: each declared model endpoint, on this same network, after the canary's own three. Its lines carry no
		// `readBack`, so `egressVerdict` reads exactly the three readings it always did.
		if (endpoints.length > 0) {
			if (staleRunner) {
				checks.push({ ok: false, warn: true, label: `${venue.prefix}Model endpoints: not probed, because the job image has no runner module (above), and their probes take the runner's route`, fix: "use a job image built after issue #427, then re-run doctor" });
			} else {
				checks.push(...(await runEndpointProbes({ probe, bin, pid, network: net, proxy, image, user, endpoints, venue, unfinished, size, hostCpus })));
			}
		}
	} finally {
		// The probes FIRST, by the name carrying this pid, then the network: a member still attached is exactly
		// why the old `network rm` failed, and it failed silently. `rm -f` of a name that is not there is docker
		// saying so, which is not worth a line (measured: exit 0).
		// Through the BOUNDED runner, not `runCmd`, which has no timeout at all: `unfinished` is non-empty only
		// when the daemon already wedged a 30 s probe, so this is exactly the call most likely to hang.
		//
		// AND THE RESULT IS READ (issue #379, item 4). It was dropped, so a probe that would not go was never
		// named -- while `REQ-EGRESS-ALLOWLIST` is about to state that every canary object is removed in this
		// run's `finally` or reported in the same run. A probe still standing is the same fact the sweep's
		// `kept` line reports one run later, so it is reported with the same words, now rather than then.
		const stuck = [];
		for (const name of unfinished) if ((await docker(canaryProbeRemoval(bin, name))).code !== 0) stuck.push(name);
		// AND THE NETWORK IS THEN KEPT, because that is what the line says. Reusing the sweep's wording while
		// removing the network anyway printed "the network is the only way left to find it" and then removed
		// it in the same run -- both halves of the sentence false, and the page's own row for this shape says
		// removing it would orphan that container permanently. The sweep `continue`s here for exactly this
		// reason; the teardown now does the same.
		if (stuck.length > 0) {
			checks.push(canaryCheck("kept", { name: net, stuck }, venue));
		} else if (created) {
			const outcome = await removeNetworkOrSay(docker, { network: net, detach: [proxy], bin, gate });
			// The COMMAND lives in the label and the generic advice in the fix, which is the shape `--live`'s own
			// leftover notes already use: `render` prints a fix line only when a check is not ok, and an ok check
			// never prints one at all.
			if (outcome.blocked) checks.push(canaryCheck("held", { name: net, because: detachBlockedSentence(outcome.blocked, bin) }, venue));
			else if (!outcome.removed) checks.push(canaryCheck("notRemoved", { name: net, command: outcome.command }, venue));
		}
	}
	return { checks, results: readingsOf(checks) };
}

/** The canary's readings, `[{ property, want, reached }]`, off its checks: what `egressVerdict` reads. */
function readingsOf(checks) {
	return checks.filter((c) => c.readBack?.property === "egress").map((c) => c.readBack);
}

/**
 * The probes doctor runs per declared model endpoint (issue #503, REQ-EGRESS-ALLOWLIST), in this order, and ONE list:
 * the loop names its containers from it and the dead-pid sweep matches on it, as `CANARY_PROBE_SLUGS` is shared. Not
 * folded into `CANARY_PROBE_SLUGS`, whose three readings are what `egressVerdict` reads; these never reach it.
 *   - `models`: `GET http://<host>:<port>/v1/models` by the runner's route, which tunnels it, as a job's provider call
 *     goes. Must answer 200: Ollama, llama-server, vLLM and LM Studio all serve that path.
 *   - `nextport`: the same, to the nearest port above that no declaration for that host uses and that the allowlist's
 *     own rules do not open (`undeclaredPortNear`). Must get the proxy's 403 on the CONNECT, which proves the
 *     endpoint's rule is port-exact.
 *   - `plain`: a plain forward `GET` to the declared port. Must get squid's 403, which proves the include adds a tunnel
 *     and nothing else.
 */
export const ENDPOINT_PROBE_SLUGS = Object.freeze(["models", "nextport", "plain"]);

/** The parser's id rule without its anchors, for the sweep's pattern. */
const ENDPOINT_ID_CLASS = MODEL_ENDPOINT_ID_RE.source.replace(/^\^/, "").replace(/\$$/, "");

/** How long an endpoint probe waits for its answer inside the container: a server that takes the tunnel and never answers. */
const ENDPOINT_PROBE_TIMEOUT_MS = 15_000;

/** Where the proxy reads the include, in every venue's mount (compose, the Quadlet unit, the hand-started recipe). */
export const ENDPOINTS_INCLUDE_IN_PROXY = "/etc/pi-dispatch/model-endpoints.conf";

/**
 * The tunnelled endpoint probes' in-container script: the runner's route (`loadPiThenRestore`), then one `GET`. It is
 * `egressCanaryScript` with two differences. It sends a GET, the method a model list is read with. And it reports the
 * PROXY's answer to the CONNECT when there is one: a refused or failed tunnel reaches the caller only as an error whose
 * cause chain carries undici's `Proxy response (<status>) !== 200 when HTTP Tunneling` (measured on 2026-09-30, M9:
 * a job sees squid's 503, "allowed but nothing answered", and its 403, "not declared", alike as "Connection error"). So
 * the script walks the chain for that text, and doctor shows the status. The text is pinned at the 0.99.1 pin's undici
 * 8.10.2 (`lib/dispatcher/proxy-agent.js`) by a test that runs this script against a fake proxy.
 *
 * Prints ONE line: `reached <status>` (exit 0), `tunnel <status>` (exit 3), `blocked <code>` (exit 6: no answer, and no
 * proxy status, as for a request that went around the proxy or timed out), `error ...` (exit 5, or 4 for an image with
 * no runner module).
 */
export function egressEndpointScript(url, { timeoutMs = ENDPOINT_PROBE_TIMEOUT_MS } = {}) {
	return `import(${JSON.stringify(EGRESS_CANARY_RUNNER_MODULE)}).then(m=>m.loadPiThenRestore(),e=>{console.log("error",e.code??e.message);process.exit(e.code==="ERR_MODULE_NOT_FOUND"?${EGRESS_CANARY_STALE_RUNNER}:5)}).then(()=>fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(${Number(timeoutMs)})}).then(r=>{console.log("reached",r.status);process.exit(0)},e=>{let c=e,s=null;for(let i=0;c&&i<8&&s===null;i++){const m=/Proxy response \\((\\d{3})\\) !== 200 when HTTP Tunneling/.exec(String(c.message??""));if(m)s=m[1];c=c.cause}if(s!==null){console.log("tunnel",s);process.exit(3)}console.log("blocked",e.cause?.code??e.name??"error");process.exit(6)}),e=>{console.log("error",e.message);process.exit(5)})`;
}

/**
 * What one endpoint probe printed, as `{ kind, status, detail }`, or null. Read from the LAST line of that shape, since
 * a runtime may print its own lines first. `detail` is kept only when it is a short code word: the plain probe's is the
 * `X-Squid-Error` header, which a server that answered instead of the proxy writes, and a terminal is not handed that.
 */
function endpointProbeReading(answer) {
	const lines = String(answer?.output ?? answer?.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^(reached|tunnel|blocked|error)(?: (\d{3}))?(?: (\S+))?/.exec(lines[i]);
		if (m) return { kind: m[1], status: m[2] ? Number(m[2]) : null, detail: m[3] && /^[A-Za-z_]{1,40}$/.test(m[3]) ? m[3] : "" };
	}
	return null;
}

/** `host:port` as a URL writes it (an IPv6 host is stored in brackets already). */
function endpointAddress(host, port) {
	return `${host}:${port}`;
}

/** Endpoints in id order, the order the include is rendered in. */
function endpointsById(endpoints) {
	return [...endpoints].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The exits each probe's script ends a READING with; any other exit is a container that did not run it. */
const ENDPOINT_PROBE_READ_EXITS = Object.freeze({ models: [0, 3, 6], nextport: [0, 3, 6], plain: [0, 3] });

/**
 * One endpoint probe's line. Every line names the endpoint id and shows the proxy's status, and every one is warn-tier,
 * as the canary's are: each needs the network to answer. What passes, and nothing else:
 *   - `models`: the server answered 200 through the tunnel;
 *   - `nextport`: the proxy refused the TUNNEL with 403. A 503 there means the proxy let the CONNECT through and found
 *     nothing listening, so the rule is not port-exact; a server's own 403 through a tunnel is the same finding;
 *   - `plain`: a 403 carrying squid's `X-Squid-Error: ERR_ACCESS_DENIED`. A bare 403 may be the server's own answer to a
 *     request the proxy forwarded.
 */
function endpointProbeCheck({ slug, endpoint, answer, venue, bin, proxy, next }) {
	const head = `${venue.prefix}Model endpoint ${endpoint.id}`;
	const at = endpointAddress(endpoint.host, endpoint.port);
	const reading = endpointProbeReading(answer);
	const tag = { id: endpoint.id, probe: slug, kind: reading?.kind ?? null, status: reading?.status ?? null };
	if (!ENDPOINT_PROBE_READ_EXITS[slug].includes(answer?.code) || !reading || reading.kind === "error") {
		return {
			ok: false,
			warn: true,
			label: `${head}: the ${slug} probe did not run (${answer?.code === null || answer?.code === undefined ? `${bin} run did not finish` : `${bin} run exited ${answer.code}`})`,
			fix: "re-run doctor; if it persists, run the job image by hand to see why a container on this network will not start",
			endpointProbe: tag,
		};
	}
	const reload = reloadCommand(bin, proxy);
	if (slug === "models") {
		if (reading.kind === "reached" && reading.status === 200) return { ok: true, warn: true, label: `${head} answers through the proxy (GET http://${at}/v1/models through a CONNECT tunnel: 200)`, endpointProbe: tag };
		// The SERVER refused the request for want of a key (vLLM --api-key, a gateway in front): the route and the rule are
		// proved, since only an open tunnel carries the server's own answer. Said apart from a fault, still warn-tier.
		if (reading.kind === "reached" && (reading.status === 401 || reading.status === 403)) {
			return {
				ok: false,
				warn: true,
				label: `${head}: the route through the proxy works (the tunnel to ${at} opened), and the server wants a key (GET /v1/models answered ${reading.status})`,
				fix: "declare it without \"keyless\" and give its provider its key, as for any provider that needs one; nothing about the egress proxy needs changing",
				endpointProbe: tag,
			};
		}
		// A server that took the connection and never answered is not one to start: say what was seen.
		const timedOut = reading.kind === "blocked" && reading.detail === "TimeoutError";
		const why =
			reading.kind === "tunnel"
				? reading.status === 503
					? `the proxy allowed the tunnel to ${at} and answered 503, so nothing answered there`
					: reading.status === 403
						? `the proxy refused the tunnel to ${at} with 403, so the rules it runs do not allow this endpoint`
						: `the proxy answered ${reading.status} to the CONNECT to ${at}`
				: reading.kind === "reached"
					? `the tunnel to ${at} was let through, but GET /v1/models answered ${reading.status}, not 200`
					: timedOut
						? `it accepted the connection but did not answer /v1/models within ${ENDPOINT_PROBE_TIMEOUT_MS / 1000} s`
						: `no answer came back through the proxy (${reading.detail || "no reason given"})`;
		const fix =
			reading.kind === "tunnel" && reading.status === 403
				? `\`pi-dispatch egress render\` in the deployment folder, then \`${reload}\`; the include line above says whether the proxy holds the declared rules`
				: reading.kind === "reached"
					? "check that this port is the model server's and that it serves the OpenAI-compatible API under /v1 (Ollama, llama-server, vLLM and LM Studio do)"
					: timedOut
						? "the server is there but stuck or busy (a model still loading, every slot taken): check its own log, then re-run doctor"
						: bin === "podman"
							? `start the model server, bound to this host's LAN address or 0.0.0.0 (never 127.0.0.1 alone), and declare a server on this host as host.containers.internal (docs/egress.md, "Local model servers"). A job meets this as "Connection error"`
							: `start the model server, and check it listens where the proxy reaches it (docs/egress.md, "Local model servers"; on Docker Engine that is 172.17.0.1 or 0.0.0.0, never 127.0.0.1 alone). A job meets this as "Connection error"`;
		return { ok: false, warn: true, label: `${head} does NOT answer: ${why}`, fix, endpointProbe: tag };
	}
	const wider = `the proxy's rules are wider than model-endpoints.conf renders: compare the include inside it (\`${bin} exec ${proxy} cat ${ENDPOINTS_INCLUDE_IN_PROXY}\`) with \`pi-dispatch egress render\`'s, check egress-allowlist.conf does not list ${endpoint.host}, then \`${reload}\``;
	if (slug === "nextport") {
		const nextAt = endpointAddress(endpoint.host, next);
		if (reading.kind === "tunnel" && reading.status === 403) return { ok: true, warn: true, label: `${head}'s rule is port-exact (a CONNECT to ${nextAt}, a port nobody declared, got the proxy's 403)`, endpointProbe: tag };
		const what =
			reading.kind === "tunnel"
				? reading.status === 503
					? `the proxy let a CONNECT to ${nextAt}, a port nobody declared, through and answered 503 (nothing listens there)`
					: `the proxy answered ${reading.status} to a CONNECT to ${nextAt}, not its 403`
				: reading.kind === "reached"
					? `a CONNECT to ${nextAt}, a port nobody declared, was let through, and something there answered ${reading.status}`
					: `a CONNECT to ${nextAt} got no answer from the proxy (${reading.detail || "no reason given"}), so the refusal was not seen`;
		return { ok: false, warn: true, label: `${head}'s rule is NOT shown to be port-exact: ${what}`, fix: wider, endpointProbe: tag };
	}
	if (reading.status === 403 && reading.detail.startsWith("ERR_ACCESS_DENIED")) return { ok: true, warn: true, label: `${head} admits no plain forward request (GET http://${at}/v1/models without a tunnel got the proxy's 403 ${reading.detail})`, endpointProbe: tag };
	return {
		ok: false,
		warn: true,
		label: `${head} admits a plain forward request: GET http://${at}/v1/models without a tunnel got ${reading.status ?? "no status"}${reading.detail ? ` ${reading.detail}` : ""}, not the proxy's 403 ERR_ACCESS_DENIED`,
		fix: wider,
		endpointProbe: tag,
	};
}

/**
 * The port the `nextport` probe asks for (issue #503): the first one above the declared port that no declaration for the
 * same host uses, wrapping below the declared port past 65535. Never 443 or 80, which the allowlist admits for a listed
 * host (a CONNECT to 443, plain HTTP to 80): a host that is also listed would pass there by that rule, and the line would
 * blame the endpoint's. Skipped whether or not the host is listed, which costs nothing and reads no file. The port
 * itself is shown on the line. `null` only when every other port of the host is declared, which no real file does.
 */
export function undeclaredPortNear(endpoint, endpoints) {
	const taken = new Set((endpoints ?? []).filter((e) => e.host === endpoint.host).map((e) => e.port));
	const free = (p) => p !== endpoint.port && !taken.has(p) && p !== 443 && p !== 80;
	for (let p = endpoint.port + 1; p <= 65535; p++) if (free(p)) return p;
	for (let p = endpoint.port - 1; p >= 1; p--) if (free(p)) return p;
	return null;
}

/**
 * The three probes for each declared endpoint (issue #503), in id order, on the canary's network and through the
 * canary's own runner, so the teardown that removes the canary's probes removes these too (`unfinished` is the
 * canary's list). Each container is built by `egressCanaryProbeArgs`, a job's shape, with the job's plain-HTTP proxy
 * variable as well on docker: the runner's dispatcher sends an `http://` origin to HTTP_PROXY, which docker's canary
 * argv does not otherwise carry (podman's is a job's environment and has it).
 */
async function runEndpointProbes({ probe, bin, pid, network, proxy, image, user, endpoints, venue, unfinished, size = DEFAULT_JOB_SIZE, hostCpus = null }) {
	const checks = [];
	for (const endpoint of endpointsById(endpoints)) {
		const next = undeclaredPortNear(endpoint, endpoints);
		const models = `http://${endpointAddress(endpoint.host, endpoint.port)}/v1/models`;
		const nextUrl = `http://${endpointAddress(endpoint.host, next)}/v1/models`;
		const runs = [
			[ENDPOINT_PROBE_SLUGS[0], models, egressEndpointScript(models)],
			...(next === null ? [] : [[ENDPOINT_PROBE_SLUGS[1], nextUrl, egressEndpointScript(nextUrl)]]),
			[ENDPOINT_PROBE_SLUGS[2], models, egressCanaryPlainScript(models, { proxyUrl: egressProxyUrl(proxy) })],
		];
		for (const [slug, url, script] of runs) {
			const name = egressEndpointProbe(slug, endpoint.id, pid);
			const answer = await probe(egressCanaryProbeArgs({ bin, slug, name, pid, network, proxy, image, url, user, script, httpProxy: true, size, hostCpus }));
			if (answer?.code === null && answer.ended !== "error") unfinished.push(name);
			checks.push(endpointProbeCheck({ slug, endpoint, answer, venue, bin, proxy, next }));
		}
	}
	return checks;
}

/**
 * The include as the RUNNING proxy sees it, against what the declaration renders (issue #503). Read inside the
 * container, never from this folder's file: a single-file bind mount holds the inode, so a file replaced by a rename
 * leaves the container on the OLD one, and a reload then silently loads the old rules (measured on 2026-09-30, M3, on
 * Docker and Podman on Linux). `answer` is the `<bin> exec <proxy> cat` capture; `recreate` is the venue's way to start
 * the proxy on the file anew.
 */
function endpointsIncludeCheck({ answer, endpoints, bin, proxy, prefix, recreate, mounted = null }) {
	const read = `${bin} exec ${proxy} cat ${ENDPOINTS_INCLUDE_IN_PROXY}`;
	if (answer?.code !== 0) {
		return {
			ok: false,
			warn: true,
			label: `${prefix}Model endpoints: the include inside the running proxy could not be read (\`${read}\` ${answer?.code === null || answer?.code === undefined ? "did not finish" : `exited ${answer.code}`})`,
			fix: `the proxy must mount this deployment's model-endpoints.conf at ${ENDPOINTS_INCLUDE_IN_PROXY}, as the shipped proxy does; run the command yourself to see why it fails`,
		};
	}
	const ids = endpointsById(endpoints).map((e) => e.id).join(", ");
	// The file the proxy mounts, by its bind source, against what the container holds, FIRST (issue #503, gate rounds 1
	// and 2): a file replaced by a rename on the host leaves the container on the old inode, so the two differ, and no
	// render or reload reaches the proxy until it is started on the file anew. Without this, a hand-replaced file whose
	// JSON did not change read ✓. `mounted` is null when there is no such bind or it cannot be read here: no compare.
	if (mounted && mounted.text !== String(answer.output)) {
		return {
			ok: false,
			label: `${prefix}Model endpoints: the proxy is mounted on a replaced file: the file it mounts (${mounted.path}) differs from what ${proxy} reads at ${ENDPOINTS_INCLUDE_IN_PROXY}, so it was replaced (a rename, an editor's save) rather than written in place, and no reload reaches the proxy`,
			fix: `recreate the proxy so it mounts the file anew: ${recreate}. From then on, change the file only with \`pi-dispatch egress render\`, which writes in place`,
		};
	}
	if (String(answer.output) === renderEndpointsInclude(endpoints)) {
		return { ok: true, label: `${prefix}Model endpoints: the include inside the running proxy matches model-endpoints.json (${ids})` };
	}
	return {
		ok: false,
		label: `${prefix}Model endpoints: the include inside the running proxy (${ENDPOINTS_INCLUDE_IN_PROXY} in ${proxy}) does not match model-endpoints.json (${ids}), so a reload would not load the declared rules`,
		fix: `\`pi-dispatch egress render\` in the deployment folder, then \`${reloadCommand(bin, proxy)}\`. If the render says the file already matches and this line stays, the proxy holds an earlier copy of a file that was replaced rather than written in place, which a reload never sees: ${recreate}`,
	};
}

/**
 * The text of the host file a proxy bind-mounts at the include's path (issue #503, gate round 2), from its inspected
 * `[{ type, source, destination }]`, or null: no such bind, or a source this host cannot read (Docker Desktop reports the
 * real macOS path, so it reads there), and then the replaced-file compare is skipped rather than guessed.
 */
function readIncludeBindSource(mounts) {
	const bind = (Array.isArray(mounts) ? mounts : []).find((m) => m?.type === "bind" && m.destination === ENDPOINTS_INCLUDE_IN_PROXY);
	if (!bind || typeof bind.source !== "string" || !isAbsolute(bind.source)) return null;
	const text = readTextOrNull(bind.source);
	return text === null ? null : { path: bind.source, text };
}

/** `{{json .Mounts}}` as `[{ type, source, destination }]`, the shape `parseProxyState` gives docker's; `[]` when unreadable. */
function mountsFromJson(output) {
	try {
		const list = JSON.parse(String(output ?? "").trim());
		return (Array.isArray(list) ? list : []).filter((m) => m && typeof m === "object").map((m) => ({ type: String(m.Type ?? ""), source: String(m.Source ?? ""), destination: String(m.Destination ?? "") }));
	} catch {
		return [];
	}
}

/** A regular file's text, or null for anything else or any failure: a compare that has nothing to compare says nothing. */
function readTextOrNull(path) {
	try {
		return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

/**
 * The route from the egress proxy to each endpoint's host on THIS runtime (issue #503), from the measured table
 * (`hostRouteFor`, `HOST_ROUTES` in backends.mjs). Only a REFUTED route fails: the proxy cannot reach that host here,
 * whatever is listening. A measured route is a ✓ saying what it needs. One that is not measured on this runtime, or is
 * another machine's ordinary outbound route, is said as information and NOT warned about: nearly every runtime version
 * is unmeasured, so a ⚠ there would be on every run, and the endpoint probe is what proves the route.
 */
function endpointRouteChecks({ runtime, endpoints, prefix, proof }) {
	return endpointsById(endpoints).map((endpoint) => {
		const { status, sentence } = hostRouteFor(runtime, endpoint.host);
		const head = `${prefix}Model endpoint ${endpoint.id} (${endpointAddress(endpoint.host, endpoint.port)})`;
		if (status === HOST_ROUTE_REFUTED) {
			return { ok: false, label: `${head} has no route from the egress proxy on this runtime: ${sentence}`, fix: "declare the host this runtime reaches (docs/backends.md lists the measured routes per venue: host.docker.internal on Docker, host.containers.internal on Podman), then `pi-dispatch egress render` and the reload it prints" };
		}
		if (status === HOST_ROUTE_WORKS) return { ok: true, label: `${head}: ${sentence}` };
		// Another machine: an ordinary route out, said as such, never prefixed "not measured" before a sentence that names
		// where it WAS measured.
		if (status === HOST_ROUTE_LAN) return { ok: true, label: `${head}: ${sentence} ${proof}` };
		// A rootless Podman that did not say which helper it runs: the table's rows are per helper, so none applies. Said as
		// what this Podman did not report, never as a fault of the host or the endpoint.
		if (runtime?.backend === "podman" && runtime.rootless === true && typeof runtime.helper !== "string") {
			return { ok: true, label: `${head}: the rootless network helper was not reported by this Podman, so the route is not judged here. ${proof}` };
		}
		return { ok: true, label: `${head}: the route from the proxy is not measured here. ${sentence} ${proof}` };
	});
}

/**
 * The runtime `hostRouteFor` reads, from the `docker info` answer doctor already holds (`makeDaemonFactsReader`), or
 * null. Docker Desktop is the daemon that calls its OS `Docker Desktop`, as the job-user line reads it; rootful Podman
 * through its Docker API is `podman`. Nothing else is asked: a field doctor does not have stays missing and the route
 * reads unmeasured.
 */
function routeRuntimeFromFacts(answer, platform) {
	const facts = answer?.answered === true ? answer.facts : null;
	if (!facts) return null;
	const version = facts.serverVersion ?? "";
	if (facts.podman === true) return { backend: "podman", version, ...(typeof facts.rootless === "boolean" ? { rootless: facts.rootless } : {}) };
	const desktop = facts.os === "Docker Desktop";
	return { backend: "docker", version, desktop, ...(desktop ? { os: platform } : {}) };
}

/**
 * The rootless network helper this account is running (`slirp4netns` or `pasta`), from `observeRootlessNetns`, or null
 * when none runs, the read fails, or two kinds run at once. Podman 4.9.3's `podman info` names no helper, so this is how
 * its slirp4netns is known there; with no bridge container running there is no helper to see, and the route reads
 * unjudged rather than guessed from the version.
 */
function runningNetnsHelper({ fs, euid, runRoot }) {
	if (!fs || !Number.isInteger(euid)) return null;
	try {
		const seen = observeRootlessNetns({ fs, euid, runRoot });
		const kinds = [...new Set((seen.helpers ?? []).map((h) => h.kind))];
		return kinds.length === 1 ? kinds[0] : null;
	} catch {
		return null;
	}
}

/** The interface names whose addresses are a runtime's own bridges or a VM's, never this host's LAN address. */
const NOT_LAN_INTERFACE = /^(?:docker|br-|virbr|veth|cni|podman|flannel|cali|vmnet|vboxnet|utun|bridge|lima)/;

/**
 * This host's own IPv4 LAN addresses for `hostRouteFor` (`hostAddresses`), or undefined for none: plain dotted quads,
 * not loopback, not link-local, and not on a container bridge (docker0, a compose `br-`, podman's), whose address a
 * declaration naming it would reach by another route than the own-address row was measured on.
 */
export function lanIPv4Addresses(interfaces) {
	const found = [];
	for (const [name, list] of Object.entries(interfaces ?? {})) {
		if (NOT_LAN_INTERFACE.test(name) || !Array.isArray(list)) continue;
		for (const a of list) {
			if ((a?.family !== "IPv4" && a?.family !== 4) || a.internal === true || typeof a.address !== "string") continue;
			if (!/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(a.address) || a.address.startsWith("169.254.") || a.address.startsWith("127.")) continue;
			if (!found.includes(a.address)) found.push(a.address);
		}
	}
	return found.length > 0 ? found : undefined;
}

/** Whether a host as `baseUrlTarget` gives it is loopback or host-local from inside a job (`PROXY_LOCAL_ADDRESSES`). */
function loopbackTarget(host) {
	if (host.startsWith("[") && host.endsWith("]")) return isProxyLocalHost("ipv6", host.slice(1, -1));
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isProxyLocalHost("ipv4", host);
	return isProxyLocalHost("name", host);
}

/**
 * The overlay models.json's models whose effective baseUrl (the model's own, else its provider's) names localhost or
 * a loopback literal (issue #503), as `provider/model (host:port)` strings. Inside a job that address is the job's own
 * container, egress on or off, so no job reaches the server. A provider that lists no models is named by itself.
 */
export function overlayLoopbackModels(models) {
	const providers = models?.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return [];
	const found = [];
	for (const [name, entry] of Object.entries(providers)) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const listed = Array.isArray(entry.models) ? entry.models.filter((m) => m !== null && typeof m === "object" && typeof m.id === "string") : [];
		const check = (baseUrl, who) => {
			const target = baseUrlTarget(baseUrl);
			if (target && loopbackTarget(target.host)) found.push(`${who} (${target.host}:${target.port})`);
		};
		if (listed.length === 0) check(entry.baseUrl, quotedShown(name));
		for (const m of listed) check(typeof m.baseUrl === "string" ? m.baseUrl : entry.baseUrl, `${quotedShown(name)}/${quotedShown(m.id)}`);
	}
	return found;
}

/** The two host aliases a model server on this machine is declared by, never listed in the allowlist. */
const HOST_ALIASES = Object.freeze(["host.docker.internal", "host.containers.internal"]);

/**
 * Host aliases the allowlist admits (issue #503), from its text, as `[{ alias, entry }]` with the first entry that admits
 * each: squid's `dstdomain` file, one entry per word, `#` comments, and an entry with a leading dot admitting that domain
 * and every name under it, so `.internal` and `.docker.internal` admit `host.docker.internal` as surely as the name
 * itself. Admitting one opens that host's port 443 by CONNECT and its port 80 by plain HTTP, and no model server's port,
 * which is the confusion this names.
 */
export function allowlistHostAliases(text) {
	const found = new Map();
	for (const line of String(text ?? "").split(/\r?\n/)) {
		for (const word of line.replace(/#.*/, "").trim().split(/\s+/)) {
			const entry = word.toLowerCase();
			if (entry === "") continue;
			for (const alias of HOST_ALIASES) {
				const admits = entry.startsWith(".") ? alias === entry.slice(1) || alias.endsWith(entry) : alias === entry;
				if (admits && !found.has(alias)) found.set(alias, word);
			}
		}
	}
	return HOST_ALIASES.filter((a) => found.has(a)).map((alias) => ({ alias, entry: found.get(alias) }));
}

/**
 * The worker and receiver services installed for THIS folder, as `[{ which, source, setup }]` (`setup` null for a unit
 * rendered without `--env-setup`): an installed unit whose WorkingDirectory is this folder (systemd, launchd), or the
 * nssm service by name on win32, where nssm keeps the folder in a separate AppDirectory property and there is exactly
 * one machine-scoped service per name. Read ONCE (issue #481, PR #485's final review) and shared by the env-setup lines
 * and every check that asks whether a service's script may supply a value, so no second `nssm get` is spent.
 */
async function installedServices(seams) {
	const { cwd, spawn, fileExists, platform, home } = seams;
	const found = [];
	if (platform === "win32") {
		for (const which of ["worker", "receiver"]) {
			const service = `pi-dispatch-${which}`;
			const got = await runCmdCapture(spawn, "nssm", ["get", service, "AppEnvironmentExtra"]);
			// Not installed, or nssm not on PATH: silence. Same doctrine as check-ignore below -- a check
			// nobody can silence must never cry wolf, and "could not ask" is not "misconfigured".
			if (got.code !== 0) continue;
			found.push({ which, source: `${service}'s AppEnvironmentExtra`, setup: readUnitSeam(got.output, "win32").setup });
		}
	} else {
		for (const { path, which } of installedUnitPaths(platform, home)) {
			if (!fileExists(path)) continue;
			let seam;
			try {
				seam = readUnitSeam(readFileSync(path, "utf8"), platform);
			} catch {
				continue; // a system-scope unit this user may not read: which deployment it serves is unknowable
			}
			if (seam.deployDir !== cwd) continue;
			found.push({ which, source: path, setup: seam.setup });
		}
	}
	return found;
}

/**
 * Where this deployment's service sources an `--env-setup` script from, as `Map<path, how doctor learned it>`, for the
 * env-setup lines: the installed services for this folder, else PI_ENV_SETUP in doctor's own environment. The
 * fallback is for REPORTING only (it answers for a doctor run through the environment launchd or nssm give the service);
 * nothing a service may or may not be given is judged from it (`setupSupplies`).
 */
function envSetupSources(env, services) {
	const sources = new Map(); // setup path -> how doctor learned it; the first source to name it wins
	for (const { setup, source } of services) if (setup && !sources.has(setup)) sources.set(setup, source);
	// env-internal PI_ENV_SETUP: unit configuration, deliberately never an .env key. The wrappers capture
	// it BEFORE they source ./.env so that nothing able to write that file can name a script they run
	// (REQ-DEPLOYMENT-BOOTSTRAP). doctor reads it here only to answer for a host whose unit names none.
	// NOT trimmed, because `worker-env-wrapper.sh` does not trim: it tests `[ -n "$env_setup" ]` and then
	// `[ ! -f "$env_setup" ]`, so `PI_ENV_SETUP="   "` is a CONFIGURED script that does not exist and the
	// wrapper refuses to start on it. Trimming here read that as unset, so the one deployment shape where
	// the worker cannot boot got no line anywhere in the report (issue #384).
	const fromEnv = env.PI_ENV_SETUP ?? "";
	if (sources.size === 0 && fromEnv !== "") sources.set(fromEnv, "PI_ENV_SETUP in this environment");
	return sources;
}

/**
 * The `--env-setup` script (issue #216). `pi-dispatch service render|install --env-setup <path>` names a
 * script the service manager SOURCES at every boot, as the service user, with the deployment's
 * environment -- and after that nothing ever looks at it again. resolveEnvSetup checked it existed once,
 * at render time, on a host that may not be this one.
 *
 * doctor has to DISCOVER the path before it can check it, because --env-setup is a render-time flag and
 * the rendered unit is the only place it lives. Two sources, in this order:
 *
 *   1. The installed units for THIS deployment -- the file that actually boots, and so the honest
 *      answer. A unit whose WorkingDirectory names some other folder belongs to some other deployment on
 *      the same host and is deliberately skipped: doctor is this deployment's preflight, and warning
 *      about a neighbour's unit would fire forever on a host that runs two.
 *   2. PI_ENV_SETUP in doctor's OWN environment, and only when (1) found nothing. That is what launchd
 *      and nssm put in front of the wrapper, so it is the right answer for a doctor run through the same
 *      environment the service gets. It is a different question from (1), which is why every line below
 *      names the source it came from rather than blurring the two.
 *
 * Everything here is warn-tier and nothing carries a `fixAction` -- the never tier
 * (REQ-DEPLOYMENT-BOOTSTRAP): doctor does not chmod an operator's file and does not move it. Nor does it
 * ever OPEN the script. The script holds no secret by design, but what it holds is the commands that
 * fetch them, and a preflight that echoed those would be publishing the map instead of the treasure.
 *
 * Returns [] when no seam is configured, so a deployment that does not use one gets byte-identical
 * output.
 */
async function envSetupChecks(env, seams, sources) {
	const { spawn, fileExists, platform, runTimeouts = RUN_TIMEOUTS } = seams;

	const checks = [];
	for (const [setup, source] of sources) {
		if (!fileExists(setup)) {
			checks.push({
				ok: false,
				warn: true,
				label: `the env-setup script at ${envValueShown(setup)} does not exist (named by ${source})`,
				fix: "restore it, or re-render without --env-setup -- the service manager sources it at every boot, so until it is back the unit exits 1 in a restart loop and the worker never starts (docs/secrets.md)",
			});
			continue;
		}
		checks.push({ ok: true, label: `env-setup script present (${setup}, named by ${source})` });

		// WRITABILITY, not readability -- deliberately `& 0o022` and not the App key's `& 0o077`. This file
		// is EXECUTED (sourced) by the account that holds the provider key and the forge token, so anyone
		// who can edit it owns the worker. That it is READABLE is fine: it holds no secret by design.
		// POSIX only, for the same reason the App key's mode check skips win32 -- stat modes are synthetic
		// there, so this would warn on every healthy Windows deployment and teach operators to scroll past.
		if (platform !== "win32") {
			try {
				if ((statSync(setup).mode & 0o022) !== 0) {
					checks.push({
						ok: false,
						warn: true,
						label: `the env-setup script at ${setup} is group/world-writable`,
						fix: `chmod go-w ${setup} -- the service manager sources it at every boot as the account that holds the provider key and the forge token, so whoever can edit it owns the worker`,
					});
				}
			} catch {
				// stat raced a deletion or an exotic fs: the presence line above already covered existence.
			}
			const dir = dirname(setup);
			try {
				const mode = statSync(dir).mode;
				// Sticky (0o1000) is exempt and must stay exempt: in a sticky directory a non-owner cannot
				// rename or delete someone else's file, so "anyone can replace it" would simply be false there.
				if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
					checks.push({
						ok: false,
						warn: true,
						label: `the directory holding the env-setup script (${dir}) is group/world-writable`,
						fix: `chmod go-w ${dir} -- the script's own mode does not help when anyone can replace the file, and the manager sources whatever is there at the next boot`,
					});
				}
			} catch {
				// an unreadable parent directory: nothing to claim either way.
			}
		}

		// The #211 question, asked of a different file. Exit 1 is again the ONLY case that speaks: 0 means
		// ignored, 128 means no work tree, null means git could not be launched, and all three are silence.
		const ignoreCode = (await runCmd(spawn, "git", [...GIT_READ_FLAGS, "-C", dirname(setup), "check-ignore", "-q", setup], runTimeouts.cmd)).code;
		if (ignoreCode === 1) {
			checks.push({
				ok: false,
				warn: true,
				label: `the env-setup script at ${setup} is inside a git work tree that does not ignore it`,
				fix: "move it outside that repo, or ignore it there -- it holds no secret by design, but it holds the commands that FETCH them (client and project ids, a manager address, sometimes a path to a credential file), which is a map to every secret this deployment uses",
			});
		}
	}
	return checks;
}

/**
 * READ-ONLY branch-protection preflight for the github repos the triggers file names (issue #80,
 * REQ-BRANCH-PROTECTION-PRECONDITION). Two `gh api` GETs per repo -- resolve the default branch, then ask
 * the protection endpoint -- and never anything else: doctor reports repo settings, it does not change
 * them, so the fix line SHOWS the settings page rather than running a PUT.
 *
 * A non-zero exit on the protection endpoint deliberately conflates GitHub's determinate 404 ("no
 * protection") with transient errors. The worker's own gate does the 404-vs-retryable split, because there
 * a false "unprotected" would disarm the never-merge backstop (github-host.mjs, issue #61) -- here every
 * answer is an advisory warn, and a warn that occasionally fires on a flaky API is acceptable where a
 * false ✓ would not be.
 *
 * Exported rather than folded into runDoctor: the shared schema admits `run.repository` only on azure
 * triggers today (see readTriggerFacts), so no valid triggers file can reach this loop through runDoctor
 * yet -- tests exercise it directly, and the runDoctor wiring is already live for the day the schema
 * grows the field for github. Returns check objects in runDoctor's `{ok, warn, label, fix}` shape.
 */
export async function githubProtectionPreflight(spawn, repositories, runTimeouts = RUN_TIMEOUTS) {
	const checks = [];
	// gh availability first, mirroring the GITHUB_AUTH_SOURCE=gh handling in runDoctor: one warn covers
	// every repo, and the loop is skipped rather than producing one confusing failure line per repo.
	const status = await runCmdCapture(spawn, "gh", ["auth", "status"]);
	if (status.code !== 0) {
		checks.push({
			ok: false,
			warn: true,
			label: `branch-protection preflight skipped: gh is unavailable or not logged in (${repositories.length} github repo(s) named in triggers.json)`,
			fix: "install gh and run `gh auth login` -- the preflight is a read-only `gh api` per repo; the worker still enforces REQ-BRANCH-PROTECTION-PRECONDITION at job time either way",
		});
		return checks;
	}
	// Bounded so a large trigger file cannot turn doctor into a network crawl: two API round-trips per
	// repo, five repos. The rest are not silently dropped -- the cap line says so, and job time enforces.
	const capped = repositories.slice(0, 5);
	if (repositories.length > capped.length) {
		checks.push({
			ok: true,
			label: `branch-protection preflight capped at ${capped.length} of ${repositories.length} repos -- the rest are still enforced per job before any spend`,
		});
	}
	for (const repo of capped) {
		const branch = await runCmdCapture(spawn, "gh", ["api", `repos/${repo}`, "--jq", ".default_branch"]);
		const name = branch.code === 0 ? branch.output.trim() : "";
		if (!name) {
			checks.push({
				ok: false,
				warn: true,
				label: `could not resolve the default branch of ${repo} -- branch protection not preflighted`,
				fix: "check the run.repository value and this gh login's access to it; the worker still refuses an unprotected repo at job time",
			});
			continue;
		}
		// THE ONE SITE WHERE A TIMEOUT WOULD HAVE BEEN A WRONG VERDICT rather than a missing one: this is a
		// network call, and reading "did not finish" as "non-zero exit" reports a PROTECTED branch as
		// unprotected and tells the operator to go and protect it. It says it could not tell, instead --
		// the wording the unresolvable-default-branch arm above already uses for the same situation.
		const protection = await runCmd(spawn, "gh", ["api", `repos/${repo}/branches/${name}/protection`], runTimeouts.cmd);
		checks.push(
			protection.code === 0
				? { ok: true, label: `default branch of ${repo} is protected (${name})` }
				: protection.ended === "timeout"
					? {
							ok: false,
							warn: true,
							label: `could not check branch protection for ${repo} -- gh did not answer in ${Math.round(runTimeouts.cmd / 1000)}s`,
							fix: "re-run when the forge is reachable; the worker still refuses an unprotected repo at job time, so this is a preflight and not the gate",
						}
					: {
							ok: false,
							warn: true,
							label: `default branch of ${repo} is not protected -- the worker refuses forge jobs on unprotected repos before any spend (REQ-BRANCH-PROTECTION-PRECONDITION)`,
							fix: `protect ${name} at https://github.com/${repo}/settings/branches (see SECURITY.md) -- a read-only preflight, doctor never changes repo settings`,
						},
		);
	}
	return checks;
}

/**
 * Resolve a spawned command's exit code, BOUNDED, and say why it ended (issue #397).
 *
 * This had no timeout at all, so a daemon that accepts the connection and never answers held
 * `pi-dispatch doctor` open at the FIRST docker call with nothing printed and no check to point at.
 * Measured on docker 27.4.0: `docker info` against such a daemon waits indefinitely, and the CLI's own
 * `--tls*` timeouts do not apply to a socket that is open but silent.
 *
 * ONE BOUND WITH A PER-CALL OVERRIDE, which is why this is not simply a constant. `--fix`'s `docker pull`
 * can legitimately take minutes on a cold host, so a single bound is either too short for the pull or too
 * long to be a bound. `runCmdCapture` beside this one already had exactly that shape, and so does
 * `import-pi`'s 600s override, so this is the file's existing answer rather than a new one.
 *
 * AND IT SAYS WHY, in `liveRunVia`'s vocabulary (`"error"`, `"timeout"`, `"close"`), because the two nulls
 * are opposite facts to an operator: a CLI that never launched means docker is not installed, and one
 * killed by the bound means the daemon is wedged. Reading a timeout as "not installed" would tell someone
 * with a running-but-stuck daemon to install Docker, and reading `gh api`'s timeout as a non-zero exit
 * would report a PROTECTED branch as unprotected. Every caller that can tell those apart now does.
 */
function runCmd(spawn, cmd, args, timeoutMs = RUN_TIMEOUTS.cmd) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolve({ code: null, ended: "error" });
			return;
		}
		let done = false;
		const finish = (code, ended) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, ended });
		};
		// SIGKILL, like `liveRunVia`: a catchable signal lets a child that is already wedged outlive the
		// bound, which is the whole thing this is here to stop.
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(null, "timeout");
		}, timeoutMs);
		child.on("error", () => finish(null, "error")); // ENOENT etc. — the binary is not available
		child.on("close", (code) => finish(code, "close"));
	});
}

/**
 * The step that gives a deployment's Valkey its password and restarts it with it (issue #468), per venue: the podman
 * venue's Quadlet Valkey through `service install --force`, docker's through `up` (or compose's own recreate). Named,
 * never run by doctor (issue #471's rule).
 */
export function valkeyPasswordUpgradeStep({ localUsed, podmanUsed }) {
	if (podmanUsed && !localUsed) return "run `pi-dispatch service install --force` as this account: it writes a VALKEY_PASSWORD into .env, restarts the Quadlet Valkey with it (the queue in its volume is kept) and then the worker and the receiver";
	return "run `pi-dispatch up`: it writes a VALKEY_PASSWORD into .env and restarts pi-dispatch-valkey with it (its volume, and the queue, is kept); a compose-started Valkey is recreated with `docker compose --env-file .env -f deploy/docker-compose.yml up -d`. Then restart the worker and the receiver so they send it";
}

/** The fix for a Valkey that refuses this deployment's credential (issue #468). */
function valkeyAuthFix(state, { localUsed, podmanUsed, envPath }) {
	if (state === "noauth") return `put ${VALKEY_PASSWORD_KEY}=<that Valkey's password> in ${envPath} (for a Valkey shared with PI_VALKEY_SHARED=1, the password of the account that runs it), then restart the worker and the receiver`;
	return `${VALKEY_PASSWORD_KEY} in ${envPath} is not that Valkey's password. If you changed it, restart Valkey with it: ${valkeyPasswordUpgradeStep({ localUsed, podmanUsed })}`;
}

/**
 * Doctor's password lines (issue #468), after the reachability line: whether this deployment's Valkey requires a
 * password, said by whether one is SET and never by its value. A loopback Valkey that answers a client sending none is a
 * warning with the upgrade step (any local account can read and feed that queue); a remote one is the operator's own and
 * is not judged. A `.env` holding VALKEY_PASSWORD that other accounts can read is a warning too, and a value the start
 * script could not hand to Valkey is a failure. The file's value comes from issue #471's one resolution (`fileValue`).
 */
async function valkeyPasswordChecks({ verdict, context, seams, valkeyUrl, valkeyTalkUrl, localUsed, podmanUsed, platform, statSeam, fileValue }) {
	const checks = [];
	const inFile = fileValue(VALKEY_PASSWORD_KEY);
	if (typeof inFile === "string" && inFile !== "" && seams.serviceEnvFile) {
		const problem = valkeyPasswordProblem(inFile);
		if (problem) checks.push({ ok: false, label: `${VALKEY_PASSWORD_KEY} in ${seams.serviceEnvFile.path} cannot be handed to Valkey: ${problem}`, fix: VALKEY_PASSWORD_HOWTO });
		if (platform !== "win32") {
			let mode = null;
			try {
				mode = statSeam(seams.serviceEnvFile.path).mode;
			} catch {
				// Unreadable metadata: nothing is said about it.
			}
			if (typeof mode === "number" && (mode & 0o077) !== 0) {
				checks.push({ ok: false, warn: true, label: `${seams.serviceEnvFile.path} holds ${VALKEY_PASSWORD_KEY} and is readable by ${(mode & 0o007) !== 0 ? "every account on this host" : "its group"} (mode ${(mode & 0o777).toString(8).padStart(3, "0")})`, fix: `chmod 600 ${seams.serviceEnvFile.path}` });
			}
		}
	}
	if (!verdict || verdict.state !== "ok" || !seams.valkeyAuth) return checks;
	let host = "";
	try {
		host = new URL(valkeyUrl).hostname;
	} catch {
		return checks;
	}
	// A Valkey on another machine is the operator's own to secure; the threat this answers is another account on THIS one.
	if (!isLoopbackHost(host)) return checks;
	const open = await seams.valkeyAuth(valkeyTalkUrl, { context, withoutPassword: true });
	const upgrade = valkeyPasswordUpgradeStep({ localUsed, podmanUsed });
	if (open.state === "ok") {
		checks.push(
			verdict.passwordSet
				? { ok: false, warn: true, label: `Valkey (${urlShown(valkeyUrl)}) answers a client that sends no password, although ${VALKEY_PASSWORD_KEY} is set: it was started before the password existed, and any local account can read, enqueue or delete this deployment's jobs`, fix: upgrade }
				: { ok: false, warn: true, label: `Valkey (${urlShown(valkeyUrl)}) has no password: any local account can read, enqueue or delete this deployment's jobs (${VALKEY_PASSWORD_KEY} is not set)`, fix: upgrade },
		);
	} else if (open.state === "noauth") {
		// The source named (PR #475's review): the environment, the .env, or the URL's own userinfo, never the value.
		const source = verdict.from === "VALKEY_URL" ? "the password in VALKEY_URL" : verdict.from ? `${VALKEY_PASSWORD_KEY} from ${verdict.from}` : VALKEY_PASSWORD_KEY;
		checks.push({ ok: true, label: `Valkey (${urlShown(valkeyUrl)}) requires a password, and the one this deployment sends (${source}) is accepted (the value is not shown)` });
	}
	return checks;
}

/**
 * Like runCmd but collects stdout+stderr into one combined string — gh moves its human output between
 * the two across versions, so callers get both. Resolves `{code, output}`; `code: null` when the command
 * could not be launched or overran the timeout (default 30s, so a hung docker daemon cannot stall doctor).
 * `opts.env` is passed through to the spawn so secrets can travel via env instead of argv; `opts.cwd`
 * likewise, for the child-process fixActions that must run where doctor's own cwd seam points.
 */
/**
 * The build-ish scripts a staged package declares, which `--ignore-scripts` means did NOT run (issue #102).
 * `prepare` and `build` join the stager's own trio because a package can declare either and still ship
 * unbuilt sources. Returns [] for anything unreadable: a package we cannot parse is not a finding.
 */
function buildScriptsOf(packageDir, fileExists) {
	const path = join(packageDir, "package.json");
	if (!fileExists(path)) return [];
	try {
		const scripts = JSON.parse(readFileSync(path, "utf8"))?.scripts ?? {};
		return ["prepare", "postinstall", "install", "build"].filter((key) => typeof scripts[key] === "string");
	} catch {
		return [];
	}
}

function runCmdCapture(spawn, cmd, args, opts = {}) {
	// `stdoutOnly` for a caller that PARSES the answer (issue #345): Podman's docker emulation prints a banner on
	// stderr ("Emulate Docker CLI using podman ..."), which a merged capture puts in front of the value.
	// `input` for a caller that hands the child a secret (issue #521): written to its stdin and closed, so the value is in
	// neither argv nor any environment. Without it stdin stays ignored, as every other caller wants.
	const { timeoutMs = 30000, stdoutOnly = false, input } = opts;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
		} catch {
			resolve({ code: null, output: "" });
			return;
		}
		if (input !== undefined) {
			// A child that exits before reading (a missing image, a CLI that refuses the argv) closes the pipe under the
			// write: EPIPE is that child's answer, which its exit code already carries, not doctor's crash.
			child.stdin?.on("error", () => {});
			child.stdin?.end(input);
		}
		let output = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, output });
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => {
			if (!stdoutOnly) output += d;
		});
		child.on("error", () => finish(null)); // ENOENT etc. — the binary is not available
		child.on("close", (code) => finish(code));
	});
}

/**
 * Pull the scope list out of `gh auth status` output. The line reads like
 * `  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'` (older gh omits the quotes). Returns null
 * when the line is absent — fine-grained tokens report no classic scopes at all.
 */
function parseGhTokenScopes(output) {
	const m = output.match(/Token scopes:\s*(.+)/);
	if (!m) return null;
	return m[1]
		.split(",")
		.map((s) => s.trim().replace(/^'(.*)'$/, "$1"))
		.filter((s) => s.length > 0);
}

/**
 * Reachability probe with a raw, fail-fast ioredis client. `lazyConnect` holds the connect until the
 * error handler is attached, so a down Valkey is reported as one ✗ line — not the ioredis stack traces
 * a BullMQ Queue's internal client would dump. Reuses `parseConnection`'s fail-fast options (cli.mjs:88).
 */
/**
 * The fleet's registry rows (issue #57), through a fail-fast client that is always disconnected.
 *
 * A SEAM rather than a direct import so the multi-host checks are testable with no Valkey at all, which
 * is the posture every other network-touching check here already takes. Never throws: a fleet this
 * command cannot see is a fleet it says nothing about, not a doctor that fails.
 */
/**
 * This host's name as the worker computes it, so doctor and the worker cannot disagree about who "I" am. Takes the
 * declared name collectChecks resolved (`declaredWorkerName`, issue #464), not an environment.
 */
function workerNameOf(declared) {
	return declared || defaultWorkerName();
}

async function defaultReadHosts(url) {
	try {
		const { makeRedisClient } = await import("./connection.mjs");
		const { readLiveHosts } = await import("./host-registry.mjs");
		const client = makeRedisClient(url, { failFast: true, lazyConnect: true });
		client.on("error", () => {});
		try {
			await client.connect();
			return await readLiveHosts(client);
		} finally {
			client.disconnect();
		}
	} catch (err) {
		return { unreachable: err?.message ?? "registry unreadable" };
	}
}

/**
 * Has any host reserved dollars on this Valkey recently? For `fleetDollarChecks`, asked only when a peer publishes no
 * `fpUsd` and nothing else says dollar caps are in use. BEST EFFORT, and it says so wherever it is described:
 *   1. EXISTS on the deployment's current day, week and month keys (`budget:usd:YYYY-MM-DD`, `:w:<Monday>`,
 *      `:m:YYYY-MM`, `budget.mjs`'s key functions at `now`), the counters any host with a dollar window writes;
 *   2. else a bounded SCAN for `budget:usd:*` (at most ten passes of COUNT 1000), for scope and model windows.
 * The whole read is bounded by `deadlineMs`, so a large keyspace or a hung server answers "not seen". Any fault is
 * false: the answer can add a warning, never remove one. A host whose only dollar setting is the per-job cap writes no
 * counter at all, so it is not found this way (PR #551's review, round 2).
 */
export async function dollarKeysExistWith(client, { now = () => new Date(), deadlineMs = 2000 } = {}) {
	let timer;
	const deadline = new Promise((resolve) => {
		// NOT unref'd, `host-registry.mjs`'s reason: an unref'd timer does not fire when the hung call is the last thing
		// holding the loop, which is the case it is for. It is cleared as soon as the answer is in.
		timer = setTimeout(() => resolve(false), deadlineMs);
	});
	const ask = (async () => {
		const at = now();
		const current = [dayKey(at, DOLLAR_KEY_PREFIX), weekKey(at, DOLLAR_KEY_PREFIX), monthKey(at, DOLLAR_KEY_PREFIX)];
		if (Number(await client.exists(...current)) > 0) return true;
		let cursor = "0";
		for (let pass = 0; pass < 10; pass++) {
			const [next, keys] = await client.scan(cursor, "MATCH", `${DOLLAR_KEY_PREFIX}:*`, "COUNT", 1000);
			if (Array.isArray(keys) && keys.length > 0) return true;
			cursor = String(next);
			if (cursor === "0") return false;
		}
		return false;
	})();
	ask.catch(() => {});
	try {
		return (await Promise.race([ask, deadline])) === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** `dollarKeysExistWith` over a fail-fast client on `url`, always disconnected. */
export async function defaultDollarKeysExist(url) {
	try {
		const { makeRedisClient } = await import("./connection.mjs");
		const client = makeRedisClient(url, { failFast: true, lazyConnect: true });
		client.on("error", () => {});
		try {
			await client.connect();
			return await dollarKeysExistWith(client);
		} finally {
			client.disconnect();
		}
	} catch {
		return false;
	}
}

async function defaultProbeValkey(url) {
	const { makeRedisClient } = await import("./connection.mjs");
	const client = makeRedisClient(url, { failFast: true, lazyConnect: true });
	client.on("error", () => {}); // swallow connect errors + retries; reachability is the ✓/✗, not a trace
	try {
		await client.connect();
		await client.ping();
		return true;
	} catch {
		return false;
	} finally {
		client.disconnect();
	}
}

/**
 * The deployment's default job size as doctor reads it (issue #596): `PI_JOB_MEMORY` and `PI_JOB_CPUS` through the
 * worker's own rule (`jobSizeDefaults`), or the built-in 4g and 2 when they do not parse (`jobSizeChecks` reports that as
 * the boot refusal it is, and the read-backs then probe the size a fixed configuration would get).
 */
export function doctorJobSize(env) {
	try {
		const d = jobSizeDefaults(env);
		return { memMiB: d.memMiB, cpuCenti: d.cpuCenti, source: d.memSet || d.cpuSet ? "env" : "default" };
	} catch {
		return DEFAULT_JOB_SIZE;
	}
}

/**
 * The job size lines (issue #596): the default size every job without a project size gets, the `--cpus` ceiling this
 * host's runtime gives every job, and a WARNING where the Docker daemon reports `SwapLimit` false, because there
 * `--memory-swap` cannot be enforced and a job may swap past its memory, which the size promised it would not.
 * A setting that does not parse is a FAILURE: the worker refuses to start on it (`loadConfig`).
 * `daemon` is the local venue's one `docker info` answer, or null where it was not read.
 */
export function jobSizeChecks(env, { daemon = null } = {}) {
	let d;
	try {
		d = jobSizeDefaults(env);
	} catch (error) {
		return [{ ok: false, label: `job size does not parse: ${error.message}, so the worker REFUSES TO START`, fix: "set PI_JOB_MEMORY like 512m, 1536m or 4g and PI_JOB_CPUS like 0.5 or 2 (or unset them for 4g and 2), then re-run doctor" }];
	}
	const where = d.memSet || d.cpuSet ? "PI_JOB_MEMORY and PI_JOB_CPUS" : "the built-in default";
	const checks = [{ ok: true, label: `Job size: ${formatMemory(d.memMiB)} of memory with no swap beyond it, and the CPU weight of ${formatCpus(d.cpuCenti)} CPUs, per job (${where}; a project row's memory and cpus override it, docs/scoped-limits.md)` }];
	const facts = daemon?.answered === true ? daemon.facts : null;
	const ceiling = hostCpuCeiling(facts?.hostCpus);
	if (ceiling !== null) checks.push({ ok: true, label: `local: every job may use at most ${ceiling} of this runtime's ${facts.hostCpus} CPUs (--cpus)${ceiling < facts.hostCpus ? ", one kept for the host" : ""}; under contention each gets CPU in proportion to its size (--cpu-shares)` });
	if (facts?.swapLimit === false) {
		checks.push({ ok: false, warn: true, label: "local: the Docker daemon reports SwapLimit false, so --memory-swap cannot be enforced here and a job may swap beyond its memory", fix: "enable swap accounting in the kernel (cgroup v2, or swapaccount=1 on cgroup v1), restart Docker, then re-run doctor" });
	}
	return checks;
}

/**
 * WHERE this deployment's jobs run, and what that place actually guarantees (issue #227).
 *
 * THIS IS THE CHECK THAT MAKES THE DECLARATION ADMISSIBLE AT ALL. `CONST-EGRESS-POLICY-IN-THE-ARGV` says a
 * control an operator BELIEVES in is worse than one they know is missing, because the belief displaces the
 * credential bound that is really holding. A table of guarantees nothing ever prints is exactly such a
 * belief. So the three words must stay TOLD APART on the way out, and told apart ON THE SCREEN rather than
 * in a field nobody renders:
 *
 *   enforced -- ours, in this worker's own code, readable back from what it produced. Quiet.
 *   asserted -- someone else's. Rendered as a WARNING, and it NAMES who is asserting it, because "not us"
 *               without "them" leaves an operator nothing to go and check.
 *   absent   -- not provided at all. A failure, since a deployment reaching it must know before a job does.
 *
 * `ok: false, warn: true` IS THE WARNING SHAPE, and it is the one thing to get right when editing here.
 * `render` reads `c.ok` FIRST, so `ok: true, warn: true` renders as a plain pass and drops the `fix` line
 * with it. An earlier draft used that shape and every asserted property printed as a green tick, which made
 * this section say the opposite of what it exists to say. `warn` keeps the RUN green -- `render` only fails
 * on `!ok && !warn` -- so an operator's CI is unaffected while the operator is actually told.
 *
 * A property a deployment switch gates is printed with the switch AND its position, never the bare
 * capability word: `local` can enforce egress, and a `PI_EGRESS=0` deployment is not getting it. Those are
 * two different sentences. `absent` OUTRANKS the gate, because a control that does not exist is a different
 * fact from one that is merely unarmed, and "CAN be absent but the switch is off" would be both meaningless
 * and green.
 *
 * Reads the environment directly, like every other check here, and parses through `backends.mjs` so doctor
 * and the worker cannot disagree about what a floor says.
 */
export function backendChecks(env, { endpoint = null, daemon = null, fs = { statSync, readFileSync, readdirSync }, podman = null, unit } = {}) {
	const checks = [];
	// What this shell's docker CLI resolves (#278), and what its daemon and this host's files say about bounds and mounts
	// (#345), as the observation map the table's `observedBy` reads. Anything doctor was not given is not observed, which
	// gets no credit -- the same polarity as everywhere. Issue #354: `podman` is `observePodman`'s answer plus the info
	// read it came from (`read`), or null where the podman venue is not blessed, which adds nothing to the map.
	const observed = observeHost({ endpoint, daemon, fs, unit, env });
	const observations = { ...observed.observations, [DOCKER_ENDPOINT_LOCAL]: endpoint?.local === true, ...(podman?.observations ?? {}) };
	let backends;
	let floor;
	try {
		backends = parseBackendList(env.PI_BACKENDS);
		floor = parseBackendFloor(env.PI_BACKEND_FLOOR);
	} catch (error) {
		// The worker refuses to boot on this, so doctor must not soften it to a warning.
		return [{ ok: false, label: `backend configuration does not parse: ${error.message}`, fix: "fix PI_BACKENDS / PI_BACKEND_FLOOR, then re-run doctor" }];
	}

	// The switch positions every `armedBy` in the table can name. A MAP rather than one boolean, because
	// `armedBy` is a general field: hardcoding one variable name here would silently hide a second switch's
	// off-position the day one is added, which is the defect `armedBy` exists to prevent.
	const switches = {};
	try {
		switches.PI_EGRESS = egressArmed(env);
	} catch (error) {
		// NOT an abstention that falls through to the good case. A value doctor cannot parse is a value the
		// worker refuses to boot on, and an earlier draft claimed in a comment that "its own check reports
		// that" -- nothing did, so doctor printed every gated property as quietly enforced on a deployment
		// that could not start.
		checks.push({ ok: false, label: `PI_EGRESS does not parse, so what this deployment actually gets cannot be determined: ${error.message}`, fix: 'set PI_EGRESS to exactly "0" (off) or "1"/unset (on)' });
	}

	// The dispatch landed in slice 4, so the "nothing selects yet" qualifier came off -- and it came off HERE
	// as well as in the code, because a stale caveat on the one surface that makes the table admissible is
	// its own kind of false statement.
	checks.push({ ok: true, label: `Jobs run on: ${backends.join(", ")}${backends.length > 1 ? ` (a trigger that names none runs on ${backends[0]}; run.backend selects)` : ""}` });

	for (const name of backends) {
		for (const property of PROPERTY_NAMES) {
			const d = declarationOf(name, property);
			if (!d) continue;
			// FIRST, ahead of the gate: a control that does not exist is not a control that is unarmed.
			if (d.word === ABSENT) {
				checks.push({ ok: false, label: `${name}: ${property} is ABSENT -- ${d.question}`, fix: `this backend does not provide ${property}; a deployment that needs it must not run jobs on ${name}` });
				continue;
			}
			if (d.armedBy && switches[d.armedBy] === undefined) {
				// The switch did not parse. Say so rather than pick a side; the failure is already reported.
				checks.push({ ok: false, warn: true, label: `${name}: ${property} depends on ${d.armedBy}, which does not parse -- cannot say whether this deployment gets it`, fix: `fix ${d.armedBy}, then re-run doctor` });
				continue;
			}
			if (d.armedBy && switches[d.armedBy] === false) {
				checks.push({ ok: false, warn: true, label: `${name}: ${property} CAN be ${d.word} here, but ${d.armedBy} is off, so this deployment is not getting it`, fix: `arm ${d.armedBy} to get it (${d.question})` });
				continue;
			}
			if (d.observedBy === DOCKER_ENDPOINT_LOCAL && observations[DOCKER_ENDPOINT_LOCAL] !== true) {
				// #278: the word holds only while the docker CLI sends containers to this host. Printed as what it
				// degrades to, and who is asserting it, with THIS SHELL named: the service's EnvironmentFile or a
				// systemd User= can resolve differently, and the worker logs its own answer at boot.
				const redirected = endpoint?.local === false;
				const seen = redirected ? `this shell's docker CLI resolves context ${quotedShown(endpoint.context)} to ${endpointShown(endpoint)}, which is not shown to be on this host` : `this shell's docker CLI did not say which endpoint it resolves (${endpoint?.reason ?? "not asked"})`;
				checks.push({
					ok: false,
					warn: true,
					label: `${name}: ${property} is ASSERTED by the operator, not enforced: ${seen}`,
					fix: redirected
						? `the provider key, the per-job forge token and any run.secrets values ride to that daemon across a network this worker cannot see; point the docker CLI back at this host, or accept it deliberately. The worker logs its own answer at boot (worker_started.dockerEndpointLocal)`
						: `nothing shows where job containers (and the credentials they carry) would go; fix what stops the docker CLI answering, then re-run doctor. The worker logs its own answer at boot (worker_started.dockerEndpointLocal)`,
				});
				continue;
			}
			// Issue #354: the podman venue's three, from its own `podman info` and this account's files, never from the docker
			// daemon's answer. Said when `podman info` answered, or failed in a way that may pass (a timeout); NOT when it was
			// never read or cannot answer here (no podman, a refused platform), where the podman section's refusal line is the
			// whole story, as the docker branch below is not said without a docker binary. A floor still refuses on it below.
			if (PODMAN_OBSERVATIONS.has(d.observedBy)) {
				if (observations[d.observedBy] !== true && (podman?.read?.answered === true || podman?.read?.transient === true)) {
					const unread = observations[d.observedBy] !== false;
					// The endpoint is the operator's to point, as docker's is; bounds and mounts are this account's Podman setup.
					const by = d.observedBy === PODMAN_SERVICE_LOCAL ? "the operator" : "this account's Podman setup";
					// Issue #453: when the bounds miss for a reason in the account's systemd setup (no user manager, or one Podman
					// cannot reach), this line is the ONE that says so (the podman section below does not repeat it), and its fix is
					// that cause's rather than the floor's generic remedy. Keyed on the observation's own cause, so a miss with
					// another cause keeps OBSERVATION_FIX.
					const causeFix = d.observedBy === PODMAN_BOUNDS_DELEGATED && !unread ? PODMAN_BOUNDS_FIX[podman.boundsCause] : undefined;
					checks.push({
						ok: false,
						warn: true,
						label: `${name}: ${property} is ASSERTED by ${by}, not enforced: ${podman.evidence?.[d.observedBy] ?? "not observed"}`,
						fix: causeFix ?? (!unread ? OBSERVATION_FIX[d.observedBy] : podman.reasons?.[d.observedBy] === "file-unread" ? fileUnreadFix(OBSERVATIONS[d.observedBy]) : `nothing shows whether ${OBSERVATIONS[d.observedBy]}; fix what stops \`podman info\` answering for the worker's account, then re-run doctor`),
					});
					continue;
				}
			}
			// Not said when no daemon read happened at all, or there is no docker binary (the daemon line above already failed): a
			// floor still refuses on it below.
			else if (d.observedBy && d.observedBy !== DOCKER_ENDPOINT_LOCAL && observations[d.observedBy] !== true && daemon !== null && daemon.reason !== "docker-not-found") {
				// #345: the word holds only while this daemon, or this host's runtime configuration, is observed providing it.
				// Printed as what it degrades to, with what was seen, and the worker's own boot line named.
				const unread = observations[d.observedBy] !== false;
				const bounds = d.observedBy === DAEMON_APPLIES_BOUNDS;
				checks.push({
					ok: false,
					warn: true,
					label: `${name}: ${property} is ASSERTED by ${bounds ? "the daemon" : "the container runtime's configuration"}, not enforced: ${observed.evidence[d.observedBy] ?? "not observed"}`,
					fix: unread
						? observed.reasons?.[d.observedBy] === "file-unread"
							? `${fileUnreadFix(OBSERVATIONS[d.observedBy])}. The worker logs its own answer at boot (worker_started.${d.observedBy})`
							: `nothing shows whether ${OBSERVATIONS[d.observedBy]}; fix what stops the daemon answering, then re-run doctor. The worker logs its own answer at boot (worker_started.${d.observedBy})`
						: bounds
							? `the pid and memory bounds in the job argv are the daemon's to apply, and it is not observed applying them: \`pi-dispatch doctor --live\` reads pids.max and memory.max off a real container on this daemon. The worker logs its own answer at boot (worker_started.${d.observedBy})`
							: `Podman mounts what its mounts.conf and containers.conf list into every job container, invisible to docker inspect: create an empty /etc/containers/mounts.conf and remove any volumes or mounts key. The worker logs its own answer at boot (worker_started.${d.observedBy})`,
				});
				continue;
			}
			if (d.word === ASSERTED) {
				checks.push({ ok: false, warn: true, label: `${name}: ${property} is ASSERTED by ${d.assertedBy ?? "something outside this worker"}, not enforced by it`, fix: `not verifiable from here, so treat it as a claim rather than a control: ${d.question}` });
				continue;
			}
			// enforced, and armed if it is gated at all. The good case, and it stays quiet.
		}
	}

	// ALWAYS a line, including when no floor is set. `PI_BACKENDS_FLOOR` is a plausible one-character-off
	// spelling of the real name, and nothing in this project warns on an unknown PI_* variable, so silence
	// here would make a typo'd VARIABLE NAME look exactly like a floor that holds -- the same belief the
	// strict parsing inside the string exists to prevent, arriving from outside the string.
	const floorNames = Object.keys(floor);
	if (floorNames.length === 0) {
		checks.push({ ok: true, label: "PI_BACKEND_FLOOR is not set, so no minimum is required of any backend" });
		return checks;
	}

	const misses = floorShortfall(backends, floor);
	const unarmed = unarmedFloor(floor, switches);
	const unobserved = unobservedFloor(backends, floor, observations);
	// A floor whose every entry is `absent` parses, reads, and bounds NOTHING: `meets(have, absent)` is true
	// for every value. It is the one READABLE word that reproduces the outcome `isDeclaration` refuses a
	// typo for, so it is named rather than affirmed.
	const bounding = floorNames.filter((p) => floor[p] !== ABSENT);
	const spelled = floorNames.map((p) => `${p}=${floor[p]}`).join(", ");
	if (misses.length > 0) {
		checks.push({ ok: false, label: `PI_BACKEND_FLOOR is not met: ${misses.map((m) => `${m.backend}.${m.property} is ${m.have}`).join(", ")}`, fix: "raise the backend, lower PI_BACKEND_FLOOR, or drop the backend from PI_BACKENDS" });
	} else if (unarmed.length > 0) {
		checks.push({ ok: false, label: `PI_BACKEND_FLOOR asks for ${unarmed.map((u) => `${u.property}=${u.want}`).join(", ")}, which ${[...new Set(unarmed.map((u) => u.armedBy))].join(", ")} has switched off`, fix: "arm the switch, or lower that entry to `absent` if you did not mean to require it" });
	} else if (unobserved.length > 0) {
		// One clause per miss, naming the observation it needed (#278, #345), and each observation's own remedy.
		const needed = unobserved.map((u) => `${u.property}=${u.want} (${u.backend} provides it only while ${OBSERVATIONS[u.observedBy] ?? u.observedBy}, and that is not observed)`);
		// True on the failure path too: where nothing it needed was ANSWERED (a daemon down or still starting), the worker
		// retries rather than refusing, and the remedy is to get an answer, not to change the host.
		if (unobserved.every((u) => typeof observations[u.observedBy] !== "boolean")) {
			checks.push({ ok: false, label: `PI_BACKEND_FLOOR asks for ${needed.join("; ")}`, fix: "nothing it needs could be read here; fix what stops the daemon answering and re-run doctor. Until it answers, the worker exits 1 at boot so the supervisor retries, and retries each job." });
		} else {
			const remedies = Object.keys(OBSERVATION_FIX).filter((o) => unobserved.some((u) => u.observedBy === o)).map((o) => OBSERVATION_FIX[o]);
			checks.push({ ok: false, label: `PI_BACKEND_FLOOR asks for ${needed.join("; ")}`, fix: `${remedies.join(" ")} The worker refuses to boot, and refuses each job, on the same answer.` });
		}
	} else if (bounding.length === 0) {
		checks.push({ ok: false, warn: true, label: `PI_BACKEND_FLOOR (${spelled}) requires nothing: every entry asks for "absent", which every backend meets`, fix: "raise an entry to `asserted` or `enforced` for it to bound anything" });
	} else {
		checks.push({ ok: true, label: `PI_BACKEND_FLOOR holds (${spelled})` });
	}

	return checks;
}

/**
 * WHO a local job runs as on this host (issue #341, `DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST`), decided with the
 * worker's own resolver from THIS SHELL's facts: its ids, the endpoint above, one `docker info` under the worker's own
 * bound, the socket's owner, and the job image's `anyUid`. No container runs. Returns `{ checks, forLive }`, where
 * `forLive` is what `--live` runs its probe as: `{ run: true, user }`, or `{ run: false, reason }` wherever no job
 * would run as a decided uid (a refusal, an unreadable answer, an undecidable daemon). Exported for the CI e2e.
 *
 * Severity follows the worker: ✗ only for what stops it booting (an identity verdict while `local` is the default
 * venue, from the set the worker's boot reads); a per-job refusal, an unreadable answer and an undecidable daemon are
 * ⚠, because the worker runs and says so per job. Nothing is read when docker itself did not answer: the daemon line
 * above already failed.
 */
export async function jobUserChecks(env, seams, { endpoint, dockerCode, imageCode, jobImage }) {
	const { spawn, cwd, home, fileExists, jobUserIdentity: ids = {}, stat, passwd, readUnit = (path) => readFileSync(path, "utf8"), observationFs = { statSync, readFileSync, readdirSync } } = seams;
	if (dockerCode !== 0) return { checks: [], forLive: { run: true, user: null }, daemon: null };
	const platform = ids.platform ?? seams.platform;
	// The worker's bound, not the endpoint read's 5 s: `docker info` is the slow read on a busy host, and a doctor that
	// gave up sooner would call undecidable a host the worker decides.
	const readFacts = seams.readFactsOnce ?? makeDaemonFactsReader({ run: dockerRunVia(spawn, DAEMON_FACTS_TIMEOUT_MS) });
	const resolve = makeJobUserResolver({ readFacts, platform, ...(ids.release !== undefined ? { release: ids.release } : {}), euid: ids.euid, egid: ids.egid, ...(stat ? { stat } : {}) });
	const { decision, socket, daemon } = await resolve({ endpoint, key: "doctor" });
	let defaultIsLocal = true;
	try {
		defaultIsLocal = parseBackendList(env.PI_BACKENDS)[0] === DEFAULT_BACKEND;
	} catch {
		// the backend section above reports an unparseable PI_BACKENDS
	}
	const checks = [];
	// Issue #345: WHICH runtime answered, display only, from the same read. Podman's docker emulation (podman-docker) is
	// named as a warning: it resolves no docker context, so credentialTransit is never observed there and --live does not
	// run; the real docker CLI pointed at Podman's socket is the route that reads everything back.
	const runtime = runtimeLine(daemon);
	if (runtime) checks.push(runtime);
	// Issue #448: on rootful Podman's Docker API service on this host, the containers.conf that service reads, judged by
	// the worker's own function, next to the line that says which runtime this is. Nothing is read or spawned elsewhere.
	// Severity by the boot rule: ✗ where a worker with `local` as its default venue refuses to boot, ⚠ where it boots and
	// refuses each local job. What this account cannot read is its own ⚠, a residual named, never a refusal.
	const readPodmanService = seams.readPodmanService ?? makePodmanServiceReader({ run: dockerRunVia(spawn, PODMAN_SERVICE_TIMEOUT_MS, { bin: "systemctl" }) });
	// One read of the unit, handed back for the backend section's mounts observation too (issue #448).
	const unit = await readRootfulService({ endpoint, daemon, readService: readPodmanService });
	const rootful = await observeRootfulConf({ endpoint, daemon, fs: observationFs, readService: readPodmanService, env, unit });
	const rootfulRefused = rootful?.refusal ?? null;
	if (rootfulRefused?.transient) {
		checks.push({ ok: false, warn: true, label: `local: whether rootful Podman's containers.conf widens a job could not be read just now: ${rootfulRefused.evidence}`, fix: rootfulConfFix(rootfulRefused) });
	} else if (rootfulConfRetries(rootfulRefused)) {
		// Gate round 1 of PR #473: a service older than its containers.conf (or a clock behind a change time) heals by
		// itself, so the worker holds each job (gate round 2: re-checked every minute, no attempt spent, for up to an hour)
		// and a boot exits 1: ⚠, never the ✗ a configuration fix earns.
		checks.push({ ok: false, warn: true, label: `local: every local job is held, not refused, until rootful Podman's service restarts: ${rootfulRefused.evidence}`, fix: rootfulConfFix(rootfulRefused) });
	} else if (rootfulRefused) {
		const boot = defaultIsLocal && decision.mode !== "unmappable";
		checks.push({
			ok: false,
			...(boot ? {} : { warn: true }),
			label: `local: no job can run on this venue (${rootfulRefused.cause}): ${rootfulRefused.evidence}${boot ? " -- a worker running as this account refuses to boot" : " -- every local job is refused"}`,
			fix: rootfulConfFix(rootfulRefused),
		});
	} else if (rootful) {
		// Says only what was judged: "among those this account can read" beside an unread part, and nothing about the running
		// service when systemctl did not answer for it (the ⚠ below names both). Doctor keeps no deletion memory (a worker
		// does, from the files it saw while the service ran), so the ✓ claims only changes a change time shows, and names
		// the deletion it cannot see (gate round 2 of PR #473: it said "not running with an older one" while one leaked).
		const serviceUnread = rootful.unread.some((u) => !u.path.startsWith("/"));
		const filesUnread = rootful.unread.some((u) => u.path.startsWith("/"));
		checks.push({ ok: true, label: `local: no containers.conf rootful Podman's service reads here sets any of the ${PODMAN_ROOTFUL_WIDENING_KEYS.length} keys the local venue refuses (docs/podman.md)${filesUnread ? ", among those this account can read" : ""}${serviceUnread ? "" : `, and none of them changed since ${PODMAN_SERVICE_UNIT} started (a file deleted while it runs is not seen here: only a running worker remembers what it saw)`}` });
	}
	if (rootful && rootful.unread.length > 0) {
		checks.push({ ok: false, warn: true, label: `local: part of rootful Podman's configuration is not judged here: ${rootfulUnreadList(rootful.unread)}`, fix: rootfulConfResidual(rootful.unread) });
	}
	let forLive = { run: true, user: null };
	if (decision.mode === "image") {
		const why = decision.cause === "desktop-platform" ? "a VM-backed daemon that maps file ownership" : "the docker endpoint is not on this host";
		checks.push({ ok: true, label: `local: jobs run as the job image's own user (${why})` });
	} else if (decision.mode === "unknown") {
		checks.push({ ok: false, warn: true, label: `local: which uid a job runs as could not be decided (${decision.reason})`, fix: "the worker retries every local job until it can decide; start or fix the daemon and re-run doctor" });
		forLive = { run: false, reason: `the job user could not be decided (${decision.reason}), so a probe as any uid would read back a container no job gets` };
	} else if (decision.mode === "unmappable") {
		const boot = BOOT_REFUSING_JOB_USER_CAUSES.has(decision.cause) && defaultIsLocal;
		const unreadable = decision.cause === "runtime-unreadable";
		checks.push({
			ok: false,
			...(boot ? {} : { warn: true }),
			label: unreadable
				? "local: which uid a job runs as could not be read from the daemon's answer (runtime-unreadable) -- every local job is refused"
				: `local: no job can run as a non-root user that owns its files on this daemon (${decision.cause})${boot ? " -- a worker running as this account refuses to boot" : " -- every local job is refused"}`,
			fix: JOB_USER_FIX[decision.cause] ?? "see DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST",
		});
		forLive = { run: false, reason: `a local job is refused on this daemon (${decision.cause}), so a probe would read back a container no job gets` };
	} else if (ids.euid === SHIPPED_IMAGE_UID) {
		checks.push({ ok: true, label: `local: jobs run as the job image's own user (this shell is uid ${SHIPPED_IMAGE_UID}, the image's own uid)` });
	} else if (imageCode !== 0) {
		checks.push({ ok: true, label: `local: jobs run as uid:gid ${decision.user} (passed as --user) with HOME=${CONTAINER_HOME}, once the job image is present and declares anyUid` });
		forLive = { run: true, user: decision.user };
	} else {
		const image = await makeImagePreflight({ image: jobImage, spawnFn: spawn })({});
		const chosen = resolveImageUser(decision, { capabilities: image?.capabilities ?? [], euid: ids.euid, egid: ids.egid, socket });
		if (chosen.refused) {
			checks.push({
				ok: false,
				warn: true,
				label: chosen.refused === "job-image-any-uid-unsupported" ? `local: every job on ${jobImage} is refused as this uid (${chosen.refused})` : `local: every local job is refused as this uid (${chosen.cause})`,
				fix: JOB_USER_FIX[chosen.cause] ?? "see DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST",
			});
			forLive = { run: false, reason: `a local job is refused as this uid (${chosen.cause}), so a probe would read back a container no job gets` };
		} else {
			checks.push({ ok: true, label: `local: jobs run as uid:gid ${chosen.user} (passed as --user) with HOME=${chosen.home} (a daemon that enforces bind-mount ownership)` });
			forLive = { run: true, user: chosen.user };
			// PI_FORWARD_ENV is an .env.example key; read here only for whether it names HOME.
			const forwarded = (env.PI_FORWARD_ENV ?? "").split(",").map((s) => s.trim());
			if (forwarded.includes("HOME")) {
				checks.push({ ok: false, warn: true, label: "PI_FORWARD_ENV names HOME, which a job run as --user never receives", fix: `the worker sets HOME=${CONTAINER_HOME} after the forwarded names, so the forwarded value is dropped; remove HOME from PI_FORWARD_ENV` });
			}
		}
	}
	// This answer is THIS SHELL's. A system unit that runs the WORKER as another account decides for that account (the
	// receiver runs no job, so its unit is not compared). Drop-ins (`*.service.d/*.conf`) are not read.
	if (platform === "linux" && typeof ids.euid === "number") {
		for (const { path, scope, which } of installedUnitPaths(platform, home)) {
			if (which !== "worker" || scope !== "system" || !fileExists(path)) continue;
			let text;
			try {
				text = readUnit(path);
			} catch {
				continue;
			}
			if (readUnitSeam(text, platform).deployDir !== cwd) continue;
			// ONLY an explicit User= is compared, and nothing is inferred from its absence: a unit with none (root, or a
			// DynamicUser= uid) is not guessed at here, because guessing produced wrong texts for every case the guess
			// missed. What covers the gap is not universal and the comment used to say it was: a root worker refuses to
			// BOOT only while `local` is the default venue (`BOOT_REFUSING_JOB_USER_CAUSES`); otherwise it boots and
			// refuses each local job with `worker-is-root`. An explicit `User=` IS compared, and for uid 0 the fix
			// below states the refusal instead of sending the operator to find it.
			const user = readUnitUser(text, platform);
			if (user === null) continue;
			const uid = /^\d+$/.test(user) ? Number(user) : uidOf(user, passwd);
			if (uid !== null && uid !== ids.euid) {
				// UID 0 gets the ANSWER instead of the instruction (issue #348), and doctor names it only where it is
				// CERTAIN. The certainty is narrow and is the whole rule: when THIS SHELL's decision is `worker`, the
				// daemon maps uids fine and the only thing separating this shell from the unit's account is rootness,
				// so that account gets `worker-is-root`. The facts have to be the same facts, and they are read from
				// THIS process: a unit pointing the service at another daemon through `Environment=` would not be
				// seen, because `readUnitSeam` reads `ExecStart`'s `--env-setup` and `WorkingDirectory` and nothing
				// else. Every other decision keeps the instruction, and for two different reasons rather than one.
				// A host-level refusal (a userns-remapped daemon, Docker Desktop on Linux, an unreadable answer, an
				// endpoint that is not here) is already stated by the `local:` line above and this line would only
				// repeat it. A refusal inferred from THIS SHELL's own socket is the opposite case: that row is
				// narrowed to `socket.uid === euid`, so it says nothing about another account, and the instruction
				// is the only honest answer there. Both keep it; neither wants a per-account refusal invented.
				//
				// TWO WRONG VERSIONS were caught in review and both belong here, because each looks right. Printing
				// `worker-is-root` for any explicit uid 0 tells an operator on a rootless daemon to run the worker as
				// an unprivileged account, which the line above has just refused. Re-asking `decideJobUser` with
				// `euid: 0` looks like the careful repair and is worse: its socket-owner rootless row is guarded
				// `euid !== 0`, so forcing uid 0 DISCARDS the one row that detects a rootless Podman older than
				// 4.9.3, and the answer comes back `worker-is-root` on exactly the host where that is most wrong.
				const rootFix = uid === 0 && decision.mode === "worker" ? JOB_USER_FIX["worker-is-root"] : null;
				// sudo reads a bare number as a user NAME, not a uid: `man sudo` wants `#4242`, and the `#` has to be
				// quoted or an interactive shell swallows the rest of the line as a comment. Reachable for 0 only
				// since this line stopped always answering for root, and wrong for every numeric unit before that.
				// The NAME branch is quoted on the same rule, which #368 closed for the numeric half and left
				// open here (issue #370, item 3): an `/etc/passwd` entry whose name carries a space or a shell
				// metacharacter renders a line that does not do what it appears to when pasted. Anything
				// outside `[A-Za-z0-9._-]` is single-quoted, and an embedded single quote is closed, escaped
				// and reopened, which is the only form `sh`, `bash` and `zsh` all read back exactly. Effectively
				// unreachable, and closed with the half beside it rather than left as the odd one out.
				const asAccount = /^\d+$/.test(user) ? `'#${user}'` : /^[A-Za-z0-9._-]+$/.test(user) ? user : `'${user.replace(/'/g, `'\\''`)}'`;
				checks.push({
					ok: false,
					warn: true,
					// "MAY NOT BE", not "is not" (issue #370, item 2). Under `userns-remap`, `desktop-linux-userns`,
					// `runtime-unreadable` and a daemon reporting `name=rootless`, the refusal is host-level: every
					// account on this host gets the identical verdict, so the line above IS the service's answer too
					// and re-running as that account changes nothing. "may not be" is true in every mode, and this is
					// the mirror image of a correction #368 made to the comment beside it.
					label: `this shell is uid ${ids.euid}, but ${path} runs the worker as ${user} (uid ${uid}), so the job-user line above is this shell's answer and may not be the service's`,
					fix: rootFix ?? `re-run doctor as that account (sudo -u ${asAccount} pi-dispatch doctor) to see what its jobs run as`,
				});
			}
		}
	}
	// A local job refused on rootful Podman's configuration (issue #448) runs no container, so neither does the probe.
	if (rootfulRefused) forLive = { run: false, reason: rootfulRefused.transient ? "rootful Podman's containers.conf could not be read just now, so whether a probe would match a job is not known" : rootfulConfRetries(rootfulRefused) ? "a local job waits for rootful Podman's service to restart, so a probe would read back a container no job gets yet" : `a local job is refused here (${rootfulRefused.cause}), so a probe would read back a container no job gets` };
	return { checks, forLive, daemon, unit };
}

/** The podman venue's observations (issue #354), which only its own `podman info` and this account's files answer. */
const PODMAN_OBSERVATIONS = new Set([PODMAN_BOUNDS_DELEGATED, PODMAN_ADDS_NO_MOUNTS, PODMAN_SERVICE_LOCAL]);

/**
 * The fix for an observation left unanswered by a HOST FILE that could not be read for a moment (`reason:
 * "file-unread"`, issue #428), where the runtime itself answered: the label above already names the file, so this says
 * what that means and that the worker retries, rather than sending the operator after a daemon that is fine.
 */
function fileUnreadFix(what) {
	return `nothing shows whether ${what}, because the file named above could not be read just now (the runtime itself answered); a job the floor needs it for is retried rather than refused, so if this recurs, fix what the host ran out of (file descriptors, memory, a failing disk), then re-run doctor`;
}

/**
 * The podman venue's section (issue #354, DES-PODMAN-NATIVE-ROOTLESS-BACKEND): ONE bounded `podman info` as this shell's
 * account, under the worker's own bound, answering the job user (`decidePodmanJobUser`, the worker's own rows), the three
 * observations (`observePodman`) and the display facts; then the job image in THIS account's store and, with egress
 * armed, the proxy under the same rootless Podman. Returns `{ checks, observed, relabel, forLive }`; `observed` feeds the
 * backend section (printed before this) and `forLive` is what `--live` reads back on podman with.
 *
 * Severity follows the worker, as the local job-user line does: ✗ only for what stops it booting (a refusing cause
 * while podman is the DEFAULT venue); a per-job refusal and an unanswered read are ⚠, since the worker runs and refuses
 * or retries each podman job. The image and the proxy are ✗ as they are for local: every job is refused without them.
 *
 * What goes wrong with the observations is NOT repeated here: the backend section above names each degraded word with
 * what was seen, so this section prints the bounds line only when they hold. That includes a missing systemd user
 * manager (issue #453): the backend section's isolation line carries it as evidence with its own fix, and the floor
 * line there carries the ✗, so a line here would only repeat both.
 */
export async function podmanChecks(env, seams, { jobImage, jobImageNote = "" }) {
	const { spawn, home = safeHomeDir(), jobUserIdentity: ids = {}, observationFs = { statSync, readFileSync, readdirSync }, runTimeouts = RUN_TIMEOUTS } = seams;
	const platform = ids.platform ?? seams.platform;
	const { podmanDefault, localUsed } = venuesOf(env);
	const readInfo = makePodmanInfoReader({ run: dockerRunVia(spawn, PODMAN_INFO_TIMEOUT_MS, { bin: "podman" }) });
	// ONE read, handed to all three: the decision, the observations and the display line must speak from the same answer,
	// and a second `podman info` could land on a different one. Not asked off Linux, where the decision's first row refuses
	// before any read (Podman machine is unmeasured), so doctor spawns nothing there either.
	const infoRead = platform === "linux" ? await readInfo() : null;
	const decision = decidePodmanJobUser({ platform, euid: ids.euid, egid: ids.egid, read: infoRead });
	const info = infoRead?.answered ? infoRead.info : null;
	const observed = infoRead
		? { ...observePodman({ read: infoRead, fs: observationFs, home, env, euid: ids.euid }), read: infoRead }
		: // Never read: nothing is observed, and the backend section stays quiet about it, since the refusal line below is
			// the whole story.
			{ observations: { [PODMAN_BOUNDS_DELEGATED]: null, [PODMAN_ADDS_NO_MOUNTS]: null, [PODMAN_SERVICE_LOCAL]: null }, evidence: {}, reasons: {}, read: null };
	const checks = [];
	// `fix` names the line above that stops the read-back, so `--live` points at the conf refusal when that is the one.
	const notRun = (reason, fix) => ({ run: false, reason, ...(fix ? { fix } : {}) });
	let forLive = notRun("podman was not read");

	if (info) {
		const version = typeof info.version === "string" ? ` ${info.version}` : "";
		checks.push({ ok: true, label: `podman: \`podman info\` answered as this account (Podman${version}${info.rootless === true ? ", rootless" : ""}${info.serviceIsRemote === false ? ", this host's own" : ""})` });
	}

	if (decision.mode === "unmappable") {
		const boot = PODMAN_BOOT_REFUSING_CAUSES.has(decision.cause) && podmanDefault;
		checks.push({
			ok: false,
			...(boot ? {} : { warn: true }),
			label: `podman: no job can run on this venue (${decision.cause})${boot ? " -- a worker running as this account refuses to boot" : " -- every podman job is refused"}`,
			fix: PODMAN_JOB_USER_FIX[decision.cause] ?? JOB_USER_FIX[decision.cause] ?? "see DES-PODMAN-NATIVE-ROOTLESS-BACKEND",
		});
		return { checks, observed, relabel: false, forLive: notRun(`a podman job is refused here (${decision.cause}), so a probe would read back a container no job gets`) };
	}
	// Issue #428: the account's containers.conf, read from the files the worker reads, by the worker's own function, so the
	// line cannot say something the worker does not do. Severity by the boot rule, as the identity line above: ✗ where a
	// worker with `podman` as its default venue refuses to boot, ⚠ where it boots and refuses each podman job. No spawn.
	// `runRoot` from the same read (issue #450), `undefined` while it has not answered (the worker retries such a job).
	const widened = podmanConfWidening({ fs: observationFs, home, env, euid: ids.euid, runRoot: infoRead?.answered === true && infoRead.info ? (infoRead.info.runRoot ?? null) : undefined });
	// What `--live` points at (issue #450): the line above is the RUNNING rootless network's when the finding is `live`, and
	// its fix is that network's reset, not a containers.conf edit.
	const firstFix = widened?.live
		? widened.key && !widened.transient
			? "reset this account's rootless network as the podman line above says first, then re-run `pi-dispatch doctor --live`"
			: "fix the podman rootless network line above first, then re-run `pi-dispatch doctor --live`"
		: "fix the podman containers.conf line above first, then re-run `pi-dispatch doctor --live`";
	if (widened?.transient) {
		// A read that failed for a moment is the worker's retry, never its refusal, so it is ⚠ and says so.
		checks.push({ ok: false, warn: true, label: `podman: whether this account's containers.conf or running rootless network widens a job could not be read just now: ${widened.evidence}`, fix: podmanConfFix(widened) });
		return { checks, observed, relabel: false, forLive: notRun("this account's containers.conf or running rootless network could not be read just now, so whether a probe would match a job is not known", firstFix) };
	}
	if (widened) {
		checks.push({
			ok: false,
			...(podmanDefault ? {} : { warn: true }),
			label: `podman: no job can run on this venue (${widened.cause}): ${widened.evidence}${podmanDefault ? " -- a worker running as this account refuses to boot" : " -- every podman job is refused"}`,
			fix: podmanConfFix(widened),
		});
		return { checks, observed, relabel: false, forLive: notRun(`a podman job is refused here (${widened.cause}), so a probe would read back a container no job gets`, firstFix) };
	}
	// Issue #464: Podman's run directory gone from under it, after the containers.conf refusal (read from files, so it holds
	// whatever Podman answers) and in place of the undecided line below, which it explains. Podman keeps the run root it
	// first used in its database (/run/user/<uid>/containers, while the account's user manager ran), and once linger is
	// switched off that directory is removed with the manager; every podman call as the account then fails before it does
	// anything (measured on Fedora 44 with 5.8.1 and Ubuntu 24.04 with 4.9.3: exit 125, `default OCI runtime "crun" not
	// found`; exit 1 with XDG_RUNTIME_DIR set to the missing directory on 5.8.1). stderr is never read (dockerRunVia), so
	// this rests on two facts: the read failed with an exit status, and /run/user/<uid> does not exist.
	const runRootGone = infoRead ? podmanRunDirGone({ read: infoRead, euid: ids.euid, fs: observationFs, home, env }) : null;
	if (runRootGone) {
		const user = userNameOf(seams);
		const linger = user ? await readLingerOrFlag(user, { spawn, fs: observationFs }) : null;
		const who = user ?? "<account>";
		checks.push({
			ok: false,
			...(podmanDefault ? {} : { warn: true }),
			label: `podman: every podman command fails as this account (${infoRead.reason}): its run directory ${runRootGone} does not exist${linger === false ? `, because linger is off for ${who}` : linger === null ? " (linger could not be read)" : ""}. Podman keeps the run root it first used, under that directory, and cannot start a container or answer \`podman info\` without it${podmanDefault ? " -- no podman job can run" : " -- every podman job fails"}`,
			fix: `sudo loginctl enable-linger ${who} -- it starts the account's user manager, which recreates ${runRootGone}, and keeps it with no one logged in (measured, Podman 5.8.1 and 4.9.3). \`podman system migrate\` does not get past this (measured: it fails the same way), and a login session of the account (ssh, \`machinectl shell ${who}@\`) recreates the directory only while that session lasts. Then re-run doctor`,
		});
		return { checks, observed, relabel: false, forLive: notRun(`podman cannot run as this account (${runRootGone} does not exist)`, "fix the podman run directory line above first, then re-run `pi-dispatch doctor --live`") };
	}

	if (decision.mode !== "worker") {
		checks.push({ ok: false, warn: true, label: `podman: which uid a job runs as could not be decided (${decision.reason})`, fix: "the worker retries every podman job until it can decide; fix what stops `podman info` answering for the worker's account, then re-run doctor" });
		return { checks, observed, relabel: false, forLive: notRun(`the podman job user could not be decided (${decision.reason}), so a probe as any uid would read back a container no job gets`) };
	}

	// The bounds, said when they hold; see the header for why a miss is left to the backend section.
	if (observed.observations[PODMAN_BOUNDS_DELEGATED] === true) {
		// The user manager's delegated list the answer rests on (issue #453), not `podman info`'s, which is the caller's cgroup.
		const controllers = Array.isArray(observed.boundsControllers) ? observed.boundsControllers : [];
		checks.push({ ok: true, label: `podman: cgroup v2 controllers are delegated to this account (${controllers.join(", ")}), so a job's pid, memory and cpu bounds are applied` });
		// Issue #453 (gate round 1, measured): with linger off the user manager runs only while the account has a login
		// session, and a doctor run then reads it running, from any shell, `sudo -iu` included. That ✓ ends with the last
		// session, and a service-run worker then gets no bounds. Asked of loginctl as `up` asks it; an answer it cannot
		// read says nothing, since the ✓ above is still what this read saw.
		const user = userNameOf(seams);
		const linger = user ? await readLinger(user, (cmd, args) => runCmdCapture(spawn, cmd, args, { stdoutOnly: true, timeoutMs: 5000 })) : null;
		if (linger === false) {
			checks.push({
				ok: false,
				warn: true,
				label: `podman: linger is off for ${user}, so the user manager above runs only while a login session of the account is open: when the last one ends, a worker run as a user service stops with it, and one run as a system unit with User= runs on with no bounds (refused per job under an isolation floor)`,
				fix: `sudo loginctl enable-linger ${user} -- it keeps the manager running with no one logged in, which is what a service needs`,
			});
		}
	}

	// SELinux, and what it means for a job's mounts: the worker's rule (#355) is `:Z` on a job's own directories only.
	const relabel = decision.relabel === true;
	if (relabel) {
		checks.push({ ok: true, label: "podman: SELinux confines containers here, so a job's own directories are relabelled (:Z) and your local folders are not: the SELinux label lines below read those" });
	} else if (info?.selinux === false) {
		checks.push({ ok: true, label: "podman: SELinux does not confine containers here, so nothing a job mounts is relabelled" });
	} else {
		checks.push({ ok: false, warn: true, label: "podman: whether SELinux confines containers here was not reported, so nothing a job mounts is relabelled", fix: "on an SELinux host an unlabelled job directory is unreadable in the container and every job fails before it starts; check `podman info` as the worker's account (host.security.selinuxEnabled)" });
	}

	// The job image, in THIS ACCOUNT'S store: rootless Podman keeps one per account, so an image docker, root or another
	// account holds is not one a job here can start from (and `--pull=never` fetches nothing). The worker's own preflight.
	//
	// Issue #433: on a deployment without `local` this is THE image check (docker's is not asked), so there, and ONLY
	// there, it carries the same `--fix` offer docker's line does. Not with `local` listed (review round 1): that
	// deployment's `--fix` is what it always was (DES-CLI-SURFACE, REQ-DEPLOYMENT-BOOTSTRAP), and one run offering two
	// pulls of one image into two stores is a change of that tier, not of this issue. The line and its words still say
	// how. The offer follows docker's rules: the prompt tier, only for the deployment default (an
	// overridden PI_JOB_IMAGE is the operator's trust choice, which pulling ghcr's image would not satisfy), and only for
	// an answered miss, never for a store that did not answer. Into THIS shell's account's store, which is the store the
	// line reads and the one a worker running as this account starts jobs from. `pi-job:latest` is tagged as is: Podman
	// stores it as `localhost/pi-job:latest`, and `--pull=never` resolves the short name to exactly that (docs/podman.md).
	const image = await makeImagePreflight({ image: jobImage, spawnFn: spawn, bin: "podman" })({});
	const imagePresent = image?.ok === true;
	// The per-trigger images are asked of this store only when it answered for the default one (issue #433).
	const imagesReadable = imagePresent || image?.missing !== undefined;
	const imageDigest = imagePresent ? (image.imageDigest ?? null) : null;
	if (imagePresent) {
		checks.push({ ok: true, label: `podman: job image present in this account's Podman store (${jobImage})${jobImageNote}` });
	} else if (image?.missing) {
		checks.push({
			ok: false,
			label: `podman: job image is not in this account's Podman store (${jobImage})`,
			// A name no pull is offered for (issue #523, round 2) is built or loaded, never pulled.
			fix: `${jobImage === "pi-job:latest" || pullOffered(jobImage) ? "pull or load" : "build or load"} it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: ${jobImageFix("podman", jobImage)} -- jobs run with --pull=never, so the worker never fetches it`,
			...(!localUsed && jobImage === "pi-job:latest"
				? {
						fixAction: {
							tier: "prompt",
							describe: PODMAN_JOB_IMAGE_PULL,
							run: async ({ spawn: fixSpawn }) => {
								// The PULL bound, as docker's: a cold pull of the job image is minutes of real work.
								const pulled = await runCmd(fixSpawn, "podman", ["pull", "ghcr.io/edgehero/pi-job:latest"], runTimeouts.pull);
								if (pulled.code !== 0) return { ok: false, note: pulled.ended === "timeout" ? `podman pull did not finish within ${Math.round(runTimeouts.pull / 60000)} minutes` : "podman pull failed" };
								if ((await runCmd(fixSpawn, "podman", ["tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"], runTimeouts.cmd)).code !== 0) return { ok: false, note: "podman tag failed" };
								return { ok: true };
							},
						},
					}
				: {}),
		});
	} else {
		checks.push({ ok: false, warn: true, label: `podman: whether the job image is in this account's Podman store could not be read (${jobImage})`, fix: "`podman image inspect` and `podman info` did not answer; fix that, then re-run doctor" });
	}

	// Who a job runs as: the decision, with the image's `anyUid` where the image could be read.
	let user = decision.user;
	if (imagePresent) {
		const chosen = resolvePodmanImageUser(decision, { capabilities: image.capabilities ?? [], euid: ids.euid, egid: ids.egid });
		if (chosen.refused || chosen.unavailable) {
			const cause = chosen.cause ?? chosen.reason;
			checks.push({
				ok: false,
				warn: true,
				label: chosen.refused === "job-image-any-uid-unsupported" ? `podman: every job on ${jobImage} is refused as this uid (${chosen.refused})` : `podman: every podman job is refused as this uid (${cause})`,
				fix: PODMAN_JOB_USER_FIX[cause] ?? JOB_USER_FIX[cause] ?? "see DES-PODMAN-NATIVE-ROOTLESS-BACKEND",
			});
			return { checks, observed, relabel, imagesReadable, imageDigest, forLive: notRun(`a podman job is refused as this uid (${cause}), so a probe would read back a container no job gets`) };
		}
		user = chosen.user;
		checks.push({ ok: true, label: `podman: jobs run as uid:gid ${chosen.user} (passed as --user, with --userns=keep-id) with HOME=${chosen.home}` });
	} else {
		checks.push({ ok: true, label: `podman: jobs run as uid:gid ${decision.user} (passed as --user, with --userns=keep-id) with HOME=${CONTAINER_HOME}, once the job image is in this account's store${ids.euid === SHIPPED_IMAGE_UID ? "" : " and declares anyUid"}` });
	}

	// The proxy, with egress armed: under the SAME rootless Podman, since a rootless `--internal` network reaches nothing on
	// the host (measured), so a proxy under docker or another account cannot serve a podman job. A malformed PI_EGRESS
	// reads as armed here, as it does for local's proxy line: the .env check fails on it, and the worker refuses to boot.
	let armed;
	try {
		armed = egressArmed(env);
	} catch {
		armed = null;
	}
	const proxy = egressProxyName(env);
	let proxyRunning = null;
	// Issue #458: why `--live` must not tear a network down under the proxy here, or null where nothing stops it.
	let keeperBlocked = null;
	// Issue #503: the declared model endpoints `--live` probes on this venue, `[]` for none; and whether the rules the
	// proxy runs include their file (only the shipped proxy's account copy is read; another proxy must include it).
	let endpoints = [];
	let endpointRulesInclude = true;
	if (armed !== false) {
		// `.State.Status` (issue #453): only `running` carries traffic; Podman reports paused and between-restarts states
		// with their own words (measured on 4.9.3 and 5.8.1).
		const state = await runCmdCapture(spawn, "podman", ["inspect", "--format={{.State.Status}}", proxy], { stdoutOnly: true });
		const status = state.code === 0 ? state.output.trim() : null;
		proxyRunning = status === "running";
		// The worker's simple rule (egress.mjs), as on docker: a state it retries through is ⚠, one it refuses on is ✗.
		// A CRASH LOOP is ✗ too, as docker's `restarting` is, since every job is retried once and then failed. Podman reads
		// a `--restart=always` crash loop as `stopped` continuously (PR #466 gate round 1, Podman 5.8.1: about eight restarts
		// a second), while `podman stop`, `--restart=no` and an exhausted `on-failure` read `exited`; the worker retries
		// through `stopped` (`egress.mjs` keeps that mapping), so a ⚠ saying jobs wait was the wrong line while every job
		// failed. The label names the raw word, so `stopped` and `exited` read apart, and the fix names the crash loop as
		// the likely cause, not as a fact.
		const crashLoop = status === "stopped" || status === "restarting";
		const retried = state.code === 0 && !proxyRunning && /^[a-z]{1,20}$/.test(status ?? "") && !STOPPED_PROXY_STATES.has(status) && !crashLoop;
		checks.push({
			ok: proxyRunning,
			...(retried ? { warn: true } : {}),
			label: proxyRunning ? `podman: egress proxy running under this account's Podman (${proxy})` : state.code === 0 ? `podman: egress proxy is ${/^[a-z]{1,20}$/.test(status ?? "") ? status : "in a state it did not report"} under this account's Podman (${proxy})` : `podman: egress proxy is not under this account's Podman (${proxy})`,
			fix: retried
				? `a podman job meanwhile is retried once, then failed (the worker does not refuse it outright on this state); if it stays ${status}, \`podman logs ${proxy}\` says why`
				: crashLoop
				? `if a restart policy keeps bringing it back, its squid keeps exiting (Podman reads such a crash loop as ${status}) and every podman job is retried once, then failed; \`podman logs ${proxy}\` says why`
				: "start it as the worker's account, under the same rootless Podman, on a named bridge network (docs/podman.md): a job's --internal network reaches nothing on the host, so a proxy under docker or another account cannot serve it. Every podman job is refused pre-spend while this is down (PI_EGRESS=0 opts out)",
		});
		// Said, never implied by the ✓ above: running is not the same as enforcing the allowlist. Issue #431: on this venue
		// the canary that reads it back runs with `--live` (`podmanLiveChecks`), not here, so a plain run says where it is
		// read and a `--live` run says nothing, since its read-back prints the canary's own lines a moment later. Not run
		// here on every doctor, as docker's is: a podman canary is two job-shaped keep-id containers, whose first start of
		// an image copies its layers (27 to 32 s measured), and `--live` is where this venue already starts containers
		// built like a job's.
		if (proxyRunning && seams.live !== true) {
			checks.push({ ok: false, warn: true, label: "podman: the egress allowlist is read back by `pi-dispatch doctor --live` on this venue, not by this run", fix: "run `pi-dispatch doctor --live`: its egress canary runs three containers built like a podman job's (the job user, --userns=keep-id, the venue's pinned flags) on a job-shaped --internal network under this account's Podman, one that must reach the provider through the proxy, one that must not reach an unlisted host, and one that must not get plain HTTP through to a listed host off port 80" });
		}
		// Issue #484: the account-owned copy of the rules the shipped unit mounts, against the installed package's. `service
		// install` compares it on every run and replaces a differing one only under --force, and `up` installs nothing
		// while it differs, so after an upgrade that changed the shipped rules neither said so unless asked to install. A
		// proxy PI_EGRESS_PROXY names mounts no copy of ours.
		if (proxy === DEFAULT_EGRESS_PROXY) {
			const stale = proxyConfCopyCheck({
				path: proxyConfCopyPath(home),
				name: `podman: the egress proxy's rules copy ${proxyConfCopyPath(home)}`,
				seams,
				refresh: "`pi-dispatch service install` lists it among what differs and `pi-dispatch service install --force` replaces it and restarts the proxy (squid reads its rules only at start); --force also replaces every other item that list names",
			});
			if (stale) checks.push(stale);
			// Issue #503: endpoints declared while the account copy predates the include, said as docker's venue says it.
			let rulesInclude = false;
			try {
				rulesInclude = rulesIncludeEndpoints(String((seams.readProxyConf ?? ((p) => readFileSync(p, "utf8")))(proxyConfCopyPath(home))));
			} catch {
				// No copy yet: `service install` writes the current rules, include and all.
				rulesInclude = true;
			}
			const declared = (seams.includeNeeds ? seams.includeNeeds({ env, cwd: seams.cwd, platform: seams.platform ?? process.platform }).endpointsDeclared : endpointsDeclaredIn({ env, cwd: seams.cwd, fs: { readFileSync, existsSync }, platform: seams.platform ?? process.platform }));
			if (declared && !rulesInclude) checks.push({ ok: false, warn: true, label: `podman: ${rulesPredateEndpointsLine("podman")}`, fix: "a reload changes nothing here: the rules themselves must include the file, and `service install --force` writes them with the unit that mounts it" });
			endpointRulesInclude = rulesInclude;
		}
		// Issue #503: the declared model endpoints on this venue, as docker's section reads them. The route rows and the
		// include read here; the three probes per endpoint run with `--live`, beside the canary they share a network with.
		// None declared, or rules that predate the include (the line above says it all), is nothing more.
		const { declaredEndpoints = ({ env: e, cwd, platform: p }) => declaredEndpointsIn({ env: e, cwd, fs: { readFileSync, existsSync }, platform: p }), hostAddresses = () => lanIPv4Addresses(networkInterfaces()) } = seams;
		const declaredList = declaredEndpoints({ env, cwd: seams.cwd, platform: seams.platform ?? process.platform });
		if (declaredList.length > 0 && endpointRulesInclude) {
			endpoints = declaredList;
			// The helper as Podman 5 names it in `podman info` (`rootlessNetworkCmd`), else as this account's running rootless
			// network shows it (`observeRootlessNetns`, the record or the 4.x argv the worker's widening check reads), else
			// not known, which the route row says as such.
			const helper = info?.rootless === true ? (info.rootlessNetworkCmd ?? runningNetnsHelper({ fs: observationFs, euid: ids.euid, runRoot: info.runRoot })) : null;
			const runtime = info ? { backend: "podman", version: info.version ?? "", ...(typeof info.rootless === "boolean" ? { rootless: info.rootless } : {}), ...(helper ? { helper } : {}) } : null;
			const addresses = hostAddresses();
			checks.push(...endpointRouteChecks({ runtime: runtime && addresses ? { ...runtime, hostAddresses: addresses } : runtime, endpoints, prefix: "podman: ", proof: seams.live === true ? "The endpoint probes in this --live run are the proof." : "`pi-dispatch doctor --live` probes it, which is the proof." }));
			if (proxyRunning) {
				const inside = await runCmdCapture(spawn, "podman", ["exec", proxy, "cat", ENDPOINTS_INCLUDE_IN_PROXY], { stdoutOnly: true, timeoutMs: CANARY_STEP_TIMEOUT_MS });
				// The file the proxy actually mounts there, from its own inspect (the Quadlet unit mounts the deployment folder's,
				// which need not be the folder doctor runs in). Podman gives the source as a plain host path (4.9.3, 5.8.1).
				const mounts = await runCmdCapture(spawn, "podman", ["inspect", "--format", "{{json .Mounts}}", proxy], { stdoutOnly: true, timeoutMs: CANARY_STEP_TIMEOUT_MS });
				const mounted = mounts.code === 0 ? readIncludeBindSource(mountsFromJson(mounts.output)) : null;
				checks.push(endpointsIncludeCheck({ answer: inside, endpoints, bin: "podman", proxy, prefix: "podman: ", mounted, recreate: proxy === DEFAULT_EGRESS_PROXY ? "`systemctl --user restart pi-dispatch-egress-proxy.service` starts a new container on the file (a restart cuts running jobs' tunnels)" : `recreate ${proxy} so it mounts the file anew` }));
			}
		}
		const keeper = await netnsKeeperCheck(spawn, info?.version, { proxy, now: typeof seams.wallClock === "function" ? seams.wallClock : Date.now });
		keeperBlocked = keeper.keeperBlocked ?? null;
		checks.push(keeper);
		const keeperNetwork = await netnsKeeperNetworkCheck(spawn);
		if (keeperNetwork) checks.push(keeperNetwork);
	}

	forLive = { run: true, user, relabel, info, imagePresent, egress: { armed, proxy, proxyRunning, keeperBlocked, endpoints } };
	return { checks, observed, relabel, imagesReadable, imageDigest, forLive };
}

/**
 * The rootless network keeper (issue #458), read with egress armed, whatever the proxy's name, since the worker
 * disconnects any proxy from every egress job's network. Read and judged by the one shared rule (`judgeNetnsKeeper`):
 * it counts only when RUNNING, in BRIDGE mode and ON its own network (issue #463 gate: a keeper on `--network none`,
 * slirp4netns, pasta or host runs and holds nothing open), off stdout alone.
 *
 * ✗ on Podman 4.x (and on a version `podman info` did not give, which is no evidence of 5.x) whenever it does not hold:
 * measured on 4.9.3, the first egress job's teardown then cuts the proxy's route out, and every egress job after it
 * starts, spends and gets 503 from the proxy until the proxy restarts, while the proxy line above still reads ✓. ✓ on
 * 5.x either way, where the teardown leaves the proxy alone (measured on 5.8.1) and the keeper is one idle container.
 */
const NETNS_KEEPER_FIX = `start it as the worker's account where its Quadlet unit is installed: ${NETNS_KEEPER_START} (else \`pi-dispatch service install\` or \`pi-dispatch up\` installs it, or start it by hand, docs/podman.md step 6; a container of its name that is not the shipped keeper must be removed first)`;

export async function netnsKeeperCheck(spawn, version, { proxy = DEFAULT_EGRESS_PROXY, now = Date.now } = {}) {
	const state = await runCmdCapture(spawn, "podman", ["inspect", NETNS_KEEPER_FORMAT, NETNS_KEEPER], { stdoutOnly: true });
	// PR #463 round 2: the worker's own rule, read the worker's way: running for 3 s, and not started more than 15 s
	// after the proxy (a keeper that restarted under a running proxy may already have let a teardown cut its route out).
	// On 5.x neither rule is asked: there the keeper is one idle container and nothing depends on it.
	const needs = podmanNeedsNetnsKeeper(version);
	const proxyState = needs ? await runCmdCapture(spawn, "podman", ["inspect", STARTED_AT_FORMAT, proxy], { stdoutOnly: true }) : null;
	const proxyStarted = proxyState?.code === 0 ? proxyState.output.trim() : "";
	const keeper = judgeNetnsKeeper({ code: state.code, stdout: state.output }, needs ? { now: now(), proxyStartedMs: /^\d+$/.test(proxyStarted) ? Number(proxyStarted) : null } : {});
	if (keeper.holds) {
		return { ok: true, label: `podman: rootless network keeper running under this account's Podman on its own bridge network (${NETNS_KEEPER}), so a job's network teardown cannot cut the proxy's route out` };
	}
	const where = `${NETNS_KEEPER} ${keeper.problem}`;
	if (!needs) {
		return { ok: true, label: `podman: rootless network keeper ${where}, which Podman ${version} does not need: its job network teardown leaves the proxy's route out alone` };
	}
	const on = `Podman ${typeof version === "string" && version.trim() ? version.trim() : "of an unreported version"}`;
	return {
		ok: false,
		// Not rendered: what `--live` reads to run nothing that detaches the proxy (`podmanEgressCanary`, `runLiveProbes`).
		keeperBlocked: `the rootless network keeper ${where} on ${on}, where tearing down a network the proxy is on would cut the proxy's route out (issue #458)`,
		label: keeper.restartProxy
			? `podman: rootless network keeper ${where}: on ${on}, so every egress job may get 503 from the proxy until the proxy restarts, and the worker retries each one rather than start it`
			: `podman: rootless network keeper ${where}: on ${on}, the first egress job's network teardown then cuts the proxy's route out, and every egress job after it gets 503 from the proxy`,
		fix: keeper.restartProxy
			? `${netnsKeeperRemedy(keeper, proxy)}. The keeper itself is fine; a proxy started after it counts again. If egress still fails after that, docs/podman.md has the aardvark-dns repair`
			: `${keeper.thenRestartProxy ? `${NETNS_KEEPER_FIX}, then ${proxyRestartAdvice(proxy)}, since the proxy has been up since before it` : NETNS_KEEPER_FIX}. \`pi-dispatch doctor --live\` runs no egress canary and no peer networks here until it holds, since their teardown is the same trigger. If egress still fails after that, docs/podman.md has the aardvark-dns repair`,
	};
}

/**
 * The keeper's network, as it IS (PR #463 round 3). Its units create it with `--ignore`, which keeps a network of that
 * name that already exists whatever its options, so one made by hand without `--internal` or with DNS on would stay
 * that way unseen, and a keeper on it has a route out. ✗ unless `podman network inspect` says internal and DNS off, on
 * every Podman version (it is about what the keeper can reach, not about the 4.x defect); nothing when the network is
 * not there, which the keeper line above already covers; ⚠ when podman answered in words this cannot read.
 */
export async function netnsKeeperNetworkCheck(spawn) {
	const read = await runCmdCapture(spawn, "podman", ["network", "inspect", "--format", "{{.Internal}} {{.DNSEnabled}}", NETNS_KEEPER], { stdoutOnly: true });
	if (read.code !== 0) return null;
	const answer = read.output.trim();
	if (answer === "true false") return { ok: true, label: `podman: the keeper's network ${NETNS_KEEPER} is internal with DNS off, so the keeper reaches nothing` };
	const fix = `remove the network and restart the keeper units, which recreate it as shipped: systemctl --user stop ${NETNS_KEEPER}.service; podman network rm ${NETNS_KEEPER}; ${NETNS_KEEPER_START}`;
	const m = /^(true|false) (true|false)$/.exec(answer);
	if (!m) return { ok: false, warn: true, label: `podman: whether the keeper's network ${NETNS_KEEPER} is internal with DNS off could not be read (podman said ${quotedShown(answer)})`, fix };
	const wrong = [m[1] !== "true" ? "not internal (it has a route out)" : null, m[2] !== "false" ? "DNS on" : null].filter(Boolean).join(" and ");
	return { ok: false, label: `podman: the keeper's network ${NETNS_KEEPER} is ${wrong}, which is not the network this project ships: its units create it with --ignore, which keeps an existing network of that name whatever its options`, fix };
}

/** The two SELinux types a container may read a bind mount under without it being relabelled (container-selinux). */
const CONTAINER_READABLE_TYPES = new Set(["container_file_t", "container_ro_file_t"]);

/**
 * The SELinux label checks (issue #355), for a host where `relabelsPrivateMounts` holds. Exported for the tests.
 *
 * The worker relabels only what it makes per job (`:Z`). An operator's local folder and the global overlay are NEVER
 * relabelled, by decision: `:Z` would take the folder from every other container (measured) and replace a label the
 * operator chose, and the overlay is shared by every job. Measured on an enforcing Fedora 44 host: an unlabelled source
 * (`user_home_t`, `var_t`, `user_tmp_t`) is denied to the container outright, so each such directory is a job refused
 * before it spends (`job-inputs-unreadable`), not a worker that cannot boot, which is why the line is ⚠. The fix is the
 * one measured to make a directory readable to every container: a `container_file_t` rule plus `restorecon`.
 *
 * READ, never inferred: `stat -L --format=%C` through doctor's bounded runner. `-L` because a local folder may be a
 * symlink (prepare-local treats one as ordinary) and a container reads what the link points at, whose label is the one
 * that matters. The fix names the directory restorecon will actually meet: the folder resolved through EVERY link (its
 * own, a chain of them, or a linked parent, each of which left a rule on the configured path matching nothing,
 * measured), then mapped back through the policy's path equivalences (`file_contexts.subs_dist` and `.subs`, e.g.
 * `/var/home /home`), because semanage refuses a rule on the aliased side of one and names the other (measured for
 * /var/home, /var/opt and /var/roothome). That is the rule semanage itself applies. The rule's path is escaped as the
 * regular expression semanage reads it as, whitespace as a hex escape because it refuses a literal or backslashed
 * space ("File specification can not include spaces", semanage from policycoreutils-python-utils 3.11, measured). A `stat` that did not answer (not GNU
 * coreutils, a directory this shell cannot reach, no label at all) is a quiet "not checked" line, never a warning:
 * the runner's own refusal names the path if a job meets it, and a false alarm here would send an operator to relabel
 * a folder that was fine. A readable type with MCS categories is a directory some container relabelled PRIVATE, which
 * locks every other container out (measured), so it is treated like an unlabelled one.
 */
export async function selinuxLabelChecks({ folders = [], overlay = null, spawn, realpath = realpathSync, readFile = readFileSync }) {
	const aliases = fcontextAliases(readFile);
	const checks = [{ ok: true, label: "SELinux: jobs' own directories are relabelled for SELinux (:Z); a local folder and the global overlay never are" }];
	const targets = [...folders.map((dir) => ({ dir, what: "local folder", refused: "a job in it that is denied is refused before it spends" })), ...(overlay ? [{ dir: overlay, what: "global overlay", refused: "a job that is denied it is refused before it spends" }] : [])];
	for (const { dir, what, refused } of targets) {
		const answer = await runCmdCapture(spawn, "stat", ["-L", "--format=%C", "--", dir], { stdoutOnly: true });
		const context = answer.code === 0 ? parseSelinuxContext(answer.output) : null;
		if (!context) {
			checks.push({ ok: true, label: `SELinux: the label of the ${what} ${dir} was not checked (stat did not answer with one)` });
			continue;
		}
		if (CONTAINER_READABLE_TYPES.has(context.type) && !context.categories) {
			checks.push({ ok: true, label: `SELinux: the ${what} ${dir} is labelled ${context.type}, which a container can read` });
			continue;
		}
		const configured = resolve(dir);
		let resolved = configured;
		try {
			resolved = realpath(configured);
		} catch {
			// unresolvable here: the configured path, made absolute, is the best name there is
		}
		const real = unaliasFcontextPath(resolved, aliases);
		const via = real !== configured ? ` (resolved to ${real})` : "";
		checks.push({
			ok: false,
			warn: true,
			// Not "denied" outright: the policy grants containers some types it does not relabel (a container reads usr_t, which
			// /var/opt defaults to, measured), so only the measured types are named as denied.
			label: context.categories
				? `SELinux: the ${what} ${dir}${via} is labelled ${context.type} with a private category pair (another container's :Z), which locks every other container out of it (measured) -- ${refused}`
				: `SELinux: the ${what} ${dir}${via} is labelled ${context.type}, not a container type, so a job container may be denied it (measured: user_home_t, user_tmp_t, var_lib_t and var_t are) -- ${refused}`,
			fix: `label it for containers once: \`semanage fcontext -a -t container_file_t ${shellQuote(`${escapeFcontextPath(real)}(/.*)?`)} && restorecon -R ${shellQuote(resolved)}\` (as root). pi-dispatch never relabels this directory itself, because a private label would lock every other container out of it. On an NFS, CIFS or FUSE mount, or one mounted with \`context=\`, the label comes from the mount instead and restorecon cannot change it: there the container's access is the virt_use_nfs, virt_use_samba or virt_use_fusefs boolean, or the mount's own context`,
		});
	}
	return checks;
}

/** `{ type, categories }` from one `user:role:type:level` line, or `null` for anything else (no label, "?", noise). */
function parseSelinuxContext(output) {
	const line = String(output ?? "").trim();
	if (line.includes("\n")) return null;
	const parts = line.split(":");
	if (parts.length < 4 || !/^[a-z0-9_]+$/.test(parts[2])) return null;
	// The level is everything after the type (`s0`, or `s0:c123,c456` for a private one), so it is re-joined.
	return { type: parts[2], categories: /c\d/.test(parts.slice(3).join(":")) };
}

/** A path as the regular expression `semanage fcontext` matches it as: every metacharacter escaped, `/` left alone. */
function escapeFcontextPath(path) {
	// Whitespace as a two-digit hex escape: semanage refuses a space written plainly or backslashed ("File specification
	// can not include spaces"), and accepts the hex form (measured on container-selinux 2.247.0).
	// ASCII whitespace only: a two-digit escape cannot spell a code point past U+00FF, and those were not measured.
	return path.replace(/[.*+?^$()[\]{}|\\]/g, "\\$&").replace(/[\t\n\v\f\r ]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * The policy's path equivalences, `[alias, original]` pairs from `file_contexts.subs_dist` and the local `.subs`, for the
 * policy /etc/selinux/config names (default `targeted`). Unreadable files give none: the fix then names the resolved
 * path, which is right wherever no equivalence applies.
 */
function fcontextAliases(readFile) {
	let policy = "targeted";
	try {
		policy = /^SELINUXTYPE=(\S+)/m.exec(readFile("/etc/selinux/config", "utf8"))?.[1] ?? policy;
	} catch {}
	const pairs = [];
	for (const name of ["file_contexts.subs_dist", "file_contexts.subs"]) {
		let text = "";
		try {
			text = readFile(`/etc/selinux/${policy}/contexts/files/${name}`, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const fields = line.trim().split(/\s+/);
			if (fields.length === 2 && !fields[0].startsWith("#") && fields[0].startsWith("/") && fields[1].startsWith("/")) pairs.push(fields);
		}
	}
	return pairs;
}

/** `path` with the longest equivalence alias it starts with replaced by that alias's original, on a separator boundary. */
function unaliasFcontextPath(path, aliases) {
	let best = null;
	for (const [alias, original] of aliases) {
		if ((path === alias || path.startsWith(`${alias}/`)) && (best === null || alias.length > best[0].length)) best = [alias, original];
	}
	return best === null ? path : `${best[1]}${path.slice(best[0].length)}`;
}

/** A path as one POSIX shell word: bare when it is plain, else single-quoted with an embedded quote closed and reopened. */
function shellQuote(value) {
	return /^[A-Za-z0-9._\/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The runtime identity line (issue #345), or `null` when the daemon did not answer: display only, never a decision. */
function runtimeLine(daemon) {
	if (!daemon?.answered || !daemon.facts) return null;
	const { facts } = daemon;
	const version = facts.serverVersion ? ` ${facts.serverVersion}` : "";
	if (facts.shape === "podman") {
		return {
			ok: false,
			warn: true,
			label: `local: the daemon is Podman${version}, reached through podman-docker, Podman's own emulation of the docker command`,
			fix: "podman-docker resolves no docker context, so credentialTransit is never observed and `doctor --live` does not run: install the real docker CLI and point it at Podman's socket (`docker context create podman --docker host=unix:///run/podman/podman.sock`, then `docker context use podman`)",
		};
	}
	if (facts.podman) return { ok: true, label: `local: the daemon is Podman${version}, through its Docker API` };
	if (facts.os === "Docker Desktop") return { ok: true, label: `local: the daemon is Docker Desktop (engine${version})` };
	return { ok: true, label: `local: the daemon is Docker Engine${version}${facts.rootless ? ", rootless" : ""}` };
}

/** A user name's uid from passwd text, or `null`. Never throws: an unreadable file is simply no answer. */
function uidOf(name, passwd) {
	let text;
	try {
		text = passwd();
	} catch {
		return null;
	}
	for (const line of String(text ?? "").split("\n")) {
		const [user, , uid] = line.split(":");
		if (user === name && /^\d+$/.test(uid ?? "")) return Number(uid);
	}
	return null;
}

/**
 * The endpoint resolver's `run` seam over doctor's own spawn (#278), so the tests' fake spawn answers it. Bounded
 * like the worker's runner: a CLI that does not answer is killed and reported as a timeout rather than awaited.
 * `bin` (issue #354) is the runtime CLI it spawns, so a podman venue's reads go through the same bounded runner;
 * every caller today passes none and spawns `docker` exactly as before.
 */
export function dockerRunVia(spawn, timeoutMs = 5000, { bin = "docker" } = {}) {
	return (args) =>
		new Promise((resolve) => {
			let child;
			try {
				child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch (err) {
				resolve({ code: null, stdout: "", error: err });
				return;
			}
			let stdout = "";
			let done = false;
			const finish = (value) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(value);
			};
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish({ code: null, stdout: "", error: { timedOut: true } });
			}, timeoutMs);
			child.stdout?.on("data", (d) => (stdout += d));
			// stderr is never read: it carries the operator's home path, and a DOCKER_HOST the CLI could not parse
			// is repeated in it with any credentials still inside.
			child.on("error", (err) => finish({ code: null, stdout: "", error: err }));
			child.on("close", (code, signal) => finish({ code, stdout, error: signal ? { signal } : null }));
		});
}

/**
 * `doctor --live`'s checks (issues #278 and #344, INT-LIVE-PROBE-CONTRACT): the eight declarations a container read can reach,
 * read back off short-lived real containers on this host, rendered as `read back on local: ...`. Exported so the never-tier
 * pin can walk them: like every check doctor has, and on purpose, none carries a `fixAction` -- a failed read-back
 * is a fact about the image or the runtime, and nothing here may guess at changing either.
 */
export async function liveChecks(env, seams, facts) {
	const { spawn, out = () => {}, home = safeHomeDir(), liveFs, isAlive = defaultIsAlive, pid = process.pid, nonce = randomBytes(6).toString("hex"), jobUserIdentity: ids = {}, now, delay } = seams;
	// Issue #341: the probe runs as the job user this host decides, or not at all where a local job would be refused.
	const jobUser = facts.jobUser ?? { run: true, user: null };
	if (jobUser.run === false) {
		return [{ ok: false, warn: true, label: `read back on local: not run -- ${jobUser.reason}`, fix: "fix the job-user line above first, then re-run `pi-dispatch doctor --live`" }];
	}
	// Issue #355: `:Z` on the probe's own mounts exactly where a job's would carry it, from the same daemon answer and
	// endpoint the job-user line was decided from. The fixture's global directory is never relabelled, like a job's.
	const relabel = relabelsPrivateMounts(facts.daemon?.answered ? facts.daemon.facts : null, facts.endpoint, ids.platform ?? seams.platform);
	const result = await runLiveProbes({
		image: facts.jobImage ?? jobImageOf(env).image,
		// Issue #596: the deployment's default size, and the `--cpus` ceiling from the same `docker info` answer, so the
		// probe is built at the size a job gets and reads back memory, swap, weight and ceiling against it.
		size: doctorJobSize(env),
		hostCpus: facts.daemon?.answered ? (facts.daemon.facts?.hostCpus ?? null) : null,
		endpoint: facts.endpoint,
		// Asked again right before the first probe command, through the same resolver as the collection's read.
		resolveEndpoint: makeDockerEndpointResolver({ run: dockerRunVia(spawn) }),
		dockerReachable: facts.dockerCode === 0,
		imagePresent: facts.imageCode === 0,
		jobsDir: jobsDirPath(env),
		home,
		sessionsDir: env.PI_SESSIONS_DIR || null,
		egress: facts.egress,
		// The collection's one `docker info` answer, for the detach gate (issue #452, gate round 3); where the collection did
		// not read one, the gate reads it itself.
		...(facts.daemon ? { readRuntime: async () => runtimeFromFacts(facts.daemon) } : {}),
		pid,
		nonce,
		run: liveRunVia(spawn),
		fs: liveFs,
		isAlive,
		announce: (line) => out(`\nread back on local: ${line}\n`),
		user: jobUser.user ?? null,
		relabel,
		// root can remove whatever a job leaves, and a sudo'd doctor is not the worker, so there is no owner to compare.
		euid: ids.euid === 0 ? undefined : ids.euid,
		// The removal wait's clock (issue #344), seamed so a test never waits out a real deadline.
		...(now ? { now } : {}),
		...(delay ? { delay } : {}),
	});
	return readBackChecks({
		venue: DEFAULT_LOCAL_BACKEND,
		bin: "docker",
		result,
		user: jobUser.user,
		ids,
		relabel,
		facts,
		userFix: "the daemon did not apply --user as the worker passes it: no job here runs as the uid its files belong to",
		peersOn: "this daemon's job networks",
		// env-internal DOCKER_CONTENT_TRUST: the docker CLI's own variable, read here only to say that it changes what
		// --pull=never governs; pi-dispatch sets nothing with it, so it is not a key of ours to document.
		extraLimits: env.DOCKER_CONTENT_TRUST === "1" ? ["DOCKER_CONTENT_TRUST=1 resolves a tag through notary, which --pull=never does not govern"] : [],
	});
}

/**
 * One venue's read-back rendered as checks (issues #278, #344, #354): what an interrupted run left and this one removed,
 * the uid PID 1 ran as against the decided one, one line per verdict, the teardown notes, and the limits line. Shared
 * by `local` and `podman` so the two cannot drift into different judgements of the same verdicts; only the words that
 * name the runtime differ, passed in, and for `local` every one of them is what this function's body always printed.
 */
function readBackChecks({ venue, bin, result, user, ids, relabel, facts, userFix, peersOn, extraLimits = [] }) {
	const prefix = `read back on ${venue}`;
	const checks = (result.swept ?? []).map((what) => ({ ok: true, label: `${prefix}: removed ${what}, left by an interrupted --live run` }));
	const noteChecks = () => result.notes.map((note) => ({ ok: false, warn: true, label: `${prefix}: ${note}`, fix: "remove it by hand now, or let the next `pi-dispatch doctor --live` remove it once this process has exited" }));
	if (!result.ran) {
		// What was swept and what could not be removed are said on this path too: both are host changes, and neither
		// depends on whether a reading was made.
		checks.push({ ok: false, warn: true, label: `${prefix}: not run -- ${result.reason}`, fix: "the declarations above are unchanged and still unverified; fix what stopped the probe and re-run `pi-dispatch doctor --live`" }, ...noteChecks());
		return checks;
	}
	// The decision, read back: the uid PID 1 ran as against the one this host decides.
	const wantUid = user ? Number(user.split(":")[0]) : null;
	if (typeof result.ranAs !== "number") {
		checks.push({ ok: false, warn: true, label: `${prefix}: the job user was not read back (PID 1's status showed no uid)`, fix: LIVE_UNREAD_FIX });
	} else if (wantUid !== null && result.ranAs !== wantUid) {
		checks.push({ ok: false, label: `${prefix}: the probe ran as uid ${result.ranAs}, not the decided job user ${user}`, fix: userFix });
	} else if (wantUid !== null) {
		checks.push({ ok: true, label: `${prefix}: the probe ran as uid ${result.ranAs}, the job user this host decides (${user})` });
	} else {
		checks.push({ ok: true, label: `${prefix}: the probe ran as the job image's own user (uid ${result.ranAs})` });
	}
	checks.push(
		...result.verdicts.map((v) => {
			if (v.ok) return { ok: true, label: `${prefix}: ${v.property} holds (${v.detail})` };
			if (v.warn) return { ok: false, warn: true, label: `${prefix}: ${v.property} ${v.detail}`, fix: LIVE_UNREAD_FIX };
			const declared = declarationOf(venue, v.property)?.word ?? "undeclared";
			const fix = liveFailFix(bin, v.cause ? `${v.property}:${v.cause}` : v.property) ?? liveFailFix(bin, v.property);
			return { ok: false, label: `${prefix}: ${v.property} does NOT hold -- declared ${declared}, observed: ${v.detail}`, fix };
		}),
	);
	checks.push(...noteChecks());
	// What a green read-back does NOT mean, on a line of its own so a row of ✓ is never read as more than it is.
	// Each sentence says only what DID happen: a probe that was not read back has its own line above saying why, and
	// a sentence here claiming it ran would contradict that line.
	const verdictOf = (property) => result.verdicts.find((v) => v.property === property);
	const unread = [
		"every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint",
		`it ran as ${user ? `the job user ${user}` : "the image's own user"}, decided for this shell${typeof ids.euid === "number" ? ` (uid ${ids.euid})` : ""}, and the worker service may run as another account`,
		"it wrote to a fixture folder, not to any folder of yours",
		// The fixture's workspace is doctor's own directory and carries :Z like a forge clone's; an operator's local folder
		// never does, so localFolders holding here says nothing about yours, which the SELinux label lines read instead.
		...(relabel ? ["on this SELinux host the fixture's workspace was relabelled (:Z), which a local folder of yours never is: the SELinux label lines above read those"] : []),
		`it read back PI_JOB_IMAGE only${facts.triggerImages?.length ? `, not the ${facts.triggerImages.length} image(s) your triggers name` : ""}`,
		// Only a HELD ephemeral read ran both runs: a first run that survived, or a name held against the second, ran one.
		...(verdictOf("ephemeral")?.ok === true ? ["ephemeral ran two short-lived containers under one name, not two real jobs"] : []),
		// Any jobToJobIsolation ANSWER, held or reached, needed both peers started.
		...(verdictOf("jobToJobIsolation") && verdictOf("jobToJobIsolation").warn !== true ? [`jobToJobIsolation tried one pair of peers on ${peersOn}, from the first to the second only, not every pair of jobs`] : []),
		...(facts.egress?.armed === false ? ["jobToJobIsolation needs PI_EGRESS armed, since without it jobs share the default bridge by design"] : []),
		...(facts.egress?.armed === true && facts.egress?.proxyRunning === false ? ["jobToJobIsolation needs the egress proxy running, since a job network is built around it"] : []),
		"secretsCustody and credentialTransit are not container properties",
		...(ids.euid === 0 ? ["the host owner of what the probe wrote was not compared, because doctor ran as root"] : []),
		...extraLimits,
	];
	checks.push({ ok: true, label: `${prefix}: limits of this read-back -- ${unread.join("; ")}` });
	return checks;
}

/**
 * A failed read-back's fix for one runtime (issue #354). `LIVE_FAIL_FIX` is written for docker, whose words are returned
 * untouched; for another runtime its CLI's name replaces docker's wherever the text names a command or a wrapper, so a
 * podman venue is never sent to `docker ps -a`. "Docker Desktop" and "rootful Podman" are proper names and stay.
 */
function liveFailFix(bin, key) {
	const text = (bin === "podman" ? LIVE_FAIL_FIX_PODMAN[key] : undefined) ?? LIVE_FAIL_FIX[key];
	return text === undefined ? text : forRuntime(text, bin);
}

/**
 * `doctor --live` on the podman venue (issue #354, INT-LIVE-PROBE-CONTRACT): the same eight read back by the same
 * `runLiveProbes`, through `podman` with the podman venue's own builder (`--userns=keep-id` exactly where its jobs carry
 * it) and as the uid its jobs run as, rendered as `read back on podman: ...`. The local gate is the service's own answer,
 * `serviceIsRemote === false`, read by the collection and ASKED AGAIN right before the first command, as docker's
 * endpoint is: a CONTAINER_HOST exported in between would otherwise send every read to another machine.
 *
 * egress IS read back here since issue #431, by the same canary docker's doctor runs (`runEgressCanary`), under this
 * account's Podman: its probe containers built by the podman builder as a job's are, as the job user, on a job-shaped
 * `--internal` network with the proxy attached. Its lines come first in what this returns, so the egress verdict's "see
 * the egress lines above" points at them. The refusals above stop it with everything else, and so does a podman
 * service not seen as this host's own, asked AGAIN right before its first command for the reason given above.
 */
export async function podmanLiveChecks(env, seams, facts) {
	const { spawn, out = () => {}, home = safeHomeDir(), liveFs, isAlive = defaultIsAlive, pid = process.pid, nonce = randomBytes(6).toString("hex"), jobUserIdentity: ids = {}, now, delay } = seams;
	const podman = facts.podman;
	if (podman.run === false) {
		return [{ ok: false, warn: true, label: `read back on podman: not run -- ${podman.reason}`, fix: podman.fix ?? "fix the podman job-user line above first, then re-run `pi-dispatch doctor --live`" }];
	}
	const readInfo = makePodmanInfoReader({ run: dockerRunVia(spawn, PODMAN_INFO_TIMEOUT_MS, { bin: "podman" }) });
	const run = liveRunVia(spawn, { bin: "podman" });
	const image = facts.jobImage ?? jobImageOf(env).image;
	const canary = await podmanEgressCanary({ podman, readInfo, run, image, pid, isAlive, size: doctorJobSize(env), announce: (line) => out(`\nread back on podman: ${line}\n`) });
	const egress = { armed: podman.egress.armed, results: canary.results, proxy: podman.egress.proxy, proxyRunning: podman.egress.proxyRunning, keeperBlocked: podman.egress.keeperBlocked ?? null };
	const result = await runLiveProbes({
		image,
		// Issue #596: as the docker read-back, from this account's own `podman info`.
		size: doctorJobSize(env),
		hostCpus: podman.info?.hostCpus ?? null,
		endpoint: podman.info,
		resolveEndpoint: async () => {
			const again = await readInfo();
			return again?.answered ? again.info : null;
		},
		isLocal: (info) => info?.serviceIsRemote === false,
		dockerReachable: podman.info !== null,
		imagePresent: podman.imagePresent === true,
		jobsDir: jobsDirPath(env),
		home,
		sessionsDir: env.PI_SESSIONS_DIR || null,
		egress,
		// The section's own `podman info` answer, for the detach gate (issue #452, gate round 3): one read per run.
		readRuntime: async () => (podman.info ? { podman: true, rootless: podman.info.rootless, version: podman.info.version } : null),
		pid,
		nonce,
		run,
		// The first keep-id run of an image copies its layers (27 s measured), longer than the 20 s step bound.
		startTimeoutMs: PODMAN_FIRST_START_TIMEOUT_MS,
		buildArgs: buildPodmanRunArgs,
		bin: "podman",
		fs: liveFs,
		isAlive,
		announce: (line) => out(`\nread back on podman: ${line}\n`),
		user: podman.user,
		relabel: podman.relabel === true,
		euid: ids.euid === 0 ? undefined : ids.euid,
		...(now ? { now } : {}),
		...(delay ? { delay } : {}),
	});
	return [
		...canary.checks,
		...readBackChecks({
			venue: PODMAN_BACKEND,
			bin: "podman",
			result,
			user: podman.user,
			ids,
			relabel: podman.relabel === true,
			facts: { ...facts, egress },
			userFix: "podman did not apply --user with --userns=keep-id as the worker passes it: no job here runs as the uid its files belong to",
			peersOn: "this account's Podman job networks",
		}),
	];
}

/**
 * The podman venue's egress canary for `--live` (issue #431): the stale-network sweep, then `runEgressCanary`, both
 * through `podman`. Returns `{ checks, results }` like the canary does, with `results` empty wherever it did not run,
 * which `egressVerdict` reads as not read back.
 *
 * Gated like docker's, on the facts the podman section read: nothing with the policy off (a malformed PI_EGRESS reads as
 * armed, as it does for the proxy line and for docker's canary, and the verdict says it could not be read); the SWEEP
 * whenever it is armed, because a proxy that has since stopped is no reason to leave a dead run's network behind; the
 * canary only with the proxy seen running and the job image in this account's store, whose absence the section above
 * already names. Before either, `podman info` is asked again and must still say `serviceIsRemote: false`: the sweep
 * judges a pid against THIS process table and the canary's containers must start where the section looked, and both of
 * those are false the moment CONTAINER_HOST points elsewhere. The re-ask costs one spawn and only with egress armed.
 */
async function podmanEgressCanary({ podman, readInfo, run, image, pid, isAlive, size = DEFAULT_JOB_SIZE, announce = () => {} }) {
	const none = { checks: [], results: [] };
	if (podman.egress?.armed === false) return none;
	// Issue #458: on Podman 4.x without the keeper, the canary's own teardown (and the stale sweep's detach) is the step
	// that cuts the proxy's route out, so neither runs: a read-back that breaks what it reads is worse than none. Said
	// as ✗, beside the keeper line, and the egress verdict below says it was not read back because of it.
	if (podman.egress?.keeperBlocked) {
		return { checks: [{ ok: false, label: `podman: Egress policy: not proved, and no egress canary was run (nor a stale canary network swept), because ${podman.egress.keeperBlocked}`, fix: `${NETNS_KEEPER_FIX}, then re-run \`pi-dispatch doctor --live\`` }], results: [] };
	}
	const again = await readInfo();
	if (!(again?.answered && again.info?.serviceIsRemote === false)) {
		return { checks: [{ ok: false, warn: true, label: "podman: Egress policy: not proved, because this shell's podman CLI is not observed to point at this host, so no canary container was started", fix: "fix what the podman lines above say about this account's Podman service (CONTAINER_HOST, or a service that did not answer), then re-run `pi-dispatch doctor --live`" }], results: [] };
	}
	// The service is this host's own, which is `endpoint.local === true` in the sweep's terms: its pid test is sound here.
	const canaryRun = (args, opts) => run(args, { timeoutMs: opts?.timeoutMs ?? CANARY_STEP_TIMEOUT_MS });
	// One detach gate for this pass, shared with the canary below (issue #452, gate round 3).
	const gate = makeDetachGate(canaryRun, { bin: "podman", readRuntime: async () => (again.info ? { podman: true, rootless: again.info.rootless, version: again.info.version } : null) });
	const checks = await sweepStaleCanaryNetworks({ run: canaryRun, pid, isAlive, endpoint: { local: true }, venue: CANARY_PODMAN, gate });
	if (podman.egress.proxyRunning !== true || podman.imagePresent !== true) return { checks, results: [] };
	// Announced, as `runLiveProbes` announces its own containers: these start before it, and a cold first keep-id start
	// can take half a minute each, which is a long silence on an operator's terminal.
	const probes = CANARY_PROBE_SLUGS.map((slug) => egressCanaryProbe(slug, pid));
	// Issue #503: three more per declared model endpoint, said in a second sentence so the canary's own stays as it was.
	const endpoints = podman.egress.endpoints ?? [];
	const more = endpoints.length > 0 ? `; then three per declared model endpoint (${endpointsById(endpoints).map((e) => e.id).join(", ")}), named ${EGRESS_ENDPOINT_PROBE_PREFIX}<probe>-<id>-${pid}, removed the same way` : "";
	announce(`starting ${probes.slice(0, -1).join(", ")} and ${probes.at(-1)} from ${image} (as the job user ${podman.user}) on the --internal network ${egressCanaryNetwork(pid)}, with ${podman.egress.proxy} attached, to read the egress allowlist back; all three are removed when the canary ends${more}`);
	const canary = await runEgressCanary({ run, bin: "podman", proxy: podman.egress.proxy, image, pid, user: podman.user, gate, endpoints, size, hostCpus: again.info?.hostCpus ?? null });
	return { checks: [...checks, ...canary.checks], results: canary.results };
}

/** The backend `doctor --live` reads back: the table default, which is the only venue on this host's docker CLI. */
const DEFAULT_LOCAL_BACKEND = "local";

const LIVE_UNREAD_FIX = "this property was not read back, which is not the same as holding: see the reason, fix it if you can, and re-run `pi-dispatch doctor --live`";

/** Per property, what a failed read-back points at. Words only: none of these is a thing doctor could do for you. */
const LIVE_FAIL_FIX = {
	isolation: "the runtime did not apply a flag the worker passes (on rootless docker, cgroup delegation; otherwise the daemon's security options) -- jobs on this host do not have the boundary the table declares",
	mountSet: "a container built by the job builder has a mount the contract does not allow -- check the daemon's defaults and any volume plugins before running jobs here",
	"mountSet:runtime-mount": "the container runtime mounted something into a job-built container that docker inspect does not list (on rootful Podman, /run/secrets from its default mounts.conf, with host subscription files a job can read): create an empty /etc/containers/mounts.conf, remove any volumes or mounts key from containers.conf, and re-run `pi-dispatch doctor --live`",
	egress: "see the egress lines above: the proxy's allowlist, or the job image's NODE_USE_ENV_PROXY support",
	imagePinning: "the daemon ran or pulled an image this host does not have -- check for a docker CLI plugin or wrapper that rewrites `docker run`",
	nonRoot: "PI_JOB_IMAGE runs as root: the root-owned hard-rules floor does not bind a root agent -- use an image with a non-root USER (the shipped pi-job image does)",
	"localFolders:not-writable": "the job user cannot write a folder this shell owns: where the daemon enforces bind-mount ownership a local-folder job runs as the worker's own uid (issue #341), so the folder must be writable by the account the worker runs as",
	"localFolders:job-unreadable": "the job user cannot list a 0700 job directory: the uid the job-user line above names is not the one that owns the jobs directory here (a rootless daemon, userns-remap, NFS root_squash or SELinux can each cause it), so every job on this host fails before it starts",
	"localFolders:mount-not-writable": "the job user cannot write the outbox or session mount, which a local job and a resumed job write; the same ownership rule as the job directory applies",
	"localFolders:not-yours": "a job's files land owned by another uid, so the worker cannot remove what a job leaves: run doctor as the worker's own account, and check the job-user line above",
	"ephemeral:survived": "a container run with --rm was still listed after it exited: the daemon or a wrapper is not removing containers, so every job leaves one behind -- check `docker ps -a` and any docker wrapper or alias",
	"ephemeral:name-held": "a container name stayed taken after its container was seen gone, so a retried job id cannot start. The read-back removed whatever held the name when it ended, so re-run `pi-dispatch doctor --live`; if it recurs, check the daemon for a stale name reservation (on Podman, `podman ps -a --external` also lists storage containers another tool made)",
	"ephemeral:reused": "the daemon handed a second run the first run's container: a job would inherit another job's state -- do not run jobs on this daemon until that is explained",
	"ephemeral:residue": "a new container found a file the previous one wrote to its own /tmp: a job would inherit another job's filesystem -- check the runtime's storage driver and any volume the image declares",
	"jobToJobIsolation:reached": "one job's container reached another's across their own --internal networks: the network driver or firewall is not keeping job networks apart (on Podman, check netavark's firewall driver), so a job can talk to a concurrent job",
	"localFolders:not-visible": "the daemon is not sharing the jobs directory's filesystem with containers as a live bind mount (on Docker Desktop, check its file sharing settings), so a local-folder job's edits would not land in the folder",
	localFolders: "a bind-mounted host folder did not behave as one a job edits in place",
};

/**
 * Where rootless Podman's cause is not docker's with the name swapped (issue #453). A failed isolation read-back on
 * podman is, in the measured case, an account with no systemd user manager running, which the isolation line names;
 * "cgroup delegation" alone sent the operator to controllers that already read delegated.
 */
const LIVE_FAIL_FIX_PODMAN = {
	isolation: `the runtime did not apply a bound the worker passes: on rootless Podman that is the account's systemd user manager not running, Podman not reaching it, or a controller not delegated to it (the "isolation is ASSERTED" line above names which, when the static read sees it) -- jobs on this host do not have the boundary the table declares. ${capitalized(PODMAN_BOUNDS_FIX["no-user-manager"])}`,
};

/**
 * The jobs dir as this account's worker will meet it (issue #464): ✓ when it is a directory this account owns and may
 * write, or does not exist yet under a directory this account may write; ✗ otherwise, with the fix. Where it lies in
 * the per-account temp root (the default), the root is judged too, as `ensureJobsDir` judges it: a real directory owned
 * by this account. Then the sandbox dir, as `ensureSandboxDir` judges it: one that exists must be this account's. Then,
 * only for the default paths, a ⚠ when the OLD shared default still holds retained workspaces of this account, which
 * this version neither re-opens nor sweeps. Nothing where the platform has no uid (Windows).
 */
export function jobsDirChecks(env, { uid, fs, ownerName = () => null, note = "" }) {
	if (!Number.isInteger(uid)) return [];
	const jobsDir = jobsDirPath(env, uid);
	if (jobsDir === "") return [{ ok: false, label: "PI_JOBS_DIR is set to an empty value, so the worker has no directory to put a job's inputs in and cannot start", fix: "remove the line to use the default, or set it to a directory this account owns" }];
	const read = (p, follow) => {
		try {
			return (follow ? fs.statSync : fs.lstatSync)(p);
		} catch (err) {
			return err?.code === "ENOENT" ? null : { error: err?.code ?? "error" };
		}
	};
	const writable = (p) => {
		try {
			fs.accessSync(p, fsConstants.W_OK | fsConstants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	const owner = (id) => {
		const name = ownerName(id);
		return name ? `${name} (uid ${id})` : `uid ${id}`;
	};
	const checks = [];
	const root = accountTempRoot(env, uid);
	const inRoot = jobsDir === root || jobsDir.startsWith(`${root}/`);
	const refuse = (label, fix) => [{ ok: false, label: `${label} -- every job fails before it starts${note}`, fix }];
	if (inRoot) {
		const refused = accountRootRefusal(root, { uid, fs, ownerName, what: "this account's jobs dir" });
		if (refused) return refuse(refused.label, refused.fix);
	}
	const st = read(jobsDir, true);
	if (st?.error) return refuse(`the jobs dir ${jobsDir} could not be read (${st.error})`, `make it readable by this account, or point PI_JOBS_DIR at a directory this account owns`);
	if (st) {
		if (!st.isDirectory()) return refuse(`the jobs dir ${jobsDir} is not a directory`, "point PI_JOBS_DIR at a directory this account owns, or remove what is there");
		if (st.uid !== uid) return refuse(`the jobs dir ${jobsDir} is owned by ${owner(st.uid)}, not by this account (uid ${uid}), which could replace a job's inputs; the worker refuses it at boot`, jobsDirOwnerFix(jobsDir, inRoot));
		if (!writable(jobsDir)) return refuse(`the jobs dir ${jobsDir} is this account's but it cannot write it`, `chmod u+rwx ${jobsDir}`);
		checks.push({ ok: true, label: `Jobs dir ${jobsDir} is this account's and writable${note}` });
	} else {
		let parent = jobsDir;
		let found = null;
		for (let i = 0; i < 64 && !found; i += 1) {
			const next = dirname(parent);
			if (next === parent) break;
			parent = next;
			const at = read(parent, true);
			if (at && !at.error) found = at;
		}
		if (!found || !writable(parent)) return refuse(`the jobs dir ${jobsDir} does not exist, and this account cannot create it (${found ? `${parent} is not writable by it` : "no parent of it could be read"})`, "point PI_JOBS_DIR at a directory this account owns, or create it for this account");
		checks.push({ ok: true, label: `Jobs dir ${jobsDir} does not exist yet; the worker creates it (mode 0700) at boot${note}` });
	}
	// Issue #464 (gate round 1): the sandbox dir, as `ensureSandboxDir` judges it at boot. Its default lies in the jobs dir
	// just judged; one set elsewhere that another account owns (seen: a 0777 directory of another account's) is where
	// that account could swap a retained workspace for its own.
	const sandboxDir = env.PI_SANDBOX_DIR || defaultSandboxDir(env, uid);
	const sb = read(sandboxDir, true);
	if (sb?.error) return [...checks, ...refuse(`the sandbox dir ${sandboxDir} could not be read (${sb.error})`, sandboxDirOwnerFix(sandboxDir))];
	if (sb && !sb.isDirectory()) return [...checks, ...refuse(`the sandbox dir ${sandboxDir} is not a directory`, sandboxDirOwnerFix(sandboxDir))];
	if (sb && sb.uid !== uid) return [...checks, ...refuse(`the sandbox dir ${sandboxDir} is owned by ${owner(sb.uid)}, not by this account (uid ${uid}), which could swap a retained workspace for one of its own; the worker refuses it at boot`, sandboxDirOwnerFix(sandboxDir))];
	if (env.PI_JOBS_DIR === undefined && !env.PI_SANDBOX_DIR) {
		// Issue #464's migration: before it, the default was the SHARED `<tmp>/pi-dispatch/jobs`, and a retained workspace
		// there is this account's data the new default does not see. Counted by owner, so another account's are not named.
		const old = `${accountTempRoot(env, null)}/jobs/sandboxes`;
		let mine = [];
		try {
			mine = fs.readdirSync(old).filter((name) => {
				try {
					return fs.lstatSync(join(old, name)).uid === uid;
				} catch {
					return false;
				}
			});
		} catch {
			// Absent or unreadable: nothing of this account's is known to be there.
		}
		if (mine.length > 0) {
			const now = `${jobsDir}/sandboxes`;
			checks.push({
				ok: false,
				warn: true,
				label: `${mine.length} retained workspace(s) of this account are in ${old}, the shared default before issue #464: this version keeps them in ${now}, so \`pi-dispatch sandbox\` cannot re-open them and the retention sweep no longer removes them`,
				fix: `move the ones worth keeping (the same filesystem, so a rename): mkdir -m 700 -p ${root} ${now} && mv ${old}/<name> ${now}/, and delete the rest: rm -rf ${old}/<name>. Naming ${root} makes it 0700 too (\`mkdir -m\` sets only the directories named, and a plain \`mkdir -p\` leaves ${root} 755); the worker also tightens it to 0700 at its next boot`,
			});
		}
	}
	return checks;
}

/**
 * Why the per-account temp root `root` (`accountTempRoot`) cannot be used, as `{ label, fix }`, or null when it is this
 * account's real directory or does not exist yet (issue #464): the reading of `ensureAccountTempRoot`'s refusals, shared
 * by the jobs dir check and the no-home durable state check. `what` names what lives there.
 */
export function accountRootRefusal(root, { uid, fs, ownerName = () => null, what }) {
	let st = null;
	try {
		st = fs.lstatSync(root);
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		return { label: `${root}, where ${what} lives, could not be read (${err?.code ?? "error"})`, fix: `make ${root} readable by this account, or set the variable for it in .env to a directory this account owns` };
	}
	if (st.isSymbolicLink() || !st.isDirectory()) return { label: `${root}, where ${what} lives, is not a directory (a symlink or a file there is refused, since any account can create a name under the temp dir)`, fix: jobsDirOwnerFix(root, true) };
	if (st.uid !== uid) {
		const name = ownerName(st.uid);
		return { label: `${root}, where ${what} lives, is owned by ${name ? `${name} (uid ${st.uid})` : `uid ${st.uid}`}, not by this account (uid ${uid}); the worker refuses it at boot`, fix: jobsDirOwnerFix(root, true) };
	}
	return null;
}

/** An account's name from /etc/passwd text (the `passwd` seam), or null. */
/** A group's name from /etc/group, read through `fs`, else `gid N` (for the trust wording, gate round 3). */
function groupNameFromGroup(fs, gid) {
	try {
		for (const line of String(fs.readFileSync("/etc/group", "utf8")).split("\n")) {
			const f = line.split(":");
			if (f.length >= 3 && f[2] === String(gid) && f[0] !== "") return f[0];
		}
	} catch {
		// No group file: the gid alone is named.
	}
	return `gid ${gid}`;
}

function ownerNameFromPasswd(passwd, uid) {
	try {
		for (const line of String(passwd?.() ?? "").split("\n")) {
			const f = line.split(":");
			if (f.length >= 3 && f[2] === String(uid) && f[0] !== "") return f[0];
		}
	} catch {
		// No passwd: the uid alone is named.
	}
	return null;
}

/**
 * The account's run directory, `/run/user/<euid>`, when a `podman info` read failed with an exit status, that directory
 * does not exist, and Podman's own database records a run root under it (issue #464), else null. Only ENOENT counts: a
 * stat that fails another way says nothing.
 *
 * The database is the evidence that Podman ran under /run/user before (gate round 1): an account that never had a
 * session has no /run/user/<uid> either, and a podman failing there for any other reason was named "linger off". Podman
 * keeps the run root it first used in `db.sql` (SQLite; measured on Podman 5.8.1 and on Ubuntu's 4.9.3) or
 * `libpod/bolt_state.db` (BoltDB, older installs) under its storage root, `$XDG_DATA_HOME/containers/storage`, else
 * `~/.local/share/containers/storage`; both hold the path as plain bytes (measured: `/run/user/501/containers` in a
 * Lima account's db.sql). A storage root moved in storage.conf is not followed, and then nothing is claimed.
 */
export function podmanRunDirGone({ read, euid, fs, home = null, env = {} }) {
	if (!read || read.answered !== false || !/^exit-[0-9]+$/.test(String(read.reason ?? ""))) return null;
	if (!Number.isInteger(euid) || euid <= 0) return null;
	const dir = `/run/user/${euid}`;
	try {
		fs.statSync(dir);
		return null;
	} catch (err) {
		if (err?.code !== "ENOENT") return null;
	}
	// env-internal XDG_DATA_HOME: where Podman keeps this account's storage, the XDG base directory it reads itself;
	// the operator sets it for Podman, never for this project.
	const data = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : home ? `${home}/.local/share` : null;
	if (!data) return null;
	const needle = `${dir}/`;
	for (const db of [`${data}/containers/storage/db.sql`, `${data}/containers/storage/libpod/bolt_state.db`]) {
		try {
			const bytes = fs.readFileSync(db);
			if ((Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))).includes(needle)) return dir;
		} catch {
			// Absent or unreadable: no evidence from this one.
		}
	}
	return null;
}

/**
 * Linger for `user`: loginctl's answer, else logind's own flag file (issue #464). Measured on Ubuntu 24.04 (systemd 255):
 * `loginctl show-user` exits 1 for an account that is neither logged in nor lingering ("is not logged in or lingering"),
 * which is exactly the account whose linger this is asked about, while Fedora's 259 answers `Linger=no`. logind keeps
 * one empty file per lingering account in /var/lib/systemd/linger, readable by every account on both.
 */
export async function readLingerOrFlag(user, { spawn, fs }) {
	const asked = await readLinger(user, (cmd, args) => runCmdCapture(spawn, cmd, args, { stdoutOnly: true, timeoutMs: 5000 }));
	if (asked !== null) return asked;
	const flag = (p) => {
		try {
			fs.statSync(p);
			return true;
		} catch (err) {
			return err?.code === "ENOENT" ? false : null;
		}
	};
	if (flag("/var/lib/systemd/linger") !== true) return null;
	return flag(`/var/lib/systemd/linger/${user}`);
}

/** This shell's account name, for loginctl; a seam so a test names the account it models. */
function userNameOf(seams) {
	if (typeof seams.userName === "function") return seams.userName();
	try {
		return userInfo().username;
	} catch {
		return null;
	}
}

// `urlShown` (a URL as doctor may print it, never its userinfo, query or fragment) lives in valkey-endpoint.mjs since
// PR #475's review, so the CLI, the panel and doctor print every Valkey URL through the one function.
export { urlShown };

/**
 * PI_JOB_IMAGE as the worker takes it and as doctor may hand it to a runtime (issue #471): `{ image, refused }`. The
 * worker's own default rule (`config.mjs`: `||`, so an empty value is pi-job:latest), then the refusals the worker's
 * `run.image` validator (`triggers.mjs`) applies to the same positional, which docker would otherwise read as a flag or
 * refuse only at each job's start: a blank or padded value, a leading dash, and a control character. A refused value is
 * never used: `image` is then the default, and `refused` the reason, for the ✗ that names it.
 */
export function jobImageOf(env) {
	const raw = env.PI_JOB_IMAGE;
	if (typeof raw !== "string" || raw === "") return { image: "pi-job:latest", refused: null };
	// The worker's own rule (`jobImageFrom`, the shared `image-ref.mjs`), which refuses these at boot.
	const problem = imageRefProblem(raw);
	return problem ? { image: "pi-job:latest", refused: problem.reason } : { image: raw, refused: null };
}

/** Text with every C0 and C1 control blanked, for a line another party's value reaches. */
function printable(text) {
	return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** A fix line opening a sentence of its own. */
function capitalized(text) {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A PID-liveness check for the stale-fixture sweep: EPERM means alive and owned by someone else. */
function defaultIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/**
 * The bounds every `runCmd` call runs under (issue #397). `cmd` is the default and matches
 * `runCmdCapture`'s, so the two runners in this file do not disagree about what "too long" means. `pull`
 * is the override for the two `--fix` actions that fetch an image, and matches the 600s this file already
 * gives `import-pi`: a cold `docker pull` of the job image is minutes of legitimate work, and bounding it
 * at 30s would turn a working fix into a failed one.
 *
 * Injected through the `runTimeouts` seam rather than read here, so a test can drive the timeout path in
 * milliseconds instead of waiting half a minute for it.
 */
export const RUN_TIMEOUTS = Object.freeze({ cmd: 30_000, pull: 600_000 });

/** The live probes' `run` seam over doctor's spawn: `{ code, stdout, stderr }`, bounded, `code: null` when it could not run. */
/**
 * WHY a null happened, not just that it did (issue #379, item 4).
 *
 * `code: null` used to mean two opposite things: the CLI never LAUNCHED, so the daemon did nothing, or the
 * CLI started and was killed by the bound, which can land after the daemon has already acted. A caller
 * deciding whether to clean up has to tell those apart -- reading both as "nothing happened" leaks the
 * object, reading both as "it may exist" cries wolf on every host without docker installed and turns this
 * file's own ENOENT test red. So `ended` says which: `"error"` (never launched), `"timeout"` (killed by the
 * bound), or `"close"` (the child exited, and `code` is its own).
 *
 * `bin` (issue #354): the runtime CLI, `docker` unless a caller names another, as `dockerRunVia`'s.
 */
export function liveRunVia(spawn, { bin = "docker" } = {}) {
	return (args, { timeoutMs }) =>
		new Promise((resolve) => {
			let child;
			try {
				child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				resolve({ code: null, stdout: "", stderr: "", ended: "error" });
				return;
			}
			let stdout = "";
			let stderr = "";
			let done = false;
			const finish = (code, ended) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve({ code, stdout, stderr, ended });
			};
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish(null, "timeout");
			}, timeoutMs);
			child.stdout?.on("data", (d) => (stdout += d));
			child.stderr?.on("data", (d) => (stderr += d));
			child.on("error", () => finish(null, "error"));
			child.on("close", (code) => finish(code, "close"));
		});
}
