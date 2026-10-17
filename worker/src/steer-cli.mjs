/**
 * `pi-dispatch steer <jobId> [--later] <text…|->` and `pi-dispatch steer --withdraw <jobId> <msgId>` (issue #646,
 * REQ-STEER-RUNNING-JOB): an operator's message into a running, steer-armed job, and taking one back.
 *
 * Modelled on cancel-cli.mjs, and on its footing: VALKEY_URL only (resolved by cli.mjs with the kill switch's rule),
 * never loadConfig, the job found across every queue this deployment drains. What differs is what the job must BE:
 *
 *   - active. A queued job has no run to steer, and a message waiting for it would arrive as the opening of a run
 *     the person did not start it for. The message is refused, never parked.
 *   - open: `run:steer:open:<runId>` present. Only the worker's relay sets it, and only for a run that is armed
 *     (`run.steer`), running, and on a venue that can deliver (bind mounts, an exit key, an image with `steer`). An
 *     active job without it is refused with the one sentence that names all three causes, since this side cannot
 *     tell them apart, rather than accepting a message no one will ever write into the run.
 *
 * The push is the inbox's own script (steer-inbox.mjs), so a run that closes in the same moment refuses the message
 * (`closed`/`gone`) instead of swallowing it. After `ok` the command polls up to 10 s for the relay to write it
 * (`written`) or the agent to take it (`delivered`) and says which; a message still `queued` at the end of the window
 * was accepted and is said so, with exit 0. A message that turns `late` (the run ended first) is exit 1: it was not seen.
 *
 * NEVER PRINTS THE TEXT. Not on success, not in an error: the id, the mode and the state are enough to find it again,
 * and a terminal scrollback or a CI log is no place for words meant for one run.
 */

import * as inbox from "./steer-inbox.mjs";

/** Same budget the kill switch and cancel give the host registry. */
const FLEET_READ_TIMEOUT_MS = 2_000;
/** The most stdin may carry before scrubbing: four times the text bound, so control bytes the scrub removes still fit. */
const STDIN_MAX_BYTES = 32 * 1024;

/**
 * Read stdin up to `maxBytes`: `{ text }`, or `{ over: true }` the moment it passes the bound (the rest is not read).
 * `stdin` is the seam; it must be an async iterable of Buffers or strings.
 */
export async function readStdinBounded(maxBytes = STDIN_MAX_BYTES, stdin = process.stdin) {
	const chunks = [];
	let n = 0;
	for await (const chunk of stdin) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
		n += buf.length;
		if (n > maxBytes) {
			stdin.destroy?.();
			return { over: true };
		}
		chunks.push(buf);
	}
	return { text: Buffer.concat(chunks).toString("utf8") };
}

const USAGE_LINE = "pi-dispatch steer <jobId> [--later] <text…|->  or  pi-dispatch steer --withdraw <jobId> <msgId>";

/** The line for a message's state after the push and the poll. */
function stateLine(id, jobId, mode, state) {
	const head = `message ${id} for ${jobId} (${mode === "followUp" ? "follow-up" : "steer"}):`;
	if (state === "delivered") return `${head} delivered. The agent has received it\n`;
	if (state === "written") {
		return mode === "followUp"
			? `${head} written. The run holds it, and the agent reads it once it would otherwise stop\n`
			: `${head} written. The run holds it, and the agent reads it after its current tool calls\n`;
	}
	return `${head} queued. The worker has not written it into the run yet; it is delivered while the run is open, or reported late if the run ends first. See its state with the console\n`;
}

/**
 * Run the verb. `positionals` are what follows `steer` once cli.mjs has taken `--valkey-url`, `--later` and
 * `--withdraw` out. Returns the exit code. Every collaborator is a seam with the production default, cancel's shape.
 */
export async function runSteer({ positionals = [], later = false, withdraw = false } = {}, url, { write = (chunk) => process.stdout.write(chunk), errWrite = (chunk) => process.stderr.write(chunk), redisFn, queueFn, parseConnectionFn, readLiveHostsFn, discoverHostQueuesFn, fleetQueueNamesFn, unionQueueNamesFn, readStdin = readStdinBounded, randomBytes, now = Date.now, ackTimeoutMs = 10_000, pollMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), refusalFn } = {}) {
	const fail = (message) => {
		errWrite(`error: ${message}\n`);
		return 1;
	};

	// Everything that can be refused for free is refused before Valkey is touched.
	const jobId = positionals[0];
	if (typeof jobId !== "string" || jobId === "") return fail(`a job id is required: ${USAGE_LINE}  (ids are in \`pi-dispatch status\`, the panel, and the run log)`);
	let msgId = null;
	let text = null;
	if (withdraw) {
		if (later) return fail("--later and --withdraw do not go together: --withdraw takes a message back, whatever its mode");
		if (positionals.length !== 2) return fail(`--withdraw takes a job id and one message id: ${USAGE_LINE}`);
		msgId = positionals[1];
		if (!inbox.STEER_ID_RE.test(msgId)) return fail("the message id is 32 lowercase hex characters, as `pi-dispatch steer` printed it");
	} else {
		const words = positionals.slice(1);
		if (words.length === 0) return fail(`no message: ${USAGE_LINE}  (- reads it from stdin)`);
		let raw;
		if (words.length === 1 && words[0] === "-") {
			const read = await readStdin(STDIN_MAX_BYTES).catch((error) => ({ error }));
			if (read.error) return fail(`could not read the message from stdin: ${read.error?.message ?? read.error}`);
			if (read.over) return fail(`stdin carried more than ${STDIN_MAX_BYTES} bytes; a message is at most ${inbox.STEER_TEXT_MAX_BYTES} bytes. Nothing was sent`);
			raw = read.text;
		} else {
			raw = words.join(" ");
		}
		const bounded = inbox.boundSteerText(raw);
		if (bounded.refusal) return fail(bounded.refusal);
		text = bounded.text;
	}

	const { parseConnection, makeRedisClient } = await import("./connection.mjs");
	const { fleetQueueNames, discoverHostQueues, unionQueueNames, makeQueue } = await import("./queue.mjs");
	const { readLiveHosts } = await import("./host-registry.mjs");
	const { runIdOf } = await import("./recovery-queue.mjs");
	const parseConn = parseConnectionFn ?? parseConnection;
	const mkRedis = redisFn ?? makeRedisClient;
	const mkQueue = queueFn ?? makeQueue;
	const liveHosts = readLiveHostsFn ?? readLiveHosts;
	const discover = discoverHostQueuesFn ?? discoverHostQueues;
	const fleetNames = fleetQueueNamesFn ?? fleetQueueNames;
	const unionNames = unionQueueNamesFn ?? unionQueueNames;

	// cancel's rule (issue #464): a refused Valkey is said as the refusal it is, judged only where this command builds
	// its own clients.
	const refusalOf =
		refusalFn ??
		(redisFn
			? async () => null
			: async (u) => {
					const { judgeValkeyAtStart, defaultValkeyContext } = await import("./connection.mjs");
					try {
						await judgeValkeyAtStart(u, defaultValkeyContext(), { waitMs: 0 });
						return null;
					} catch (error) {
						return error?.valkeyRefused ? error.message : null;
					}
				});
	const valkeyRefused = await refusalOf(url);
	if (valkeyRefused) return fail(valkeyRefused);
	const probe = mkRedis(url);
	probe.on?.("error", () => {});
	const queues = [];
	try {
		const [fleet, existing] = await Promise.all([
			liveHosts(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((error) => ({ unreachable: error?.message ?? String(error) })),
			discover(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }),
		]);
		const blind = fleet?.unreachable ?? null;
		const names = unionNames(fleetNames(fleet?.hosts), existing);
		let job = null;
		for (const name of names) {
			const q = mkQueue(parseConn(url, { failFast: true }), { name });
			queues.push(q);
			job = await q.getJob(jobId);
			if (job) break;
		}
		if (!job) return fail(`no job ${jobId} in ${names.length} queue(s)${blind ? ` [registry unreadable: ${blind}; a host that is not registered may still hold it]` : ""}`);
		const runId = runIdOf(job);

		if (withdraw) {
			const res = await inbox.withdrawSteer({ redis: probe, runId, id: msgId });
			if (res.error) return res.error === "refused" ? fail(res.reason) : fail(`could not withdraw message ${msgId}: Valkey said ${res.error}`);
			if (res.prior === "queued") {
				write(`withdrawn message ${msgId} from ${jobId}: it was queued, so the run never sees it (guaranteed)\n`);
				return 0;
			}
			if (res.prior === "written") {
				write(`withdrawn message ${msgId} from ${jobId}, best effort: it was already written into the run's inbox, so the agent may have read it before the worker removed it. Its transcript says whether it did\n`);
				return 0;
			}
			if (res.prior === "withdrawn") {
				write(`message ${msgId} of ${jobId} was already withdrawn; nothing was changed\n`);
				return 0;
			}
			if (res.prior === "delivered") return fail(`message ${msgId} was already delivered: the agent has received it, so it cannot be withdrawn. Nothing was changed`);
			if (res.prior === "late") return fail(`message ${msgId} arrived after the run had ended (late): the agent never saw it, and there is nothing to withdraw`);
			return fail(`no message ${msgId} in the inbox of ${jobId}`);
		}

		const state = await job.getState().catch(() => "unknown");
		if (state !== "active") return fail(`job ${jobId} is ${state}: only a running job takes messages. Nothing was sent`);
		const open = await inbox.isOpen({ redis: probe, runId });
		if (open !== true) {
			if (open === false) return fail("the run is not accepting messages: it is not steer-armed, not running, or its venue cannot deliver");
			throw Object.assign(new Error(`Valkey said ${open.error}`), { code: open.error });
		}
		const mode = later ? "followUp" : "steer";
		const id = inbox.operatorMessageId(...(randomBytes ? [randomBytes] : []));
		const entry = { v: 1, id, mode, source: "cli", author: { kind: "operator", by: "cli" }, text, at: now() };
		const pushed = await inbox.pushSteer({ redis: probe, runId, entry, now });
		if (pushed?.error === "refused") return fail(pushed.reason);
		if (pushed?.error) throw Object.assign(new Error(`Valkey said ${pushed.error}`), { code: pushed.error });
		if (pushed === "gone") return fail("the run stopped accepting messages before this one arrived (it ended, or its worker stopped refreshing it). Nothing was sent");
		if (pushed === "closed") return fail("the run has finished and its inbox is closed. Nothing was sent");
		if (pushed === "full") return fail(`the run's inbox is full (at most ${inbox.STEER_MAX_MESSAGES} messages and ${inbox.STEER_TOTAL_MAX_BYTES} bytes per run, withdrawn ones included). Nothing was sent`);
		if (pushed !== "ok") return fail(`the inbox answered ${String(pushed)} for a new message id; nothing was sent`);

		// Poll for the relay's write. A read fault ends the poll, not the command: the message IS accepted.
		// Counted in polls rather than against `now()`: a test's fixed clock would otherwise poll forever, and the
		// window only needs to be roughly ten seconds.
		let seen = "queued";
		const polls = Math.max(1, Math.ceil(ackTimeoutMs / pollMs));
		for (let i = 0; i < polls; i++) {
			await sleep(pollMs);
			const s = await inbox.messageState({ redis: probe, runId, id });
			if (typeof s !== "string") break;
			seen = s;
			if (s !== "queued") break;
		}
		if (seen === "late") return fail(`message ${id} for ${jobId}: the run ended before the worker could write it (late). The agent did not see it`);
		if (seen === "withdrawn") {
			write(`message ${id} for ${jobId}: withdrawn before it was written\n`);
			return 0;
		}
		write(stateLine(id, jobId, mode, seen));
		return 0;
	} catch (error) {
		return fail(error?.valkeyRefused ? error.message : `could not reach Valkey at ${(await import("./connection.mjs")).urlShown(url)}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(url)}\n  ${error.message}`);
	} finally {
		probe.disconnect?.();
		for (const q of queues) await q.close().catch(() => {});
	}
}
