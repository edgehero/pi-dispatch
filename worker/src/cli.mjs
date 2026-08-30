#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { EXIT_POLICY } from "./exit-code.mjs";
import { gitDirty } from "./git-dirty.mjs";

const USAGE = `pi-dispatch — run pi coding-agent flows on your own folders

  pi-dispatch init         scaffold .env + triggers.json + pause-windows.json + pi-packages.json + subscriptions.json here
  pi-dispatch doctor [--fix]  preflight Docker, Valkey, the job image, and your provider key; --fix offers to run each fix (y/N per action)
  pi-dispatch up [--yes]   one consented pass: pull+tag the job image, start Valkey, init, doctor
  pi-dispatch setup github mint GitHub App credentials in one browser click (App Manifest flow);
                           every write shown first and individually consented — no --yes here
                           (--webhook-url <URL> | --no-webhook) [--org <org>] [--name <appName>]
  pi-dispatch import-pi    stage your host pi setup (models/skills/persona) into a global overlay
                           [--no-extensions] [--with-packages] [--no-host-packages]
                           [--packages-file <path>] [--from <agentDir>] [--to <overlayDir>]

  pi-dispatch run <folder> --task "<what to do>" [--flow <name>]
                           [--provider <p>] [--model <m>] [--max-turns <n>] [--image <ref>] [--force]
  pi-dispatch sandbox <jobId>
                           re-open a finished run's sandbox as a shell — same image, same workspace,
                           no credentials  [--publish <port>[:<containerPort>]] [--pin]
  pi-dispatch sandbox --list
                           what is still re-openable, for how long, and what is running now

  pi-dispatch worker       drain the queue (run this in another terminal, or as a service)
  pi-dispatch-receiver     webhook receiver for forge triggers — its own bin (see the GitHub section of the README)
  pi-dispatch service <render|install|uninstall|status|start|stop|restart> [--receiver] [--user|--system] [--force]
                           run the worker (or --receiver) as an OS service — the deploy/ templates
                           rendered with this host's real paths, installed user-level;
                           \`service restart --drain\` lets the in-flight job finish first
  pi-dispatch pause        stop taking new jobs (durable; survives worker restart)
  pi-dispatch resume       resume taking jobs
  pi-dispatch status       show paused state + job counts

Config comes from the environment (see .env.example); flags override it per run.
Prefer being walked through all of this? The operator panel's /dispatch setup does every step
with a consent per action:  pi install npm:@edgehero/pi-dispatch-admin`;

export async function main(argv = process.argv.slice(2), env = process.env) {
	const cmd = argv[0];

	if (cmd === "init") {
		const { runInit } = await import("./init.mjs");
		return runInit(process.cwd());
	}

	if (cmd === "doctor") {
		const { runDoctor } = await import("./doctor.mjs");
		// `fix` rides in the deps position (runDoctor(env, depsOrOpts)) — one options bag, no third arg.
		return runDoctor(env, { fix: argv.slice(1).includes("--fix") });
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
		process.stdout.write(`pi-dispatch setup <target> — guided credential setup\n\n  targets: github\n\n  pi-dispatch setup github (--webhook-url <URL> | --no-webhook) [--org <org>] [--name <appName>]\n      mint GitHub App credentials via the App Manifest flow — one browser click returns the app id,\n      private key, and webhook secret; every write is shown first and individually consented\n`);
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
			},
		});
		const folder = positionals[0] && resolve(positionals[0]);
		if (!folder || !existsSync(folder)) return fail(`folder not found: ${positionals[0] ?? "(none given)"}`);
		if (!values.task) return fail("a --task is required");

		// A local job edits the folder IN PLACE with no undo (SECURITY.md). Refuse a dirty working
		// tree unless --force, so a bad run cannot mix with uncommitted work the operator can't
		// cleanly separate. A non-git folder is caught later by prepare (v1 requires a git repo).
		if (existsSync(`${folder}/.git`) && !values.force) {
			const dirty = gitDirty(folder);
			if (dirty === null) return fail(`${folder} is not a usable git repository`);
			if (dirty) return fail(`${folder} has uncommitted changes. Commit or stash them, or pass --force.`);
		}

		const config = loadConfig(env);
		const { parseConnection } = await import("./connection.mjs");
		const { makeQueue, enqueueLocalJob, hostQueueName } = await import("./queue.mjs");
		// failFast: a one-shot enqueue must not hang forever if Valkey is down -- error clearly.
		// Onto THIS host's queue when the deployment declares a name (issue #57). The folder was checked
		// against this machine's filesystem a few lines up, so this machine is the only one that can run it;
		// enqueueing it where every host drains would be handing a job to a peer that has no such folder.
		const hq = config.workerNameDeclared ? hostQueueName(config.workerName) : null;
		const queue = makeQueue(parseConnection(config.valkeyUrl, { failFast: true }), { ...(hq ? { name: hq } : {}) });
		try {
			// Absent flags stay absent (undefined) so the value resolves at job start against the
			// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT).
			const jobId = await enqueueLocalJob(queue, {
				folder,
				task: values.task,
				flow: values.flow,
				provider: values.provider,
				model: values.model,
				maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
				// || not the raw value: `--image ""` must collapse to absent rather than becoming a falsy string that
				// throws inside buildDockerRunArgs after a budget slot is reserved.
				image: values.image || undefined,
			});
			process.stdout.write(`queued ${jobId} — folder ${folder}\nrun \`pi-dispatch worker\` to process it.\n`);
		} catch (error) {
			return fail(`could not reach Valkey at ${config.valkeyUrl} — is it running? (docker compose up)\n  ${error.message}`);
		} finally {
			await queue.close().catch(() => {});
		}
		return 0;
	}

	if (cmd === "pause" || cmd === "resume" || cmd === "status") {
		// The kill switch reads ONLY VALKEY_URL, not the full loadConfig -- it must work even when
		// GitHub auth is misconfigured, so an operator can always stop the queue.
		const url = env.VALKEY_URL ?? "redis://127.0.0.1:6379";
		const { parseConnection } = await import("./connection.mjs");
		const { fleetQueueNames, makeQueue } = await import("./queue.mjs");
		const { makeRedisClient } = await import("./connection.mjs");
		const { readLiveHosts } = await import("./host-registry.mjs");
		// EVERY queue this deployment drains (issue #57), not just the shared one. This is the kill switch:
		// pausing `pi-jobs` alone would stop forge deliveries while a named host's cron, chained children
		// and manual runs kept spending -- and would print "paused" for having done it. That is the silent
		// no-op the comment here already warned about for a mistyped name, arriving through a new door.
		//
		// The registry read is best-effort: an unreadable one yields the shared queue alone, which is
		// exactly what this command did before, so a Valkey blip can never make the kill switch refuse.
		const probe = makeRedisClient(url);
		const fleet = await readLiveHosts(probe).catch(() => ({ hosts: [] }));
		probe.disconnect?.();
		const queues = fleetQueueNames(fleet.hosts).map((name) => makeQueue(parseConnection(url, { failFast: true }), { name }));
		const queue = queues[0];
		try {
			if (cmd === "pause") {
				for (const q of queues) await q.pause();
				process.stdout.write(`paused — worker will stop taking new jobs (jobs still enqueue)${queues.length > 1 ? ` [${queues.length} queues]` : ""}\n`);
			} else if (cmd === "resume") {
				for (const q of queues) await q.resume();
				process.stdout.write(`resumed${queues.length > 1 ? ` [${queues.length} queues]` : ""}\n`);
			} else {
				// "paused" is included in the counts because jobs enqueued while paused land in the
				// `paused` list, not `wait` -- omitting it would report backlog 0 in the exact state
				// the pause switch creates. `pausedState` (the boolean) is named apart from the
				// `paused` count `getJobCounts` returns, so the two do not collide in the output.
				const pausedState = await queue.isPaused();
				const per = await Promise.all(queues.map((q) => q.getJobCounts("waiting", "active", "paused", "delayed", "failed")));
				const counts = per.reduce((acc, c) => {
					for (const [k, v] of Object.entries(c ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
					return acc;
				}, {});
				process.stdout.write(`${JSON.stringify({ pausedState, ...counts })}\n`);
			}
		} catch (error) {
			return fail(`could not reach Valkey at ${url} — is it running? (docker compose up)\n  ${error.message}`);
		} finally {
			for (const q of queues) await q.close().catch(() => {});
		}
		return 0;
	}

	process.stdout.write(`${USAGE}\n`);
	return cmd ? 1 : 0;
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
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.mjs")) {
	main()
		.then((code) => {
			if (code) process.exitCode = code;
		})
		.catch((err) => {
			process.stderr.write(`error: ${err.message}\n`);
			process.exitCode = entryExitCode(err);
		});
}
