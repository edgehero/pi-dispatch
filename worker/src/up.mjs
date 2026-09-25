/**
 * `pi-dispatch up` — the quickstart as ONE consented pass (issue #80). The README's five hand-typed
 * chores (pull the job image, remember the re-tag, start Valkey, init, doctor) become a sequence, but
 * every host mutation keeps a human in front of it: the EXACT command is printed, then a y/N prompt
 * that defaults to No (`--yes` accepts them all, and the commands are still printed — consent is
 * skippable, visibility is not).
 *
 * Doctrine this module must never drift from:
 *   - init's never-clobber is contractual: up always calls runInit, and it always leaves existing
 *     files (and an existing WEBHOOK_SECRET value) untouched — see env-file.mjs.
 *   - up only ever pulls the repo's OWN default image (ghcr.io/edgehero/pi-job:latest, re-tagged
 *     pi-job:latest). NEVER a trigger-named run.image: those are operator-declared and doctor's
 *     presence check covers them — a setup convenience must not become "pull whatever the triggers
 *     file happens to name" (the same reasoning as jobs running with --pull=never).
 *   - no secrets printed: the generated WEBHOOK_SECRET is announced, never echoed.
 *
 * Converge-style, not transactional: a declined or failed step is reported and the pass continues, so
 * one flaky pull does not hide the doctor report that says what else is missing. Exit code mirrors
 * doctor's: 0 unless the docker daemon was unreachable up front (nothing else can be probed, so up
 * stops there with 1) or doctor itself returned nonzero (its code is returned verbatim).
 */
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join, posix, win32 } from "node:path";
import { logsDirPath, settingsFilePath } from "./config.mjs";
import { egressArmed as egressArmedFn } from "./egress.mjs";
import { envKeyIsBlank, updateEnvFile } from "./env-file.mjs";

// The one image up may ever fetch, and the local name jobs run under. Literal on purpose (not
// env.PI_JOB_IMAGE): an operator who pointed PI_JOB_IMAGE elsewhere has outgrown the quickstart, and
// up pulling an arbitrary configured name would break the only-our-own-image doctrine above.
const UPSTREAM_IMAGE = "ghcr.io/edgehero/pi-job:latest";
const LOCAL_IMAGE = "pi-job:latest";
const PULL_ARGS = ["pull", UPSTREAM_IMAGE];
const TAG_ARGS = ["tag", UPSTREAM_IMAGE, LOCAL_IMAGE];

// deploy/docker-compose.yml's Valkey service, reproduced as one docker run: same image, AOF on
// (REQ-QUEUE-BURST-NO-DROP), bound to localhost only (the queue is not a public surface), same
// healthcheck, restart unless-stopped, and a named volume standing in for the compose volume.
const VALKEY_VOLUME_ARGS = ["volume", "create", "pi-dispatch-valkey-data"];
const VALKEY_RUN_ARGS = [
	"run",
	"-d",
	"--name",
	"pi-dispatch-valkey",
	"--restart",
	"unless-stopped",
	"-p",
	"127.0.0.1:6379:6379",
	"-v",
	"pi-dispatch-valkey-data:/data",
	"--health-cmd",
	"valkey-cli ping",
	"--health-interval",
	"10s",
	"--health-timeout",
	"3s",
	"--health-retries",
	"5",
	"valkey/valkey:8",
	"valkey-server",
	"--appendonly",
	"yes",
];

// deploy/docker-compose.yml's `egress` profile, reproduced as one docker run (REQ-EGRESS-ALLOWLIST):
// same digest-pinned image, same two mounts, same explicit container name, same restart policy, on the
// same upstream network. Written out here for the same reason VALKEY_RUN_ARGS is -- an operator who runs
// `up` and one who runs compose must end up with the same component, and two ways of starting one thing
// is two places for it to drift.
//
// The per-job networks are NOT here: the worker creates one per job and attaches this container to it for
// the life of that run. This is only the proxy and its way out.
const EGRESS_NETWORK_ARGS = ["network", "create", "pi-dispatch-egress-out"];
const EGRESS_RUN_ARGS = [
	"run",
	"-d",
	"--name",
	"pi-dispatch-egress-proxy",
	"--restart",
	"unless-stopped",
	"--network",
	"pi-dispatch-egress-out",
	// `z` for the same measured reason as the compose file's mounts (issue #355): on an SELinux-enforcing host squid
	// cannot read an unlabelled config and crash-loops; `z` (shared, never `Z`) relabels the one file so any container
	// may read it, and is a no-op where SELinux is off.
	"-v",
	"./deploy/egress-proxy.conf:/etc/squid/squid.conf:ro,z",
	"-v",
	"./egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro,z",
	"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
];

/**
 * Whether `p` is `folder` itself or sits inside it, compared on the separator rather than on a prefix so
 * `/srv/deploy-old` is not read as being inside `/srv/deploy`.
 */
function underFolder(p, folder, platform) {
	const norm = (x) => {
		const slashed = String(x).replace(/\\/g, "/").replace(/\/+$/, "");
		// Windows paths are case-insensitive and accept either separator, and `nssm-install.cmd` is a
		// supported deployment: a byte compare there misses `c:\pi\deploy\logs` against `C:/pi/deploy`
		// and writes exactly the value this guard exists to refuse. POSIX is case-SENSITIVE, so folding
		// there would refuse a different directory that merely looks alike.
		return platform === "win32" ? slashed.toLowerCase() : slashed;
	};
	const a = norm(p);
	const b = norm(folder);
	return a === b || a.startsWith(`${b}/`);
}

export async function runUp(argv = [], deps = {}) {
	const {
		env = process.env,
		spawn = nodeSpawn,
		out = (s) => process.stdout.write(s),
		prompt = defaultPrompt,
		// `realpathSync` is in this list for a reason worth keeping: `updateEnvFile` resolves the path so a
		// `.env` symlinked at a shared env file is edited THROUGH the link rather than replaced by a
		// regular file. It calls it optionally, so leaving it out here made that repair dead code in the
		// only production caller, and the test that covered it attached the method to its own fake.
		fs = { existsSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync, realpathSync },
		probeTcp = defaultProbeTcp,
		cwd = process.cwd(),
		// Injected so tests can assert the secret never reaches output without fishing it back out of
		// the written file. 32 bytes hex, matching doctor's `openssl rand -hex 32` fix line.
		randomHex = () => randomBytes(32).toString("hex"),
		// Injected for the path compare below, which has to fold case on Windows and must not on POSIX.
		platform = process.platform,
		// The two resolved defaults `up` pins, injected for the same reason the clock is elsewhere: they
		// read the real `homedir()`, so a test asserting the written `.env` byte for byte would otherwise
		// assert whichever account ran it.
		logsDirPathFn = logsDirPath,
		settingsFilePathFn = settingsFilePath,
	} = deps;
	let { runInitFn, runDoctorFn } = deps;
	const yes = argv.includes("--yes");
	const summary = [];

	out("pi-dispatch up — one pass over the quickstart; every docker action asks first (--yes accepts)\n\n");

	// (a) docker binary + daemon, before anything is offered: every mutation below runs through the
	// docker CLI, so with the daemon down the prompts would only collect consent for failures.
	// Distinguishes not-on-PATH from daemon-down exactly as doctor does (spawn error vs nonzero exit).
	const dockerCode = await runCmd(spawn, "docker", ["version"]);
	if (dockerCode !== 0) {
		out(dockerCode === null ? "✗ Docker not found\n    → install Docker — `docker` was not found on PATH\n" : "✗ Docker daemon not responding\n    → start Docker (the daemon is not responding)\n");
		out("\nup: cannot continue without Docker — fix the above, then re-run `pi-dispatch up`.\n");
		return 1;
	}
	out("✓ Docker daemon reachable\n");

	// (b) the default job image. Presence first, so the happy path re-run prompts for nothing.
	if (await runCmd(spawn, "docker", ["image", "inspect", LOCAL_IMAGE]) === 0) {
		out(`✓ Job image present (${LOCAL_IMAGE})\n`);
		summary.push(["job image", `already present (${LOCAL_IMAGE})`]);
	} else {
		const accepted = await consent(
			`The default job image (${LOCAL_IMAGE}) is not on this host. up would run:`,
			[`docker ${PULL_ARGS.join(" ")}`, `docker ${TAG_ARGS.join(" ")}`],
			{ yes, out, prompt },
		);
		if (!accepted) {
			out("skipped — pull it later with the two commands above (or build image/Dockerfile yourself)\n");
			summary.push(["job image", "skipped (declined) — jobs run with --pull=never, so nothing fetches it later"]);
		} else if (await runStreamed(spawn, "docker", PULL_ARGS, out) !== 0) {
			out("✗ docker pull failed — continuing; doctor below will re-check the image\n");
			summary.push(["job image", "pull FAILED — re-run `pi-dispatch up`, or pull by hand"]);
		} else if (await runStreamed(spawn, "docker", TAG_ARGS, out) !== 0) {
			out("✗ docker tag failed — continuing; doctor below will re-check the image\n");
			summary.push(["job image", `pulled, but tagging as ${LOCAL_IMAGE} FAILED — re-run the tag command by hand`]);
		} else {
			out(`✓ pulled and tagged ${LOCAL_IMAGE}\n`);
			summary.push(["job image", `pulled ${UPSTREAM_IMAGE} and tagged it ${LOCAL_IMAGE}`]);
		}
	}

	// (c) Valkey. A bare TCP probe of the default bind, not a redis PING: dependency-free, and the
	// honest claim is only "something is listening". If our own compose-named container is up, docker
	// can say so; if a listener exists that we cannot name, up must NOT offer a second Valkey — the
	// port is taken, and `docker run` would only fail after consent.
	if (await probeTcp("127.0.0.1", 6379)) {
		const ps = await runCmdCapture(spawn, "docker", ["ps", "--filter", "name=pi-dispatch-valkey", "--format", "{{.Names}}"]);
		const ours = ps.code === 0 && ps.output.split("\n").map((l) => l.trim()).includes("pi-dispatch-valkey");
		out(`✓ something is listening on 6379 — assuming your Valkey${ours ? " (it is the pi-dispatch-valkey container)" : ""}\n`);
		summary.push(["valkey", ours ? "container pi-dispatch-valkey already running" : "port 6379 already has a listener — left alone"]);
	} else {
		const accepted = await consent(
			"Nothing is listening on 127.0.0.1:6379. up would start Valkey (same semantics as deploy/docker-compose.yml):",
			[`docker ${VALKEY_VOLUME_ARGS.join(" ")}`, `docker ${quoteArgs(VALKEY_RUN_ARGS)}`],
			{ yes, out, prompt },
		);
		if (!accepted) {
			out("skipped — start it later with `docker compose -f deploy/docker-compose.yml up -d`\n");
			summary.push(["valkey", "skipped (declined) — the queue needs it before `pi-dispatch worker` can drain"]);
		} else if (await runStreamed(spawn, "docker", VALKEY_VOLUME_ARGS, out) !== 0) {
			out("✗ docker volume create failed — continuing; doctor below will re-check Valkey\n");
			summary.push(["valkey", "volume create FAILED — `docker compose -f deploy/docker-compose.yml up -d` is the fallback"]);
		} else if (await runStreamed(spawn, "docker", VALKEY_RUN_ARGS, out) !== 0) {
			out("✗ docker run failed — continuing; doctor below will re-check Valkey\n");
			summary.push(["valkey", "container start FAILED — `docker compose -f deploy/docker-compose.yml up -d` is the fallback"]);
		} else {
			out("✓ started Valkey (container pi-dispatch-valkey, AOF on, bound to 127.0.0.1)\n");
			summary.push(["valkey", "started container pi-dispatch-valkey (durable: --appendonly yes, restart unless-stopped)"]);
		}
	}

	// (d) init — always, and unconditionally safe to re-run: its never-clobber is contractual, so an
	// existing file is only ever reported, never overwritten. No consent gate for the same reason —
	// nothing the operator wrote can be lost here.
	out("\ninit (never overwrites — an existing file is reported and kept):\n");
	runInitFn ??= (await import("./init.mjs")).runInit;
	runInitFn(cwd, { out });
	summary.push(["init", "ran — existing files were kept untouched, missing ones scaffolded"]);

	// (e) WEBHOOK_SECRET, only into a .env that exists (init just scaffolded one unless the operator
	// keeps env elsewhere — a service-manager deployment gets no file invented for it). Same
	// never-clobber contract at key granularity: a value the operator set survives. The value itself
	// is NEVER printed — a webhook secret in a scrollback is a webhook secret in a pastebin.
	const envPath = join(cwd, ".env");
	// WHAT AN EMPTY VALUE COSTS IS PER KEY, and the first version of this said one thing for all five.
	// `config.mjs` reads these two with `??`, so an empty string survives, and `start.mjs` calls
	// `loadPauseWindows`/`loadScopedLimits` unconditionally at boot, which throw on a path that does not
	// exist: the worker does not ignore the feature, it refuses to start. `PI_LOGS_DIR` and
	// `PI_SETTINGS_FILE` use `||` and fall back to the account default; `WEBHOOK_SECRET` reads as absent.
	const EMPTY_REFUSES_BOOT = new Set(["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"]);
	const emptyNote = (key) =>
		EMPTY_REFUSES_BOOT.has(key)
			? `left untouched: the line is there and its value is EMPTY, which is not the same as no line -- a shell that sources this file exports it as "", the worker keeps it and REFUSES TO BOOT. up never clobbers a key an operator wrote, so fill it in or delete the line`
			: `left untouched: the line is there and its value is empty, which reads as unset. up never clobbers a key an operator wrote, so fill it in or delete the line`;
	// The blank test is `env-file.mjs`'s, and the reader underneath it is the one doctor uses -- which is
	// what issue #365 was actually about: two callers answering "is this key set" with two hand-rolled
	// regexes is how `up` and doctor came to print opposite sentences about one file in one run.
	//
	// NOT the same CALL, since issue #384, and the difference is the consequence rather than the question.
	// `up` prints a sentence, so it asks the loose per-line answer and prefers "EMPTY" to "already set" on a
	// file it cannot fully read. Doctor's answer becomes an exit code, so it asks the same reader for the
	// platform's own loader and requires the vouch beside it: a refusal reached by inference is the one
	// verdict this project will not print.
	const writtenButEmpty = (key) => {
		try {
			return envKeyIsBlank(String(fs.readFileSync(envPath, "utf8")), key);
		} catch {
			return false;
		}
	};
	// Windows takes forward slashes everywhere Node does, and writing them is what keeps these four values
	// inside the BARE set: `deploy/worker-env-wrapper.cmd` says "Values MUST be UNQUOTED -- cmd's `set`
	// keeps surrounding quotes as part of the value", so a quoted `C:\pi\deploy\logs` there is a
	// directory that does not exist, behind a ✓. `config.mjs`'s own defaults are already spelled this way.
	const forEnvFile = (value) => (platform === "win32" ? String(value).replace(/\\/g, "/") : value);
	// What `up` wrote, layered over `env` for its OWN doctor step below. Writing a line into `.env`
	// configures the SERVICE (through `EnvironmentFile=` and the wrappers) and configures nothing about the
	// process running right now, because NOTHING in this project loads `.env` into an environment -- see
	// `docs/secrets.md`, and `worker/test/service.test.mjs` pins that a `PI_ENV_SETUP` line in `./.env` is
	// deliberately not honoured. Without this layer, `up` would write the two files' paths and then, three
	// lines later, warn that they are unset (issue #357).
	const wrote = {};
	if (fs.existsSync(envPath)) {
		// Wrapped like the four below it, and for the same reasons: a read-only deployment directory, a full
		// disk, a `.env` this account does not own. Unwrapped, `up` died with a raw stack trace where a
		// summary row was the whole point.
		try {
			if (updateEnvFile(envPath, "WEBHOOK_SECRET", randomHex(), { fs, platform }).changed) {
				out("\n✓ generated WEBHOOK_SECRET into .env (32 random bytes, hex — value not shown)\n");
				summary.push(["WEBHOOK_SECRET", "generated into .env (value not shown; the receiver verifies deliveries with it)"]);
			} else {
				const empty = writtenButEmpty("WEBHOOK_SECRET");
				// ⚠ and not ✓ for the empty line: every other ✓ in this block means "this is fine", and an empty
				// secret is a key the operator has to go and fill in.
				out(empty ? `\n⚠ WEBHOOK_SECRET has a line in .env and its value is EMPTY — left untouched\n` : "\n✓ WEBHOOK_SECRET already set in .env — left untouched\n");
				summary.push(["WEBHOOK_SECRET", empty ? emptyNote("WEBHOOK_SECRET") : "already set — left untouched"]);
			}
		} catch (err) {
			out(`\n✗ WEBHOOK_SECRET could not be written: ${err?.message}\n`);
			summary.push(["WEBHOOK_SECRET", `NOT written: ${err?.message}`]);
		}
		// (e1) the four paths four separate files already promise `up` writes, and it never did
		// (`deploy/worker.service`, `deploy/com.pi-dispatch.worker.plist`, `deploy/nssm-install.cmd`,
		// `.env.example`). Same never-clobber discipline as WEBHOOK_SECRET, at key granularity: a value the
		// operator set survives untouched.
		//
		// TWO get the deployment folder and TWO get the RESOLVED ACCOUNT DEFAULT, and the split is the
		// sharpest edge in this change rather than an inconsistency. `pause-windows.json` and
		// `scoped-limits.json` are scaffolded by `init` into this folder, and the panel defaults to this
		// folder, so pointing the worker here is what makes the three agree. `PI_LOGS_DIR` and
		// `PI_SETTINGS_FILE` are different in kind: `makeLogReaper` unlinks EVERY `.log` and `.json` in
		// `PI_LOGS_DIR` past the window with no name shape and no ownership check, so a deployment folder
		// there would eat `triggers.json`, `pause-windows.json`, `scoped-limits.json` and
		// `subscriptions.json` thirty days in, silently, and the worker would then run nothing while
		// reporting success. `<deployment>/logs` is no better: `service.mjs` creates exactly that directory
		// at install time and the plist puts `worker.out.log` in it. So these two get what
		// `logsDirPath`/`settingsFilePath` would have resolved anyway: behaviour byte-unchanged, the value
		// simply made explicit, which is the whole point -- a worker under another `User=` and the panel
		// then cannot silently resolve two different directories.
		for (const [key, raw, durable] of [
			["PI_PAUSE_WINDOWS_FILE", join(cwd, "pause-windows.json"), false],
			["PI_SCOPED_LIMITS_FILE", join(cwd, "scoped-limits.json"), false],
			["PI_LOGS_DIR", logsDirPathFn(env), true],
			["PI_SETTINGS_FILE", settingsFilePathFn(env), true],
		]) {
			const value = forEnvFile(raw);
			// `logsDirPath` and `settingsFilePath` RESOLVE rather than default: `env.PI_LOGS_DIR || <default>`.
			// So on a shell that already exports one of them at the deployment folder -- which three shipped
			// files told operators to do for a year, before this change made the promise true -- `up` would
			// persist exactly the value the rest of this block exists to prevent, and print a ✓ over it. The
			// refusal is here rather than in the resolver because the resolver is right for every other
			// caller: the worker SHOULD honour an exported path. What must never happen is `up` writing one
			// into the deployment's permanent config without anyone deciding to.
			// TWO refusals, and both are about the same resolver. `logsDirPath` is `env.PI_LOGS_DIR || <default>`,
			// so whatever this shell exports passes straight through, unvalidated and un-absolutised.
			//
			// RELATIVE is the sharper of the two and it is not hypothetical: `PI_LOGS_DIR=.` resolves against
			// the unit's `WorkingDirectory`, which IS the deployment folder, so the retention sweep then
			// deletes `triggers.json`, `pause-windows.json`, `scoped-limits.json` and `subscriptions.json`
			// thirty days in. All three deploy templates document this key as absolute for exactly that
			// reason. INSIDE THIS FOLDER is the same harm reached with an absolute path.
			//
			// The refusals live here and not in the resolver, because the resolver is right for the worker:
			// an exported path SHOULD be honoured at run time. What must never happen is `up` copying one
			// into the deployment's permanent config, where it outlives the shell that set it.
			// Only a value THIS SHELL supplied is checked, and that narrowing matters both ways. The hazard
			// is the pass-through: `logsDirPath` is `env.PI_LOGS_DIR || <default>`, so an exported value
			// lands in the deployment's permanent config where it outlives the shell that set it. The
			// computed default is never a hazard even when it sits under `cwd` -- a deployment folder that
			// IS the service account's home makes `<home>/.pi-dispatch/logs` "inside" it, and refusing
			// there would reject the very path the worker resolves anyway, with a message blaming the
			// operator for a layout that is fine.
			const fromShell = typeof env[key] === "string" && env[key].trim() !== "";
			// Both checks follow the INJECTED platform, not this process's. `node:path`'s default export is
			// already the right one in production, but a drive-letter path is "relative" to the posix
			// implementation, so a test running on POSIX would see the absolute check short-circuit and
			// never reach the folder compare it meant to exercise. Choosing explicitly makes the Windows
			// half of both rules reachable from a test on any host, which is the only way `nssm-install.cmd`
			// gets covered at all.
			const isAbsoluteOn = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
			const why = !durable || !fromShell ? null : !isAbsoluteOn(value) ? "is not an absolute path, and a relative one resolves against the service's WorkingDirectory, which is this folder" : underFolder(value, cwd, platform) ? "is inside this deployment folder" : null;
			if (why) {
				out(`✗ ${key} is ${value} in this shell, which ${why} — not written into .env\n`);
				summary.push([key, `NOT written: ${key} is set to ${value} in the environment you ran up from, and that ${why}. The log retention sweep deletes every .log and .json there past its window, so this would be persisted for the service. Unset it here, or set it by hand to a directory the worker owns`]);
				continue;
			}
			// A path this file cannot represent so that BOTH consumers read it back is refused rather than
			// mangled: `renderEnvValue` throws on a single quote, which the shells want escaped as `'\''`
			// and systemd's parser does not understand.
			let changed;
			try {
				({ changed } = updateEnvFile(envPath, key, value, { fs, platform }));
			} catch (err) {
				out(`✗ ${key} could not be written: ${err?.message}\n`);
				summary.push([key, `NOT written: ${err?.message}. Set it by hand, or move the deployment somewhere without that character in its path`]);
				continue;
			}
			if (changed) {
				wrote[key] = value;
				out(`✓ ${key}=${value} written into .env\n`);
				summary.push([key, `written into .env (${value})`]);
			} else {
				summary.push([key, writtenButEmpty(key) ? emptyNote(key) : "already set — left untouched"]);
			}
		}
	} else {
		summary.push(["WEBHOOK_SECRET", "no .env here — skipped (set it wherever your env lives)"]);
		for (const key of ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE"]) {
			summary.push([key, "no .env here — skipped (set it wherever your env lives)"]);
		}
	}

	// (e2) the egress policy's proxy, and ONLY when the operator has already armed it. up never invents
	// operator policy -- the same doctrine that keeps it pulling this repo's own image and no other -- so a
	// deployment that has not set PI_EGRESS hears nothing about this at all.
	//
	// AFTER init, deliberately: init has just scaffolded egress-allowlist.conf, and starting a proxy whose
	// allowlist file does not exist gets a directory created by docker where a file belonged and a squid
	// that fails confusingly. If the file is still missing, this step declines itself and says which file.
	if (egressArmedFn(env)) {
		if ((await runCmd(spawn, "docker", ["inspect", "--format={{.State.Running}}", "pi-dispatch-egress-proxy"])) === 0) {
			out("\n✓ Egress proxy already present (pi-dispatch-egress-proxy)\n");
			summary.push(["egress", "proxy already present — left untouched"]);
		} else if (!fs.existsSync(join(cwd, "egress-allowlist.conf"))) {
			out("\n✗ the egress policy is on but egress-allowlist.conf is not here — not starting a proxy with no allowlist\n");
			summary.push(["egress", "skipped — no egress-allowlist.conf in this folder; run `pi-dispatch init` here, then `up` again"]);
		} else if (
			await consent("The egress policy is on (PI_EGRESS=0 opts out) but the allowlist proxy is not running. up would start it (same semantics as deploy/docker-compose.yml --profile egress):", [`docker ${EGRESS_NETWORK_ARGS.join(" ")}`, `docker ${quoteArgs(EGRESS_RUN_ARGS)}`], { yes, out, prompt })
		) {
			// The network may already exist from a previous run; that is not a failure, so its code is not
			// checked. The proxy is what matters and it is checked.
			await runStreamed(spawn, "docker", EGRESS_NETWORK_ARGS, out);
			if ((await runStreamed(spawn, "docker", EGRESS_RUN_ARGS, out)) !== 0) {
				out("✗ could not start the egress proxy — continuing; doctor below will re-check it\n");
				summary.push(["egress", "start failed — every job refuses pre-spend until it is up (costs no budget, runs nothing)"]);
			} else {
				summary.push(["egress", "started pi-dispatch-egress-proxy on pi-dispatch-egress-out"]);
			}
		} else {
			out("skipped — start it later with `docker compose -f deploy/docker-compose.yml --profile egress up -d`\n");
			summary.push(["egress", "skipped (declined) — every job is refused pre-spend until the proxy is up (PI_EGRESS=0 opts out)"]);
		}
	}

	// (f) doctor — always, verbatim: up converges what it can, doctor is the judge of what remains
	// (provider key, forge env, overlay …), and its verdict is up's exit code.
	out("\ndoctor:\n");
	runDoctorFn ??= (await import("./doctor.mjs")).runDoctor;
	// Layered, per the note at step (e1): the lines just written configure the service and not this
	// process, so an unlayered call would warn about exactly what `up` had converged a moment earlier.
	//
	// `env` WINS, and the filter is what makes that true rather than the spread order. `wrote` holds keys
	// that were empty in the FILE, which is a different question from whether this shell sets them: an
	// operator exporting `PI_SCOPED_LIMITS_FILE=/etc/pi/limits.json` with the key still commented in `.env`
	// would otherwise have doctor read back the file `up` chose instead of the one their worker loads.
	// SETS, not "sets to something usable", and the `.trim()` this dropped was hiding a refused boot from
	// up's own verdict (issue #384). A shell that exports `PI_PAUSE_WINDOWS_FILE=   ` is a shell whose
	// foreground worker reads three spaces, keeps them (`config.mjs` uses `??`, not `||`) and throws at
	// `start.mjs` before it takes a job. Filling that key from `wrote` handed doctor a path the operator
	// does not have set, so doctor judged a deployment nobody is running and `up` exited 0 on one that
	// cannot start. Doctor now names the blank itself, which is the only line that tells the operator what
	// to do about it. For the other two keys `up` writes, this hands doctor the truth rather than a default:
	// `PI_LOGS_DIR=""` does resolve through `||` to what `up` wrote, but `PI_LOGS_DIR="   "` does NOT -- three
	// spaces are truthy, so `config.mjs` keeps them and the worker really does use a directory named three
	// spaces. Filling that key in from `wrote` made doctor judge a deployment the operator is not running,
	// which is the same defect one key over.
	const layered = { ...env };
	for (const [key, value] of Object.entries(wrote)) {
		if (typeof env[key] !== "string") layered[key] = value;
	}
	const doctorCode = await runDoctorFn(layered, { out });

	// (g) the summary: what ran, what was skipped, what was already there — then the two commands
	// that actually start work, so "up is green" flows straight into the first job.
	out("\nup: summary\n");
	for (const [name, note] of summary) {
		out(`  ${name.padEnd(21)} ${note}\n`);
	}
	out(`
Next:
  edit ${envPath}
      set ANTHROPIC_API_KEY (or your provider's key) — already logged into pi? leave it blank
  pi-dispatch worker
      drain the queue (keep it running in its own terminal, or as a service)
  pi-dispatch run ./my-project --task "add type hints to utils.py"
      queue your first job from another terminal
`);
	return doctorCode;
}

/**
 * Show the exact commands, then ask. Printing happens with or without `--yes`: consent is what the
 * flag waives, never visibility — every host mutation is on screen before it runs. The prompt
 * defaults to No; only an explicit y/yes (any case) accepts.
 */
async function consent(intro, commands, { yes, out, prompt }) {
	out(`\n${intro}\n`);
	for (const c of commands) out(`  ${c}\n`);
	if (yes) {
		out("--yes: accepted\n");
		return true;
	}
	const answer = await prompt("Proceed? [y/N] ");
	return /^y(es)?$/i.test(String(answer ?? "").trim());
}

/** Re-join an argv array for display, quoting the args that contain spaces (e.g. "valkey-cli ping"). */
function quoteArgs(args) {
	return args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
}

/** Exit code of a spawned command; null when it could not launch (not on PATH) — mirrors doctor. */
function runCmd(spawn, cmd, args) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolve(null);
			return;
		}
		child.on("error", () => resolve(null)); // ENOENT etc. — the binary is not available
		child.on("close", (code) => resolve(code));
	});
}

/**
 * Run a CONSENTED command with its stdout+stderr streamed to `out` as it happens — a docker pull's
 * progress is the operator's confirmation that the thing they approved is the thing running.
 */
function runStreamed(spawn, cmd, args, out) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve(null);
			return;
		}
		child.stdout?.on("data", (d) => out(String(d)));
		child.stderr?.on("data", (d) => out(String(d)));
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code));
	});
}

/** Like runCmd but with stdout+stderr captured, for read-only lookups (docker ps). */
function runCmdCapture(spawn, cmd, args) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve({ code: null, output: "" });
			return;
		}
		let output = "";
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("error", () => resolve({ code: null, output }));
		child.on("close", (code) => resolve({ code, output }));
	});
}

/**
 * Is anything listening on host:port? A plain TCP connect, deliberately not a redis PING: up needs
 * "occupied or free", and a protocol probe would add a dependency only to answer a question doctor
 * already answers properly right afterwards.
 */
function defaultProbeTcp(host, port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const socket = netConnect({ host, port });
		const done = (result) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.on("connect", () => done(true));
		socket.on("error", () => done(false));
	});
}

/**
 * Interactive y/N question on the real terminal; tests inject their own `prompt` instead.
 *
 * Non-TTY stdin is an immediate decline WITHOUT touching readline: against an already-ended stream
 * (`up < /dev/null`, CI) `rl.question()`'s promise never settles and holds no handle, so Node would
 * drain the event loop and exit 0 MID-SEQUENCE — silently skipping init and doctor while looking
 * like success. The decline is printed so the transcript shows the question was asked and defaulted.
 * A closed-mid-question readline (ctrl-D on a real terminal) declines the same way.
 */
export async function defaultPrompt(question, { input = process.stdin, output = process.stdout, isTTY = process.stdin.isTTY } = {}) {
	if (!isTTY) {
		output.write(`${question}(no interactive stdin — defaulting to No)\n`);
		return "";
	}
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input, output });
	try {
		return await rl.question(question);
	} catch {
		return ""; // readline closed before an answer -- same contract as an empty answer: No
	} finally {
		rl.close();
	}
}
