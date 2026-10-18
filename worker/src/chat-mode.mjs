/**
 * chat-mode.mjs -- which kind of chat a run can have right now (issue #647, terminal chat).
 *
 * ONE RULE, SHARED. `pi-dispatch chat`, the console's `/api/run` and its run page's Chat panel, and the admin's
 * `/dispatch chat` all ask the same question of the same facts, and each would otherwise grow its own table. Three of
 * them drifting apart is how an operator gets offered a reply box for a run that is still running, or a fork of a run
 * whose answer another run already took. So the table lives here, once:
 *
 *   | the run                                              | mode    |
 *   |------------------------------------------------------|---------|
 *   | its job is active, or its run goes on as an active   | live    |
 *   |   #645 recovery job (`activeJobId`)                  |         |
 *   | its job is queued, or its run goes on as a queued    | refused |
 *   |   #645 recovery job (`queuedJobId`)                  |         |
 *   | parked: completed, awaiting-input, no later run on   | reply   |
 *   |   its target took the answer, and none is queued or  |         |
 *   |   running on it now                                  |         |
 *   | finished (any other record, job no longer queued)    | fork    |
 *   | unknown, answered, or being answered (a queue too    | refused |
 *   |   deep to check counts as unknown: `pendingTooMany`) |         |
 *
 * A refusal is `{ mode: null, says }`, with a sentence an operator can act on, never a bare null (the project's fail
 * loudly rule). PURE and TOTAL: no I/O, no clock, no throw; the caller reads the queue, the record and the parked fold,
 * and hands the facts in. Nothing here looks at free text: the record fields read are the worker's own closed words.
 *
 * WHY ACTIVE WINS OVER A RECORD. An infra retry keeps the job id, so attempt 1's record can exist while attempt 2 runs;
 * the run is live, and a fork of attempt 1's session would race the job that is writing it. And WHY QUEUED WINS too: a
 * retry waiting to start is about to become that writer, and so is a #645 recovery job waiting to start (its base
 * attempt's record says `recovery-enqueued`, which on its own would read as finished and offer a fork).
 *
 * WHY A RUN ON THE TARGET THAT HAS NO RECORD YET ANSWERS A PARK. The answered rule (`readParkedRuns`) looks for a later
 * RECORD, and a record is written at a run's end, so the answer's own resume run, queued or running, would leave the
 * park offering a second reply that resumes the same transcript twice. The caller looks for a job on the same target in
 * the queue (`parked.pending`), and a park with one is being answered.
 *
 * The fork mode is the run's MODE, not a promise that a fork will work: whether a session exists on this host, whether
 * the run was a pull request, and the pi-version stamp are the fork's own checks (`chat-fork.mjs`), made where the
 * session store is.
 */

/** The chat modes, in the table's order. */
export const CHAT_MODES = Object.freeze(["live", "reply", "fork"]);

/** The run states `runStateOf` answers, which `/api/run` carries as `state`. */
export const RUN_STATES = Object.freeze(["active", "queued", "parked", "answered", "finished", "unknown"]);

/**
 * BullMQ's words for a job that has not started (or is waiting to start again). `paused` is an older BullMQ's word for
 * a waiting job on a paused queue; it is kept so a mixed fleet still reads as queued. Exported so the readers that look
 * for a run's queued recovery job and for a park's pending answer judge "queued" by this one list.
 */
export const QUEUED_STATES = Object.freeze(["waiting", "delayed", "prioritized", "waiting-children", "paused"]);

/** A run id as the worker mints them (the console's `RUN_ID_RE`); anything else is no active job. */
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** The sentences a refusal says, by why. Exported so a surface can test for one without restating it. */
export const CHAT_REFUSALS = Object.freeze({
	queued: "This run has not started yet (its job is queued), so there is nothing to chat with until it runs.",
	recoveryQueued: "This run goes on as a recovery job that is queued and has not started yet, so there is nothing to chat with until it runs.",
	answered: "This run asked a question and a later run on the same target took the answer; open that run's chat instead.",
	answering: "This run asked a question and a run on the same target is queued or running now, which takes the answer; open that run's chat instead.",
	parkedUnknown: "This run asked a question, but whether it still waits for an answer cannot be told right now (the run history or the queue could not be read); try again.",
	parkedTooMany: "This run asked a question, but the queue holds too many jobs to check whether an answer is already on its way; answer it on the forge, or wait until the queue is shorter.",
	endedNoRecord: "This run's job has ended but its record is not in this host's history or the fleet's run mirror, so there is no session to open.",
	unknown: "No run with that id is in this host's history, the fleet's run mirror or the queue.",
});

/** Whether a record says its run parked on a question (REQ-AWAIT-INPUT): the worker's own closed words. */
function isParkedRecord(record) {
	return record?.outcome === "completed" && record?.reason === "awaiting-input";
}

/**
 * The run's state and its chat, from the facts the caller read:
 *
 * @param {object} facts
 * @param {string|null} facts.state - The BullMQ state of the job named (`job.getState()`), or null when the queue no
 *   longer holds it (removed on completion, or never this queue's).
 * @param {object|null} facts.record - The job's run record, or null when there is none yet (a record is written at a
 *   run's end) or none this host can read.
 * @param {string|null} facts.activeJobId - The run's ACTIVE job: the job itself when it is active, or the #645 recovery
 *   job its run goes on as (`continuesAs`); null when nothing of the run is running.
 * @param {string|null} facts.queuedJobId - The #645 recovery job the run goes on as when that job is QUEUED (waiting,
 *   delayed, prioritized), or null. Ignored when the run is active.
 * @param {{answered: boolean, pending?: boolean|null, pendingTooMany?: boolean}|null} facts.parked - For a parked record:
 *   whether a later run on its target took the answer (`readParkedRuns`'s rule) and whether a job on its target is
 *   queued or running now (`pending`, absent when not looked for, null when the scan could not tell, then
 *   `pendingTooMany` true when that was the queue's depth: `pendingFactsOf`), or null when either could not be read.
 * @returns {{state: string, mode: string|null, says: string|null}}
 */
function judge({ state = null, record = null, activeJobId = null, queuedJobId = null, parked = null } = {}) {
	const active = (typeof activeJobId === "string" && RUN_ID_RE.test(activeJobId)) || state === "active";
	if (active) return { state: "active", mode: "live", says: null };
	if (typeof state === "string" && QUEUED_STATES.includes(state)) return { state: "queued", mode: null, says: CHAT_REFUSALS.queued };
	if (typeof queuedJobId === "string" && RUN_ID_RE.test(queuedJobId)) return { state: "queued", mode: null, says: CHAT_REFUSALS.recoveryQueued };
	const rec = record !== null && typeof record === "object" && !Array.isArray(record) ? record : null;
	if (rec === null) {
		// A job the queue holds as ended with no record is a record this host cannot read (another host's, with no mirror),
		// which is not the same sentence as a run nobody knows.
		const ended = state === "completed" || state === "failed";
		return { state: "unknown", mode: null, says: ended ? CHAT_REFUSALS.endedNoRecord : CHAT_REFUSALS.unknown };
	}
	if (isParkedRecord(rec)) {
		const answered = parked !== null && typeof parked === "object" ? parked.answered : null;
		if (answered === true) return { state: "answered", mode: null, says: CHAT_REFUSALS.answered };
		if (answered === false && parked.pending === true) return { state: "answered", mode: null, says: CHAT_REFUSALS.answering };
		if (answered === false && (parked.pending === false || parked.pending === undefined)) return { state: "parked", mode: "reply", says: null };
		// FAIL LOUDLY when the queue scan could not tell (`pendingTooMany`, review round 2). The scan gives up only on a
		// queue deeper than its budget, and on such a queue a queued answer can wait longer than the ten-minute semantic
		// window (`repo#n:flow`) that would otherwise swallow a second answer: the backstop that would make failing open
		// safe has lapsed exactly when this case arises. So the park is refused with a sentence that says why, and the
		// forge, whose reply goes through the receiver's own path, stays the way to answer it.
		if (answered === false && parked.pendingTooMany === true) return { state: "unknown", mode: null, says: CHAT_REFUSALS.parkedTooMany };
		return { state: "unknown", mode: null, says: CHAT_REFUSALS.parkedUnknown };
	}
	return { state: "finished", mode: "fork", says: null };
}

/**
 * A pending-answer scan's result (the console's `readPendingAnswer`: `{ jobId }` with an id or null, `{ unknown: true,
 * tooMany? }` or `{ unreachable: true }`) as the `parked` facts `chatModeOf` reads: `{ pending, pendingTooMany,
 * pendingJobId }`. ONE mapping, so the run page's Chat panel, `/api/run`, the parked inbox and the planner cannot
 * disagree about what a scan that could not tell means (review round 2: the inbox drew a form where the panel refused).
 */
export function pendingFactsOf(scan) {
	const id = typeof scan?.jobId === "string" && RUN_ID_RE.test(scan.jobId) ? scan.jobId : null;
	if (id !== null) return { pending: true, pendingTooMany: false, pendingJobId: id };
	if (scan !== null && typeof scan === "object" && Object.hasOwn(scan, "jobId") && scan.jobId === null) return { pending: false, pendingTooMany: false, pendingJobId: null };
	return { pending: null, pendingTooMany: scan?.tooMany === true && scan?.unknown === true, pendingJobId: null };
}

/**
 * The verdict on a park no later RECORD answered, from its pending-answer scan alone (`pendingFactsOf`, then this
 * module's table): `{ mode: "reply" | null, says, answeringJobId }`. The parked inbox asks this per row, the Chat panel
 * asks `chatModeOf` with the same facts, so the two screens draw a form for exactly the same parks.
 */
export function parkedVerdictOf(scan) {
	const facts = pendingFactsOf(scan);
	const { mode, says } = judge({ record: { outcome: "completed", reason: "awaiting-input" }, parked: { answered: false, ...facts } });
	return { mode, says, answeringJobId: facts.pendingJobId };
}

/** The run's state word (one of `RUN_STATES`), from the same facts `chatModeOf` takes. */
export function runStateOf(facts) {
	return judge(facts).state;
}

/**
 * The chat this run can have: `{ mode: "live" | "reply" | "fork", says: null }`, or `{ mode: null, says }` with the
 * sentence that says why not. Facts as `runStateOf`'s.
 */
export function chatModeOf(facts) {
	const { mode, says } = judge(facts);
	return { mode, says };
}
