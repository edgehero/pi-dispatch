#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { TRIGGER_LOADER_ENV_KEYS, loadConfig, workerName } from "./config.mjs";
import { EXIT_POLICY, installRejectionPrinter, installStdoutPipeGuard } from "./exit-code.mjs";
import { isEntryModule } from "./entry.mjs";
import { gitDirty, localRepoProblem } from "./git-dirty.mjs";
import { imageRefProblem } from "./image-ref.mjs";
import { modelIdProblem, providerIdProblem } from "./model-ref.mjs";
import { refusedBeforeScript } from "./bullmq-internals.mjs";
import { cliDeploymentEnv, deploymentServiceEnv } from "./service-env.mjs";

// Issue #804: `cliDeploymentEnv` lives in service-env.mjs, where `service restart --drain` reads it too (service.mjs
// must not import this entry module). Re-exported so every caller that took it from here keeps working.
export { cliDeploymentEnv };

/**
 * How long the kill switch waits on the host registry before acting on the shared queue alone, and on the keyspace scan
 * beside it. `status` holds the pollers' heartbeats to it too, the bound `readPollerStatus` has of its own.
 */
const FLEET_READ_TIMEOUT_MS = 2_000;

/**
 * How long `pi-dispatch status` waits on one Valkey (issue #1003). Every read it makes there ends by then: the refusal
 * check's PING, the registry, the queue discovery, the pollers' heartbeats, consumer demand, each queue's paused state
 * and counts, and the waiting details. Each read keeps its own bound and ends sooner when this comes first. Before it, a
 * Valkey that took the connection and answered nothing (a frozen server, a stopped container behind a live port, a
 * proxy that holds bytes) held status open with nothing printed, because the paused state and the counts had no bound.
 * `pause` and `resume` wait as long for their discovery and their writes (issue #1007), and say what each queue is.
 */
export const STATUS_DEADLINE_MS = 5_000;

/** How long a kill switch verb waits for a queue's close before it drops the connection (`closeWithin`). */
const KILL_SWITCH_CLOSE_TIMEOUT_MS = 1_000;

/**
 * Less of the deadline left than this is a spent deadline (`statusDeadline`'s `spent`), and no queue is built (issue
 * #1003). A queue needs that long at least: its connection comes up (the address judged, AUTH, SELECT, the ready check,
 * BullMQ's version read) before it can answer anything, and one closed while it is still opening has ioredis print its
 * failed ready check as an unhandled error. It is also what makes "spent" true when the reads ran out: a read bounded by
 * the deadline ends on a timer, and Node's timers run against the event loop's cached time, so on a loaded machine one
 * fires some milliseconds before the deadline by `performance.now()` (measured, with every timer 15 ms early: a status
 * whose reads had all run out still built its queue).
 */
const KILL_SWITCH_QUEUE_MIN_MS = 100;

const USAGE = `pi-dispatch — run pi coding-agent flows on your own folders

  pi-dispatch init         scaffold .env + triggers.json + pause-windows.json + pi-packages.json + subscriptions.json here
  pi-dispatch doctor [--json] [--fix] [--live] [--openshell] [--secrets] [--no-publish]
                           preflight Docker, Valkey, the job image, and your provider key; --fix offers to run each fix (y/N per action);
                           --live reads the backend declarations back off short-lived real containers (shown in docker ps while they run);
                           --openshell says whether this host is ready for the openshell venue (run anyway once PI_BACKENDS names it);
                           --secrets resolves each project secret bundle here and prints its variable names, never values;
                           every run publishes its checks to Valkey for the console and the panel (labels with paths
                           and secret values redacted, kept 7 days), and --no-publish skips that
  pi-dispatch console [--name NAME] [--next /setup] [--port N] [--deployment DIR]
      get into the web console: starts its service if it stopped, then opens your browser signed in
  pi-dispatch up [--console] [--yes] [--adopt-volume] [--restart-proxy] [--refresh-proxy-rules]
      with --console also: [--ask-each] [--no-open] [--name NAME]
                           one consented pass: pull+tag the job image, start Valkey, init, doctor
  pi-dispatch setup github mint GitHub App credentials in one browser click (App Manifest flow);
                           every write shown first and individually consented — no --yes here
                           (--webhook-url <URL> | --no-webhook) [--org <org>] [--name <appName>]
  pi-dispatch auth <status|login CONNECTION|logout CONNECTION|usage CONNECTION|trial CONNECTION>
                           manage host-owned subscription authentication, see docs/subscription-auth.md
  pi-dispatch import-pi    stage your host pi setup (models/skills/persona) into a global overlay
                           [--no-extensions] [--with-packages] [--no-host-packages]
                           [--packages-file <path>] [--from <agentDir>] [--to <overlayDir>]

  pi-dispatch run <folder> --task "<what to do>" [--flow <name>]
                           [--provider <p>] [--model <m>] [--max-turns <n>] [--image <ref>] [--force]
  pi-dispatch run --trigger <cron id>
                           fire one cron trigger now, once, exactly as its schedule would: its folder, flow,
                           task and every other field come from the triggers file (PI_TRIGGERS_FILE, else
                           ./triggers.json here); a second call in the same minute queues nothing.
                           Both run forms take PI_WORKER_NAME (and --trigger PI_TRIGGERS_FILE and
                           PI_MAX_COST_USD) from this shell, else from ./.env here, refusing a disagreement
  pi-dispatch sandbox <jobId>
                           re-open a finished run's sandbox as a shell — same image, same workspace,
                           no credentials  [--publish <port>[:<containerPort>]] [--pin]
  pi-dispatch sandbox <id> --attach
                           return to the tracked shell on its original runtime
  pi-dispatch sandbox --new <repo> --ref <branch|pr:N|sha> --as <trigger-index> [--pin]
                           prepare a kept workspace without an agent, container, reservation or run slot
  pi-dispatch opener install --config <approved Fleet export.json>
                           register pi-dispatch-open for this account; terminal commands wait for Enter
  pi-dispatch sandbox --list
                           what is still re-openable, for how long, and what is running now
  pi-dispatch canary --role <role> --model <provider/model> --flow <flow> --cap-usd <amount>
                           replay up to three retained recent jobs in disposable workspaces with forge
                           access blocked, under one experiment cap [--count 1..10] [--json]

  pi-dispatch worker       drain the queue (run this in another terminal, or as a service)
  pi-dispatch-receiver     webhook receiver for forge triggers, its own bin (see docs/github.md)
  pi-dispatch service <render|install|uninstall|status|start|stop|restart> [--receiver|--console] [--user|--system] [--force]
                           run the worker (or --receiver, or --console) as an OS service — the deploy/ templates
                           rendered with this host's real paths, installed user-level;
                           \`service restart --drain\` lets this host's running jobs finish first
  pi-dispatch egress render
                           write model-endpoints.conf here from model-endpoints.json (in place), then print
                           the command that reloads the egress proxy; it never reloads the proxy itself
  pi-dispatch triggers check [file]
                           judge a triggers file before you move it over the one the services run, by the rules
                           the worker, the receiver, the poller and the watch collector load it by ([file], else
                           PI_TRIGGERS_FILE, else ./triggers.json here); exit 1 names each that refuses and why
  pi-dispatch pause        stop taking new jobs (durable; survives worker restart)
  pi-dispatch resume       resume taking jobs
  pi-dispatch status       show paused state + job counts
  pi-dispatch status --target <owner/repo#12|group/project!7>
                           what the queue holds for one issue or pull request: its jobs queued or running,
                           and for each flow whether a new request would be joined to a job or dropped
  pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json] [--valkey-url <url>]
                           how busy each host was: busy and idle time, slots in use, memory and CPU
                           promised and used, waits and projects, read from the run records (jobs only)
  pi-dispatch cancel <jobId>  stop one job: a queued or held job is removed (the line says whether it had
                           made attempts; cancel records nothing), a running one is aborted on whichever
                           host owns it (its record says operator-cancel)
  pi-dispatch steer <jobId> [--later] <text…|->
                           send a message to a running job whose trigger has run.steer: the agent reads it
                           after its current tool calls, or with --later once it would otherwise stop;
                           - reads the text from stdin. Prints the message id and its state, never the text
  pi-dispatch steer --withdraw <jobId> <msgId>
                           take a message back: guaranteed while it is queued, best effort once written
  pi-dispatch chat <run-id | issue-url> --fork-as-job [--entry <id>] [--position before|at] [--provider <id>] [--model <id>] [--thinking <level>] [--message <text>] [--yes]
  pi-dispatch chat <run-id | issue-or-PR-url | session-key> [--fork] [--force] [--tools] [--pi <path>] [--console <addr>] [--yes]
                           open a run's chat here, through the operator console (PI_CONSOLE_TOKEN, else a prompt):
                           a running job is followed live and steered (Enter; /later <text>; /withdraw <id>;
                           Ctrl+C detaches), a parked one is answered, and a finished one (or a session key, or
                           --fork) opens in your own pi as a fork of its stored transcript, on the host that keeps
                           the sessions, with tools off unless --tools; the stored transcript is never changed.
                           A console that is not loopback is asked about first (the token goes over plain HTTP);
                           --yes answers that question

Config comes from the environment (see .env.example); flags override it per run.
Prefer being walked through all of this? The operator panel's /dispatch setup does every step
with a consent per action:  pi install npm:@edgehero/pi-dispatch-admin`;

	// Where this command's output goes. Defaults to the real stdout, so the CLI is byte-identical; a test
	// injects a collector instead of reassigning `process.stdout.write`. That matters because `node --test`
	// runs each file in a child process that serialises its own results over that same stdout, so a test
	// holding a replacement across an `await` swallows the runner's result frames (issue #266). `cwd` is the folder a
	// command takes for the deployment's (its `./.env` and `./triggers.json`); only `triggers` reads it so far (issue
	// #970), and a test passes one rather than moving the whole process with `process.chdir`. `statusDeadlineMs` is
	// `status`'s, `pause`'s and `resume`'s wait on one Valkey (`STATUS_DEADLINE_MS`, issues #1003 and #1007), shorter in a
	// test so a Valkey that never answers is seen in well under a second.
export async function main(argv = process.argv.slice(2), env = process.env, { write = (chunk) => process.stdout.write(chunk), writeErr = (chunk) => process.stderr.write(chunk), valkeyRefusal = valkeyRefusalAtStart, now = () => new Date(), controlClients = {}, cwd = process.cwd(), statusDeadlineMs = STATUS_DEADLINE_MS } = {}) {
	const cmd = argv[0];
	if (cmd === "auth") {
		const { runAuth } = await import("./auth-cli.mjs");
		const deployment = cliDeploymentEnv(env, ["PI_AUTH_CONNECTIONS_FILE", "PI_AUTH_STORE_DIR", "PI_WORKER_NAME", "PI_SETTINGS_FILE", "PI_GLOBAL_PI_DIR", "VALKEY_URL"]);
		if (deployment.problem) { writeErr(`${deployment.problem}\n`); return 2; }
		return runAuth(argv.slice(1), { env: deployment.env, write, writeErr, now: () => Number(now()) });
	}

	if (cmd === "init") {
		const { runInit } = await import("./init.mjs");
		// The environment rides along so the next steps match the venue (issue #453): PI_BACKENDS=podman alone gets
		// the podman ladder.
		return runInit(process.cwd(), { env });
	}
	if (cmd === "setup-host") {
		if (argv.length !== 1) return 2;
		const { runSetupHostCli } = await import("./setup-host.mjs");
		return runSetupHostCli({ env });
	}

	if (cmd === "doctor") {
		const { runDoctor } = await import("./doctor.mjs");
		// `fix` and `live` ride in the deps position (runDoctor(env, depsOrOpts)) — one options bag, no third arg.
		// `--openshell` (issue #683): the openshell venue's lines, before PI_BACKENDS blesses it (issue #684 made it blessable).
		// `--secrets` (issue #704): resolve each project secret bundle on this host, printing variable names and a count only.
		// Publishing (issue #712) is ON unless `--no-publish`; `--publish` says it explicitly (the worker's own runs pass it),
		// and the two together are refused rather than one silently winning.
		const flags = argv.slice(1);
		if (flags.includes("--publish") && flags.includes("--no-publish")) {
			writeErr("pi-dispatch doctor: --publish and --no-publish contradict each other; pass one\n");
			return 2;
		}
		// `--by-worker=<hours>` is the worker's own spawn saying so (doctor-spawner.mjs), with the interval it runs at, so
		// the record names who ran it and carries the real interval. Not in the usage: an operator has no reason to type it,
		// and one who does only mislabels their own run.
		// Held to the worker's own range (1 to DOCTOR_INTERVAL_MAX_HOURS: a worker at 0 spawns no doctor at all), refused
		// otherwise, as a mistyped flag is.
		const byWorkerFlag = flags.find((f) => f.startsWith("--by-worker"));
		let publishBy = null;
		if (byWorkerFlag !== undefined) {
			const { DOCTOR_INTERVAL_MAX_HOURS } = await import("./doctor-spawner.mjs");
			const m = /^--by-worker=(\d{1,3})$/.exec(byWorkerFlag);
			const hours = m ? Number(m[1]) : NaN;
			if (!(hours >= 1 && hours <= DOCTOR_INTERVAL_MAX_HOURS)) {
				writeErr(`pi-dispatch doctor: --by-worker takes the worker's doctor interval in hours, 1 to ${DOCTOR_INTERVAL_MAX_HOURS}\n`);
				return 2;
			}
			publishBy = { worker: true, every: hours };
		}
		return runDoctor(env, { json: flags.includes("--json"), fix: flags.includes("--fix"), live: flags.includes("--live"), openshell: flags.includes("--openshell"), secrets: flags.includes("--secrets"), publish: !flags.includes("--no-publish"), publishBy });
	}

	if (cmd === "up") {
		const { runUp } = await import("./up.mjs");
		return runUp(argv.slice(1), { env });
	}

	if (cmd === "console") {
		const { runConsoleOpen } = await import("./console-open.mjs");
		return runConsoleOpen(argv.slice(1), { env });
	}

	if (cmd === "setup") {
		// Subcommand shape (`setup <forge>`) so future forges can land beside github without a new
		// top-level verb; an unknown or missing target prints guidance rather than guessing.
		if (argv[1] === "github") {
			const { runGithubAppSetup } = await import("./github-app-setup.mjs");
			return runGithubAppSetup(argv.slice(2), { env });
		}
		write(`pi-dispatch setup <target> — guided credential setup\n\n  targets: github\n\n  pi-dispatch setup github (--webhook-url <URL> | --no-webhook) [--org <org>] [--name <appName>]\n      mint GitHub App credentials via the App Manifest flow — one browser click returns the app id,\n      private key, and webhook secret; every write is shown first and individually consented\n`);
		return argv[1] ? 1 : 0;
	}

	if (cmd === "import-pi") {
		const { runImportPi } = await import("./import-pi.mjs");
		return runImportPi(argv.slice(1), { env });
	}

	if (cmd === "updates") {
		const { runUpdatesCli } = await import("./updates-cli.mjs");
		return runUpdatesCli(argv.slice(1), { env });
	}

	if (cmd === "sandbox") {
		const { runSandbox } = await import("./sandbox-cli.mjs");
		return runSandbox(argv.slice(1), { env });
	}
	if (cmd === "opener") {
		const { runOpener } = await import("./opener-cli.mjs");
		return runOpener(argv.slice(1), { env });
	}
	if (cmd === "canary") {
		const { runCanary } = await import("./canary-cli.mjs");
		return runCanary(argv.slice(1), { env, write, deploymentEnv: cliDeploymentEnv });
	}

	if (cmd === "worker") {
		const { startWorker } = await import("./start.mjs");
		await startWorker(env);
		return 0; // the worker keeps the process alive until SIGTERM
	}

	if (cmd === "service") {
		const { runService } = await import("./service.mjs");
		return runService(argv.slice(1), { env });
	}

	if (cmd === "egress") {
		const { runEgress } = await import("./egress-cli.mjs");
		return runEgress(argv.slice(1), { env, out: write });
	}

	if (cmd === "triggers") {
		// Issue #970: `check` alone. It judges a file and changes nothing, so it reads no Valkey.
		const { runTriggers } = await import("./triggers-cli.mjs");
		return runTriggers(argv.slice(1), { env, cwd, out: write, err: writeErr, now: () => Number(now()) });
	}

	if (cmd === "run") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: {
				task: { type: "string" },
				flow: { type: "string" },
				provider: { type: "string" },
				model: { type: "string" },
				"max-turns": { type: "string" },
				image: { type: "string" }, // the container image for this one job; blank/absent = PI_JOB_IMAGE
				force: { type: "boolean", default: false },
				trigger: { type: "string" }, // issue #505: fire this cron trigger once, by hand
			},
		});
		if (values.trigger !== undefined) return runTrigger(values, positionals, env, { write, valkeyRefusal, now });
		const folder = positionals[0] && resolve(positionals[0]);
		if (!folder || !existsSync(folder)) return fail(`folder not found: ${positionals[0] ?? "(none given)"}`);
		if (!values.task) return fail("a --task is required");
		// The one image rule (`image-ref.mjs`, issue #471 gate round 1), before anything is queued: a dash-leading `--image`
		// was enqueued as it was and reached the runtime's argv as a flag at job start. Empty stays "the default", as below.
		if (values.image) {
			const problem = imageRefProblem(values.image);
			if (problem) return fail(`--image ${problem.reason} (got ${JSON.stringify(values.image)})`);
		}
		// The one model-id and provider-id rule (model-ref.mjs, issue #673), before anything is queued, so a local run's
		// model is one the console's runs filter can find, as a trigger's, PI_MODEL's and the overlay's are. An empty
		// flag is refused too, never read as absent: it used to be enqueued as "" and run on a model named "". The
		// value is not echoed, as no other refusal of this rule echoes it.
		for (const [flag, judge] of [["provider", providerIdProblem], ["model", modelIdProblem]]) {
			if (values[flag] === undefined) continue;
			const problem = judge(values[flag]);
			if (problem) return fail(`--${flag} ${problem}. Nothing was queued.`);
		}

		// The worker's folder rule, before anything is queued (issue #524): `.git` at the folder itself and a commit at
		// HEAD. A folder that fails it used to be queued anyway and refused at pickup as a generic `config-refused`.
		// Not waved away by --force: that flag accepts uncommitted work, and the worker refuses this either way.
		const notARepo = localRepoProblem(folder);
		if (notARepo) return fail(`${notARepo} Nothing was queued.`);

		// A local job edits the folder IN PLACE with no undo (SECURITY.md). Refuse a dirty working
		// tree unless --force, so a bad run cannot mix with uncommitted work the operator can't
		// cleanly separate.
		if (!values.force) {
			const dirty = gitDirty(folder);
			if (dirty === null) return fail(`${folder} is not a usable git repository`);
			if (dirty) return fail(`${folder} has uncommitted changes. Commit or stash them, or pass --force.`);
		}

		// Which host queue (review of PR #575): PI_WORKER_NAME by the deployment's rule, as VALKEY_URL below is, so `run`
		// from the deployment folder queues where that folder's worker drains even when this shell does not export it.
		const deployment = cliDeploymentEnv(env, ["PI_WORKER_NAME"]);
		if (deployment.problem) return fail(`${deployment.problem}. Nothing was queued.`);
		const config = loadConfig(deployment.env);
		const { cliValkeyUrl, parseConnection } = await import("./connection.mjs");
		// PR #475's review: VALKEY_URL as the password is read, this shell's else the deployment .env's (a disagreement
		// named), not the shell's alone: from the folder of a Valkey on another port, `run` dialled 6379.
		const valkeyUrl = cliValkeyUrl(env);
		const { makeQueue, enqueueLocalJobReporting, hostQueueName, swallowedRunSentence } = await import("./queue.mjs");
		// failFast: a one-shot enqueue must not hang forever if Valkey is down -- error clearly.
		// Onto THIS host's queue when the deployment declares a name (issue #57). The folder was checked
		// against this machine's filesystem a few lines up, so this machine is the only one that can run it;
		// enqueueing it where every host drains would be handing a job to a peer that has no such folder.
		const hq = config.workerNameDeclared ? hostQueueName(config.workerName) : null;
		// Issue #464 (gate round 3): judged before anything is sent, so a refused Valkey is said as the refusal it is, from
		// any directory. Only a refusal stops here; nothing answering is the "could not reach" below.
		const refused = await valkeyRefusal(valkeyUrl, env);
		if (refused) return fail(refused);
		const queue = makeQueue(parseConnection(valkeyUrl, { failFast: true }), { ...(hq ? { name: hq } : {}) });
		try {
			// Absent flags stay absent (undefined) so the value resolves at job start against the
			// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT).
			const { id: jobId, existing } = await enqueueLocalJobReporting(queue, {
				folder,
				task: values.task,
				flow: values.flow,
				provider: values.provider,
				model: values.model,
				maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
				// || not the raw value: `--image ""` must collapse to absent rather than becoming a falsy string that
				// throws inside buildDockerRunArgs after a budget slot is reserved.
				image: values.image || undefined,
				now: now(),
			});
			// Issue #530: the closing line used to say "run `pi-dispatch worker` to process it" while workers ran. It now
			// says what this queue shows, asked on the connection the enqueue already holds, and only when a job was queued.
			const hint = existing ? null : await workerHint(queue);
			write(runQueuedLine({ jobId, existing, folder, hint }, { swallowedRunSentence }));
		} catch (error) {
			return fail(error?.valkeyRefused ? error.message : `could not reach Valkey at ${(await import("./connection.mjs")).urlShown(valkeyUrl)}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(valkeyUrl)}\n  ${error.message}`);
		} finally {
			await queue.close().catch(() => {});
		}
		return 0;
	}

	if (cmd === "pause" || cmd === "resume" || cmd === "status") {
		// The kill switch reads ONLY VALKEY_URL, not the full loadConfig -- it must work even when
		// GitHub auth is misconfigured, so an operator can always stop the queue. Which VALKEY_URL (PR #475's review,
		// rounds 1 and 2): `--valkey-url <url>` when the operator names one; else this shell's and the deployment .env's
		// (the one resolver, `valkeyUrlFor`). When those two DISAGREE, a stale export must not make "paused" true of the
		// wrong Valkey (measured: `pause` paused the shell's while the service's kept taking jobs), so the kill switch
		// keeps its promise the safe way: `pause` pauses BOTH and says so, `status` shows both, and `resume`, which would
		// START spending, refuses until the operator names which. Every URL is printed through `urlShown`: a password in
		// one never reaches the terminal.
		const { urlShown } = await import("./connection.mjs");
		// `status --target <item>` (issue #932): what the queue holds for one issue or pull request. Read-only, so it
		// takes the kill switch's URL rule and shows every URL it resolves to, as plain `status` does.
		const picked = await killSwitchUrls(argv.slice(1), env, cmd === "status" ? { target: { type: "string" } } : {}, cwd);
		if (picked.error) return fail(picked.error);
		if (picked.positionals.length > 0) return fail(`pi-dispatch ${cmd} takes no argument but ${cmd === "status" ? "--target <item> and " : ""}--valkey-url <url> (got ${picked.positionals.map((p) => JSON.stringify(p)).join(" ")})`);
		let item = null;
		if (picked.values?.target !== undefined) {
			const { parseSemanticItem } = await import("./forges.mjs");
			item = parseSemanticItem(picked.values.target);
			if (item === null) return fail("--target takes an issue or pull request as the queue names it: owner/repo#12, or group/project!7 for a GitLab merge request or an Azure DevOps pull request");
		}
		if (picked.urls.length > 1) {
			if (cmd === "resume") return fail(`${picked.disagreement}: resume would start jobs on one of them, so it names neither. Say which: pi-dispatch resume --valkey-url <url>`);
			process.stderr.write(`warning: ${picked.disagreement}: ${cmd === "pause" ? "pausing both" : "showing both"}\n`);
		}
		// Issue #964: a pause or resume also flips this host's own queue, on the deployment's Valkey alone: the one this
		// command reaches with no --valkey-url (the `.env`'s on a disagreement), so never the shell's, and never a
		// --valkey-url that names another: this host's worker drains neither, and a pause there would write a meta key every
		// later scan of it lists.
		const own = cmd === "pause" || cmd === "resume" ? await ownQueueOf(env, cwd) : { names: [], problem: null };
		const ownAt = own.names.length > 0 || own.problem ? await deploymentValkeyUrl(env, cwd, picked.urls, urlShown) : null;
		let code = 0;
		for (const url of picked.urls) {
			const label = picked.urls.length > 1 ? `[${urlShown(url)}] ` : "";
			code = Math.max(code, item !== null
				? await targetStatus(item, url, { env, write, label, urlShown, valkeyRefusal, now, controlClients, deadlineMs: statusDeadlineMs })
				: await killSwitch(cmd, url, { env, write, label, urlShown, valkeyRefusal, now, controlClients, cwd, own: url === ownAt ? own : null, deadlineMs: statusDeadlineMs }));
		}
		return code;
	}

	if (cmd === "capacity") {
		// Read-only, and on the kill switch's footing: the Valkey URL and the logs directory, never loadConfig (issue #599).
		const { runCapacity } = await import("./capacity-cli.mjs");
		return runCapacity(argv.slice(1), { env, write, valkeyRefusal, deploymentEnv: cliDeploymentEnv });
	}

	if (cmd === "cancel") {
		// The kill switch's doctrine (issue #287): VALKEY_URL only, never loadConfig, so one misbehaving
		// job can be stopped even when everything else about the deployment is misconfigured. On a shell/.env
		// disagreement it refuses until the operator names which (PR #475's review): a job id belongs to one Valkey.
		const picked = await killSwitchUrls(argv.slice(1), env);
		if (picked.error) return fail(picked.error);
		if (picked.positionals.length > 1) return fail(`pi-dispatch cancel takes one job id (got ${picked.positionals.map((p) => JSON.stringify(p)).join(" ")})`);
		const jobId = picked.positionals[0];
		if (picked.urls.length > 1) return fail(`${picked.disagreement}: a job lives in one of them. Say which: pi-dispatch cancel ${jobId ?? "<jobId>"} --valkey-url <url>`);
		const { runCancel } = await import("./cancel-cli.mjs");
		return runCancel(jobId, picked.urls[0], { write });
	}

	if (cmd === "steer") {
		// cancel's footing (issue #646): VALKEY_URL only, the kill switch's resolver, and a refusal on a shell/.env
		// disagreement, since a job id belongs to one Valkey. parseArgs is strict, so a word of the message that looks
		// like a flag is refused rather than silently dropped from the text; `--` or stdin is the way to send one.
		const picked = await killSwitchUrls(argv.slice(1), env, { later: { type: "boolean", default: false }, withdraw: { type: "boolean", default: false } });
		if (picked.error) return fail(/^Unknown option|^Option '/.test(picked.error) ? `${picked.error}\n  A message word that starts with a dash needs -- before the text, or pass - and pipe the text on stdin. Nothing was sent` : picked.error);
		if (picked.urls.length > 1) return fail(`${picked.disagreement}: a job lives in one of them. Say which: pi-dispatch steer ${picked.positionals[0] ?? "<jobId>"} --valkey-url <url> ...`);
		const { runSteer } = await import("./steer-cli.mjs");
		return runSteer({ positionals: picked.positionals, later: picked.values.later, withdraw: picked.values.withdraw }, picked.urls[0], { write });
	}

	if (cmd === "chat") {
		// Through the operator console (issue #647): its cookie login, its run lookup and its actions, never Valkey, so a
		// terminal behind an SSH tunnel needs nothing else. The fork mode reads this host's session store directly.
		const { runChat } = await import("./chat-cli.mjs");
		return runChat(argv.slice(1), { env, out: (line) => write(`${line}\n`), err: (line) => writeErr(`${line}\n`), deploymentEnv: cliDeploymentEnv });
	}

	write(`${USAGE}\n`);
	return cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0; // asked-for help is success; a typo is not (the receiver's rule)
}

/**
 * The Valkey(s) a kill-switch verb acts on: the one rule of `killSwitchValkeyUrls` (valkey-endpoint.mjs), shared with the
 * panel. The verb's own flags are parsed with parseArgs over what follows the verb (PR #475's review, round 3: a hand
 * scan took `--valkey-url` for the job id in `cancel --valkey-url URL j1`). `extraOptions` adds a verb's own parseArgs
 * flags (steer's `--later` and `--withdraw`), returned in `values`. `{ urls, disagreement, positionals, values }` or
 * `{ error }`; a note (a URL that matches neither side) is written to stderr.
 */
async function killSwitchUrls(args, env, extraOptions = {}, cwd = undefined) {
	let parsed;
	try {
		parsed = parseArgs({ args, allowPositionals: true, options: { ...extraOptions, "valkey-url": { type: "string" } } });
	} catch (error) {
		return { error: error.message };
	}
	const { killSwitchValkeyUrls } = await import("./connection.mjs");
	const picked = killSwitchValkeyUrls({ env, flagUrl: parsed.values["valkey-url"] ?? null, ...(cwd ? { cwd } : {}) });
	if (picked.error) return picked;
	if (picked.note) process.stderr.write(`warning: ${picked.note}\n`);
	return { ...picked, positionals: parsed.positionals, values: parsed.values };
}

/**
 * `pi-dispatch run --trigger <cron id>` (issue #505): fire one cron trigger now, once, as its schedule would. Typed by
 * an operator only; no tool calls it. It is the way to run a `run.portfolio` job without waiting for its schedule
 * (`pi-dispatch run <folder>` makes a manual job, which never carries the flag).
 *
 * WHICH FILE: `PI_TRIGGERS_FILE`, else `./triggers.json` in this directory, doctor's rule (`triggersPath`) and the
 * one-shot rule the worker's own live checks read by, so the command and the worker's check of the portfolio flag
 * read one file. Not `config.triggersFile`, whose null means "the worker schedules no cron": a trigger fired by hand
 * does not need the worker's scheduler.
 *
 * WHAT IS QUEUED: the trigger's own scheduler entry, from `loadSchedules` over that file (so a file the worker would
 * refuse is refused here, with the loader's message), and its data passed through whole. Nothing on the command line
 * can change it, so every other `run` flag is refused beside `--trigger`. The job id is `manual:<id>:<minute>`,
 * deduplicated through the same read back as `pi-dispatch run`.
 *
 * WHERE: on the queue the worker of this host schedules the trigger on (its own host queue when the deployment
 * declares a name, else the shared one), because the trigger's folder is on this machine. A trigger whose folder is
 * not here belongs to another host, and is refused with the command to run there: queued here, no worker could run it.
 */
async function runTrigger(values, positionals, env, { write, valkeyRefusal, now }) {
	const id = values.trigger;
	const extra = ["task", "flow", "provider", "model", "max-turns", "image"].filter((k) => values[k] !== undefined);
	if (values.force) extra.push("force");
	if (positionals.length > 0 || extra.length > 0) {
		return fail(`--trigger takes no folder and no other flag (got ${[...positionals.map((p) => JSON.stringify(p)), ...extra.map((k) => `--${k}`)].join(" ")}): the trigger's own fields are what runs. Nothing was queued.`);
	}
	// PI_TRIGGERS_FILE and PI_WORKER_NAME by the deployment's rule (review of PR #575), the one VALKEY_URL is read by
	// below: which file and which host queue are the deployment's facts, and a shell that does not export them must not
	// read ./triggers.json or queue on the shared queue while the service uses the `.env`'s. PI_MAX_COST_USD too: it is
	// the one other config value the worker's trigger loader (`loadSchedules`) accepts or refuses a file by (a trigger's
	// `run.maxCostUsd` above it), so this command refuses exactly the files the worker refuses. `fleet` is the declared
	// PI_WORKER_NAME, already here. Keep this list equal to the loader's config inputs.
	const deployment = cliDeploymentEnv(env, TRIGGER_LOADER_ENV_KEYS);
	if (deployment.problem) return fail(`${deployment.problem}. Nothing was queued.`);
	const { triggersPath } = await import("./doctor.mjs");
	const path = triggersPath(deployment.env, process.cwd());
	if (path === "" || !existsSync(path)) return fail(`no triggers file at ${path === "" ? "(PI_TRIGGERS_FILE is empty)" : path}. Set PI_TRIGGERS_FILE or run this from the deployment folder. Nothing was queued.`);

	const config = loadConfig(deployment.env);
	const { loadSchedules } = await import("./schedules.mjs");
	let schedule;
	try {
		// One read, validated whole by the shared loader (so a file the worker would refuse is refused here, with its
		// message). The cron schedule is looked up FIRST: only when no cron trigger has this id is the raw file asked
		// whether a webhook entry carries it, so a webhook entry spelling the same id never hides the cron trigger.
		const text = readFileSync(path, "utf8");
		schedule = loadSchedules({ ...config, triggersFile: path }, { readFileSync: () => text, fleet: config.workerNameDeclared }).find((s) => s.schedulerId === id);
		if (!schedule) {
			const named = JSON.parse(text).triggers.find((t) => t?.on?.id === id && t.on.type !== "cron");
			if (named) return fail(`trigger "${id}" is a ${String(named.on.type)} trigger: only a cron trigger can be fired by hand. Nothing was queued.`);
		}
	} catch (error) {
		return fail(`${error?.message ?? error}. Nothing was queued.`);
	}
	if (!schedule) return fail(`no cron trigger with id "${id}" in ${path}. Nothing was queued.`);
	if (schedule.unserved === "worker-mismatch") return fail(`cron trigger "${id}" belongs to its declared run.worker. Run this command on that worker host. Nothing was queued.`);
	if (schedule.unserved) return fail(`cron trigger "${id}" runs on another host: its folder is not on this machine. Run this command on the host that has the folder. Nothing was queued.`);
	// The worker's folder rule, `run <folder>`'s check (issue #524): `.git` at the folder and a commit at HEAD, or the job
	// is refused at pickup. Uncommitted changes stay allowed, as they are for every scheduled tick.
	const notARepo = localRepoProblem(schedule.data.folder);
	if (notARepo) return fail(`cron trigger "${id}": ${notARepo} Nothing was queued.`);

	const { cliValkeyUrl, parseConnection } = await import("./connection.mjs");
	const valkeyUrl = cliValkeyUrl(env);
	const { makeQueue, enqueueTriggerRunReporting, hostQueueName, swallowedRunSentence } = await import("./queue.mjs");
	// The queue the worker of this host schedules this trigger on (start.mjs: `cronQueue`).
	const hq = config.workerNameDeclared ? hostQueueName(config.workerName) : null;
	const refused = await valkeyRefusal(valkeyUrl, env);
	if (refused) return fail(refused);
	const queue = makeQueue(parseConnection(valkeyUrl, { failFast: true }), { ...(hq ? { name: hq } : {}) });
	try {
		const { id: jobId, existing } = await enqueueTriggerRunReporting(queue, schedule, { now: now() });
		const hint = existing ? null : await workerHint(queue);
		write(runQueuedLine({ jobId, existing, trigger: id, hint }, { swallowedRunSentence }));
	} catch (error) {
		return fail(error?.valkeyRefused ? error.message : `could not reach Valkey at ${(await import("./connection.mjs")).urlShown(valkeyUrl)}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(valkeyUrl)}\n  ${error.message}`);
	} finally {
		await queue.close().catch(() => {});
	}
	return 0;
}

/**
 * The env keys `run --trigger` resolves from the deployment: the file, the host, and every config value the worker's
 * trigger loader (`loadSchedules`: `triggersFile`, `maxCostUsd`, and `fleet` from a declared worker name) judges a file by.
 * Kept in config.mjs beside `triggerLoaderConfig`, which reads exactly these (issue #970), and re-exported here.
 */
export { TRIGGER_LOADER_ENV_KEYS };

/** `workerHint`'s line when the queue cannot say, true whether or not a worker runs. */
export const WORKER_HINT_UNKNOWN = "a worker picks it up; start one with `pi-dispatch worker` if none is running.";

/**
 * `run`'s closing line (issue #530): true with or without a running worker.
 *
 * It asks the queue the job went to, on the connection the enqueue already opened: `getWorkers()` (one CLIENT LIST,
 * matched on the client names BullMQ gives a Worker of THIS queue, so a named host queue counts only that host's
 * workers) and `isPaused()`. Measured on bullmq 5.80.4: 0 with no Worker, 1 with one, back to 0 once it closed, and
 * the Queue's own client is never counted. A paused queue is said first, since a connected worker does not take a
 * job from it. Any doubt falls back to a line that is true either way:
 *   - either call fails or takes over `timeoutMs` (a Valkey whose ACL refuses CLIENT LIST, one that went away);
 *   - an answer that is not what bullmq returns;
 *   - bullmq's own marker for a server with no CLIENT LIST, a fake row that would read as "1 worker".
 * A server that ignores CLIENT SETNAME lists no worker at all, which is why zero says "shows as connected" and names
 * the command rather than claiming none runs.
 *
 * CLIENT LIST spans every database, and bullmq matches its rows by client NAME alone, so a Worker of a same-named
 * queue on database 8 was counted for a job queued on database 9 (measured in PR #531's review: "1 worker is
 * connected ... will pick it up", and no worker ever would). Only rows whose `db` is the queue client's own count; a
 * row with no `db` field, or a client whose database cannot be read, is a doubt.
 */
export async function workerHint(queue, { timeoutMs = 2000 } = {}) {
	let timer;
	try {
		const answer = Promise.all([queue.getWorkers(), queue.isPaused(), Promise.resolve(queue.client).then((c) => c?.options?.db ?? 0)]);
		answer.catch(() => {});
		const late = new Promise((resolve) => {
			timer = setTimeout(resolve, timeoutMs, null);
		});
		const got = await Promise.race([answer, late]);
		if (got === null) return WORKER_HINT_UNKNOWN;
		const [workers, paused, db] = got;
		if (!Array.isArray(workers) || typeof paused !== "boolean" || !Number.isInteger(Number(db))) return WORKER_HINT_UNKNOWN;
		if (workers.some((w) => w?.name === "GCP does not support client list" || typeof w?.db !== "string")) return WORKER_HINT_UNKNOWN;
		if (paused) return "the queue is paused: no worker takes it until `pi-dispatch resume`.";
		const n = workers.filter((w) => w.db === String(db)).length;
		if (n === 0) return "no worker shows as connected to this queue: start one with `pi-dispatch worker`.";
		return `${n} ${n === 1 ? "worker is" : "workers are"} connected to this queue and will pick it up.`;
	} catch {
		return WORKER_HINT_UNKNOWN;
	} finally {
		clearTimeout(timer);
	}
}

/** One Valkey's pause, resume or status: every queue the deployment drains there (issue #57). Returns the exit code. */
/**
 * `pi-dispatch status --target <item>` (issue #932, target-status.mjs): one JSON line, `{ item, jobs, windows, complete,
 * unavailableQueues }`, over every queue the kill switch would act on (`deploymentQueueNames`), the same discovery and
 * the same loud degraded read (`fleet`, `discoveryIncomplete`, and `queuesMayBeShort` with its sentence under the line
 * since issue #1043). Under plain `status`'s deadline (issue #1003, `statusDeadline`): a queue that has not answered by
 * then is in `unavailableQueues` and `complete` is false, the exit code 0 as before, since `complete` already says the
 * line may be short.
 */
async function targetStatus(item, url, { env, write, label, urlShown, valkeyRefusal, now, controlClients, deadlineMs = STATUS_DEADLINE_MS }) {
	const deadline = statusDeadline(deadlineMs);
	const { parseConnection } = await import("./connection.mjs");
	const { closeWithin, makeQueue } = await import("./queue.mjs");
	const { readTargetStatus, TARGET_STATUS_TIMEOUT_MS } = await import("./target-status.mjs");
	const refused = await valkeyRefusal(url, env, { deadlineAt: deadline.at });
	if (refused) return fail(refused);
	const { names, blind, incomplete } = await deploymentQueueNames(url, controlClients, deadline.within);
	const queues = [];
	// Past the deadline no queue is built, as in `killSwitch`, which says why.
	const spent = deadline.spent();
	try {
		for (const name of names) queues.push(spent ? unansweredQueue(name) : (controlClients.makeQueue ?? makeQueue)({ ...parseConnection(url, { failFast: true }), disconnectTimeout: 0 }, { name }));
		const read = await readTargetStatus(queues, item, { now: () => Number(now()), timeoutMs: deadline.within(TARGET_STATUS_TIMEOUT_MS) });
		const degraded = blind !== null || incomplete;
		// `queuesMayBeShort` and the sentence as plain `status` has them (issue #1043): `complete` is false for a cut read
		// too, so it alone does not say that a queue may be missing from the list.
		write(`${JSON.stringify({ ...(label ? { valkey: urlShown(url) } : {}), ...read, ...(degraded ? { complete: false, discoveryIncomplete: true, queuesMayBeShort: true } : {}), ...(blind ? { fleet: blind } : {}) })}\n`);
		if (degraded) process.stderr.write(`warning: ${label}${statusShortNote(true)}\n`);
	} catch (error) {
		return fail(error?.valkeyRefused ? error.message : `could not reach Valkey at ${urlShown(url)}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(url)}\n  ${error.message}`);
	} finally {
		// `killSwitch`'s bounded close: BullMQ's QUIT on a Valkey that stopped answering after a queue was ready held the
		// command open after its line (issue #1003).
		await Promise.all(queues.map((q) => closeWithin(q, deadline.within(KILL_SWITCH_CLOSE_TIMEOUT_MS))));
	}
	return 0;
}

/**
 * Every queue this deployment drains, the kill switch's discovery (issue #57): the registry's live hosts and BullMQ's
 * own meta keys, read concurrently on one budget, failing open to the shared queue and saying so (`blind`, the
 * registry's error, and `incomplete`, a keyspace scan that did not finish). `within` holds each read to a deadline
 * (`statusDeadline`); the probe drops its socket with a disconnect timeout of 0, as `killSwitch`'s does.
 */
async function deploymentQueueNames(url, controlClients, within = (ms) => ms) {
	const { makeRedisClient } = await import("./connection.mjs");
	const { fleetQueueNames, discoverHostQueuesReporting, unionQueueNames } = await import("./queue.mjs");
	const { readLiveHosts } = await import("./host-registry.mjs");
	const probe = (controlClients.makeRedisClient ?? makeRedisClient)(url, { disconnectTimeoutMs: 0 });
	probe.on?.("error", () => {});
	const [fleet, existing] = await Promise.all([
		readLiveHosts(probe, { timeoutMs: within(FLEET_READ_TIMEOUT_MS) }).catch((error) => ({ unreachable: error?.message ?? String(error) })),
		discoverHostQueuesReporting(probe, { timeoutMs: within(FLEET_READ_TIMEOUT_MS) }),
	]);
	probe.disconnect?.();
	return { names: unionQueueNames(fleetQueueNames(fleet?.hosts), existing.names), blind: fleet?.unreachable ?? null, incomplete: Boolean(existing?.incomplete), existing };
}

/**
 * The fleet's sentence for a pause or resume whose set of queues may be short (issue #964): the console's
 * `switchShortNote` (admin/src/words.mjs), held equal to it by a test, since the CLI does not import the admin.
 */
export function killSwitchShortNote(paused) {
	return `the list of queues may be short: the host registry or the look for queues could not be read, so other queues may exist and were not ${paused ? "paused" : "resumed"}. ${paused ? "Pause" : "Resume"} the fleet again once Valkey answers`;
}

/**
 * `status`'s sentence for a line whose list of queues may be short (issue #1043), the fleet's (`killSwitchShortNote`,
 * issue #964) for a read: the queues it did not find are in none of its sums (`target`: `status --target`, none of its
 * jobs and windows), and what to do.
 */
export function statusShortNote(target) {
	return `the list of queues may be short: the host registry or the look for queues could not be read, so other queues may exist and ${target ? "the line above leaves out what they hold" : "the sums above leave them out"}. Run pi-dispatch status again once Valkey answers`;
}

/**
 * This host's own queue for the kill switch (issue #964), `{ names, problem }`: `pi-jobs@<name>` when the deployment's
 * `.env` in `cwd` declares PI_WORKER_NAME, by the worker's own rule (`workerName`), else none. The file's value alone:
 * the worker service reads that file and its value beats one injected around it, so a name this shell sets otherwise, or
 * sets where the file has none, names no queue the worker drains. Never the hostname an unnamed worker falls back to:
 * that worker drains only the shared queue, and a pause of `pi-jobs@<hostname>` would write a meta key every later scan
 * lists as a queue. A name that cannot be told, or one the worker refuses, is `problem`, which the line names; the kill
 * switch never refuses for it.
 */
async function ownQueueOf(env, cwd) {
	const res = deploymentServiceEnv({ env: {}, dir: cwd, keys: ["PI_WORKER_NAME"], fs: nodeFs });
	const shell = typeof env.PI_WORKER_NAME === "string" ? env.PI_WORKER_NAME : undefined;
	if (res.untrusted || res.unreadable) return { names: [], problem: `${res.path} ${res.untrusted ?? `could not be read (${res.unreadable})`}, so PI_WORKER_NAME cannot be told` };
	if (res.unread.length > 0 || res.hazardSkipped.length > 0) return { names: [], problem: `${res.path} has a line for PI_WORKER_NAME that the service's loader may read differently, so it cannot be told (pi-dispatch doctor names the line)` };
	const file = res.fromFile.PI_WORKER_NAME;
	if (typeof file !== "string" || file === "") return { names: [], problem: shell !== undefined && shell !== "" ? `PI_WORKER_NAME is set in this shell and not in ${res.path}, which the service reads` : null };
	if (shell !== undefined && shell !== file) return { names: [], problem: `PI_WORKER_NAME is ${JSON.stringify(shell)} in this shell and ${JSON.stringify(file)} in ${res.path}: make them agree (the service runs the file's)` };
	const { hostQueueName } = await import("./queue.mjs");
	try {
		return { names: [hostQueueName(workerName({ PI_WORKER_NAME: file }))], problem: null };
	} catch (error) {
		return { names: [], problem: error.message };
	}
}

/**
 * Which of `urls` is the deployment's Valkey (issue #964): the one this command reaches with no --valkey-url, the `.env`'s
 * on a disagreement (the second, `killSwitchValkeyUrls`'s order), compared as `urlShown` prints them. Null when none of
 * `urls` is it: a --valkey-url that names the shell's or another Valkey.
 */
async function deploymentValkeyUrl(env, cwd, urls, urlShown) {
	const { killSwitchValkeyUrls } = await import("./connection.mjs");
	const base = killSwitchValkeyUrls({ env, ...(cwd ? { cwd } : {}) });
	if (base.error || !Array.isArray(base.urls) || base.urls.length === 0) return null;
	const at = urlShown(base.urls.length > 1 ? base.urls[1] : base.urls[0]);
	return urls.find((u) => urlShown(u) === at) ?? null;
}

async function killSwitch(cmd, url, { env, write, label, urlShown, valkeyRefusal, now, controlClients, cwd = process.cwd(), own = null, deadlineMs = STATUS_DEADLINE_MS }) {
	// Its own discovery, not `deploymentQueueNames`: `status` also reads consumer health (issue #924) through the same
	// probe before it is closed, so this keeps the probe open across both reads.
	const { parseConnection, makeRedisClient } = await import("./connection.mjs");
	const { closeWithin, fleetQueueNames, discoverHostQueuesReporting, unionQueueNames, makeQueue } = await import("./queue.mjs");
	const { readLiveHosts } = await import("./host-registry.mjs");
	// One deadline over everything each verb asks of this Valkey (`statusDeadline`), from here, before the refusal check:
	// `status`'s reads since issue #1003, and `pause`'s and `resume`'s discovery and writes since issue #1007, which
	// waited for as long as a Valkey that took the connection and stopped answering stayed so, printed nothing, and could
	// leave the deployment half switched without saying so. A write the deadline cuts short is reported for what it is
	// (`switchQueue`), never as done and never as "nothing changed". `within` is a read's or a write's bound: its own,
	// or what is left of the deadline when that is sooner.
	const status = cmd === "status";
	const deadline = statusDeadline(deadlineMs);
	const within = deadline.within;
	const { readConsumerStatus, CONSUMER_READ_TIMEOUT_MS } = status ? await import("./consumer-status.mjs") : {};
	const { readPollerFacts } = status ? await import("./poller-facts.mjs") : {};
	// EVERY queue this deployment drains (issue #57), not just the shared one. This is the kill switch:
	// pausing `pi-jobs` alone would stop forge deliveries while a named host's cron, chained children
	// and manual runs kept spending -- and would print "paused" for having done it. That is the silent
	// no-op the comment here already warned about for a mistyped name, arriving through a new door.
	//
	// Both reads fail OPEN -- between them an unreadable registry and an unreadable keyspace yield the
	// shared queue alone, which is exactly what this command did before, so a Valkey blip can never make
	// the kill switch refuse. But it fails open LOUDLY: a degraded read is NAMED in the output rather
	// than left indistinguishable from a single-host success while a named host keeps spending.
	// `readLiveHosts` RETURNS `{unreachable}` rather than rejecting, so `blind` is a branch on its
	// value and the `.catch` below is only for a client that throws before it can answer.
	const refused = await valkeyRefusal(url, env, { deadlineAt: deadline.at });
	if (refused) return fail(refused);
	// A disconnect timeout of 0 (`makeRedisClient`'s, issue #599), as `cancel`'s probe has: ioredis' default arms a ref'd
	// two-second timer at `disconnect()` that only the socket's close clears, and a Valkey that answers nothing never
	// closes it, so the command outlived its last line by those two seconds (issue #1003).
	const probe = (controlClients.makeRedisClient ?? makeRedisClient)(url, { disconnectTimeoutMs: 0 });
	// Without this, a down Valkey dumps nine `[ioredis] Unhandled error event` traces before the one clean
	// line -- the exact noise `defaultProbeValkey` exists to suppress. The last error is kept for `status`'s closing
	// sentence (issue #1003): a connection that never came up ("nothing answers VALKEY_URL ...") is said as such, where
	// the reads alone would only say they ran out of time.
	let connectionError = null;
	probe.on?.("error", (error) => { connectionError = error?.message ?? String(error); });
	// Both reads, concurrently, sharing one budget. The registry answers WHO IS LIVE; BullMQ's own meta
	// keys answer WHICH QUEUES EXIST, and for a kill switch the second is the question that matters. A
	// host whose registry writes fail for ninety seconds loses its row while its worker keeps draining,
	// and a resume that misses a queue leaves it paused forever with no surface able to name it. A meta
	// key outlives its worker; a registry row does not.
	// The pollers' heartbeats (issue #970) beside them, on the same probe, with this deployment's GITHUB_INGEST and its own
	// triggers file: they need nothing the other two answer, and read after them they made a Valkey that never answers
	// wait one bound longer. Never a reason for status to fail: what cannot be read is said in `pollers` itself.
	// On a resume, this host's own queue's meta key beside them (`ownQueuesThatExist`, issue #1007): a scan that did not
	// finish may not name it, and the resume then left it paused without a word. On a connection of its own (issue #1042):
	// Valkey answers one connection's commands in order, so on the probe it waited behind a scan that stalled, which is
	// when it is needed. A scan that finished answers the question itself, so the look is not waited for once it has. The
	// registry is asked first, as before, so its list of hosts goes ahead of the scan on the probe; each host's row is
	// read after that list, and so behind a scan that stalls.
	const registry = readLiveHosts(probe, { timeoutMs: within(FLEET_READ_TIMEOUT_MS) }).catch((error) => ({ unreachable: error?.message ?? String(error) }));
	const discovery = discoverHostQueuesReporting(probe, { timeoutMs: within(FLEET_READ_TIMEOUT_MS) });
	const [fleet, existing, pollers, ownFound] = await Promise.all([
		registry,
		discovery,
		status ? readPollerFacts(probe, { env, cwd, now: () => Number(now()), timeoutMs: within(FLEET_READ_TIMEOUT_MS) }).catch(() => ({ expected: null, hosts: [], complete: false })) : null,
		cmd === "resume" ? ownQueuesThatExist(() => (controlClients.makeRedisClient ?? makeRedisClient)(url, { disconnectTimeoutMs: 0 }), own?.names ?? [], within(FLEET_READ_TIMEOUT_MS), discovery.then((found) => !found?.incomplete, () => false)) : { found: [], unread: [] },
	]);
	// Consumer demand (issue #924) is read beside the queue reads below rather than before them, so a demand read that
	// does not answer cannot spend the queues' share of the deadline. The probe stays open until it ends (the `finally`);
	// `pause` and `resume` are done with it here.
	const consumersRead = status ? readConsumerStatus(probe, fleet?.hosts ?? [], { now: () => Number(now()), timeoutMs: within(CONSUMER_READ_TIMEOUT_MS) }) : null;
	if (!status) probe.disconnect?.();
	const blind = fleet?.unreachable ?? null;
	// With this host's own queue on a pause (issue #964, `ownQueueOf`), which a registry or a scan that did not answer cannot
	// name. On a resume only where it exists, by discovery or by its own meta key (`ownFound`, issue #1007): a queue that
	// does not exist has nothing to resume, and a queue built to resume it would write its meta key.
	const names = unionQueueNames(fleetQueueNames(fleet?.hosts), [...existing.names, ...(cmd === "pause" ? own?.names ?? [] : ownFound.found)]);
	// This host's own queue whose meta key did not answer, where the scan did not finish and did not name it (issue #1042):
	// whether it exists is not known, so it may be paused and stay so, and the report names it as not resumed. A scan that
	// finished is the answer: a queue it did not name has no meta key.
	const ownUnread = existing?.incomplete ? ownFound.unread.filter(({ name }) => !names.includes(name)) : [];
	// The registry being unreadable no longer means we saw one queue: the keyspace scan may well have
	// found them. Report the count we ACTED on, and name the degraded read separately, the scan's too (issue #964), on the
	// line of a whole switch and on the first line of `switchReport`'s (issue #1007).
	const ownNote = own?.problem ? ` [this host's queue not added: ${own.problem}]` : "";
	const span = `${names.length > 1 ? ` [${names.length} queues]` : ""}${blind ? ` [registry unreadable: ${blind}]` : ""}${existing?.incomplete ? " [queue scan incomplete]" : ""}${ownNote}`;
	// What a set that may be short means, and what to do (issue #964), under the line of a switch that confirmed every
	// queue it found; the exit code stays 0, as the console answers that switch. `switchReport` says it otherwise.
	const short = blind || existing?.incomplete ? `\n${label}  but ${killSwitchShortNote(cmd === "pause")}` : "";
	const queues = [];
	// Once the deadline is spent (a Valkey that answered nothing to the PING) no queue is built: a queue closed in
	// the tick it was built is closed while its socket is still opening, and ioredis then prints the ready check that
	// fails on it as an unhandled error, since BullMQ has stopped listening. A stand-in that never answers takes its
	// place, so every read below says unread in its own words, as it would have of the real queue.
	const spent = deadline.spent();
	try {
		// Constructed INSIDE the try: `makeQueue` can throw on a malformed peer-written name, and a throw
		// at index k > 0 would otherwise leak the k connections already opened. The disconnect timeout is the probe's.
		for (const name of names) queues.push(spent ? unansweredQueue(name) : (controlClients.makeQueue ?? makeQueue)({ ...parseConnection(url, { failFast: true }), disconnectTimeout: 0 }, { name }));
		if (cmd === "pause" || cmd === "resume") {
			// A switch that did not reach every queue leaves the deployment HALF switched. Naming what each queue is now is
			// the whole difference between an operator who knows to finish the job and one who reads "unreachable" as
			// "nothing happened" and walks away from a fleet with one host still spending (issue #1007: the line that said
			// so came only from a queue whose write failed, never from one that was never answered).
			const steps = await switchQueues(queues, cmd, () => within(deadlineMs), deadlineMs / 1000);
			// A queue it found and did not confirm is a failure, exit 1 (issue #1007), and so is this host's own queue whose
			// meta key did not answer (`ownUnread`, issue #1042), reported as not sent. A list that may be short, beside a
			// switch that confirmed every queue it found, is not: it is said (`short`, issue #964), as the console says it over
			// its answer that the fleet was paused.
			if (steps.some((step) => step.state !== "confirmed") || ownUnread.length > 0) {
				return fail(switchReport({ cmd, shown: urlShown(url), names: [...names, ...ownUnread.map(({ name }) => name)], steps: [...steps, ...ownUnread.map(({ why, answered }) => ({ state: "not-sent", why, ...(answered ? { answered: true } : {}) }))], blind, incomplete: Boolean(existing?.incomplete), ownNote }));
			}
			write(`${label}${cmd === "pause" ? `paused: worker will stop taking new jobs (jobs still enqueue)${span}` : `resumed${span}`}${short}\n`);
		} else {
			// "paused" is included in the counts because jobs enqueued while paused land in the
			// `paused` list, not `wait` -- omitting it would report backlog 0 in the exact state
			// the pause switch creates. `pausedState` (the boolean) is named apart from the
			// `paused` count `getJobCounts` returns, so the two do not collide in the output.
			// The three reads at once, each ending by the deadline (issue #1003). A queue whose paused state or counts has not
			// answered by then is null here, never a zero or a running queue: "wait until status shows no active job" must not
			// be satisfied by a count nobody read.
			const { readStatusWaiting, STATUS_WAITING_TIMEOUT_MS } = await import("./status-waiting.mjs");
			const [states, per, waiting, consumers] = await Promise.all([
				answeredWithin(queues.map((q) => q.isPaused()), within(deadlineMs)),
				answeredWithin(queues.map((q) => q.getJobCounts("waiting", "active", "paused", "delayed", "failed")), within(deadlineMs)),
				readStatusWaiting(queues, { now: () => Number(now()), timeoutMs: within(STATUS_WAITING_TIMEOUT_MS) }),
				consumersRead,
			]);
			const unread = names.filter((_, i) => states[i] === null || per[i] === null);
			const counts = per.reduce((acc, c) => {
				for (const [k, v] of Object.entries(c ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
				return acc;
			}, {});
			// Summed counts with a boolean from ONE queue would report a half-paused deployment as fully
			// one or fully the other. `pausedPartial` is the third state, and the dangerous direction is
			// the one it makes visible: pause ran while a host was invisible, so that host still spends.
			// A queue that did not answer settles nothing: `pausedState` is false once one queue that answered is running,
			// and null when every queue that answered is paused but another did not answer, since that one may be running.
			const known = states.filter((s) => s !== null);
			const pausedState = known.includes(false) ? false : known.length === states.length ? true : null;
			const pausedPartial = known.includes(true) && known.includes(false);
			if (blind || existing?.incomplete) { waiting.partial = true; waiting.discoveryIncomplete = true; }
			// A list that may be short (issue #1043): the registry or the scan did not finish, so a queue it did not find is in
			// none of the sums, and only `waitingDetails` said so. `queuesMayBeShort` says it at the top, the agent tools' flag
			// for a switch over such a list (issue #964), and the sentence goes under the line. A queue it found and did not
			// read is `partial`, exit 1; a list that may be short is not a failure by itself, as #964 has it for a switch.
			const listMayBeShort = blind !== null || Boolean(existing?.incomplete);
			const out = { ...(label ? { valkey: urlShown(url) } : {}), pausedState, ...(pausedPartial ? { pausedPartial, pausedQueues: names.filter((_, i) => states[i] === true) } : {}), ...counts, ...(unread.length > 0 ? { partial: true, unavailableQueues: unread } : {}), ...(listMayBeShort ? { queuesMayBeShort: true } : {}), ...(blind ? { fleet: blind } : {}), waitingDetails: waiting, consumers, pollers };
			write(`${JSON.stringify(out)}\n`);
			if (listMayBeShort) process.stderr.write(`warning: ${label}${statusShortNote(false)}\n`);
			// The line is printed with what was read, and the exit code says status could not read what it exists to say,
			// as it does for a Valkey that refuses the connection. "Is it running?" only when nothing at all answered.
			if (unread.length > 0) {
				const answeredNothing = states.every((x) => x === null) && per.every((x) => x === null) && blind !== null && Boolean(existing?.incomplete);
				return fail(statusShortfall({ shown: urlShown(url), seconds: deadlineMs / 1000, hint: (await import("./valkey-auth.mjs")).valkeyDownHint(url), connectionError, answeredNothing, names, states, per }));
			}
		}
	} catch (error) {
		return fail(error?.valkeyRefused ? error.message : `could not reach Valkey at ${urlShown(url)}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(url)}\n  ${error.message}`);
	} finally {
		if (status) probe.disconnect?.();
		// Bounded (issue #1003): BullMQ's close sends QUIT and waits for the answer, so a Valkey that stopped answering
		// after a queue's connection was ready held the command open here, after its line was printed. The close ends by
		// the deadline too, for every verb (issues #1003 and #1007), so a spent one drops the connection at once.
		await Promise.all(queues.map((q) => closeWithin(q, within(KILL_SWITCH_CLOSE_TIMEOUT_MS))));
	}
	return 0;
}

/**
 * The kill switch verbs' one deadline over a Valkey (issues #1003 and #1007, `STATUS_DEADLINE_MS`), from the moment
 * this is called, on the monotonic clock. `at` is the deadline as a `performance.now()` instant; `within(ownMs)` is a read's bound, its own or
 * what is left when that is sooner, never below 1 ms (`readStatusWaiting` and `readTargetStatus` take 0 as "use the
 * default", which would give a read its whole time again after the deadline passed); `spent()` says nothing is left.
 */
function statusDeadline(deadlineMs) {
	const at = performance.now() + deadlineMs;
	// "Nothing is left" is less than `KILL_SWITCH_QUEUE_MIN_MS`, the least a queue can use.
	return { at, within: (ownMs) => Math.max(1, Math.min(ownMs, Math.round(at - performance.now()))), spent: () => at - performance.now() < KILL_SWITCH_QUEUE_MIN_MS };
}

/**
 * `status`'s closing sentence when its line leaves something out (issue #1003): whether the Valkey answered anything
 * (the "is it running?" `hint` only when nothing did), the connection's own error where the probe saw one, and per
 * queue exactly what is missing: its paused state, its counts, or both. `states` and `per` hold null for a read that
 * did not answer.
 */
function statusShortfall({ shown, seconds, hint, connectionError = null, answeredNothing, names, states, per }) {
	const both = names.filter((_, i) => states[i] === null && per[i] === null);
	const pausedOnly = names.filter((_, i) => states[i] === null && per[i] !== null);
	const countsOnly = names.filter((_, i) => states[i] !== null && per[i] === null);
	const lacks = [
		both.length > 0 ? `the paused state and counts of ${both.join(", ")}` : null,
		pausedOnly.length > 0 ? `the paused state of ${pausedOnly.join(", ")}` : null,
		countsOnly.length > 0 ? `the counts of ${countsOnly.join(", ")}` : null,
	].filter(Boolean).join("; ");
	const head = !answeredNothing
		? `Valkey at ${shown} did not answer every read within ${seconds} seconds`
		: connectionError !== null ? `could not reach Valkey at ${shown}: ${hint}` : `Valkey at ${shown} did not answer within ${seconds} seconds: ${hint}`;
	return `${head}${connectionError !== null ? `\n  ${connectionError}` : ""}\n  the line above leaves out ${lacks}`;
}

/** What `switchQueue` reads a step that ran out of time as. */
const NO_ANSWER = Symbol("no answer");

/**
 * One queue's pause or resume under the kill switch's deadline (issue #1007): `{ state, why? }`, never thrown.
 *   "confirmed"    Valkey answered: the queue is paused (or running).
 *   "unconfirmed"  the write was sent and not answered within `ms`, or failed after it was sent. It may still apply when
 *                  Valkey answers: measured, a pause whose Valkey was stopped (SIGSTOP) as the script reached it applied
 *                  once the Valkey was continued, after the command had given up and exited.
 *   "refused"      Valkey refused it before the script ran (`refusedBeforeScript`): the queue did not change.
 *   "errored"      Valkey answered with any other error, which can follow a switch the script already made. The
 *                  queue's paused state is read back within what is left of `ms`: `reads` is true (paused), false
 *                  (running), or null when that read did not tell; `readUnanswered` is true where it did not answer
 *                  at all (no reply in time, or a connection that failed), never where Valkey answered it with an
 *                  error, which is Valkey answering.
 *   "not-sent"     the queue's connection did not come up within `ms`, or failed first: the write never left.
 * The write is started only once the queue's client is ready, which is what makes "sent" knowable: BullMQ writes it in
 * the same turn then (its client promise has settled, and nothing between the call and ioredis' socket write waits on
 * I/O), while a write started earlier would wait inside BullMQ for a connection that may come up after this command
 * said it was never sent. A failure after the start is read as sent, the safe direction: "not sent" is a promise that
 * nothing will change.
 */
async function switchQueue(q, cmd, ms, seconds) {
	let timer;
	const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, NO_ANSWER); });
	try {
		const ready = await Promise.race([Promise.resolve(q.client).then(() => true, (error) => ({ error })), late]);
		if (ready === NO_ANSWER) return { state: "not-sent", why: `no connection within ${seconds} seconds` };
		if (ready !== true) return { state: "not-sent", why: ready.error?.message ?? String(ready.error) };
		const answer = await Promise.race([Promise.resolve().then(() => (cmd === "pause" ? q.pause() : q.resume())).then(() => true, (error) => ({ error })), late]);
		if (answer === true) return { state: "confirmed" };
		if (answer === NO_ANSWER) return { state: "unconfirmed", why: `no answer within ${seconds} seconds` };
		const why = answer.error?.message ?? String(answer.error);
		if (refusedBeforeScript(answer.error)) return { state: "refused", why };
		if (answer.error?.name !== "ReplyError") return { state: "unconfirmed", why };
		const reads = await Promise.race([Promise.resolve().then(() => q.isPaused()).then((paused) => (typeof paused === "boolean" ? paused : null), (error) => (error?.name === "ReplyError" ? null : NO_ANSWER)), late]);
		return { state: "errored", why, reads: reads === NO_ANSWER ? null : reads, ...(reads === NO_ANSWER ? { readUnanswered: true } : {}) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Pause or resume every queue (issue #1007), one `switchQueue` step each, in `queues`' order. `left()` is what is left
 * of the deadline as each step starts. A PAUSE goes to every queue at once, as the console's does (`flipQueues`, issue
 * #842): each queue has a connection of its own, and the kill switch must not wait out one queue before it tries the
 * next. A RESUME goes one queue after another and stops at the first that is not confirmed, the rest not sent: a resume
 * that lands unobserved when Valkey answers starts jobs, so none is sent after one already in doubt.
 */
async function switchQueues(queues, cmd, left, seconds) {
	if (cmd === "pause") return Promise.all(queues.map((q) => switchQueue(q, cmd, left(), seconds)));
	const steps = [];
	const after = { refused: "not tried after a queue whose resume Valkey refused", errored: "not tried after a queue whose resume Valkey answered with an error" };
	for (const q of queues) {
		const doubt = steps.find((step) => step.state !== "confirmed");
		steps.push(doubt ? { state: "not-sent", skipped: true, why: after[doubt.state] ?? "not tried after a queue whose resume is not confirmed: a resume that lands later starts jobs" } : await switchQueue(q, cmd, left(), seconds));
	}
	return steps;
}

/**
 * A pause or resume that did not confirm every queue it found (issue #1007): each queue on a line of its own, as
 * confirmed, sent but not confirmed, refused by Valkey, or not sent; "nothing changed" only when no write was sent, never
 * once one was; that the list itself may be short when the registry or the keyspace scan did not answer (a Valkey that
 * stopped answering leaves the shared queue alone in it, the fail-open rule), in the fleet's sentence (issue #964,
 * `killSwitchShortNote`) under the reads named on the first line as a whole switch's line names them; and what to do
 * next. `ownNote` is this host's queue that could not be added, as the whole switch's line says it.
 */
function switchReport({ cmd, shown, names, steps, blind = null, incomplete = false, ownNote = "" }) {
	const done = `${cmd}d`;
	const lines = names.map((name, i) => {
		const { state, why, reads } = steps[i];
		if (state === "confirmed") return `${name}: ${done}`;
		if (state === "unconfirmed") return `${name}: sent, not confirmed (${why}); it may still be ${done} when Valkey answers`;
		if (state === "refused") return `${name}: refused by Valkey, unchanged (${why})`;
		if (state === "errored") return `${name}: Valkey answered with an error (${why}); ${reads === null ? "it may have partly applied" : `it reads ${reads ? "paused" : "running"} now${reads === (cmd === "pause") ? "" : `, and part of the ${cmd} may have applied`}`}`;
		return `${name}: not sent (${why})`;
	});
	// A write that Valkey answered with an error may have applied, so it counts as sent here, as one never answered does.
	if (!steps.some((step) => ["confirmed", "unconfirmed", "errored"].includes(step.state))) lines.push("nothing changed");
	if (blind || incomplete) lines.push(killSwitchShortNote(cmd === "pause"));
	// "Once Valkey answers" only where something waits on it: a write not answered, a read back that did not answer, or a
	// connection that did not come up. A refusal or an error is Valkey's answer, a read back it answered with an error
	// included, and so is an error reply to the look for this host's queue (`answered`, issue #1042): the next step is
	// putting its cause right.
	const pending = steps.some((step) => step.state === "unconfirmed" || (step.state === "errored" && step.readUnanswered === true));
	const waiting = pending || steps.some((step) => step.state === "not-sent" && !step.skipped && !step.answered);
	const failedOn = steps.some((step) => step.state === "refused" || step.state === "errored" || (step.state === "not-sent" && step.answered === true));
	lines.push(`run pi-dispatch status ${waiting ? "once Valkey answers " : ""}to see each queue, then pi-dispatch ${cmd} again${!waiting && failedOn ? " once what Valkey refused or failed on is put right" : ""}${cmd === "resume" && pending ? "; a resume not confirmed may start jobs when it lands" : ""}`);
	const unread = `${blind ? ` [registry unreadable: ${blind}]` : ""}${incomplete ? " [queue scan incomplete]" : ""}`;
	return `could not ${cmd} the whole deployment at ${shown}${unread}${ownNote}\n  ${lines.join("\n  ")}`;
}

/**
 * Which of `names` (this host's own queue, issue #964) have a meta key, read by EXISTS within `ms` (issue #1007): a
 * resume's look at a queue its discovery may not have named, since a scan that did not finish left it paused without a
 * word. EXISTS writes nothing, where a queue built to look would write its meta key. `{ found, unread }`: `found` the
 * names whose key exists, `unread` `{ name, why, answered }` for each whose read did not answer in time or failed (issue
 * #1042), `answered` where Valkey answered it with an error, which the caller names when its scan did not finish
 * either. A name whose key Valkey says is absent is in neither.
 *
 * On a client of its own, `connect()`, made only when there is a name to look for and dropped once it answered: on the
 * probe, the EXISTS waited behind the probe's scan, since Valkey answers one connection's commands in order, so a scan
 * that stalled (the case this look exists for) held it to its bound and the queue stayed paused (issue #1042).
 * `scanned` settles true once the scan finished: that answers the question (a queue the scan did not name has no meta
 * key), so the look ends there with nothing found or unread and its client is dropped, rather than waiting out `ms` on
 * a connection that does not answer while ioredis dials it again and again.
 */
async function ownQueuesThatExist(connect, names, ms, scanned = new Promise(() => {})) {
	if (names.length === 0) return { found: [], unread: [] };
	const { QUEUE_KEY, queueKey } = await import("./bullmq-internals.mjs");
	const unanswered = Symbol("no answer");
	const moot = Symbol("answered by the scan");
	let timer;
	const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, unanswered); });
	let client = null;
	try {
		client = connect();
		client.on?.("error", () => {});
		const asked = Promise.all(names.map((name) => Promise.race([Promise.resolve().then(() => client.exists(queueKey(name, QUEUE_KEY.meta))).then((n) => Number(n) === 1, (error) => ({ error })), late])));
		const got = await Promise.race([asked, Promise.resolve(scanned).then((finished) => (finished === true ? moot : new Promise(() => {})))]);
		if (got === moot) return { found: [], unread: [] };
		const why = (answer) => (answer === unanswered ? "whether it exists could not be read in time" : `whether it exists could not be read: ${answer.error?.message ?? String(answer.error)}`);
		return { found: names.filter((_, i) => got[i] === true), unread: names.flatMap((name, i) => (typeof got[i] === "boolean" ? [] : [{ name, why: why(got[i]), answered: got[i]?.error?.name === "ReplyError" }])) };
	} catch (error) {
		// A client that could not be made (an address it refuses) has answered nothing, as one that never connects.
		return { found: [], unread: names.map((name) => ({ name, why: `whether it exists could not be read: ${error?.message ?? String(error)}` })) };
	} finally {
		clearTimeout(timer);
		client?.disconnect?.();
	}
}

/** A queue that never answers: the kill switch's stand-in for each queue once its deadline is spent (`killSwitch`). */
function unansweredQueue(name) {
	const never = new Promise(() => {});
	return { name, client: never, isPaused: () => never, getJobCounts: () => never, close: async () => {} };
}

/**
 * Each of `reads` as it settled, or null for one that had not answered `ms` after the call (issue #1003): what a read of
 * a Valkey that never answers reads as. One that fails still rejects, as before, so a Valkey that refuses the
 * connection is still said as the connection's error rather than as a line of unread parts.
 */
async function answeredWithin(reads, ms) {
	let timer;
	const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, null); });
	try {
		return await Promise.all(reads.map((read) => Promise.race([read, late])));
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What `run` prints once the queue has answered (issue #524). Three answers, because the queue gives three.
 *
 * A local job's id is derived from the folder, the flow, the task, the model fields and the minute (`localJobId`), so the same `run`
 * twice inside one minute is the same id and the queue keeps the first. That dedup is deliberate (a hasty second
 * Enter must not pay twice) and stays; what changes is that it is said. The time is the first job's own, in this
 * terminal's local time, and the state is the queue's word for it, or "already queued or done" when it could not be
 * read. No flag is offered to force a second job, because none exists: a later minute is a different id.
 * The sentence itself is `queue.mjs`'s, shared with the admin's `/dispatch run`, and handed in because this module
 * imports the queue lazily. `hint` is `workerHint`'s closing line (issue #530); without one, the line true either way.
 */
export function runQueuedLine({ jobId, existing, folder, trigger, hint = WORKER_HINT_UNKNOWN }, { swallowedRunSentence }) {
	// `trigger` (issue #505) is `run --trigger`'s cron id, said in place of the folder.
	if (existing) return `${swallowedRunSentence(jobId, existing)}\n${trigger !== undefined ? "the same trigger queues" : "the same folder and task queue"} a new run from the next minute on.\n`;
	const unknown = existing === undefined ? "could not check whether an identical run from this minute already held this id.\n" : "";
	return `queued ${jobId} for ${trigger !== undefined ? `cron trigger ${trigger}` : `folder ${folder}`}\n${unknown}${hint}\n`;
}

function fail(message) {
	process.stderr.write(`error: ${message}\n`);
	return 1;
}

/**
 * Exit code for an error that escaped main() as a rejection. A tagged config error (loadConfig's
 * `piDispatchConfig`) is a determinate refusal -> EXIT_POLICY (2, never retried); anything else is
 * infra -> 1 (retryable). Mirrors INT-RUNNER-EXIT-CODE-PROTOCOL for the CLI's own exit space.
 */
export function entryExitCode(err) {
	return err?.piDispatchConfig ? EXIT_POLICY : 1;
}

// Entry point when run as a bin. Kept out of the exported main so tests can call main() directly.
if (isEntryModule(import.meta.url)) {
	// A promise nobody handled is printed as its message alone (PR #475's review): Node's own print shows the whole
	// reason, which for a Valkey client's error could carry what it sent.
	installRejectionPrinter();
	// A reader that closes early (`| head -1`) ends the verb quietly instead of with an uncaught EPIPE.
	installStdoutPipeGuard();
	main()
		.then((code) => {
			if (code) process.exitCode = code;
		})
		.catch((err) => {
			process.stderr.write(`error: ${err.message}\n`);
			process.exitCode = entryExitCode(err);
		});
}

/**
 * The refusal of the Valkey at `url`, judged once before a CLI command connects (issue #464, gate round 3), or null. A
 * judgement that may succeed later (nothing answers, a name that does not resolve) is not a refusal: the command's own
 * connect then says it could not reach Valkey. A seam of `main` (`valkeyRefusal`), so a test can stand in for the host.
 * `deadlineAt` (a `performance.now()` instant, `statusDeadline`'s `at`) bounds its PING by what is left of `status`'s
 * deadline when the PING starts (issue #1003), after the address is judged, so the time the judgement takes (its
 * reachability probe, a name lookup) comes out of the PING's share rather than on top of the deadline; without it the
 * PING keeps `valkeyAuthState`'s own five seconds. Its client is
 * then dropped with a disconnect timeout of 0, as status's probe is, so a Valkey that never answered does not hold the
 * command two more seconds after its last line.
 */
async function valkeyRefusalAtStart(url, env, { deadlineAt = null } = {}) {
	const { judgeValkeyAtStart, makeRedisClient, valkeyAuthState, valkeyClientContext } = await import("./connection.mjs");
	const bounded = deadlineAt === null ? {} : { checkAuth: (u, opts) => valkeyAuthState(u, { ...opts, timeoutMs: Math.max(1, Math.round(deadlineAt - performance.now())), makeClient: (v, o) => makeRedisClient(v, { ...o, disconnectTimeoutMs: 0 }) }) };
	try {
		await judgeValkeyAtStart(url, valkeyClientContext({ env }), { waitMs: 0, ...bounded });
		return null;
	} catch (error) {
		return error?.valkeyRefused ? error.message : null;
	}
}
