#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { EXIT_POLICY, installRejectionPrinter, installStdoutPipeGuard } from "./exit-code.mjs";
import { isEntryModule } from "./entry.mjs";
import { gitDirty, localRepoProblem } from "./git-dirty.mjs";
import { imageRefProblem } from "./image-ref.mjs";
import { resolveServiceEnv, serviceEnvFileOf, serviceEnvLoader } from "./service-env.mjs";

/** How long the kill switch waits on the host registry before acting on the shared queue alone. */
const FLEET_READ_TIMEOUT_MS = 2_000;

const USAGE = `pi-dispatch — run pi coding-agent flows on your own folders

  pi-dispatch init         scaffold .env + triggers.json + pause-windows.json + pi-packages.json + subscriptions.json here
  pi-dispatch doctor [--fix] [--live]
                           preflight Docker, Valkey, the job image, and your provider key; --fix offers to run each fix (y/N per action);
                           --live reads the backend declarations back off short-lived real containers (shown in docker ps while they run)
  pi-dispatch up [--yes]   one consented pass: pull+tag the job image, start Valkey, init, doctor
  pi-dispatch setup github mint GitHub App credentials in one browser click (App Manifest flow);
                           every write shown first and individually consented — no --yes here
                           (--webhook-url <URL> | --no-webhook) [--org <org>] [--name <appName>]
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
  pi-dispatch sandbox --list
                           what is still re-openable, for how long, and what is running now

  pi-dispatch worker       drain the queue (run this in another terminal, or as a service)
  pi-dispatch-receiver     webhook receiver for forge triggers, its own bin (see docs/github.md)
  pi-dispatch service <render|install|uninstall|status|start|stop|restart> [--receiver] [--user|--system] [--force]
                           run the worker (or --receiver) as an OS service — the deploy/ templates
                           rendered with this host's real paths, installed user-level;
                           \`service restart --drain\` lets the in-flight job finish first
  pi-dispatch egress render
                           write model-endpoints.conf here from model-endpoints.json (in place), then print
                           the command that reloads the egress proxy; it never reloads the proxy itself
  pi-dispatch pause        stop taking new jobs (durable; survives worker restart)
  pi-dispatch resume       resume taking jobs
  pi-dispatch status       show paused state + job counts
  pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json]
                           how busy each host was: busy and idle time, slots in use, memory and CPU
                           promised and used, waits and projects, read from the run records (jobs only)
  pi-dispatch cancel <jobId>  stop one job: a queued or held job is removed (the line says whether it had
                           made attempts; cancel records nothing), a running one is aborted on whichever
                           host owns it (its record says operator-cancel)

Config comes from the environment (see .env.example); flags override it per run.
Prefer being walked through all of this? The operator panel's /dispatch setup does every step
with a consent per action:  pi install npm:@edgehero/pi-dispatch-admin`;

	// Where this command's output goes. Defaults to the real stdout, so the CLI is byte-identical; a test
	// injects a collector instead of reassigning `process.stdout.write`. That matters because `node --test`
	// runs each file in a child process that serialises its own results over that same stdout, so a test
	// holding a replacement across an `await` swallows the runner's result frames (issue #266).
export async function main(argv = process.argv.slice(2), env = process.env, { write = (chunk) => process.stdout.write(chunk), valkeyRefusal = valkeyRefusalAtStart, now = () => new Date() } = {}) {
	const cmd = argv[0];

	if (cmd === "init") {
		const { runInit } = await import("./init.mjs");
		// The environment rides along so the next steps match the venue (issue #453): PI_BACKENDS=podman alone gets
		// the podman ladder.
		return runInit(process.cwd(), { env });
	}

	if (cmd === "doctor") {
		const { runDoctor } = await import("./doctor.mjs");
		// `fix` and `live` ride in the deps position (runDoctor(env, depsOrOpts)) — one options bag, no third arg.
		return runDoctor(env, { fix: argv.slice(1).includes("--fix"), live: argv.slice(1).includes("--live") });
	}

	if (cmd === "up") {
		const { runUp } = await import("./up.mjs");
		return runUp(argv.slice(1), { env });
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

	if (cmd === "sandbox") {
		const { runSandbox } = await import("./sandbox-cli.mjs");
		return runSandbox(argv.slice(1), { env });
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
		const picked = await killSwitchUrls(argv.slice(1), env);
		if (picked.error) return fail(picked.error);
		if (picked.positionals.length > 0) return fail(`pi-dispatch ${cmd} takes no argument but --valkey-url <url> (got ${picked.positionals.map((p) => JSON.stringify(p)).join(" ")})`);
		if (picked.urls.length > 1) {
			if (cmd === "resume") return fail(`${picked.disagreement}: resume would start jobs on one of them, so it names neither. Say which: pi-dispatch resume --valkey-url <url>`);
			process.stderr.write(`warning: ${picked.disagreement}: ${cmd === "pause" ? "pausing both" : "showing both"}\n`);
		}
		let code = 0;
		for (const url of picked.urls) {
			const label = picked.urls.length > 1 ? `[${urlShown(url)}] ` : "";
			code = Math.max(code, await killSwitch(cmd, url, { env, write, label, urlShown, valkeyRefusal }));
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

	write(`${USAGE}\n`);
	return cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0; // asked-for help is success; a typo is not (the receiver's rule)
}

/**
 * The Valkey(s) a kill-switch verb acts on: the one rule of `killSwitchValkeyUrls` (valkey-endpoint.mjs), shared with the
 * panel. The verb's own flags are parsed with parseArgs over what follows the verb (PR #475's review, round 3: a hand
 * scan took `--valkey-url` for the job id in `cancel --valkey-url URL j1`). `{ urls, disagreement, positionals }` or
 * `{ error }`; a note (a URL that matches neither side) is written to stderr.
 */
async function killSwitchUrls(args, env) {
	let parsed;
	try {
		parsed = parseArgs({ args, allowPositionals: true, options: { "valkey-url": { type: "string" } } });
	} catch (error) {
		return { error: error.message };
	}
	const { killSwitchValkeyUrls } = await import("./connection.mjs");
	const picked = killSwitchValkeyUrls({ env, flagUrl: parsed.values["valkey-url"] ?? null });
	if (picked.error) return picked;
	if (picked.note) process.stderr.write(`warning: ${picked.note}\n`);
	return { ...picked, positionals: parsed.positionals };
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
 */
export const TRIGGER_LOADER_ENV_KEYS = Object.freeze(["PI_TRIGGERS_FILE", "PI_WORKER_NAME", "PI_MAX_COST_USD"]);

/**
 * Deployment keys for a CLI verb that acts for the deployment (review of PR #575): `keys` resolved by issue #471's rule
 * (`resolveServiceEnv`, service-env.mjs), the one doctor and `up` read the service's keys by. This shell's value where
 * it sets the key, else the `.env` in `cwd` from a line the service's loader reads as written. Where the two disagree,
 * or a line naming the key cannot be read as the loader reads it, or the file cannot be read and this shell sets none,
 * the answer is unknown and the verb refuses (`problem`), as `up` refuses on a PI_JOB_IMAGE disagreement: a job queued
 * on a queue no worker drains, or from a triggers file the worker does not read, is a silent no-op. Returns
 * `{ env }` (this shell's with the file's values filled in) or `{ problem }`.
 */
export function cliDeploymentEnv(env, keys, { cwd = process.cwd(), platform = process.platform, readFile = (p) => readFileSync(p) } = {}) {
	const envPath = join(cwd, ".env");
	let file;
	try {
		file = serviceEnvFileOf(readFile(envPath), envPath, serviceEnvLoader(platform));
	} catch (error) {
		const unset = keys.filter((k) => typeof env[k] !== "string");
		if (error?.code !== "ENOENT" && unset.length > 0) return { problem: `${envPath} could not be read (${error?.code ?? "error"}), so ${unset.join(" and ")} cannot be told` };
		return { env };
	}
	const read = resolveServiceEnv({ env, file, keys });
	const [d] = read.disagreements;
	if (d) return { problem: `${d.key} is ${JSON.stringify(d.shell)} in this shell and ${JSON.stringify(d.file)} in ${envPath}: make them agree (the service runs the file's)` };
	const unread = [...read.unread.map((u) => u.key), ...read.hazardSkipped];
	if (unread.length > 0) return { problem: `${envPath} has a line for ${unread.join(" and ")} that the service's loader may read differently, so it cannot be told (pi-dispatch doctor names the line)` };
	return { env: read.env };
}

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
async function killSwitch(cmd, url, { env, write, label, urlShown, valkeyRefusal }) {
	const { parseConnection, makeRedisClient } = await import("./connection.mjs");
	const { fleetQueueNames, discoverHostQueues, unionQueueNames, makeQueue } = await import("./queue.mjs");
	const { readLiveHosts } = await import("./host-registry.mjs");
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
	const refused = await valkeyRefusal(url, env);
	if (refused) return fail(refused);
	const probe = makeRedisClient(url);
	// Without this, a down Valkey dumps nine `[ioredis] Unhandled error event` traces before the one clean
	// line -- the exact noise `defaultProbeValkey` exists to suppress.
	probe.on?.("error", () => {});
	// Both reads, concurrently, sharing one budget. The registry answers WHO IS LIVE; BullMQ's own meta
	// keys answer WHICH QUEUES EXIST, and for a kill switch the second is the question that matters. A
	// host whose registry writes fail for ninety seconds loses its row while its worker keeps draining,
	// and a resume that misses a queue leaves it paused forever with no surface able to name it. A meta
	// key outlives its worker; a registry row does not.
	const [fleet, existing] = await Promise.all([
		readLiveHosts(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((error) => ({ unreachable: error?.message ?? String(error) })),
		discoverHostQueues(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }),
	]);
	probe.disconnect?.();
	const blind = fleet?.unreachable ?? null;
	const names = unionQueueNames(fleetQueueNames(fleet?.hosts), existing);
	// The registry being unreadable no longer means we saw one queue: the keyspace scan may well have
	// found them. Report the count we ACTED on, and name the degraded read separately.
	const span = `${names.length > 1 ? ` [${names.length} queues]` : ""}${blind ? ` [registry unreadable: ${blind}]` : ""}`;
	const queues = [];
	try {
		// Constructed INSIDE the try: `makeQueue` can throw on a malformed peer-written name, and a throw
		// at index k > 0 would otherwise leak the k connections already opened.
		for (const name of names) queues.push(makeQueue(parseConnection(url, { failFast: true }), { name }));
		if (cmd === "pause" || cmd === "resume") {
			const done = [];
			try {
				for (const q of queues) {
					await (cmd === "pause" ? q.pause() : q.resume());
					done.push(q.name);
				}
			} catch (error) {
				// A mid-loop failure leaves the deployment HALF switched. Naming what did change is the whole
				// difference between an operator who knows to finish the job and one who reads "unreachable"
				// as "nothing happened" and walks away from a fleet with one host still spending.
				return fail(`could not ${cmd} the whole deployment at ${urlShown(url)}\n  ${done.length > 0 ? `${cmd}d: ${done.join(", ")}` : "nothing changed"}\n  failed at: ${names[done.length]}\n  ${error.message}`);
			}
			write(`${label}${cmd === "pause" ? `paused: worker will stop taking new jobs (jobs still enqueue)${span}` : `resumed${span}`}\n`);
		} else {
			// "paused" is included in the counts because jobs enqueued while paused land in the
			// `paused` list, not `wait` -- omitting it would report backlog 0 in the exact state
			// the pause switch creates. `pausedState` (the boolean) is named apart from the
			// `paused` count `getJobCounts` returns, so the two do not collide in the output.
			const states = await Promise.all(queues.map((q) => q.isPaused()));
			const per = await Promise.all(queues.map((q) => q.getJobCounts("waiting", "active", "paused", "delayed", "failed")));
			const counts = per.reduce((acc, c) => {
				for (const [k, v] of Object.entries(c ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
				return acc;
			}, {});
			// Summed counts with a boolean from ONE queue would report a half-paused deployment as fully
			// one or fully the other. `pausedPartial` is the third state, and the dangerous direction is
			// the one it makes visible: pause ran while a host was invisible, so that host still spends.
			const pausedState = states.every(Boolean);
			const pausedPartial = !pausedState && states.some(Boolean);
			const out = { ...(label ? { valkey: urlShown(url) } : {}), pausedState, ...(pausedPartial ? { pausedPartial, pausedQueues: names.filter((_, i) => states[i]) } : {}), ...counts, ...(blind ? { fleet: blind } : {}) };
			write(`${JSON.stringify(out)}\n`);
		}
	} catch (error) {
		return fail(error?.valkeyRefused ? error.message : `could not reach Valkey at ${urlShown(url)}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(url)}\n  ${error.message}`);
	} finally {
		for (const q of queues) await q.close().catch(() => {});
	}
	return 0;
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
 */
async function valkeyRefusalAtStart(url, env) {
	const { judgeValkeyAtStart, valkeyClientContext } = await import("./connection.mjs");
	try {
		await judgeValkeyAtStart(url, valkeyClientContext({ env }), { waitMs: 0 });
		return null;
	} catch (error) {
		return error?.valkeyRefused ? error.message : null;
	}
}
