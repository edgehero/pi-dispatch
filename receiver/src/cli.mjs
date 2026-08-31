#!/usr/bin/env node
/**
 * The receiver's own bin (issue #80). Before it, the only start command in the repo lived inside
 * deploy/receiver.service -- an operator without systemd had nothing documented to type.
 *
 * It is a separate bin rather than a `receiver` case in the worker CLI because the dependency points
 * the other way: the receiver depends on `@edgehero/pi-dispatch` (queue, config, the shared triggers
 * schema), so teaching the worker CLI to start the receiver would invert that into a circular
 * workspace dependency. And the receiver is the always-on public trigger surface that lives OUTSIDE
 * pi (DES-TRIGGER-OUTSIDE-PI) -- the edge deserves its own entry point, not a mode of the thing it
 * feeds.
 *
 * Thin by design, mirroring worker/src/cli.mjs: recognise the command, lazy-import the real work.
 */

import { EXIT_POLICY } from "@edgehero/pi-dispatch/exit-code";

const USAGE = `pi-dispatch-receiver — the always-on trigger edge: turns GitHub activity into queued jobs

  pi-dispatch-receiver serve   start the webhook receiver (the default when no command is given)
  pi-dispatch-receiver poll    start the polling producer — no public URL, no DNS, no tunnel: it
                               reads api.github.com with the operator's own credential instead

Config comes from the environment (see .env.example): WEBHOOK_SECRET is required for serve
only when your triggers name github (poll needs none either — there is no inbound delivery to
verify, and a forge-only deployment has no github endpoint), PI_TRIGGERS_FILE overrides the
./triggers.json default, VALKEY_URL names the queue, RECEIVER_PORT/RECEIVER_BIND choose where
serve listens, and POLL_REPOS / POLL_INTERVAL_SECONDS shape what poll watches and how often.`;

/**
 * `start`/`startPoll` are injection seams defaulting to the lazy imports of ./start.mjs and
 * ./poller.mjs, so tests can run the command dispatch without resolving identity, opening a socket,
 * or touching Valkey -- and the help/unknown paths stay runnable even where the queue deps are not
 * installed.
 */
	// Where this command's output goes. Defaults to the real stdout, so the CLI is byte-identical; a test
	// injects a collector instead of reassigning `process.stdout.write`. That matters because `node --test`
	// runs each file in a child process that serialises its own results over that same stdout, so a test
	// holding a replacement across an `await` swallows the runner's result frames (issue #266).
export async function main(argv = process.argv.slice(2), env = process.env, { start, startPoll, write = (chunk) => process.stdout.write(chunk) } = {}) {
	const cmd = argv[0];

	if (cmd === undefined || cmd === "serve") {
		const startReceiver = start ?? (await import("./start.mjs")).startReceiver;
		await startReceiver(env);
		return 0; // the server keeps the process alive until SIGTERM
	}

	if (cmd === "poll") {
		// The polling producer (issue #81): the same gate and the same queue as serve, fed by reading
		// api.github.com instead of by being reachable from it. Awaiting `done` is what keeps the
		// process alive -- unlike serve there is no listening socket holding the loop open, only the
		// loop itself, and returning early would let the bin exit under a healthy poller.
		const startPoller = startPoll ?? (await import("./poller.mjs")).startPoller;
		const poller = await startPoller(env);
		await poller?.done;
		return 0;
	}

	write(`${USAGE}\n`);
	return cmd === "--help" || cmd === "-h" ? 0 : 1; // asked-for help is success; a typo is not
}

/**
 * Exit code for an error that escaped main() as a rejection. A tagged config error
 * (`piDispatchConfig`, from loadReceiverConfig or the HARD-FAIL identity boot gate) is a determinate
 * refusal -> EXIT_POLICY (2, never retried); anything else is infra -> 1 (retryable). The same
 * mapping as the worker CLI's entryExitCode, for the same reason: a supervisor restarting on exit 2
 * would loop on a config that can never parse.
 */
export function entryExitCode(err) {
	return err?.piDispatchConfig ? EXIT_POLICY : 1;
}

// Entry point when run as a bin. Kept out of the exported main so tests can call main() directly.
// The error line mirrors start.mjs's own entry guard: `err.message` only -- never a secret or PII.
// (start.mjs's guard keys on argv[1] ending in start.mjs, so importing it from here never double-boots.)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.mjs")) {
	main()
		.then((code) => {
			if (code) process.exitCode = code;
		})
		.catch((err) => {
			process.stderr.write(`${JSON.stringify({ event: "receiver_start_failed", reason: err?.message })}\n`);
			process.exitCode = entryExitCode(err);
		});
}
