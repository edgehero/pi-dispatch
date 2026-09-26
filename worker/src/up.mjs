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
 * The native rootless `podman` venue (issue #430): when PI_BACKENDS lists podman, `up` also gates on the venue's own
 * `podman info` rule, pulls the default image into this account's Podman store, and installs Valkey and the egress
 * proxy as Quadlet units through the installer `service install` uses (podman-stack.mjs), after init. When the list
 * does not name `local`, nothing here runs docker at all. The docker path of a deployment that blesses `local` is
 * unchanged, with one correction: the egress step looks for the proxy PI_EGRESS_PROXY names rather than the shipped
 * name, and starts nothing in place of an overriding one. The venue keys (PI_BACKENDS, PI_EGRESS, PI_EGRESS_PROXY)
 * come from this shell when it sets them and otherwise from the deployment's `.env`, the file `service install`
 * reads, so the two entry points decide the venue from the same place (`deploymentVenueEnv`).
 *
 * Converge-style, not transactional: a declined or failed step is reported and the pass continues, so
 * one flaky pull does not hide the doctor report that says what else is missing. Exit code mirrors
 * doctor's: 0 unless the docker daemon was unreachable up front (nothing else can be probed, so up
 * stops there with 1) or doctor itself returned nonzero (its code is returned verbatim).
 */
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync, readFileSync as readPackageFile } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { PODMAN_BOOT_REFUSING_CAUSES, makePodmanInfoReader, decidePodmanJobUser, podmanJobUserRefusal } from "./backend-podman.mjs";
import { venuesOf } from "./backends.mjs";
import { logsDirPath, settingsFilePath } from "./config.mjs";
import { DEFAULT_EGRESS_PROXY, egressArmed as egressArmedFn, egressProxyName } from "./egress.mjs";
import { envKeyIsBlank, updateEnvFile } from "./env-file.mjs";
import { STACK_KEYS, applyStack, describeAction, foreignContainerRefusal, foreignContainers, lingerNote, planStack, readLinger, readStackKeys, stackComponents } from "./podman-stack.mjs";

// The shipped Quadlet templates, module-relative like service.mjs's: worker/deploy in a checkout, <pkg>/deploy under npm.
const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");

// The one image up may ever fetch, and the local name jobs run under. Literal on purpose (not
// env.PI_JOB_IMAGE): an operator who pointed PI_JOB_IMAGE elsewhere has outgrown the quickstart, and
// up pulling an arbitrary configured name would break the only-our-own-image doctrine above.
const UPSTREAM_IMAGE = "ghcr.io/edgehero/pi-job:latest";
const LOCAL_IMAGE = "pi-job:latest";
const PULL_ARGS = ["pull", UPSTREAM_IMAGE];
const TAG_ARGS = ["tag", UPSTREAM_IMAGE, LOCAL_IMAGE];
// The same two, into THIS account's rootless store (issue #430): a rootless Podman sees neither root's images nor
// docker's. Podman's CLI takes the same argv, and `podman tag` of the short name makes `localhost/pi-job:latest`, which
// `--pull=never` resolves `pi-job:latest` to with no registry lookup (measured, docs/podman.md step 5).
const PODMAN_EXISTS_ARGS = ["image", "exists", LOCAL_IMAGE];

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
		// The podman venue's seams (issue #430). The info read is the venue's own bounded reader, so `up` asks exactly
		// the question the worker asks at boot; the ids are the ones the job-user rule judges.
		readPodmanInfo = makePodmanInfoReader(),
		euid = typeof process.geteuid === "function" ? process.geteuid() : null,
		egid = typeof process.getegid === "function" ? process.getegid() : null,
		home = homedir(),
		// Whose linger `up` reads after starting the podman stack: the login already running it, as service.mjs reads
		// it. Resolved LAZILY (`userName` below), never as a default here: `userInfo()` throws for a uid with no passwd
		// entry, and the docker path, which never asks, must not die of it.
		user,
		templatesDir = TEMPLATES_DIR,
		// The shipped Quadlet templates are the package's files, read for real even where `fs` is a test's fake of the
		// deployment folder; injectable so a test can hand in its own.
		readTemplate = (name) => readPackageFile(join(templatesDir, name), "utf8"),
		mkdir = mkdirSync,
	} = deps;
	let { runInitFn, runDoctorFn } = deps;
	const yes = argv.includes("--yes");
	const summary = [];
	// env-internal USER: the login running `up`, only ever read on the podman path (see the `user` seam above).
	const userName = () => user ?? (env.USER || userInfo().username);

	// The venue keys, from the same place `service install` reads them (issue #430 review, D2). Nothing loads `.env`
	// into a process, so `up` used to decide the venue from this shell alone: an operator who followed the docs and put
	// PI_BACKENDS=podman in `.env` got the docker pass, and the service they installed next got podman. THIS SHELL WINS
	// where it sets a key (the same precedence the doctor layering below uses, and what the wizard relies on when it
	// runs `up` with PI_BACKENDS=podman before init has written `.env`); `.env` fills the keys the shell leaves unset; a
	// disagreement is printed, because the service will run the file's value. A `.env` line touching one of these keys
	// that the loaders read differently stops `up` before anything runs, as `service install` refuses.
	const venue = deploymentVenueEnv({ env, fs, envPath: join(cwd, ".env") });
	if (venue.error) {
		out(`✗ ${venue.error}\n\nup: cannot tell which venue this deployment runs: fix the above, then re-run \`pi-dispatch up\`.\n`);
		return 1;
	}
	for (const line of venue.disagreements) out(`⚠ ${line}\n`);
	const venueEnv = venue.env;

	// Which runtimes this pass drives (issue #430). With `local` blessed (which the unset default is) everything below
	// is exactly what it always was, and a list that also names podman adds the podman steps after the docker ones. A
	// list WITHOUT `local` never touches docker at all: such a host may have no docker, and asking it would only fail.
	const venues = venuesOf(venueEnv);
	const dockerUsed = venues.localUsed;
	//
	// The docker lines below keep their original text and indentation, the `else` and the unbraced block included, so
	// that the diff of issue #430 shows the docker path as the byte-identical thing its tests pin it to be.
	if (!dockerUsed) out("pi-dispatch up: one pass over the quickstart for the podman venue; every podman and systemctl action asks first (--yes accepts)\n\n");
	else
	out("pi-dispatch up — one pass over the quickstart; every docker action asks first (--yes accepts)\n\n");

	if (dockerUsed) {
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
	}

	// (a2)(b2) the podman venue: its gate and its job image, in this account's own store (issue #430). `podmanReady`
	// is what lets the stack step below run at all.
	let podmanReady = false;
	if (venues.podmanUsed) {
		const gate = await podmanGate({ readPodmanInfo, platform, euid, egid, out });
		if (gate.refused) {
			summary.push(["podman", `NOT ready: ${gate.why}`]);
			if (!dockerUsed) {
				out("\nup: cannot continue without a usable rootless Podman: fix the above, then re-run `pi-dispatch up`.\n");
				return 1;
			}
			out("  the docker steps above are unaffected; the podman steps below are skipped\n");
		} else {
			if (!gate.ok) summary.push(["podman", `not decided yet: ${gate.why}`]);
			podmanReady = true;
			await podmanImageStep({ spawn, out, yes, prompt, summary });
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
	const proxyName = egressProxyName(venueEnv);
	if (dockerUsed && egressArmedFn(venueEnv) && proxyName !== DEFAULT_EGRESS_PROXY) {
		// PI_EGRESS_PROXY names the operator's own proxy (issue #430). This step used to look for, and offer to start, the
		// shipped name whatever that key said, so it could report a proxy present that no job attaches to, or start one
		// beside the one the worker actually uses. It now asks about the name the worker attaches by and starts nothing:
		// that container is the operator's, and the shipped command below would not produce it.
		if ((await runCmd(spawn, "docker", ["inspect", "--format={{.State.Running}}", proxyName])) === 0) {
			out(`\n✓ Egress proxy present (${proxyName}, named by PI_EGRESS_PROXY)\n`);
			summary.push(["egress", `${proxyName} (PI_EGRESS_PROXY) present, left untouched`]);
		} else {
			out(`\n✗ PI_EGRESS_PROXY names ${proxyName}, and docker has no container of that name. up starts only the shipped ${DEFAULT_EGRESS_PROXY}, so start ${proxyName} yourself\n`);
			summary.push(["egress", `${proxyName} (PI_EGRESS_PROXY) not found; every job is refused pre-spend until it runs`]);
		}
	} else if (dockerUsed && egressArmedFn(venueEnv)) {
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

	// (e3) the podman venue's stack: Valkey and, while the policy is armed, the proxy, as Quadlet units through the SAME
	// installer `pi-dispatch service install` uses (issue #430). After init for the reason (e2) gives: the proxy mounts
	// the allowlist init scaffolds.
	if (podmanReady) {
		await podmanStackStep({ env: venueEnv, venues, spawn, out, yes, prompt, summary, fs, probeTcp, cwd, home, user: userName(), templatesDir, readTemplate, mkdir });
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
	// The venue keys `.env` supplied (D2), by the same env-wins rule, so doctor judges the venue this pass drove.
	for (const [key, value] of Object.entries(venue.fromFile)) {
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
	// A worker run BY HAND reads only its shell, so on the podman venue it needs the list exported; the service reads
	// `.env` itself. Printed only there, so every other deployment's closing text is unchanged.
	if (venues.podmanUsed) {
		out("  (podman venue: a worker started by hand reads only its shell, so export the same PI_BACKENDS there first, or run it as a service with `pi-dispatch service install`, which reads .env)\n");
	}
	return doctorCode;
}

/**
 * The venue keys this pass decides with (D2): this shell's value where it sets one, else the deployment `.env`'s, read
 * with `readStackKeys` exactly as `service install` reads them. Returns `{ env, fromFile, disagreements }` or
 * `{ error }`. `env` is the whole environment with the file's keys filled in; `fromFile` is only what the file
 * supplied, for doctor's layering; `disagreements` names each key both set differently.
 */
function deploymentVenueEnv({ env, fs, envPath }) {
	let keys = {};
	if (fs.existsSync(envPath)) {
		let text = null;
		try {
			text = String(fs.readFileSync(envPath, "utf8"));
		} catch {
			// Unreadable: the later .env steps say so in their own words; the venue then comes from the shell alone.
		}
		if (text !== null) {
			const read = readStackKeys(text, { loader: "systemd", path: envPath });
			if (read.error) return { error: read.error };
			keys = read.keys;
		}
	}
	const merged = { ...env };
	const fromFile = {};
	const disagreements = [];
	for (const key of STACK_KEYS) {
		if (!Object.hasOwn(keys, key)) continue;
		if (typeof env[key] === "string") {
			if (env[key] !== keys[key]) disagreements.push(`${key} is ${JSON.stringify(env[key])} in this shell and ${JSON.stringify(keys[key])} in ${envPath}: this pass uses the shell's, and the service will run the file's`);
			continue;
		}
		merged[key] = keys[key];
		fromFile[key] = keys[key];
	}
	return { env: merged, fromFile, disagreements };
}

/**
 * The podman venue's gate: the same `podman info` read and the same ordered job-user rule the worker boots with
 * (`decidePodmanJobUser`), so `up` cannot pass a host the worker then refuses, or refuse one it would run. Printed in
 * the worker's own refusal words.
 */
async function podmanGate({ readPodmanInfo, platform, euid, egid, out }) {
	let read;
	try {
		read = await readPodmanInfo();
	} catch {
		read = { answered: false, reason: "spawn-failed", transient: true };
	}
	const decision = decidePodmanJobUser({ platform, euid, egid, read });
	if (decision.mode === "worker") {
		out(`✓ rootless Podman answering (podman jobs run as ${decision.user}, with --userns=keep-id)\n`);
		return { ok: true };
	}
	// Parity with the worker's BOOT (issue #430 review, D7): only the causes that stop a worker booting stop `up`. A
	// podman info that timed out, or one nothing could read, is a verdict the worker defers to each job rather than
	// refusing at boot, so `up` warns and carries on; the image and stack steps then answer for themselves.
	if (decision.mode === "unmappable" && PODMAN_BOOT_REFUSING_CAUSES.has(decision.cause)) {
		const why = podmanJobUserRefusal(decision);
		out(`✗ podman venue not usable here\n    → ${why}\n`);
		return { ok: false, refused: true, why };
	}
	const why = decision.mode === "unmappable" ? podmanJobUserRefusal(decision) : `podman info did not answer (${decision.reason}); check that \`podman info --format json\` works as this account.`;
	out(`⚠ podman venue not decided yet (the worker would retry this, not refuse it at boot)\n    → ${why}\n`);
	return { ok: false, refused: false, why };
}

/** The default job image into this account's Podman store, mirroring the docker step (b) line for line. */
async function podmanImageStep({ spawn, out, yes, prompt, summary }) {
	if ((await runCmd(spawn, "podman", PODMAN_EXISTS_ARGS)) === 0) {
		out(`✓ Job image present in this account's Podman store (${LOCAL_IMAGE})\n`);
		summary.push(["podman job image", `already present (${LOCAL_IMAGE})`]);
		return;
	}
	const accepted = await consent(
		`The default job image (${LOCAL_IMAGE}) is not in this account's Podman store. up would run:`,
		[`podman ${PULL_ARGS.join(" ")}`, `podman ${TAG_ARGS.join(" ")}`],
		{ yes, out, prompt },
	);
	if (!accepted) {
		out("skipped: pull it later with the two commands above\n");
		summary.push(["podman job image", "skipped (declined): jobs run with --pull=never, so nothing fetches it later"]);
	} else if ((await runStreamed(spawn, "podman", PULL_ARGS, out)) !== 0) {
		out("✗ podman pull failed: continuing; doctor below will re-check the image\n");
		summary.push(["podman job image", "pull FAILED: re-run `pi-dispatch up`, or pull by hand"]);
	} else if ((await runStreamed(spawn, "podman", TAG_ARGS, out)) !== 0) {
		out("✗ podman tag failed: continuing; doctor below will re-check the image\n");
		summary.push(["podman job image", `pulled, but tagging as ${LOCAL_IMAGE} FAILED: re-run the tag command by hand`]);
	} else {
		out(`✓ pulled and tagged ${LOCAL_IMAGE} in this account's Podman store\n`);
		summary.push(["podman job image", `pulled ${UPSTREAM_IMAGE} and tagged it ${LOCAL_IMAGE}`]);
	}
}

/**
 * The podman venue's stack step. Decides what is missing the way the docker steps do (a listener on 6379 is left
 * alone, a proxy that exists is left alone), then plans the Quadlet files with `planStack`, shows `plan.actions`, and on
 * consent hands those same objects to `applyStack`: what runs is literally what was shown.
 */
async function podmanStackStep({ env, venues, spawn, out, yes, prompt, summary, fs, probeTcp, cwd, home, user, templatesDir, readTemplate, mkdir }) {
	const armed = egressArmedFn(env);
	let includeValkey = false;
	if (!venues.localUsed) {
		if (await probeTcp("127.0.0.1", 6379)) {
			const ps = await runCmdCapture(spawn, "podman", ["ps", "--filter", "name=pi-dispatch-valkey", "--format", "{{.Names}}"]);
			const ours = ps.code === 0 && ps.output.split("\n").map((l) => l.trim()).includes("pi-dispatch-valkey");
			out(`\n✓ something is listening on 6379, assuming your Valkey${ours ? " (it is the pi-dispatch-valkey container)" : ""}\n`);
			summary.push(["valkey", ours ? "container pi-dispatch-valkey already running" : "port 6379 already has a listener, left alone"]);
		} else {
			includeValkey = true;
		}
	}
	const components = stackComponents({ venues, env, includeValkey, armed });
	for (const note of components.notes) out(`\n⚠ ${note}\n`);
	if (components.proxy) {
		// RUNNING, read off the output: `podman inspect` exits 0 for an EXITED container too and prints `false`
		// (measured), so the exit code alone called a stopped hand-started proxy "present" and offered nothing, which is
		// exactly the upgrade this step exists for. A stopped one is offered the unit, under the foreign-container rule.
		const inspect = await runCmdCapture(spawn, "podman", ["inspect", "--format={{.State.Running}}", DEFAULT_EGRESS_PROXY]);
		if (inspect.code === 0 && inspect.output.trim() === "true") {
			out(`\n✓ Egress proxy already present under this account's Podman (${DEFAULT_EGRESS_PROXY})\n`);
			summary.push(["egress (podman)", "proxy already present, left untouched"]);
			components.proxy = false;
		} else if (!fs.existsSync(join(cwd, "egress-allowlist.conf"))) {
			out("\n✗ the egress policy is on but egress-allowlist.conf is not here, not starting a proxy with no allowlist\n");
			summary.push(["egress (podman)", "skipped: no egress-allowlist.conf in this folder; run `pi-dispatch init` here, then `up` again"]);
			components.proxy = false;
		}
	}
	if (!components.valkey && !components.proxy) return;
	const plan = planStack({ components, templatesDir, deployDir: cwd, home, fs, readTemplate });
	if (plan.error) {
		out(`\n✗ ${plan.error}\n`);
		summary.push(["podman stack", `NOT installed: ${plan.error}`]);
		return;
	}
	const changed = plan.files.filter((f) => f.state === "changed");
	if (changed.length > 0) {
		// up has no --force, and a file someone edited is theirs until they say otherwise (init's contract).
		out(`\n✗ ${changed.map((f) => f.path).join(", ")} differs from what this version renders, left untouched\n`);
		summary.push(["podman stack", "NOT installed: a Quadlet file differs; `pi-dispatch service install --force` replaces it"]);
		return;
	}
	// The shared installer's foreign-container rule (D3): a container of a unit's name that the unit does not own would
	// be removed by the unit's `podman run --replace`. up has no --force, so it names both ways out and installs nothing.
	const foreign = await foreignContainers(plan, (cmd, args) => runCmdCapture(spawn, cmd, args));
	if (foreign.length > 0) {
		const why = foreignContainerRefusal(foreign, { forceHint: "run `pi-dispatch service install --force`, which replaces it and says so" });
		out(`\n✗ ${why}\n`);
		summary.push(["podman stack", `NOT installed: ${foreign.map((f) => f.container).join(", ")} exists and is not the Quadlet unit's`]);
		return;
	}
	const parts = [components.valkey ? "Valkey" : null, components.proxy ? "the egress proxy" : null].filter(Boolean).join(" and ");
	const accepted = await consent(
		`${parts} ${components.valkey && components.proxy ? "are" : "is"} not running under this account's Podman. up would install ${components.valkey && components.proxy ? "them" : "it"} as Quadlet units in your user manager (the same installer \`pi-dispatch service install\` uses; systemd brings them back at boot while linger is on):`,
		plan.actions.map(describeAction),
		{ yes, out, prompt },
	);
	const row = components.valkey && components.proxy ? "podman stack" : components.valkey ? "valkey" : "egress (podman)";
	if (!accepted) {
		out("skipped: `pi-dispatch service install` installs the same units with the worker\n");
		summary.push([row, `skipped (declined): ${components.valkey ? "the queue needs Valkey before `pi-dispatch worker` can drain" : "every podman job is refused pre-spend until the proxy is up (PI_EGRESS=0 opts out)"}`]);
		return;
	}
	// The fs seam gains mkdir here only: up's own writes (`.env`) never needed one, and the Quadlet directory usually
	// does not exist on a fresh account.
	const applied = await applyStack(plan, { fs: { ...fs, mkdirSync: fs.mkdirSync ?? mkdir }, run: (cmd, args) => runStreamed(spawn, cmd, args, out) });
	if (!applied.ok) {
		out(`✗ ${applied.failed} failed: continuing; doctor below will re-check. \`journalctl --user -u ${plan.start.join(" -u ")}\` has the details\n`);
		summary.push([row, `install FAILED at: ${applied.failed}`]);
		return;
	}
	out(`✓ started ${plan.start.join(" ")}\n`);
	summary.push([row, `installed as Quadlet units and started (${plan.start.join(", ")})`]);
	out(lingerNote(await readLinger(user, (cmd, args) => runCmdCapture(spawn, cmd, args)), user));
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
