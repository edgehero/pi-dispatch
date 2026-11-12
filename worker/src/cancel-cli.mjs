/**
 * `pi-dispatch cancel <jobId>` (issue #287): the operator's stop for ONE job, whatever state it is in.
 *
 * VALKEY_URL-only like `pause`, and for the same reason: stopping a job must work even when forge auth is
 * misconfigured. The verb finds the job across every queue this deployment drains (the kill switch's own
 * fleet discovery), then dispatches on what the job IS:
 *
 *   held on run.waitFor  -> the shared removeHeldJob sequence (hold keys first, then the job); no record
 *                           (the dispatch_wait_cancel rule).
 *   delayed / queued     -> job.remove(); no record, same rule.
 *                           Both through `removeQueuedJob` (cancel-state.mjs, issue #737), the sequence the
 *                           console's cancel-queued shares, which also deletes the removed job's defer record.
 *   active               -> a `cancel:req` key + a brief ack poll (cancel-state.mjs), because the abort can
 *                           only be raised by the process that holds the job. No ack within the window is a
 *                           NAMED failure, never a silent one: the job may be on a host that is down, or on
 *                           a worker predating this verb.
 *
 * Held is checked BEFORE the plain state dispatch: a held job IS delayed, and removing it through the plain
 * path would strand its wait:* keys as a panel row for a job that no longer exists.
 *
 * What the line says about the job's PAST is read off the job, not assumed from its state (issue #477): a delayed job
 * can be one waiting to retry after a failed attempt, which usually wrote a run record and may have left a retained
 * sandbox, and "it never ran" was printed about it. `ranBefore` (cancel-state.mjs, shared with the panel) words it from the
 * job's attempt count.
 */

import { CANCEL_REQ_TTL_MS, cancelReqKey, ranBefore, removeQueuedJob, requestCancel } from "./cancel-state.mjs";

/** Same budget the kill switch gives the host registry before acting on what the keyspace alone says. */
const FLEET_READ_TIMEOUT_MS = 2_000;

/**
 * A sentence another module wrote (BullMQ's, a client's, Valkey's own: of any length, holding any bytes), as a line of
 * this command carries it to stderr, which is a terminal: every control character a terminal acts on (C0, DEL and C1:
 * an ESC sequence, a CSI with no ESC, a bell, a carriage return that overwrites the line) made a space, then cut at 200
 * characters. The console carries such text by the same substitution and the same cut (`boundedText` in the admin's
 * job-actions.mjs, over its `scrubControls`), which a test holds this to on the class a terminal executes. The
 * console's class is wider (it also substitutes what draws as nothing, or as a blank that is not a space, for a
 * reader), and it is asked of the admin's own width table, which the worker does not import.
 */
export function boundedText(text) {
	return String(text ?? "no reason given").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
}

/** Whether `error` is Valkey's own refusal (a reply), as against no answer at all: the two are different sentences. */
function refusedByValkey(error) {
	return error?.name === "ReplyError";
}

/** What went wrong, as the start of a line: Valkey refused a command (it answered), or it did not answer. */
function valkeyFault(error, shown) {
	const command = typeof error?.command?.name === "string" ? error.command.name.toUpperCase() : "a command";
	return refusedByValkey(error) ? `Valkey at ${shown} refused ${boundedText(command)}: ${boundedText(error?.message)}` : `Valkey at ${shown} stopped answering (${boundedText(error?.message)})`;
}

/**
 * The job's state, read under the same bound as every other command here: `{ state }`, or `{ unread }` with why it could
 * not be read. Issue #846: a read that failed was `"unknown"`, which is also what BullMQ says of a job that left its
 * queue, so a job still running was reported as gone "and nothing was changed".
 */
async function boundedState(job, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve(job.getState()).then((state) => ({ state })),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve({ unread: `no answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
				timer.unref?.();
			}),
		]);
	} catch (error) {
		return { unread: error?.message ?? String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Run the cancel. Returns the process exit code. Every collaborator is a seam with the production default,
 * so tests drive states and races without a queue; `write` is the stdout seam cli.mjs already injects.
 */
export async function runCancel(jobId, url, { write = (chunk) => process.stdout.write(chunk), errWrite = (chunk) => process.stderr.write(chunk), redisFn, queueFn, parseConnectionFn, readLiveHostsFn, discoverHostQueuesFn, fleetQueueNamesFn, unionQueueNamesFn, ackTimeoutMs = 10_000, pollMs = 250, sleep, refusalFn, touchStore, touchOutbox = null, now = Date.now } = {}) {
	const fail = (message) => {
		errWrite(`error: ${message}\n`);
		return 1;
	};
	if (typeof jobId !== "string" || jobId === "") {
		return fail("a job id is required: pi-dispatch cancel <jobId>  (ids are in `pi-dispatch status`, the panel, and the run log)");
	}
	// Lazy imports, the pause verb's shape: a mistyped id must not load bullmq before it can be refused.
	const { parseConnection, makeRedisClient, VALKEY_COMMAND_TIMEOUT_MS } = await import("./connection.mjs");
	const { fleetQueueNames, discoverHostQueues, unionQueueNames, makeQueue } = await import("./queue.mjs");
	const { readLiveHosts } = await import("./host-registry.mjs");
	const parseConn = parseConnectionFn ?? parseConnection;
	const mkRedis = redisFn ?? makeRedisClient;
	const mkQueue = queueFn ?? makeQueue;
	const liveHosts = readLiveHostsFn ?? readLiveHosts;
	const discover = discoverHostQueuesFn ?? discoverHostQueues;
	const fleetNames = fleetQueueNamesFn ?? fleetQueueNames;
	const unionNames = unionQueueNamesFn ?? unionQueueNames;

	// Issue #464 (gate round 3): judged before anything is sent, so a refused Valkey is said as the refusal it is. Only
	// where this command builds its own clients (a test's fakes stand in for Valkey itself), or a test's `refusalFn`.
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
	const refused = await refusalOf(url);
	if (refused) return fail(refused);
	// BOUNDED (issue #846): each command waits at most VALKEY_COMMAND_TIMEOUT_MS for its answer, and one that timed out is
	// never sent again. The unbounded client this was waited for as long as Valkey was gone: killed during the ack poll it
	// printed nothing until the operator gave up, and on a partition its DEL never reached the catch below.
	const probe = mkRedis(url, { commandTimeoutMs: VALKEY_COMMAND_TIMEOUT_MS, disconnectTimeoutMs: 0 });
	probe.on?.("error", () => {});
	const queues = [];
	let requested = false;
	let requestedAt = null;
	try {
		// The job could sit on the shared queue or on any host's own (issue #57): find it the way pause
		// spans them, and fail OPEN but LOUDLY on a degraded registry read, exactly as the kill switch does.
		const [fleet, existing] = await Promise.all([
			liveHosts(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((error) => ({ unreachable: error?.message ?? String(error) })),
			discover(probe, { timeoutMs: FLEET_READ_TIMEOUT_MS }),
		]);
		const blind = fleet?.unreachable ?? null;
		const names = unionNames(fleetNames(fleet?.hosts), existing);

		// Constructed INSIDE the try (the pause loop's leak posture); first queue that knows the id wins.
		// Job ids are delivery GUIDs, `local-<hex>` or `repeat:<id>:<millis>`, so a cross-queue duplicate
		// is not a state this project can produce.
		let job = null;
		let owner = null;
		for (const name of names) {
			const q = mkQueue(parseConn(url, { failFast: true }), { name });
			queues.push(q);
			job = await q.getJob(jobId);
			if (job) {
				owner = q;
				break;
			}
		}
		if (!job) {
			return fail(`no job ${jobId} in ${names.length} queue(s)${blind ? ` [registry unreadable: ${boundedText(blind)} — a host that is not registered may still hold it]` : ""}`);
		}

		// Held FIRST, then a job waiting to start: the shared sequence (`removeQueuedJob`, cancel-state.mjs), which the
		// console's cancel-queued runs too. It judges the hold by the `wait:job` hash's `since`, the clock that makes it a
		// real hold rather than a counter key, and deletes the removed job's defer record. This verb's reach is its own:
		// it removes a job waiting to retry as well, which the console refuses.
		const queued = await removeQueuedJob({ redis: probe, queue: owner, job, jobId, touchStore, touchOutbox, now });
		if (queued.ok && queued.touchWarning) errWrite("warning: the job was removed; touch tracking is incomplete. Do not repeat the cancellation.\n");
		if (queued.ok && queued.held) {
			// A hold consumes no attempt (`skipAttempt`), so a held job that ran is a retry held again by its conditions.
			write(`cancelled ${jobId}: it was held on its wait condition, and ${ranBefore(queued)}\n`);
			return 0;
		}
		// A removal that failed after the hold's keys were deleted changed something: the job lost its hold and was not removed,
		// so the line says so and how to finish, never only the error (which reads as "nothing happened"). Every error a
		// line carries is bounded (`boundedText`): it is another module's words, of any length and with any bytes.
		if (queued.invalid !== undefined && queued.cleared === true) {
			return fail(`could not cancel held job ${jobId}: its hold was cleared, but the job itself could not be removed (${boundedText(queued.invalid)}); it may still be queued, now without its hold. Run \`pi-dispatch cancel ${jobId}\` again to remove or stop it`);
		}
		if (queued.invalid !== undefined) return fail(`could not cancel held job ${jobId}: ${boundedText(queued.invalid)}`);
		if (queued.ok) {
			write(`removed ${jobId} (${queued.state}): ${ranBefore(job)}\n`);
			return 0;
		}
		const state = queued.state;
		// The one race worth handling by name: picked up between getState and remove. remove() throws on a locked job, so
		// the state is re-read and an active job falls through to the active path rather than failing an operator whose
		// job is now exactly the case the active path exists for. Otherwise the re-read state and the throw's own words
		// together, labelled apart: the error came from the remove attempt, the state from after it, and gluing them
		// unlabelled read as one mismatched diagnosis.
		if (queued.raced && state !== "active") return fail(`could not remove ${jobId} — it is now ${state}; the remove failed with: ${boundedText(queued.error.message)}`);

		if (state === "active") {
			requested = true;
			requestedAt = now();
			const res = await requestCancel({ redis: probe, jobId, ackTimeoutMs, pollMs, now, ...(sleep ? { sleep } : {}) });
			if (res.ack !== undefined) {
				write(`cancel accepted by ${res.ack === "" ? "the worker" : boundedText(res.ack)} — stopping the container (allow ~30s); the run record will say operator-cancel\n`);
				return 0;
			}
			// Gate round 2 of PR #479: the worker stops its cancel poll before it holds or retries a job, so a request that
			// lands in that moment is never acknowledged and the job is back in the queue. Re-read, so the words are true.
			// Gate round 3: by the state, since a job that finished or left the queue cannot be removed by a second cancel.
			const read = await boundedState(job, VALKEY_COMMAND_TIMEOUT_MS);
			const waited = `no worker acknowledged within ${Math.round(ackTimeoutMs / 1000)}s`;
			// Issue #846: a state that could not be read is said as that, never as BullMQ's "unknown" (a job that left).
			if (read.unread !== undefined) return fail(`${waited}, and the job's state could not be read (${boundedText(read.unread)}), so whether it still runs is not known. The cancel request was withdrawn, so nothing was changed: run \`pi-dispatch status\`, and \`pi-dispatch cancel ${jobId}\` again if it still runs`);
			const after = read.state;
			if (after === "waiting" || after === "delayed" || after === "prioritized" || after === "paused") return fail(`${waited}: the job went back to the queue before its worker read the cancel (it is now ${after}), and nothing was changed. Run \`pi-dispatch cancel ${jobId}\` again to remove it`);
			if (after === "completed" || after === "failed") return fail(`${waited}: the job finished (${after}) before its worker read the cancel, and nothing was changed`);
			if (after !== "active") return fail(`${waited}: the job is no longer in the queue (its state reads ${after}), and nothing was changed`);
			return fail(`no worker acknowledged within ${Math.round(ackTimeoutMs / 1000)}s — the job is active but no reachable worker owns it (host down, or a worker predating cancel); nothing was changed`);
		}

		return fail(`job ${jobId} is ${state} — nothing to cancel`);
	} catch (error) {
		// Best-effort, and ONLY when a request was actually placed: an abandoned request must not fire
		// after the operator read an error and walked away -- but against a Valkey that is DOWN, a bare
		// del would sit in ioredis's retry queue and hold this process open long past the error message.
		// The bound timer is CLEARED when the del wins the race (discoverHostQueues' own rule): cli.mjs
		// sets exitCode rather than exiting, so a stray pending timer is a second of pure hang.
		let withdrawn = false;
		if (requested) {
			let bound;
			withdrawn = await Promise.race([
				Promise.resolve(probe.del?.(cancelReqKey(jobId))).then(() => true, () => false),
				new Promise((r) => (bound = setTimeout(() => r(false), 1000))),
			]);
			clearTimeout(bound);
		}
		if (error?.valkeyRefused) return fail(error.message);
		const shown = (await import("./connection.mjs")).urlShown(url);
		// Issue #846: after the request went out, what is said is what became of it. The old line said only "could not reach
		// Valkey ... is it running?", also when Valkey answered with a refusal, and never that a request may still stand.
		if (requested && error?.valkeyMayStillRun) {
			if (withdrawn) return fail(`${valkeyFault(error, shown)} after the cancel request for ${jobId} was written. The request was withdrawn again, so nothing was changed, unless its worker read it in that moment: run \`pi-dispatch status\` to see whether ${jobId} still runs`);
			const until = new Date((requestedAt ?? now()) + CANCEL_REQ_TTL_MS).toISOString();
			return fail(`${valkeyFault(error, shown)} after the cancel request for ${jobId} was written, and the request could not be withdrawn. It stands until ${until}, ${Math.round(CANCEL_REQ_TTL_MS / 1000)}s after it was written, and a worker that reads it before then stops the job: run \`pi-dispatch status\` once Valkey answers to see whether it did`);
		}
		if (refusedByValkey(error)) return fail(`${valkeyFault(error, shown)}; nothing was changed`);
		return fail(`could not reach Valkey at ${shown}: ${(await import("./valkey-auth.mjs")).valkeyDownHint(url)}\n  ${boundedText(error?.message)}`);
	} finally {
		probe.disconnect?.();
		// BOUNDED (issue #846): `close()` waits for the answer to QUIT, so on a Valkey that stopped answering the verb printed
		// its line and then never exited. Past the bound the queue is dropped (`disconnect`, no QUIT), which nothing here
		// needs an answer to: every command this verb sent has been answered or given up on by then.
		await Promise.all(queues.map((q) => closeWithin(q, 1000)));
	}
}

/** Close `queue`, or drop its connection when the close is not answered within `ms`. Never throws. */
async function closeWithin(queue, ms) {
	let timer;
	const closed = await Promise.race([
		Promise.resolve(queue.close()).then(() => true, () => true),
		new Promise((resolve) => (timer = setTimeout(() => resolve(false), ms))),
	]);
	clearTimeout(timer);
	if (!closed) await Promise.resolve(queue.disconnect?.()).catch(() => {});
}

