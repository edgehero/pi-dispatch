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
 *
 * Every command it sends has a bound (issue #846 for its own client, issue #867 for its queues), so a Valkey that is
 * connected and stopped answering ends the verb with a line rather than holding it for as long as it stays so. The line
 * says what the point it stopped at allows: the lookup changes nothing about the job (each queue writes its own meta row
 * on connect, as every BullMQ queue does), so nothing was changed; a removal or a hold's delete that was sent and not
 * answered may or may not have been made, and `cancel` again settles it once Valkey answers.
 */

import { CANCEL_REQ_TTL_MS, cancelAckKey, cancelReqKey, ranBefore, removeQueuedJob, requestCancel } from "./cancel-state.mjs";

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

/** A bound in words: whole seconds, or milliseconds below one (a test's bound read "0s"). */
function spoken(ms) {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms} ms`;
}

/** Whether `error` is a command that got no answer: a bound that fired, or one sent whose answer was lost. */
function unanswered(error) {
	return error?.code === "ETIMEDOUT" || error?.valkeyMayStillRun === true;
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
				timer = setTimeout(() => resolve({ unread: `no answer within ${spoken(timeoutMs)}` }), timeoutMs);
			}),
		]);
	} catch (error) {
		return { unread: error?.message ?? String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `promise`'s answer, or a rejection once `ms` passed without one, marked as no answer (`ETIMEDOUT`, `lookupBound`). Each
 * queue's lookup has this bound of its own, as one step (issue #867): BullMQ connects inside the queue, and on a Valkey
 * that takes the connection and never answers, ioredis' handshake (CLIENT SETINFO, then the ready check's INFO) waits
 * one command bound each, on each of the three connections `failFast` tries, so the per-command bound alone ended a
 * lookup after about six of them (measured: 6.4 s at a 1 s bound). A lookup changes nothing about the job, so what it
 * leaves running changes nothing either, and its queue is dropped on the way out (`closeWithin`).
 */
function answeredWithin(promise, ms) {
	let timer;
	return new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${spoken(ms)}`), { code: "ETIMEDOUT", lookupBound: true })), ms);
		Promise.resolve(promise).then(resolve, reject);
	}).finally(() => clearTimeout(timer));
}

/**
 * Run the cancel. Returns the process exit code. Every collaborator is a seam with the production default,
 * so tests drive states and races without a queue; `write` is the stdout seam cli.mjs already injects.
 */
export async function runCancel(jobId, url, { write = (chunk) => process.stdout.write(chunk), errWrite = (chunk) => process.stderr.write(chunk), redisFn, queueFn, parseConnectionFn, readLiveHostsFn, discoverHostQueuesFn, fleetQueueNamesFn, unionQueueNamesFn, ackTimeoutMs = 10_000, pollMs = 250, sleep, refusalFn, touchStore, touchOutbox = null, now = Date.now, commandTimeoutMs = null, closeTimeoutMs = 1000 } = {}) {
	const fail = (message) => {
		errWrite(`error: ${message}\n`);
		return 1;
	};
	if (typeof jobId !== "string" || jobId === "") {
		return fail("a job id is required: pi-dispatch cancel <jobId>  (ids are in `pi-dispatch status`, the panel, and the run log)");
	}
	// Lazy imports, the pause verb's shape: a mistyped id must not load bullmq before it can be refused.
	const { parseConnection, makeRedisClient, VALKEY_COMMAND_TIMEOUT_MS, urlShown } = await import("./connection.mjs");
	// The bound on each command and on the state reads: the console's, unless a test asks for another.
	const bound = Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0 ? commandTimeoutMs : VALKEY_COMMAND_TIMEOUT_MS;
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
	const probe = mkRedis(url, { commandTimeoutMs: bound, disconnectTimeoutMs: 0 });
	probe.on?.("error", () => {});
	// Whether a connection to Valkey was ever made (issue #867, the review): a lookup that got no answer from a Valkey that
	// took the connection says it stopped answering; one where nothing ever took it (an address that drops the connect, a
	// host that is off) says it could not be reached, with the hint, as before #867. The probe connects first, so it tells.
	let connected = false;
	probe.on?.("connect", () => {
		connected = true;
	});
	const queues = [];
	// Whether the job was found: until then nothing about the job changed (issue #867), so a failure says nothing was changed.
	let found = false;
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
		// BOUNDED (issue #867), each command at the probe's bound (`parseConnection`'s `commandTimeoutMs`) and each queue's
		// lookup as one step (`answeredWithin`): `failFast` alone refuses while nothing is connected, and a command a Valkey
		// took and never answered (`kill -STOP`, a partition) held the verb for as long as it stayed so, in the lookup and in
		// the state read and the remove of `removeQueuedJob`, which go through this queue too.
		let job = null;
		let owner = null;
		for (const name of names) {
			const q = mkQueue(parseConn(url, { failFast: true, commandTimeoutMs: bound }), { name });
			queues.push(q);
			job = await answeredWithin(q.getJob(jobId), bound);
			if (job) {
				owner = q;
				found = true;
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
		// Issue #867: a write of the held sequence that was sent and not answered may still run when Valkey wakes, so the line
		// names which write that was and says it may or may not have been made. The cleared line below would say the job
		// "could not be removed" of a removal that may yet land, and its hold "was cleared" of a delete that may not.
		const shown = urlShown(url);
		// Issue #867 (the review): a hold that could not be read refuses, so a held job is never removed by the plain path,
		// which strands its hold as a panel row. Nothing was sent. The outcome comes before the failure's words, which are
		// the only part bounded, so a long id never cuts it off.
		if (typeof queued.holdUnread === "string") {
			if (queued.noAnswer !== undefined) return fail(`Valkey at ${shown} stopped answering (${boundedText(queued.noAnswer)}) while cancel read whether ${jobId} is held, so nothing was changed. Run \`pi-dispatch cancel ${jobId}\` again once Valkey answers`);
			return fail(`could not read whether ${jobId} is held on its wait condition, so nothing was changed: ${boundedText(queued.holdUnread)}`);
		}
		if (queued.invalid !== undefined && queued.cleared !== true && queued.noAnswer !== undefined) {
			return fail(`could not cancel held job ${jobId}: Valkey at ${shown} did not answer (${boundedText(queued.noAnswer)}), so nothing was changed. Run \`pi-dispatch cancel ${jobId}\` again once Valkey answers`);
		}
		if (queued.invalid !== undefined && queued.cleared === true && queued.unanswered === "hold") {
			return fail(`Valkey at ${shown} stopped answering (${boundedText(queued.invalid)}) after the delete of held job ${jobId}'s hold was sent, so the hold may or may not be gone, and the job itself was not removed. Once Valkey answers, run \`pi-dispatch cancel ${jobId}\` again to remove it`);
		}
		if (queued.invalid !== undefined && queued.cleared === true && queued.unanswered === "job") {
			return fail(`Valkey at ${shown} stopped answering (${boundedText(queued.invalid)}) after the removal of held job ${jobId} was sent: its hold was cleared, and the job may or may not have been removed. ${settleLater(jobId)}`);
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
		// Issue #867: a remove that was sent and not answered, with the job not read back in any of BullMQ's lists (it was
		// read as "unknown", or not read at all), may have run: never "nothing was changed", which the re-read below would
		// say of a state it cannot read. A job read back in a list was not removed (its remove is one script), and goes on.
		if (queued.raced && queued.error?.valkeyMayStillRun === true && state === "unknown") {
			return fail(`${valkeyFault(queued.error, shown)} after the removal of ${jobId} was sent, so it may or may not have been removed. ${settleLater(jobId)}`);
		}
		// Issue #846: `removeQueuedJob` reads a state it could not read as "unknown" (the console's sequence shares it), which
		// BullMQ also says of a job that left its queue. Asked again under the bound, so a read that failed says so.
		if (state === "unknown") {
			const again = await boundedState(job, bound);
			if (again.unread !== undefined) return fail(`could not read the state of ${jobId} (${boundedText(again.unread)}), so whether it is running is not known; nothing was changed. Run \`pi-dispatch cancel ${jobId}\` again once Valkey answers`);
		}
		// The one race worth handling by name: picked up between getState and remove. remove() throws on a locked job, so
		// the state is re-read and an active job falls through to the active path rather than failing an operator whose
		// job is now exactly the case the active path exists for. Otherwise the re-read state and the throw's own words
		// together, labelled apart: the error came from the remove attempt, the state from after it, and gluing them
		// unlabelled read as one mismatched diagnosis.
		if (queued.raced && state !== "active") return fail(`could not remove ${jobId} — it is now ${state}; the remove failed with: ${boundedText(queued.error.message)}`);

		if (state === "active") {
			requested = true;
			requestedAt = now();
			const res = await requestCancel({ redis: probe, jobId, ackTimeoutMs, pollMs, now, onWritten: () => (requestedAt = now()), ...(sleep ? { sleep } : {}) });
			if (res.ack !== undefined) {
				write(`cancel accepted by ${res.ack === "" ? "the worker" : boundedText(res.ack)} — stopping the container (allow ~30s); the run record will say operator-cancel\n`);
				return 0;
			}
			// Gate round 2 of PR #479: the worker stops its cancel poll before it holds or retries a job, so a request that
			// lands in that moment is never acknowledged and the job is back in the queue. Re-read, so the words are true.
			// Gate round 3: by the state, since a job that finished or left the queue cannot be removed by a second cancel.
			const read = await boundedState(job, bound);
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
		// What the withdrawing DEL ANSWERED decides the sentence (issue #846, the second adversary round): 1, it was taken back;
		// 0, it was already gone, because its worker read it (and may have acknowledged) or it expired; no answer, not known.
		// Reading "answered" as "withdrawn" said "nothing was changed" of a cancel its worker had taken and acted on, when a
		// poll was lost to a Valkey that died and came back within the bound.
		const within = (promise, ms) => {
			let timer;
			return Promise.race([Promise.resolve(promise).then((value) => ({ value }), (error) => ({ lost: true, error })), new Promise((r) => (timer = setTimeout(() => r({ lost: true }), ms)))]).finally(() => clearTimeout(timer));
		};
		let withdrawal = null;
		let acked = null;
		if (requested) {
			withdrawal = await within(probe.del?.(cancelReqKey(jobId)), 1000);
			if (withdrawal.value !== undefined && Number(withdrawal.value) === 0) {
				const ack = await within(probe.get?.(cancelAckKey(jobId)), 1000);
				if (typeof ack.value === "string") acked = ack.value;
			}
		}
		if (acked !== null) {
			write(`cancel accepted by ${acked === "" ? "the worker" : boundedText(acked)} — stopping the container (allow ~30s); the run record will say operator-cancel\n`);
			return 0;
		}
		if (error?.valkeyRefused) return fail(error.message);
		const shown = urlShown(url);
		// Issue #846: after the request went out, what is said is what became of it. The old line said only "could not reach
		// Valkey ... is it running?", also when Valkey answered with a refusal, and never that a request may still stand.
		if (requested && error?.valkeyMayStillRun) {
			const removed = withdrawal?.value !== undefined ? Number(withdrawal.value) : null;
			if (removed !== null && removed > 0) return fail(`${valkeyFault(error, shown)} after the cancel request for ${jobId} was written. The request was withdrawn again, so nothing was changed, unless its worker read it in that moment: run \`pi-dispatch status\` to see whether ${jobId} still runs`);
			if (removed === 0) return fail(`${valkeyFault(error, shown)} after the cancel request for ${jobId} was written, and the request was gone when the CLI went to withdraw it: its worker may have read it, or it expired, and no acknowledgment was found. Run \`pi-dispatch status\` to see whether ${jobId} still runs`);
			const until = new Date((requestedAt ?? now()) + CANCEL_REQ_TTL_MS).toISOString();
			const then = refusedByValkey(error) || refusedByValkey(withdrawal?.error) ? "run `pi-dispatch status` to see whether it did" : "run `pi-dispatch status` once Valkey answers to see whether it did";
			return fail(`${valkeyFault(error, shown)} after the cancel request for ${jobId} was written, and its withdrawal was not answered, so it may stand until ${until}, ${Math.round(CANCEL_REQ_TTL_MS / 1000)}s after it was written: a worker that reads it before then stops the job. ${then.charAt(0).toUpperCase()}${then.slice(1)}`);
		}
		if (refusedByValkey(error)) return fail(`${valkeyFault(error, shown)}; nothing was changed`);
		// Issue #867: the lookup changes nothing about the job, so a failure there changed nothing, and the line says so: a
		// Valkey that took a connection and stopped answering as that, with when to ask again; one never reached (nothing took
		// a connection, so the lookup's own bound fired, or the queue gave up) as before #867, with the hint. A lost answer
		// (`valkeyMayStillRun`) was on a socket, so it was reached.
		const reached = connected || error?.valkeyMayStillRun === true;
		if (!found && unanswered(error) && reached) return fail(`${valkeyFault(error, shown)} while cancel looked for ${jobId}, so nothing was changed. Run \`pi-dispatch cancel ${jobId}\` again once Valkey answers`);
		const hint = (await import("./valkey-auth.mjs")).valkeyDownHint(url);
		const words = error?.lookupBound === true && !reached ? `no connection within ${spoken(bound)}` : error?.message;
		if (!found) return fail(`could not reach Valkey at ${shown} while cancel looked for ${jobId}, so nothing was changed: ${hint}\n  ${boundedText(words)}`);
		return fail(`could not reach Valkey at ${shown}: ${hint}\n  ${boundedText(error?.message)}`);
	} finally {
		probe.disconnect?.();
		// BOUNDED (issue #846): `close()` waits for the answer to QUIT, so on a Valkey that stopped answering the verb could hold
		// its process after its last line. Past the bound the queue is dropped (`disconnect`, no QUIT; ioredis may still take
		// its own disconnect timeout to let the socket go), which nothing here needs an answer to.
		await Promise.all(queues.map((q) => closeWithin(q, closeTimeoutMs)));
	}
}

/**
 * What to do about a removal that was sent and not answered (issue #867): run the verb again once Valkey answers, which
 * finds the job and removes it, or says no queue holds it. Not `pi-dispatch status`, whose counts name no job.
 */
function settleLater(jobId) {
	return `Once Valkey answers, run \`pi-dispatch cancel ${jobId}\` again: it removes the job if it is still queued, and says so if it is gone`;
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

