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
 * in-container fails jobs mid-run, not at submit. Token values travel via the spawn env only, never argv.
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
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, release as osRelease, tmpdir } from "node:os";
import { dirname, isAbsolute, join, delimiter, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { defaultLogsDir, defaultSandboxDir, defaultSettingsFile, defaultWorkerName, globalExtensionsEnabled, jobsDirPath, legacyTempStateDir, logsDirPath, pauseWindowsFilePath, safeHomeDir, scopedLimitsFilePath, settingsFilePath, underOsTempDir } from "./config.mjs";
import { envFileHazard, envValueShown, readEnvAssignments, renderEnvValue } from "./env-file.mjs";
import { canonicalScope, loadScopedLimits, parseScopedLimits } from "./scoped-limits.mjs";
import { loadPauseWindows } from "./pause-windows.mjs";
import { WAIT_AFTER_MAX_DEFAULT_MS, afterInstantMs, parseWaitProfiles } from "./wait-for.mjs";
import { isForgeKind } from "./forges.mjs";
import { findLiteralSecret, ADMIN_RE } from "./import-pi.mjs";
import { agentDirFrom, readHostPi } from "./host-pi.mjs";
import { PACKAGES_SUBDIR, readStagedSkills, readStageManifest } from "./packages.mjs";
import { copySkillTree } from "./copy-tree.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";
import { ABSENT, ASSERTED, DAEMON_APPLIES_BOUNDS, DEFAULT_BACKEND, DOCKER_ENDPOINT_LOCAL, OBSERVATION_FIX, OBSERVATIONS, PROPERTY_NAMES, RUNTIME_ADDS_NO_MOUNTS, declarationOf, floorShortfall, parseBackendFloor, parseBackendList, unarmedFloor, unobservedFloor } from "./backends.mjs";
import { observeHost } from "./runtime-observations.mjs";
import { endpointShown, makeDockerEndpointResolver, quotedShown } from "./backend-local.mjs";
import { EGRESS_CANARY_NET_PREFIX, EGRESS_CANARY_PROBE_PREFIX, egressArmed, egressCanaryNetwork, egressCanaryProbe, egressProxyName, networkEndpoints, removeNetworkOrSay } from "./egress.mjs";
import { runLiveProbes } from "./live-probes.mjs";
import { installedUnitPaths, readUnitSeam, readUnitUser } from "./service.mjs";
import { CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, DAEMON_FACTS_TIMEOUT_MS, JOB_USER_FIX, makeDaemonFactsReader, makeJobUserResolver, resolveImageUser } from "./job-user.mjs";
import { parseSecretProfiles } from "./secret-profiles.mjs";
// The OAuth-suffix rule and the variable it selects live in their own import-free module so the worker
// can share them: doctor NAMES a variable and env-allowlist WRITES one, and they must never differ.
import { OAUTH_KEY_RE, apiKeyVariable } from "./provider-key.mjs";
import { parseTriggers } from "./triggers.mjs";

const NODE_FLOOR = [22, 19]; // pi's engine floor (22.19.0)

// gh login scopes that reach well past what a job should ever hold — called out by name in the fix line.
const BROAD_SCOPES = ["admin:org", "delete_repo", "workflow"];

// The loopback Valkey, as one docker argv. Mirrors deploy/docker-compose.yml exactly: AOF on (the
// wait-list must survive a reboot, REQ-QUEUE-BURST-NO-DROP), bound to 127.0.0.1 only (the queue is not a
// public surface), restart unless-stopped, data on a named volume. Container and volume names are
// pi-dispatch-prefixed so compose's own `valkey`/`valkey-data` never collide with these.
const VALKEY_RUN = ["run", "-d", "--name", "pi-dispatch-valkey", "--restart", "unless-stopped", "-p", "127.0.0.1:6379:6379", "-v", "pi-dispatch-valkey-data:/data", "valkey/valkey:8", "valkey-server", "--appendonly", "yes"];

export async function runDoctor(env = process.env, deps = {}) {
	const {
		cwd = process.cwd(),
		out = (s) => process.stdout.write(s),
		spawn = nodeSpawn,
		// The bounds every `runCmd` goes through (issue #397). A seam so a test can drive the timeout path
		// in milliseconds; nothing else passes it.
		runTimeouts = RUN_TIMEOUTS,
		probeValkey = defaultProbeValkey,
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
		agentDir = agentDirFrom(env),
		// Where the service manager's units live, and which formats to read them in (issue #216). Seams
		// rather than bare process.platform/homedir() because the --env-setup check has to be exercised
		// for all three unit formats, and only one of them exists on whichever host runs the suite.
		platform = process.platform,
		home = safeHomeDir(),
		// doctor's one contact with pi's package, injectable so a test can drive the could-not-load arm
		// without uninstalling a dependency. Threaded like every other seam: a seam collectChecks honours
		// and runDoctor silently drops is a seam that cannot pin an EXIT CODE, only a check object.
		providerOracle = defaultProviderOracle,
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
		readEnvFile = (path) => readFileSync(path, "utf8"),
		// Issue #345: the host files the runtime-mounts observation reads (Podman's mounts.conf and containers.conf).
		observationFs = { statSync, readFileSync, readdirSync },
		isAlive = defaultIsAlive,
		pid = process.pid,
		nonce = randomBytes(6).toString("hex"),
	} = deps;
	// The facts a --live pass needs from the collection it follows (the endpoint read, docker and the image, the
	// egress canary's readings), filled by collectChecks rather than re-probed.
	const facts = {};
	// `isAlive` and `pid` ride the SHARED seams since issue #350, not just the `--live` spread below: the egress
	// canary names its network after the doctor PROCESS and now sweeps what an earlier doctor run left,
	// so it needs both, and a test cannot drive that sweep while the names come from `process.pid` directly.
	const seams = { cwd, out, spawn, probeValkey, readHosts, fileExists, nodeVersion, mkdir, chmod, rm, agentDir, platform, home, providerOracle, facts, jobUserIdentity, stat, passwd, readUnit, readEnvFile, observationFs, isAlive, pid, runTimeouts };

	let checks = await collectChecks(env, seams);
	let failed = render(checks, out);

	if (fix) {
		const ran = await applyFixes(checks, seams, promptFn);
		if (ran > 0) {
			// Converge-to-green: the probes are idempotent and cheap, so ONE full re-collect answers "did
			// the fixes take" without bookkeeping about which probe fed which check. At most once,
			// structurally -- the re-check never re-enters the fix pass, so a fix that did not take is
			// reported still-failing rather than retried forever.
			checks = await collectChecks(env, seams);
			const passing = checks.filter((c) => c.ok).length;
			out(`\nre-check after fixes: ${passing} of ${checks.length} checks pass\n`);
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
		const liveResults = await liveChecks(env, { ...seams, liveFs, isAlive, pid, nonce }, facts);
		if (render(liveResults, out)) failed = true;
	}

	out(failed ? "\ndoctor: some checks failed — fix the above, then re-run.\n" : "\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n");
	return failed ? 1 : 0;
}

/** The ✓/⚠/✗ lines plus each failure's fix, exactly as doctor has always printed them. Returns whether
 *  any HARD check failed (a ⚠ never fails doctor). */
function render(checks, out) {
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

/**
 * The values `<cwd>/.env` sets for NAMED keys, or `{}`. The only place in this project that reads a `.env`
 * file's contents at all (issue #357), and the narrowing is what makes it an addition rather than a
 * reversal:
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
export const ENV_FILE_READABLE_KEYS = Object.freeze(["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"]);

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
		const text = readEnvFile(path);
		// THE SERVICE'S OWN LOADER FIRST, because this file has three and they disagree (issue #384).
		// `service.mjs` renders exactly one per platform: systemd's `EnvironmentFile=` on linux,
		// `worker-env-wrapper.sh` (a sourcing shell) on darwin, `worker-env-wrapper.cmd` on win32. Reporting a
		// reading from a loader this deployment does not use is how doctor told half its operators the wrong
		// file under the previous shape, which asked systemd's grammar on every platform.
		const serviceLoader = platform === "linux" ? "systemd" : platform === "win32" ? "cmd" : "shell";
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
		const hazard = envFileHazard(text, { loader: serviceLoader });
		const plain = {};
		const notPlain = {};
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
			else if (own !== undefined && !own.plain) notPlain[key] = own.line;
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
		return { ...plain, notPlain, exported, alsoExported, blankInFile, serviceLoader, hazard };
	} catch {
		// COULD NOT READ is not "this key is unset". Returning the same `{}` for both told an operator whose
		// `.env` is a directory, or is not readable by this account, that the worker ignores a key -- a positive
		// claim about a file nobody could open.
		return { unreadable: true };
	}
}

/**
 * The two files a worker LOADS AT BOOT, and the one place that knows what each is and how to ask.
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
		resolve: scopedLimitsFilePath,
		load: (path, io) => loadScopedLimits({ scopedLimitsFile: path }, io),
	}),
]);

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
		spec.load(path, io.loaderIo);
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
export async function collectChecks(env, seams) {
	const { cwd, spawn, probeValkey, readHosts = defaultReadHosts, fileExists, nodeVersion, platform, agentDir = agentDirFrom(env), home = safeHomeDir(), underTemp = underOsTempDir, providerOracle = defaultProviderOracle, facts = null, readEnvFile = null, stat: statSeam = statSync, runTimeouts = RUN_TIMEOUTS } = seams;

	const jobImage = env.PI_JOB_IMAGE ?? "pi-job:latest";
	const valkeyUrl = env.VALKEY_URL ?? "redis://127.0.0.1:6379";
	const provider = env.PI_PROVIDER ?? "anthropic";

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
			run: async ({ out }) => {
				// Lazy import: a doctor run without --fix (or without this failure) never loads init.
				const { runInit } = await import("./init.mjs");
				const code = runInit(cwd, { out });
				return { ok: code === 0, note: "scaffolded by `pi-dispatch init` (create-only: existing files were kept)" };
			},
		},
	});

	// Right after `.env present`, because it answers the same question that check raises: where DOES this
	// deployment's environment come from. [] unless a seam is configured (issue #216).
	checks.push(...(await envSetupChecks(env, seams)));

	// THE FIRST DOCKER CALL OF THE RUN, which is why it was the one that hung (issue #397): a daemon that
	// accepts the connection and never answers held doctor here, before it had printed anything. Bounded
	// now, and the three outcomes are three different sentences, because telling someone whose daemon is
	// WEDGED to install Docker is worse than saying nothing.
	const dockerRun = await runCmd(spawn, "docker", ["info"], runTimeouts.cmd);
	const dockerCode = dockerRun.code;
	checks.push({
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
	const endpoint = await makeDockerEndpointResolver({ run: dockerRunVia(spawn) })();

	// Read once, used twice, so the triggers file is parsed a single time: `images` drives the per-trigger
	// image checks just below, and `optingOut`/`requiring` colour the staged-packages lines further down.
	// `optingOut` counts the only value that withholds the staged set; `requiring` counts an explicit
	// run.packages: true, which arms nothing any more but is still an operator statement of intent.
	const { requiring, waiting, waitProfiles, waitAfters, optingOut, resuming, replicating, instructing, commands, secreting, onceArmed, onceSpent, secretProfiles, localSecretFolders, secretNames, folders, images, skillsDirs, forges, repositories, flows, parseError, path: triggersFilePath } = readTriggerFacts(env, fileExists, cwd);
	const scopedLimitFacts = readScopedLimitFacts(env, fileExists);
	// FIRST, and fail rather than warn: every check below this line reads counts that a parse failure
	// zeroed, so a green run here would be reporting on a file nobody could read. The receiver loads this
	// file unconditionally and refuses to start without it, which is the consequence worth naming.
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

	// Only meaningful if docker itself responds; otherwise the image check is noise on top of a down daemon.
	const imageRun = dockerCode === 0 ? await runCmd(spawn, "docker", ["image", "inspect", jobImage], runTimeouts.cmd) : { code: null, ended: "error" };
	const imageCode = imageRun.code;
	checks.push({
		ok: imageCode === 0,
		// A timeout says the DAEMON did not answer, not that the image is absent: the fix for the second is
		// a pull, and for the first a pull would hang exactly as this did.
		label: imageRun.ended === "timeout" ? `Job image present (${jobImage}) -- the daemon did not answer` : `Job image present (${jobImage})`,
		fix:
			imageRun.ended === "timeout"
				? "restart Docker first: this asked the same daemon that did not answer above, so whether the image is present is unknown rather than false"
				: "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)",
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
		if (probe.skipped.symlinks > 0) {
			checks.push({
				ok: true,
				warn: true,
				label: `${probe.skipped.symlinks} entry(ies) under ${dir} are symlinks and are SKIPPED`,
				fix: "the copier never follows a link (a link out of the tree would put a host file in a job container); replace them with real files if the jobs need them",
			});
		}
		// Gap 5 of issue #60, and the one an operator cannot discover any other way: the ai-trigger gate
		// reads the repo's committed .pi/skills at the pinned sha, so an injected SKILL.md carrying the
		// opt-in is never consulted. Without this line the operator writes it and nothing honours it.
		const chainable = aiTriggerNames(dir);
		if (chainable.length > 0) {
			checks.push({
				ok: true,
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
		checks.push({ ok: true, label: `${commands} command trigger(s): a command is only verifiable in-container -- the runner refuses an unregistered one pre-spend (command-unregistered)` });
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
	for (const img of dockerCode === 0 ? images.filter((i) => i !== jobImage) : []) {
		const run = await runCmd(spawn, "docker", ["image", "inspect", img], runTimeouts.cmd);
		const code = run.code;
		checks.push({
			ok: code === 0,
			label: run.ended === "timeout" ? `Trigger job image present (${img}) -- the daemon did not answer` : `Trigger job image present (${img})`,
			fix: `docker pull ${img} (or build it) -- a trigger names it in run.image, and jobs run with --pull=never, so the worker never fetches it at job time`,
		});
		if (code !== 0) continue;
		const entry = await runCmdCapture(spawn, "docker", ["image", "inspect", "--format={{json .Config.Entrypoint}}", img]);
		if (entry.code === 0 && !entry.output.includes("entrypoint.sh")) {
			checks.push({
				ok: false,
				warn: true,
				label: `${img} does not appear to carry the pi-dispatch runner entrypoint`,
				fix: "build your job image FROM this repo's image/Dockerfile so it keeps /entrypoint.sh -- an image without the runner can exit 0 without ever starting the agent, and the queue records that as success (docs/job-image.md)",
			});
		}
	}

	// REQ-EGRESS-ALLOWLIST (issue #202). [] when PI_EGRESS=0, so a deployment that declined it gets
	// byte-identical output. Gated on docker and the image, because two of these checks run a container and
	// the rest are noise on top of a down daemon.
	const egress = await egressChecks(env, seams, { dockerCode, imageCode, jobImage, endpoint });
	checks.push(...egress);
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
	const jobUser = await jobUserChecks(env, seams, { endpoint, dockerCode, imageCode, jobImage });
	// No docker binary at all is an ANSWER for the observations, as it is for the worker (exit 2 under a floor, not a retry).
	// A daemon that did not ANSWER is the opposite class, and telling them apart is the whole point of `ended`
	// (issue #397): `docker-not-found` is DETERMINATE in `runtime-observations` -- it resolves to `value: false`,
	// which makes a floor REFUSE and hands the operator "no docker CLI was found on PATH" for a host whose CLI
	// is fine. A timeout resolves to `value: null` instead, which is the transient class `backendChecks` already
	// has the right sentence for ("fix what stops the daemon answering"; the worker exits 1 so the supervisor
	// retries). Before this arm existed both landed on the determinate one, byte-identically.
	const daemon =
		jobUser.daemon ??
		(dockerRun.ended === "timeout"
			? { answered: false, reason: "docker-no-answer", transient: true }
			: dockerCode === null
				? { answered: false, reason: "docker-not-found", transient: true }
				: null);
	checks.push(...backendChecks(env, { endpoint, daemon, fs: seams.observationFs }));
	checks.push(...jobUser.checks);
	if (facts) facts.jobUser = jobUser.forLive;

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
			checks.push({ ok: true, label: `gitlab triggers configured (${env.GITLAB_URL ?? "https://gitlab.com"})` });
			// The scope an operator cannot narrow. Said out loud because it is the one place GitLab is
			// weaker than the github App path and an operator should know which trade they made
			// (CONST-TOKEN-SCOPED-PER-JOB).
			checks.push({
				ok: true,
				warn: true,
				label: "a GitLab project access token needs the `api` scope to post notes, which grants full project API read/write",
				fix: "scope the token to ONE project and rotate it on a schedule -- GitLab offers no contents-vs-issues split, and no short-expiry equivalent of a GitHub App token",
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
			checks.push({ ok: true, label: `forgejo triggers configured (${env.FORGEJO_URL})` });
		}
	}

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
			checks.push({ ok: true, label: `azure triggers configured (${env.AZURE_ORG_URL})` });
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
	const ghSource = env.GITHUB_AUTH_SOURCE ?? "gh"; // config.mjs's own default, read directly — no loadConfig
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
	// boot refusal. WARN, never fail, same doctrine as the rest of the github block: a deployment can
	// legitimately be mid-setup. The private key gets a hygiene pass on top — presence, POSIX mode, and
	// a first-bytes PEM sniff — but its CONTENTS never reach output: only the leading bytes are read
	// (never the whole key into memory), and nothing from the file is ever echoed. Every fix line points
	// at `pi-dispatch setup github`, which mints all three values and writes the PEM 0600 in one pass.
	if (ghSource === "app") {
		const setupFix = "run `pi-dispatch setup github` -- it mints the App, writes these .env lines, and lands the key mode 0600";
		const numeric = (v) => typeof v === "string" && /^\d+$/.test(v.trim());
		for (const name of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID"]) {
			checks.push({
				ok: numeric(env[name]),
				warn: true,
				label: numeric(env[name])
					? `${name} set (${env[name].trim()})`
					: `GITHUB_AUTH_SOURCE=app but ${name} is ${env[name] ? `not numeric (${JSON.stringify(env[name])})` : "unset"} -- github jobs cannot mint tokens`,
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
		if (inlineKey !== "" && keyPath) {
			checks.push({
				ok: false,
				warn: true,
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
		} else if (!keyPath) {
			checks.push({ ok: false, warn: true, label: "GITHUB_AUTH_SOURCE=app but neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set -- the worker will refuse to boot", fix: setupFix });
		} else if (!fileExists(keyPath)) {
			checks.push({ ok: false, warn: true, label: `GITHUB_APP_PRIVATE_KEY_PATH does not exist (${keyPath})`, fix: setupFix });
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
	// are green; otherwise it is noise on top of the failures already reported above.
	if (dockerCode === 0 && imageCode === 0) {
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
				token = (env[patVar] ?? "").trim(); // absent → skip; loadConfig fails loud at worker boot anyway
			}
			if (token && endpoint.local !== true) {
				// NOT RUN on a daemon that is not observed on this host (#278). The probe hands the operator's own gh
				// token -- full scope and non-expiring by default -- to `docker run -e`, and on a redirected CLI that
				// token rides to another machine. A check must not do the thing the credentialTransit line warns
				// about. Only once there IS a token: app mode and an unset PAT never run the probe at all.
				checks.push({
					ok: false,
					warn: true,
					label: `in-image gh auth: not checked, because this shell's docker CLI ${endpoint.local === false ? `resolves ${endpointShown(endpoint)}, which is not shown to be on this host` : `did not say which daemon it uses (${endpoint.reason})`}, and the probe would send your gh token there`,
					fix: "point the docker CLI at this host and re-run doctor to check it",
				});
			} else if (token) {
				// Value-less `-e` flags: docker forwards GH_TOKEN/GITHUB_TOKEN from the spawn env, so the
				// token value never enters argv (visible in `ps`) and never reaches doctor's output.
				const probe = await runCmdCapture(
					spawn,
					"docker",
					["run", "--rm", "--pull=never", "-e", "GH_TOKEN", "-e", "GITHUB_TOKEN", "--entrypoint", "gh", jobImage, "auth", "status"],
					{ env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token } },
				);
				checks.push({
					ok: probe.code === 0,
					warn: true,
					label:
						probe.code === 0
							? `gh authenticates inside the job image (${jobImage})`
							: `gh cannot authenticate inside the job image (${jobImage})`,
					fix: "check network egress from containers or rebuild/pull the job image -- jobs that use gh will fail mid-run",
				});
			}
		}
	}

	checks.push({
		ok: await probeValkey(valkeyUrl),
		label: `Valkey reachable (${valkeyUrl})`,
		fix: "docker compose -f deploy/docker-compose.yml up -d",
		// Prompt tier, and only for a LOOPBACK url (the shipped default): starting a local container cannot
		// make a remote VALKEY_URL reachable, so a pointed-elsewhere deployment keeps the plain fix line
		// rather than an offer that would mask the real problem. The argv mirrors the compose file's
		// semantics exactly (VALKEY_RUN above).
		...(/^redis:\/\/(127\.0\.0\.1|localhost)(:6379)?\/?$/.test(valkeyUrl)
			? {
					fixAction: {
						tier: "prompt",
						describe: `docker ${VALKEY_RUN.join(" ")}`,
						run: async ({ spawn }) =>
							// The PULL bound: this `docker run` fetches the valkey image on a host that does not have it.
							(await runCmd(spawn, "docker", VALKEY_RUN, runTimeouts.pull)).code === 0
								? { ok: true }
								: { ok: false, note: "docker run failed (is a container named pi-dispatch-valkey already present? `docker start pi-dispatch-valkey`)" },
					},
				}
			: {}),
	});

	// --- the fleet (issue #57) -------------------------------------------------------------------------
	//
	// Every line here is gated on a peer actually existing, so a single-host deployment's output is
	// byte-identical. And every one is a WARN rather than a failure, with one exception noted below: this
	// command runs on ONE machine and must not refuse a deployment for a condition that machine cannot fix.
	// This host's own image id, read through the same seam every other docker probe here uses. Only when
	// the image is actually present -- an absent one is already reported above, and a second line saying
	// its digest is unknown would be noise on a fault the operator has been told about.
	const fleet = await readHosts(valkeyUrl);
	const peers = (fleet.hosts ?? []).filter((h) => h.name !== workerNameOf(env));
	// Read only when there is a peer to compare against. Every line below is gated on a peer existing, and
	// the SUBPROCESS has to be too: otherwise every `doctor` run on every single-host deployment spawns an
	// extra docker call whose answer nothing reads.
	const imageDigest =
		peers.length > 0 && imageCode === 0
			? (await runCmdCapture(spawn, "docker", ["image", "inspect", "--format={{.Id}}", jobImage], { stdoutOnly: true })).output.trim() || null
			: null;
	if (peers.length > 0) {
		const mine = workerNameOf(env);
		checks.push({ ok: true, label: `Fleet: ${peers.length + 1} worker${peers.length === 0 ? "" : "s"} (${[mine, ...peers.map((h) => h.name)].sort().join(", ")})` });

		// The one thing that is silently WRONG rather than merely undeclared. Without a declared name this
		// host enqueues its own folder work to the SHARED queue, where a peer that has no such folder can
		// pop it -- so the routing that makes a fleet safe is simply off, and nothing else says so.
		if (!env.PI_WORKER_NAME) {
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
	} else if (fleet.unreachable) {
		// Said, rather than silently absent: "no peers" and "could not ask" are different facts.
		checks.push({ ok: true, label: `Fleet: could not read the host registry (${fleet.unreachable})` });
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
	checks.push(providerKeyCheck({ provider, env, agentDir, oracle, nodeOk: checks[0]?.ok }));


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
	if (overlay) {
		const dirOk = fileExists(overlay);
		checks.push({ ok: dirOk, label: `Global overlay dir exists (${overlay})`, fix: "run `pi-dispatch import-pi`, or fix PI_GLOBAL_PI_DIR" });
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
			let modelsOk = true;
			let modelsFix = "";
			if (fileExists(modelsPath)) {
				try {
					const leak = findLiteralSecret(JSON.parse(readFileSync(modelsPath, "utf8")));
					if (leak) {
						modelsOk = false;
						modelsFix = `literal secret at ${leak} — move it to env/auth.json or a "$VAR" reference`;
					}
				} catch {
					modelsOk = false;
					modelsFix = "overlay models.json is not valid JSON";
				}
			}
			checks.push({ ok: modelsOk, label: "Overlay models.json is credential-free", fix: modelsFix });
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
						const res = await runCmdCapture(spawn, process.execPath, [cli, "import-pi", "--with-packages", "--no-host-packages", "--to", overlay], { env, cwd, timeoutMs: 600000 });
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
			const hostPi = await readHostPi({
				agentDir,
				fs: { existsSync: fileExists, readFileSync, readdirSync, statSync },
				// doctor's seam is `spawn`, host-pi's is an execFile-shaped call, so this adapts one to the
				// other rather than giving doctor a second process seam to inject in tests.
				exec: async (file, args) => {
					const res = await runCmdCapture(spawn, file, args, { env, cwd, timeoutMs: 15000 });
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
		// cannot disagree about what will run.
		const named = new Set(waitProfiles);
		for (const name of Object.keys(declaredWaits).sort()) {
			const path = declaredWaits[name];
			const st = statPath(path);
			const used = named.has(name);
			checks.push({
				ok: st.ok || !used,
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
			// when closed and a disclosure when open.
			const roots = (env.PI_SECRET_RESOLVER_ROOTS ?? "").split(delimiter).map((r) => r.trim()).filter(Boolean);
			checks.push({
				ok: true,
				...(roots.length === 0
					? { label: "PI_SECRET_RESOLVER_ROOTS is unset, so only PI_SECRET_PROFILES declares resolvers (the panel can declare none)" }
					: { warn: true, label: `PI_SECRET_RESOLVER_ROOTS admits panel-declared resolvers under: ${roots.join(", ")}`, fix: "keep those directories writable by nobody but the account the worker runs as: whoever can write a resolver there can run code as the worker" }),
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
		if (localSecretFolders.length > 0) {
			checks.push({
				ok: true,
				warn: true,
				label: `${localSecretFolders.length} local trigger(s) bind secrets and run IN the operator's own folder: ${localSecretFolders.join(", ")}`,
				fix: "a local job edits that folder in place, so a credential the agent writes to .env, .netrc or .git-credentials lands in your real repository (and survives in a retained sandbox for PI_SANDBOX_RETENTION_HOURS). Nothing scans for that: keep those folders out of anything you push",
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
			checks.push({
				ok: exists,
				label: `Session store ${exists ? "exists" : "does not exist"} (${sessionsDir})`,
				fix: `create it: mkdir -p ${sessionsDir} && chmod 700 ${sessionsDir}`,
				// Silent tier: setting PI_SESSIONS_DIR WAS the decision, and it has already been made -- the
				// mkdir is the mechanical remainder, creates only the path the env var names, and 0700 is
				// the mode the fix line already prescribes (transcripts are PII-bearing, host-only).
				fixAction: {
					tier: "silent",
					describe: `mkdir -p ${sessionsDir} && chmod 700 ${sessionsDir}`,
					run: async ({ mkdir, chmod }) => {
						mkdir(sessionsDir, { recursive: true });
						chmod(sessionsDir, 0o700);
						return { ok: true, note: "mode 0700" };
					},
				},
			});
			// Not a failure -- a warning, because it is a disclosure the operator may have accepted
			// knowingly. A transcript holds tool output, file contents and the agent's own reasoning, which
			// is strictly more than logs/<jobId>.log holds, and that one is opt-in for this reason.
			checks.push({
				ok: true,
				warn: true,
				label: `${resuming} trigger(s) persist agent transcripts to ${sessionsDir} -- PII-bearing, host-only, never committed`,
				fix: "confirm it is outside every git repo and on a disk you would put issue text on; PI_SESSIONS_TTL_DAYS, PI_SESSION_MAX_AGE_DAYS, PI_SESSION_MAX_RESUME_CHAIN and PI_SESSION_MAX_CONTEXT_PCT each bound a different thing about how much history one key accumulates (docs/sessions.md)",
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
				label: `Resume bounds: ${bounds.map(([name, value, fallback]) => `${name}=${value === undefined || value === "" ? fallback : value}`).join(", ")}`,
			});
			// The one bound that can be set and still do nothing, and the operator cannot see it from here.
			// Its measurement is reported by the JOB IMAGE's runner (INT-RUNNER-EXIT-CODE-PROTOCOL), so an
			// image older than that field reports none, the gate passes on no measurement by design, and the
			// bound is inert with nothing anywhere saying so. There is deliberately no image capability to
			// check against -- capabilities are an inclusion list for what the host DEMANDS of an image, and
			// telemetry is not that -- so this warning is the whole detection surface, which is exactly why
			// it exists rather than being left to a doc.
			if (env.PI_SESSION_MAX_CONTEXT_PCT) {
				checks.push({
					ok: true,
					warn: true,
					label: `PI_SESSION_MAX_CONTEXT_PCT=${env.PI_SESSION_MAX_CONTEXT_PCT} needs a job image whose runner reports context usage`,
					fix: `an older image reports none, and a bound with no measurement passes rather than guessing, so on such an image this bound does nothing at all. On an image that does report one the reading is kept whether or not the bound is set, so it applies from the next job. Each run's own record (${env.PI_LOGS_DIR || "the logs directory"}/<jobId>.json) carries session.reason, which names the gate that refused`,
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

	// REQ-REPLICA-RUNS. A warning, never a failure -- replicas are an opt-in an operator chose in a reviewed
	// file, and the harness is doing exactly what was asked. What is worth saying is the arithmetic: each
	// replica reserves its OWN budget slot before its own tokens (CONST-BUDGET-BEFORE-TOKENS), so a delivery
	// on a `replicas: 2` trigger consumes two, and the daily cap divides accordingly. Only reported when a
	// trigger actually asked for it.
	if (replicating > 0) {
		checks.push({
			ok: true,
			warn: true,
			// Both facts live in the LABEL rather than the fix, because an `ok: true` check never prints its
			// fix line (the loop below) -- and the concurrency half is the one an operator most often has
			// wrong: replicas above PI_CONCURRENCY queue instead of racing, which looks like the feature
			// silently not working.
			label: `${replicating} trigger(s) set run.replicas -- one delivery reserves one budget slot PER replica; PI_CONCURRENCY bounds how many actually race`,
			fix: "confirm the daily/weekly/monthly caps account for the multiplier, and that PI_CONCURRENCY is at least the largest run.replicas",
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
		checks.push({
			ok: true,
			warn: env.PI_TRIGGERS_FILE === undefined,
			label: `${onceArmed} one-shot trigger(s) armed (on.once) -- the worker disarms the entry in ${env.PI_TRIGGERS_FILE === undefined ? "./triggers.json resolved against the worker service's working directory; set PI_TRIGGERS_FILE so worker and receiver name the same file from anywhere" : "PI_TRIGGERS_FILE"} after the run record exists`,
			fix: "set PI_TRIGGERS_FILE to an absolute path in both services' environments",
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
	const envFile = envFileKeys(join(cwd, ".env"), ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"], { fileExists, readEnvFile, platform });
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
	const seamsForLoad = { statFile: statSeam, loaderIo: { existsSync: (p) => fileExists(p), readFileSync: readEnvFile ? (p) => readEnvFile(p) : readFileSync } };
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
	if (envFile.hazard != null) {
		const named = BOOT_FILES.map((spec) => spec.key).join(" or ");
		checks.push({
			ok: false,
			warn: true,
			label: `whether ${named} reaches the service cannot be read off ${join(cwd, ".env")}: line ${envFile.hazard.line} is not one this command can read`,
			fix: `fix line ${envFile.hazard.line} of that file and run doctor again -- a line that is not an assignment is RUN by the wrappers that source this file, an unclosed quote or a trailing backslash makes the line below it part of that value, and a value that can run a command or end the shell leaves every key in the file unset. Other keys in the same file are affected too and are not checked here: this command reads only the two it names`,
		});
	}

	for (const spec of BOOT_FILES) {
		const scaffolded = join(cwd, spec.scaffold);
		const shellRaw = spec.resolve(env);
		const fileRaw = envFile[spec.key];
		const notPlainLine = envFile.notPlain?.[spec.key];
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
		// `!== ""`, not `.trim() !== ""`, because `worker-env-wrapper.sh` tests `[ -n "$env_setup" ]` and then
		// `[ ! -f "$env_setup" ]`: a value of three spaces is CONFIGURED to the wrapper, which then refuses to
		// start on the missing file. Reading it as unset here left that deployment with no line anywhere.
		const envSetupRaw = typeof env.PI_ENV_SETUP === "string" && env.PI_ENV_SETUP !== "" ? env.PI_ENV_SETUP : null;
		// AND ONLY WHEN IT COULD RUN. A script doctor has already reported as missing cannot replace anything,
		// so downgrading on it produced two contradicting lines in one run: one saying the unit restart-loops
		// until the script is back, the next saying a blank key is only a warning because that same script may
		// replace it.
		const envSetup = envSetupRaw !== null && fileExists(envSetupRaw) ? envSetupRaw : null;

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
				label: `${spec.key} is assigned an EMPTY value in ${join(cwd, ".env")}, which is not unset: ${loaderName} keeps it, the worker tries to load "" and REFUSES TO START${alsoExported === undefined ? "" : `, while ${otherName} would take ${envValueShown(alsoExported)}, so two deployments of this one file disagree`}`,
				fix: envSetup !== null
					? `${envSetup} runs after that file and may replace it, which is why this is a warning: if it does not, delete the ${spec.key} line, or give it the absolute path (${scaffolded})`
					: `delete the ${spec.key} line from that .env, or give it a path: ${fixLineFor(spec.key, scaffolded)}. Deleting it turns ${spec.noun} off; an empty value turns the worker off`,
			});
		} else if (envFile.hazard == null && notPlainLine !== undefined) {
			// NAMED, NEVER QUOTED. The value is outside the grammar every loader reads the same way, so this
			// file cannot say what the service gets -- and printing a guess is what the previous reader did.
			checks.push({
				ok: false,
				warn: true,
				label: `${spec.key} on line ${notPlainLine} of ${join(cwd, ".env")} is not in the form every loader reads the same way, so the service may read something other than what the line appears to say`,
				fix: `rewrite it as ${fixLineFor(spec.key, scaffolded)} with any comment on its own line above it, which is the form \`pi-dispatch up\` writes`,
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
				label: `${spec.key} is assigned TWICE in ${join(cwd, ".env")} with different values: ${loaderName} takes ${envValueShown(fileRaw)}, ${otherName} would take ${alsoExported === "" ? "an EMPTY value, which refuses the boot" : envValueShown(alsoExported)}`,
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
							label: `${spec.key} is set in ${join(cwd, ".env")} (${envValueShown(fileRaw)}) to a file the worker cannot load, so a service started from it REFUSES TO START: ${verdict.reason}`,
							fix: envSetup !== null ? `${envSetup} runs after that file and may replace it; if it does not, fix ${envValueShown(fileRaw)} or point the key at a file that loads` : `fix ${envValueShown(fileRaw)}, or point ${spec.key} at a file that loads`,
						},
			);
		}

		// THE SHELL, judged on what a foreground `pi-dispatch worker` started from here would get.
		if (typeof shellRaw === "string" && shellRaw.trim() === "") {
			checks.push({
				ok: false,
				label: `${spec.key} is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and REFUSES TO START`,
				fix: `unset ${spec.key} in this shell (that turns ${spec.noun} off), or give it the absolute path: export ${fixLineFor(spec.key, scaffolded)}`,
			});
		} else if (typeof shellRaw === "string") {
			const verdict = loadVerdict(spec, shellRaw, cwd, seamsForLoad, platform);
			if (!verdict.ok) {
				checks.push({
					ok: false,
					label: `${spec.key} is set in this shell to a file the worker cannot load, so it REFUSES TO START: ${verdict.reason}`,
					fix: `fix ${envValueShown(shellRaw)}, or point ${spec.key} at a file that loads`,
				});
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
				fix: `set ${fixLineFor(spec.key, scaffolded)} in .env and restart the worker -- unset means ${spec.unsetMeans}, while the admin panel defaults to this same file and reports each ${spec.unit} it writes as applied live; delete the file if this deployment has no ${spec.nothing}`,
			});
		}
	}

	// The dead-scope advisory (issue #242), honest about what doctor can actually judge. A forge repo
	// always contains "/" and never begins "/", "./" or "../" or carries a backslash, so a scope in any
	// of THOSE shapes can only ever be a folder -- and a folder row that matches no trigger's canonical
	// run.folder guards nothing. Rows that COULD be a repo (an "a/b" shape) stay silent, not caveated:
	// webhook jobs carry their repo in the delivery, which triggers.json cannot enumerate, so a line on
	// every legitimate repo cap would be standing noise that teaches skimming (`repositories` is empty
	// for every valid file today -- run.repository is azure-only, its own fact says so). Guarded on the
	// TRIGGERS facts being readable too: a zeroed `folders` from an absent or unparseable triggers file
	// has no honest claim to make (readTriggerFacts' own rule). ok:true -- the replica advisory's tier,
	// and like it, everything the operator needs lives in the LABEL: an ok:true check never prints its
	// fix line.
	if (scopedLimitFacts.parseError === null && scopedLimitFacts.limits.length > 0 && parseError === null && triggersFilePath !== null) {
		const folderSet = new Set(folders);
		const folderOnly = (s) => s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.includes("\\") || !s.includes("/") || /^[A-Za-z]:/.test(s);
		const dead = scopedLimitFacts.limits.map((l) => l.scope).filter((s) => folderOnly(s) && !folderSet.has(s));
		if (dead.length > 0) {
			checks.push({
				ok: true,
				warn: true,
				label: `${dead.length} scoped limit(s) name a folder no trigger runs in (${dead.join(", ")}) -- the cap guards nothing; scopes match exactly (no globs, folders by resolved ABSOLUTE path), so check the spelling against triggers.json run.folder or delete the entry`,
				fix: `edit ${scopedLimitFacts.path} by hand or via dispatch_limit_edit/_delete -- repo-shaped scopes are never flagged here, because a webhook job's repo comes from the delivery, which triggers.json cannot enumerate`,
			});
		}
	}

	// REQ-RESURRECTABLE-SANDBOX. A warning, never a failure: retention is a convenience, and the only thing
	// worth surfacing is that finished runs' directories -- a repository clone plus the run's prompt.md and
	// event.json, so issue text -- are sitting on disk, and how many. An operator who never opens a sandbox
	// should still know they are being kept.
	{
		const retentionHours = nonNegativeEnvInt(env.PI_SANDBOX_RETENTION_HOURS, 24);
		const sandboxDir = env.PI_SANDBOX_DIR || defaultSandboxDir(env);
		if (retentionHours === 0) {
			checks.push({ ok: true, label: "Workspace retention off (PI_SANDBOX_RETENTION_HOURS=0) — finished runs are deleted, none are re-openable" });
		} else {
			const kept = countRetained(sandboxDir, fileExists);
			checks.push({
				ok: true,
				warn: kept.count > 0,
				label: `${kept.count} retained workspace(s) in ${sandboxDir}, swept after ${retentionHours}h — re-open one with \`pi-dispatch sandbox <jobId>\``,
				fix: "each holds the run's clone plus its prompt.md/event.json (issue text); PI_SANDBOX_RETENTION_HOURS=0 turns retention off entirely",
			});
		}
	}

	// issue #290. The two DURABLE stores -- the run history everything folds over, and the overlay holding
	// every cap the operator tuned from the panel -- used to default under the OS temp dir, which macOS
	// sweeps on its own schedule and which is tmpfs (RAM) on several Linux distros. They now default under
	// ~/.pi-dispatch, so this block is normally one green line; it warns only when a path RESOLVES under a
	// temp dir, which after the move means an operator put it there.
	//
	// Deliberately NOT checked: PI_JOBS_DIR, PI_SANDBOX_DIR and PI_GRAPH_DIR. Those are per-run,
	// retention-bounded and regenerable respectively, and they stay under temp on purpose. Warning about a
	// directory that is SUPPOSED to be swept is how an operator learns to skim this section, which costs
	// more than it buys.
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

	return checks;
}

/**
 * How many retained workspaces are sitting in the retention root.
 *
 * Reads its OWN env rather than loadConfig, like every other doctor check (`doctor.mjs` header): a broken
 * GitHub auth must not stop the operator finding out how much disk this is using. Never throws -- an
 * unreadable or absent root reports zero, which is the honest answer to "how many can I open".
 */
function countRetained(sandboxDir, fileExists) {
	if (!fileExists(sandboxDir)) return { count: 0 };
	try {
		return { count: readdirSync(sandboxDir).length };
	} catch {
		return { count: 0 };
	}
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
function providerKeyCheck({ provider, env, agentDir, oracle, nodeOk }) {
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
	if (candidates.length === 0) return noKeyVariableCheck(provider, oracle);

	// Presence by PI'S truthiness, not a stricter one. This used to trim, and trimming made doctor pick a
	// DIFFERENT variable than the worker will: with a whitespace `ANTHROPIC_OAUTH_TOKEN` beside a real
	// `ANTHROPIC_API_KEY`, a trimming filter drops the token and reports the API key green, while pi reads
	// the token (non-empty to it), wins precedence with it, and fails auth on every job. Whitespace is
	// still refused -- one step further down, against the variable pi actually reads, where it is a fact
	// about THAT credential rather than a reason to pretend the variable is unset.
	const set = candidates.filter((name) => (env[name] ?? "") !== "");
	// The variable to TELL an operator to set is never the OAuth token, and it is the SAME choice the
	// worker makes when it writes an `auth.json` key into a container (issue #311). One function, one
	// module, so a doctor line cannot name a variable the job path does not use.
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
		if (!OAUTH_KEY_RE.test(using)) return { ok: true, label: `Provider key set (${provider}: ${using})` };
		// Warn, not fail, and the choice is deliberate: the worker forwards this variable and the job WILL
		// run, so failing here would put doctor in disagreement with the worker -- the exact disease this
		// issue is about. What doctor must stop doing is what it did before: pass in silence, as though a
		// subscription login were a service credential.
		const shadowed = set[1] ?? null;
		return {
			ok: false,
			warn: true,
			label: `Provider key set (${provider}: ${using}) -- an OAuth/subscription login, not an API key`,
			fix: shadowed
				? `unset ${using}: pi reads it BEFORE ${shadowed}, so every job spends the subscription login and your API key is ignored`
				: `set ${apiKeyVar} instead -- an OAuth/subscription token expires, the container cannot refresh it, and it is not the credential for an unattended service`,
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
	};
}

/**
 * pi reads no API-key variable for this id, and the two reasons need different fixes -- which is exactly
 * the distinction `findEnvKeys`'s single `undefined` cannot make, and the reason issue #286 needed a
 * second question at all.
 */
function noKeyVariableCheck(provider, oracle) {
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
	const wanted = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
	const owner = oracle.piProviders().find((id) => oracle.providerKeyCandidates(id).includes(wanted));
	return {
		ok: false,
		label: `PI_PROVIDER is ${JSON.stringify(provider)}, which is not a provider pi has`,
		fix: owner
			? `set PI_PROVIDER=${owner}, the provider pi reads ${wanted} from -- or unset it for the default \`anthropic\``
			: `set PI_PROVIDER to a provider id pi has, or unset it for the default \`anthropic\`: ${oracle.piProviders().join(", ")}`,
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

function readTriggerFacts(env, fileExists, cwd) {
	const none = { requiring: 0, waiting: 0, waitProfiles: [], waitAfters: [], optingOut: 0, resuming: 0, replicating: 0, instructing: 0, commands: 0, secreting: 0, onceArmed: 0, onceSpent: 0, secretProfiles: [], localSecretFolders: [], secretNames: [], folders: [], images: [], skillsDirs: [], forges: [], repositories: [], flows: [], parseError: null, path: null };
	try {
		// Unset falls back to ./triggers.json in cwd, MIRRORING the receiver's own default
		// (receiver/src/config.mjs) -- the two must read the same file, or doctor preflights a deployment
		// the receiver will not boot. An absent file still means "no triggers at all", exactly as before.
		const path = env.PI_TRIGGERS_FILE ?? join(cwd, "triggers.json");
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
					label: t.on.type === "cron" ? `cron "${t.on.id}"` : `${t.on.type} trigger #${index}`,
					flow: t.run.flow,
					kind: t.run.kind,
					folder: typeof t.run.folder === "string" ? t.run.folder : null,
					skillsDir: typeof t.run.skillsDir === "string" ? t.run.skillsDir : null,
					packages: t.run.packages !== false,
				}))
				.filter((f) => typeof f.flow === "string"),
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

/** The triggers path doctor would have read, so a parse failure can name it. */
function triggersPath(env, cwd) {
	return env.PI_TRIGGERS_FILE ?? join(cwd, "triggers.json");
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
		label: ({ prefix }) => `leftovers from an EARLIER doctor run could not be listed: docker network ls --filter name=${prefix}`,
	},
	foreign: {
		tier: "warn",
		fix: () => CANARY_FOREIGN_FIX,
		label: ({ name, cliSays }) => `${name} may be left over from an EARLIER doctor run, and is not swept because this shell's docker CLI ${cliSays}, so a pid that is dead here may be alive there`,
	},
	unreadable: {
		tier: "warn",
		fix: () => CANARY_LEFTOVER_FIX,
		label: ({ name }) => `the network ${name} could not be read: docker network inspect ${name}`,
	},
	kept: {
		tier: "warn",
		fix: () => CANARY_LEFTOVER_FIX,
		label: ({ name, stuck }) => `${name} is kept, because the probe ${stuck.join(", ")} could not be removed and the network is the only way left to find it: docker rm -f ${stuck.join(" ")}`,
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
});

/**
 * One canary check, built from the table and CARRYING what it was built from.
 *
 * `canary: { shape, params }` is the seam the tests use: they drive the real sweep over the real scenarios
 * and compare every `Egress canary:` line to `CANARY_LINES[shape].label(params)`, so a line that drifts from
 * the table is caught by construction rather than by a regex over prose.
 */
function canaryCheck(shape, params) {
	const spec = CANARY_LINES[shape];
	const fix = spec.fix();
	return { ok: spec.tier === "ok", ...(spec.tier === "warn" ? { warn: true } : {}), label: `Egress canary: ${spec.label(params)}`, ...(fix ? { fix } : {}), canary: { shape, params } };
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
 */
async function sweepStaleCanaryNetworks({ docker, pid, isAlive, endpoint }) {
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
	const listed = await docker(["network", "ls", "--filter", `name=${EGRESS_CANARY_NET_PREFIX}`, "--format", "{{.Name}}"]);
	// THE LISTING ALWAYS RUNS, on any daemon. The reason the sweep is confined to a daemon this host owns is
	// `isAlive`, whose answer is about THIS process table -- reading a list is not. Asking first is what lets
	// this say nothing at all on the overwhelmingly common case of a host with no leftovers, instead of a
	// warning about a category of object it never looked for. `doctor`'s own doctrine: a check nobody can
	// silence must never cry wolf, and "could not ask" is not "misconfigured".
	if (listed?.code !== 0) return [canaryCheck("unlisted", { prefix: EGRESS_CANARY_NET_PREFIX })];
	const shape = new RegExp(`^${EGRESS_CANARY_NET_PREFIX}(\\d+)$`);
	// The slug is a CLOSED set, not free text: accepting `\\S+` there would `rm -f` any container under this
	// prefix that happened to end in the dead pid. Escaped into the pattern because the pid reached it as a
	// string from a name we matched, and a name is not a number. The set is read from CANARY_PROBE_SLUGS,
	// which the probe loop names its own containers from: two literals in two places is how a third direction
	// gets added to the producer and not to the reaper.
	//
	// ASYMMETRY ON PURPOSE, recorded because it looks like an oversight three characters apart: the OWNER is
	// escaped and the slugs are interpolated raw. `CANARY_PROBE_SLUGS` is a frozen literal of two plain words
	// three lines below, so today there is nothing to escape and escaping it would say the set is untrusted
	// when it is this file's own. It is here so that whoever adds a slug with a `.` or a `-` in it sees the
	// obligation: a metacharacter there widens what this `rm -f` matches (issue #360, item 6).
	const probeOf = (owner) => new RegExp(`^${EGRESS_CANARY_PROBE_PREFIX}(?:${CANARY_PROBE_SLUGS.join("|")})-${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
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
			checks.push(canaryCheck("foreign", { name, cliSays }));
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
		const { ok, names, absent } = await networkEndpoints(docker, name);
		if (absent) continue;
		if (!ok) {
			// The command that FAILED, which is this file's convention for a label, and it was the wrong one
			// here: a `network rm` is advice, it never ran, and it is advice about a network whose membership
			// is by definition unknown -- removing it could strand a probe nothing else can find. The advice
			// stays in the fix, where advice belongs.
			checks.push(canaryCheck("unreadable", { name }));
			continue;
		}
		// The dead run's own probes are REMOVED, everything else is merely detached -- the proxy is shared and
		// long-lived, and a stranger on a network in this namespace is not ours to delete.
		// RESIDUAL, same as `live-probes.mjs`'s and measured under #337: `names` holds RUNNING endpoints, so a
		// probe in `created` state is missing from it and the removal below would succeed and strand it. Not
		// guarded, and the reason is the line above: only a DEAD pid's network is touched here, and a dead
		// process is not mid-launch.
		// Recorded only when it TOOK, the same rule `removeNetworkOrSay` applies to `detached` -- a ✓ claiming a
		// probe was removed while it is still running is worse than no line. One that did NOT go stays in the
		// detach list, so it is at least taken off the network rather than falling between the two.
		const removed = [];
		const stuck = [];
		for (const endpoint of names.filter((n) => probeOf(ownerText).test(n))) {
			if ((await docker(["rm", "-f", endpoint]))?.code === 0) removed.push(endpoint);
			else stuck.push(endpoint);
		}
		// THE NETWORK IS THE ONLY HANDLE. Nothing in this project ever enumerates `pi-dispatch-egress-probe-`
		// containers -- the name exists to be built and matched, not searched for -- so removing the network
		// out from under a probe we could not kill orphans that container permanently, and an earlier draft
		// did exactly that behind a ✓. Detaching it first is no better: it is still running, and now nothing
		// points at it. So the network stays, and the line names the container to remove by hand.
		if (stuck.length > 0) {
			checks.push(canaryCheck("kept", { name, stuck }));
			continue;
		}
		const outcome = await removeNetworkOrSay(docker, { network: name, detach: names.filter((n) => !removed.includes(n)) });
		// `" and "` between the two clauses, for the reason given at the vanished-network line below: each half
		// is itself a comma-separated list, so a comma between them marks no boundary. This is the COMMON
		// line, and it kept the defect for a round after its rarer sibling was fixed.
		const after = [removed.length > 0 ? `after removing ${removed.join(", ")}` : null, outcome.detached.length > 0 ? `detaching ${outcome.detached.join(", ")}` : null].filter(Boolean).join(" and ");
		// "an EARLIER run", not "a run that did not finish", which both of these lines used to say and neither
		// could support: a doctor run that finishes normally leaves this network behind whenever its own
		// teardown `network rm` fails, and says so in a warning of its own, and issue #360 item 5 records a
		// second producer (a `network create` killed by a signal after the daemon had already made it). The
		// only thing the sweep knows is that the pid in the name is not alive now.
		if (outcome.removed && !outcome.absent) checks.push(canaryCheck("removed", { name, after }));
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
			if (did) checks.push(canaryCheck("gone", { name, did }));
		} else checks.push(canaryCheck("notRemoved", { name, command: outcome.command }));
	}
	return checks;
}

/** The canary's two probe directions. ONE list: the loop names its containers from it and the sweep matches on it. */
export const CANARY_PROBE_SLUGS = Object.freeze(["provider", "unlisted"]);

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
	const { spawn, pid = process.pid, isAlive = defaultIsAlive } = seams;
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
	const canaryDocker = (args) => liveRunVia(spawn)(args, { timeoutMs: CANARY_STEP_TIMEOUT_MS });
	checks.push(...(await sweepStaleCanaryNetworks({ docker: canaryDocker, pid, isAlive, endpoint })));

	// `docker inspect` on the container, not `ps`: it answers present-vs-absent and running-vs-stopped in
	// one call, and those are two different fixes. The FIELD_SEP habit is image-preflight.mjs's -- neither
	// a boolean nor a health word can contain "|".
	const state = await runCmdCapture(spawn, "docker", ["inspect", `--format={{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}`, proxy], { stdoutOnly: true });
	const [running, health] = state.code === 0 ? state.output.trim().split("|") : [];
	const up = running === "true";
	checks.push({
		ok: up,
		label: up ? `Egress proxy running (${proxy})` : state.code === 0 ? `Egress proxy is stopped (${proxy})` : `Egress proxy is not on this host (${proxy})`,
		fix: "docker compose -f deploy/docker-compose.yml --profile egress up -d  -- the egress policy refuses every job pre-spend while this is down, which costs no budget but runs nothing (PI_EGRESS=0 opts out)",
		// Not rendered: `--live`'s peer probe (issue #344) needs the proxy's name and whether it is up, and reads them here
		// rather than asking docker a second time.
		proxyState: { proxy, running: up },
	});
	if (!up) return checks;

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
	// inspecting it. Two containers, on a throwaway network built exactly like a job's, gated on the image
	// being present because it uses the job image's own node -- which is the point: it proves the operator's
	// OWN image honours NODE_USE_ENV_PROXY, the property a stale image would silently lack and the one
	// whose absence turns the whole policy into an outage.
	//
	// Credential-free by construction: `api.anthropic.com` answers 401 to an unauthenticated request, so
	// reaching the provider and being refused for the key proves the entire path and costs nothing. That is
	// docs/egress.md's own method, promoted from prose to a check.
	if (imageCode !== 0) return checks;
	const net = egressCanaryNetwork(pid);
	// A runner that captures BOTH streams and is bounded: `runCmd` answers with an exit code only and `stdio:
	// "ignore"`, so the "network is not there" rule -- whose wording the daemon puts on stderr with stdout
	// empty when `--format` is passed -- could not read it. `liveRunVia` is already exactly this shape in this
	// file; a fourth runner would be a fourth place for the bound to be wrong.
	const docker = (args) => liveRunVia(spawn)(args, { timeoutMs: CANARY_STEP_TIMEOUT_MS });
	// Probe containers this run may have left BEHIND its CLI, see the `code === null` branch below.
	const unfinished = [];
	let created = false;
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
			checks.push({ ok: false, warn: true, label: `Egress policy: not proved, because the canary network ${net} could not be created${create.code === null && create.ended !== "error" ? " and the create did not finish, so it may exist" : ""}`, fix: CANARY_UNPROVED_FIX });
			return checks;
		}
		if ((await docker(["network", "connect", net, proxy])).code !== 0) {
			checks.push({ ok: false, warn: true, label: `Egress policy: not proved, because ${proxy} could not be attached to the canary network`, fix: CANARY_UNPROVED_FIX });
			return checks;
		}
		// The unlisted host must be one that RESOLVES and answers. The first version used a reserved `.example` name,
		// which no proxy can reach, so a proxy allowing every host still read as denying this one (measured: an
		// allow-all squid answered 503 for it and let `example.com` through). `example.com` is reserved for documentation
		// (RFC 2606), answers everywhere, and is contacted only when the proxy lets the request out, which is the finding.
		for (const [slug, host, url, want] of [
			[CANARY_PROBE_SLUGS[0], "the provider", "https://api.anthropic.com/v1/messages", true],
			[CANARY_PROBE_SLUGS[1], "an unlisted host", "https://example.com/", false],
		]) {
			const probe = await runCmdCapture(spawn, "docker", [
				"run",
				"--rm",
				// Named, and outside the boot reaper's `pi-job-` filter by construction. `--rm` disposes of it,
				// so the name exists for the operator watching `docker ps` during a doctor run and for the one
				// reading `ps` afterwards to find out what a wedged probe was doing.
				"--name",
				// The PID too, so two doctor runs at once do not collide on a name and read the loser's exit 125 as a deny.
				egressCanaryProbe(slug, pid),
				"--pull=never",
				`--network=${net}`,
				"-e",
				`HTTPS_PROXY=http://${proxy}:3128`,
				"-e",
				"NODE_USE_ENV_PROXY=1",
				"--entrypoint",
				"node",
				jobImage,
				"-e",
				// The URL rides ARGV, not the spawn env, and the difference from the in-image `gh` probe is
				// deliberate: that one carries a TOKEN, which must never be visible in `ps`. This carries a
				// public hostname, so argv is the honest place for it -- an operator reading `ps` during a
				// doctor run can see exactly which host is being probed.
				`fetch(${JSON.stringify(url)},{method:"POST"}).then(r=>{console.log("reached",r.status);process.exit(0)},e=>{console.log("blocked",e.cause?.code??e.message);process.exit(3)})`,
			]);
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
			if (probe.code === null && probe.ended !== "error") unfinished.push(egressCanaryProbe(slug, pid));
			if (probe.code !== 0 && probe.code !== 3) {
				checks.push({
					ok: false,
					warn: true,
					label: `Egress policy probe for ${host} did not run (${probe.code === null ? "docker run did not finish" : `docker run exited ${probe.code}`})`,
					fix: "re-run doctor; if it persists, run the job image by hand to see why a container on this network will not start",
					readBack: { property: "egress", want, reached: null },
				});
				continue;
			}
			const reached = probe.code === 0;
			checks.push({
				ok: reached === want,
				warn: true,
				// NOT rendered: what `doctor --live` folds into its egress read-back (live-probes.mjs), so the canary is
				// run once and read twice rather than a second canary built beside it.
				readBack: { property: "egress", want, reached },
				label: reached === want
					? want
						? `Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)`
						: `Egress policy denies ${host} (the deny direction is the half an allowlist can silently lose)`
					: want
						? `Egress policy does NOT reach the provider (api.anthropic.com)`
						: `Egress policy ALLOWS ${host} that is not on your allowlist`,
				fix: want
					? `add api.anthropic.com to egress-allowlist.conf and restart the proxy -- until then every job starts, fails at its first turn, and spends two budget slots proving it (docs/egress.md)`
					: `check egress-allowlist.conf: a rule wider than you meant (a bare domain where you wanted a subdomain) lets a job reach hosts you did not list`,
			});
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
		for (const name of unfinished) if ((await docker(["rm", "-f", name])).code !== 0) stuck.push(name);
		// AND THE NETWORK IS THEN KEPT, because that is what the line says. Reusing the sweep's wording while
		// removing the network anyway printed "the network is the only way left to find it" and then removed
		// it in the same run -- both halves of the sentence false, and the page's own row for this shape says
		// removing it would orphan that container permanently. The sweep `continue`s here for exactly this
		// reason; the teardown now does the same.
		if (stuck.length > 0) {
			checks.push(canaryCheck("kept", { name: net, stuck }));
			return checks;
		}
		if (created) {
			const outcome = await removeNetworkOrSay(docker, { network: net, detach: [proxy] });
			// The COMMAND lives in the label and the generic advice in the fix, which is the shape `--live`'s own
			// leftover notes already use: `render` prints a fix line only when a check is not ok, and an ok check
			// never prints one at all.
			if (!outcome.removed) checks.push(canaryCheck("notRemoved", { name: net, command: outcome.command }));
		}
	}
	return checks;
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
async function envSetupChecks(env, seams) {
	const { cwd, spawn, fileExists, platform, home, runTimeouts = RUN_TIMEOUTS } = seams;
	const sources = new Map(); // setup path -> how doctor learned it; the first source to name it wins

	if (platform === "win32") {
		for (const which of ["worker", "receiver"]) {
			const service = `pi-dispatch-${which}`;
			const got = await runCmdCapture(spawn, "nssm", ["get", service, "AppEnvironmentExtra"]);
			// Not installed, or nssm not on PATH: silence. Same doctrine as check-ignore below -- a check
			// nobody can silence must never cry wolf, and "could not ask" is not "misconfigured".
			if (got.code !== 0) continue;
			// No deployment match here: nssm keeps the folder in a SEPARATE AppDirectory property, and there
			// is exactly one machine-scoped service per name for it to be confused with.
			const { setup } = readUnitSeam(got.output, "win32");
			if (setup && !sources.has(setup)) sources.set(setup, `${service}'s AppEnvironmentExtra`);
		}
	} else {
		for (const { path } of installedUnitPaths(platform, home)) {
			if (!fileExists(path)) continue;
			let seam;
			try {
				seam = readUnitSeam(readFileSync(path, "utf8"), platform);
			} catch {
				continue; // a system-scope unit this user may not read: which deployment it serves is unknowable
			}
			if (!seam.setup || seam.deployDir !== cwd) continue;
			if (!sources.has(seam.setup)) sources.set(seam.setup, path);
		}
	}

	// env-internal PI_ENV_SETUP: unit configuration, deliberately never an .env key. The wrappers capture
	// it BEFORE they source ./.env so that nothing able to write that file can name a script they run
	// (REQ-DEPLOYMENT-BOOTSTRAP). doctor reads it here only to answer for a host whose unit names none.
	// NOT trimmed, because `worker-env-wrapper.sh` does not trim: it tests `[ -n "$env_setup" ]` and then
	// `[ ! -f "$env_setup" ]`, so `PI_ENV_SETUP="   "` is a CONFIGURED script that does not exist and the
	// wrapper refuses to start on it. Trimming here read that as unset, so the one deployment shape where
	// the worker cannot boot got no line anywhere in the report (issue #384).
	const fromEnv = env.PI_ENV_SETUP ?? "";
	if (sources.size === 0 && fromEnv !== "") sources.set(fromEnv, "PI_ENV_SETUP in this environment");

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
	const { timeoutMs = 30000, stdoutOnly = false } = opts;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
		} catch {
			resolve({ code: null, output: "" });
			return;
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
/** This host's name as the worker computes it, so doctor and the worker cannot disagree about who "I" am. */
function workerNameOf(env) {
	return env.PI_WORKER_NAME || defaultWorkerName();
}

async function defaultReadHosts(url) {
	try {
		const { Redis } = await import("ioredis");
		const { parseConnection } = await import("./connection.mjs");
		const { readLiveHosts } = await import("./host-registry.mjs");
		const client = new Redis({ ...parseConnection(url, { failFast: true }), lazyConnect: true });
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

async function defaultProbeValkey(url) {
	const { Redis } = await import("ioredis");
	const { parseConnection } = await import("./connection.mjs");
	const client = new Redis({ ...parseConnection(url, { failFast: true }), lazyConnect: true });
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
export function backendChecks(env, { endpoint = null, daemon = null, fs = { statSync, readFileSync, readdirSync } } = {}) {
	const checks = [];
	// What this shell's docker CLI resolves (#278), and what its daemon and this host's files say about bounds and mounts
	// (#345), as the observation map the table's `observedBy` reads. Anything doctor was not given is not observed, which
	// gets no credit -- the same polarity as everywhere.
	const observed = observeHost({ endpoint, daemon, fs });
	const observations = { ...observed.observations, [DOCKER_ENDPOINT_LOCAL]: endpoint?.local === true };
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
			// Not said when no daemon read happened at all, or there is no docker binary (the daemon line above already failed): a
			// floor still refuses on it below.
			if (d.observedBy && d.observedBy !== DOCKER_ENDPOINT_LOCAL && observations[d.observedBy] !== true && daemon !== null && daemon.reason !== "docker-not-found") {
				// #345: the word holds only while this daemon, or this host's runtime configuration, is observed providing it.
				// Printed as what it degrades to, with what was seen, and the worker's own boot line named.
				const unread = observations[d.observedBy] !== false;
				const bounds = d.observedBy === DAEMON_APPLIES_BOUNDS;
				checks.push({
					ok: false,
					warn: true,
					label: `${name}: ${property} is ASSERTED by ${bounds ? "the daemon" : "the container runtime's configuration"}, not enforced: ${observed.evidence[d.observedBy] ?? "not observed"}`,
					fix: unread
						? `nothing shows whether ${OBSERVATIONS[d.observedBy]}; fix what stops the daemon answering, then re-run doctor. The worker logs its own answer at boot (worker_started.${d.observedBy})`
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
	const { spawn, cwd, home, fileExists, jobUserIdentity: ids = {}, stat, passwd, readUnit = (path) => readFileSync(path, "utf8") } = seams;
	if (dockerCode !== 0) return { checks: [], forLive: { run: true, user: null }, daemon: null };
	const platform = ids.platform ?? seams.platform;
	// The worker's bound, not the endpoint read's 5 s: `docker info` is the slow read on a busy host, and a doctor that
	// gave up sooner would call undecidable a host the worker decides.
	const readFacts = makeDaemonFactsReader({ run: dockerRunVia(spawn, DAEMON_FACTS_TIMEOUT_MS) });
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
	return { checks, forLive, daemon };
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
 */
function dockerRunVia(spawn, timeoutMs = 5000) {
	return (args) =>
		new Promise((resolve) => {
			let child;
			try {
				child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
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
	const result = await runLiveProbes({
		image: facts.jobImage ?? env.PI_JOB_IMAGE ?? "pi-job:latest",
		endpoint: facts.endpoint,
		// Asked again right before the first probe command, through the same resolver as the collection's read.
		resolveEndpoint: makeDockerEndpointResolver({ run: dockerRunVia(spawn) }),
		dockerReachable: facts.dockerCode === 0,
		imagePresent: facts.imageCode === 0,
		jobsDir: jobsDirPath(env),
		home,
		sessionsDir: env.PI_SESSIONS_DIR || null,
		egress: facts.egress,
		pid,
		nonce,
		run: liveRunVia(spawn),
		fs: liveFs,
		isAlive,
		announce: (line) => out(`\nread back on local: ${line}\n`),
		user: jobUser.user ?? null,
		// root can remove whatever a job leaves, and a sudo'd doctor is not the worker, so there is no owner to compare.
		euid: ids.euid === 0 ? undefined : ids.euid,
		// The removal wait's clock (issue #344), seamed so a test never waits out a real deadline.
		...(now ? { now } : {}),
		...(delay ? { delay } : {}),
	});
	const checks = (result.swept ?? []).map((what) => ({ ok: true, label: `read back on local: removed ${what}, left by an interrupted --live run` }));
	const noteChecks = () => result.notes.map((note) => ({ ok: false, warn: true, label: `read back on local: ${note}`, fix: "remove it by hand now, or let the next `pi-dispatch doctor --live` remove it once this process has exited" }));
	if (!result.ran) {
		// What was swept and what could not be removed are said on this path too: both are host changes, and neither
		// depends on whether a reading was made.
		checks.push({ ok: false, warn: true, label: `read back on local: not run -- ${result.reason}`, fix: "the declarations above are unchanged and still unverified; fix what stopped the probe and re-run `pi-dispatch doctor --live`" }, ...noteChecks());
		return checks;
	}
	// The decision, read back: the uid PID 1 ran as against the one this host decides.
	const wantUid = jobUser.user ? Number(jobUser.user.split(":")[0]) : null;
	if (typeof result.ranAs !== "number") {
		checks.push({ ok: false, warn: true, label: "read back on local: the job user was not read back (PID 1's status showed no uid)", fix: LIVE_UNREAD_FIX });
	} else if (wantUid !== null && result.ranAs !== wantUid) {
		checks.push({ ok: false, label: `read back on local: the probe ran as uid ${result.ranAs}, not the decided job user ${jobUser.user}`, fix: "the daemon did not apply --user as the worker passes it: no job here runs as the uid its files belong to" });
	} else if (wantUid !== null) {
		checks.push({ ok: true, label: `read back on local: the probe ran as uid ${result.ranAs}, the job user this host decides (${jobUser.user})` });
	} else {
		checks.push({ ok: true, label: `read back on local: the probe ran as the job image's own user (uid ${result.ranAs})` });
	}
	checks.push(
		...result.verdicts.map((v) => {
			if (v.ok) return { ok: true, label: `read back on local: ${v.property} holds (${v.detail})` };
			if (v.warn) return { ok: false, warn: true, label: `read back on local: ${v.property} ${v.detail}`, fix: LIVE_UNREAD_FIX };
			const declared = declarationOf(DEFAULT_LOCAL_BACKEND, v.property)?.word ?? "undeclared";
			const fix = LIVE_FAIL_FIX[v.cause ? `${v.property}:${v.cause}` : v.property] ?? LIVE_FAIL_FIX[v.property];
			return { ok: false, label: `read back on local: ${v.property} does NOT hold -- declared ${declared}, observed: ${v.detail}`, fix };
		}),
	);
	checks.push(...noteChecks());
	// What a green read-back does NOT mean, on a line of its own so a row of ✓ is never read as more than it is.
	// env-internal DOCKER_CONTENT_TRUST: the docker CLI's own variable, read here only to say that it changes what
	// --pull=never governs; pi-dispatch sets nothing with it, so it is not a key of ours to document.
	const contentTrust = env.DOCKER_CONTENT_TRUST === "1";
	// Each sentence says only what DID happen: a probe that was not read back has its own line above saying why, and
	// a sentence here claiming it ran would contradict that line.
	const verdictOf = (property) => result.verdicts.find((v) => v.property === property);
	const unread = [
		"every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint",
		`it ran as ${jobUser.user ? `the job user ${jobUser.user}` : "the image's own user"}, decided for this shell${typeof ids.euid === "number" ? ` (uid ${ids.euid})` : ""}, and the worker service may run as another account`,
		"it wrote to a fixture folder, not to any folder of yours",
		`it read back PI_JOB_IMAGE only${facts.triggerImages?.length ? `, not the ${facts.triggerImages.length} image(s) your triggers name` : ""}`,
		// Only a HELD ephemeral read ran both runs: a first run that survived, or a name held against the second, ran one.
		...(verdictOf("ephemeral")?.ok === true ? ["ephemeral ran two short-lived containers under one name, not two real jobs"] : []),
		// Any jobToJobIsolation ANSWER, held or reached, needed both peers started.
		...(verdictOf("jobToJobIsolation") && verdictOf("jobToJobIsolation").warn !== true ? ["jobToJobIsolation tried one pair of peers on this daemon's job networks, from the first to the second only, not every pair of jobs"] : []),
		...(facts.egress?.armed === false ? ["jobToJobIsolation needs PI_EGRESS armed, since without it jobs share the default bridge by design"] : []),
		...(facts.egress?.armed === true && facts.egress?.proxyRunning === false ? ["jobToJobIsolation needs the egress proxy running, since a job network is built around it"] : []),
		"secretsCustody and credentialTransit are not container properties",
		...(ids.euid === 0 ? ["the host owner of what the probe wrote was not compared, because doctor ran as root"] : []),
		...(contentTrust ? ["DOCKER_CONTENT_TRUST=1 resolves a tag through notary, which --pull=never does not govern"] : []),
	];
	checks.push({ ok: true, label: `read back on local: limits of this read-back -- ${unread.join("; ")}` });
	return checks;
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
 */
function liveRunVia(spawn) {
	return (args, { timeoutMs }) =>
		new Promise((resolve) => {
			let child;
			try {
				child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
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
