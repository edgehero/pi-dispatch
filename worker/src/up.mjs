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
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { egressArmed as egressArmedFn } from "./egress.mjs";
import { updateEnvFile } from "./env-file.mjs";

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
	"-v",
	"./deploy/egress-proxy.conf:/etc/squid/squid.conf:ro",
	"-v",
	"./egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro",
	"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
];

export async function runUp(argv = [], deps = {}) {
	const {
		env = process.env,
		spawn = nodeSpawn,
		out = (s) => process.stdout.write(s),
		prompt = defaultPrompt,
		fs = { existsSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync },
		probeTcp = defaultProbeTcp,
		cwd = process.cwd(),
		// Injected so tests can assert the secret never reaches output without fishing it back out of
		// the written file. 32 bytes hex, matching doctor's `openssl rand -hex 32` fix line.
		randomHex = () => randomBytes(32).toString("hex"),
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
	if (fs.existsSync(envPath)) {
		if (updateEnvFile(envPath, "WEBHOOK_SECRET", randomHex(), { fs }).changed) {
			out("\n✓ generated WEBHOOK_SECRET into .env (32 random bytes, hex — value not shown)\n");
			summary.push(["WEBHOOK_SECRET", "generated into .env (value not shown; the receiver verifies deliveries with it)"]);
		} else {
			out("\n✓ WEBHOOK_SECRET already set in .env — left untouched\n");
			summary.push(["WEBHOOK_SECRET", "already set — left untouched"]);
		}
	} else {
		summary.push(["WEBHOOK_SECRET", "no .env here — skipped (set it wherever your env lives)"]);
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
	const doctorCode = await runDoctorFn(env, { out });

	// (g) the summary: what ran, what was skipped, what was already there — then the two commands
	// that actually start work, so "up is green" flows straight into the first job.
	out("\nup: summary\n");
	for (const [name, note] of summary) {
		out(`  ${name.padEnd(15)} ${note}\n`);
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
