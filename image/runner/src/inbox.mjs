import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { configError } from "./outcome.mjs";

/**
 * Issue #646: the run's inbox, the container's half of steering a running job (INT-STEER-INBOX-CONTRACT).
 *
 * The worker relays each message an operator or a forge comment pushed for this run into a file in a host directory
 * mounted read-only at /inbox: `<seq:06d>-<id>.json`, written to a temporary name and renamed, holding
 * `{"v":1,"id","mode","source","content"}` where `content` is the framed text the worker built (data, not
 * instructions). This module reads those files and hands each one to the running agent, once, in order.
 *
 * HOW A MESSAGE REACHES THE MODEL. `api.sendMessage` (pi's `AgentSession.sendCustomMessage`, pinned by hash in
 * pinned-api.test.mjs) with `deliverAs: "steer"` or `"followUp"`. A steer is delivered after the current turn's tool
 * results and before the next model call; a follow-up when the agent would otherwise stop, restarting the loop. pi
 * persists it as a `custom_message` entry at its message_end and the model sees it as user text.
 * REJECTED: `session.steer()`/`followUp()` and `sendUserMessage`. Those run the extensions' input handlers and expand
 * prompt templates and `/skill:` commands, so a comment that begins with `/name` would run a staged template.
 * sendCustomMessage skips all of that: the text arrives exactly as the worker framed it.
 *
 * WHEN IT IS SAFE TO PUSH. Only while a run is active, at most one of ours in flight, never once closed, never once
 * parked:
 *   - "Active" is from each `agent_start` to its `agent_end`, and pi must also say the session is busy
 *     (`ctx.isIdle() === false`). Only while pi's `_isAgentRunActive` holds does sendCustomMessage QUEUE the message
 *     on the agent; outside it, a custom message with no `triggerTurn` is APPENDED to the transcript with its valid
 *     ack and never shown to the model, and the worker would count a delivery that never happened. The window closes
 *     at agent_end, not at agent_settled, because an aborted run skips agent_before_settle, clears the flag and then
 *     awaits every extension's agent_settled handler in load order (file extensions before this inline one): a timer
 *     poll that fired in between would append exactly that entry. Between agent_end and settling, the only push is
 *     the boundary's own (below), made while pi is still inside the run.
 *   - One in flight, cleared on its own message_end: pi drains its steering queue one message per turn, and holding
 *     the rest here keeps the FIFO and the counts ours to report.
 *   - Closed: on `agent_before_settle` the inbox is read ONCE, synchronously, and a waiting message is pushed from
 *     the handler. pi then sees a queued message and continues the loop (`_runBeforeSettleBoundary`:
 *     `result.continue || this.agent.hasQueuedMessages()`, and `canContinue` holds for a trailing assistant with a
 *     queue; pinned). With nothing waiting the inbox closes for good: a message after that point would land after the
 *     run's last answer, so it stays on disk and the worker settles it as late.
 *   - Parked: once `await_human_input` has run, nothing more is pushed. pi's loop polls steering after a terminating
 *     tool and a queued message would un-park the run; the worker turns a held message into the resumed job instead.
 *     The residual: a message pi had already queued in that same turn still un-parks it (one at most), and its ack
 *     says so.
 *
 * WHY POLL rather than fs.watch: the directory is a bind mount whose writer is on the host, and inotify across a bind
 * mount is not delivered on every venue (a VM-backed Docker Desktop shares files through a filesystem that drops
 * them). A readdir every second costs nothing, and the turn_end and before_settle reads make delivery prompt where it
 * matters. The timer is unref'd, so it never holds the process.
 *
 * THE ACK. Each message carries `details.ack = HMAC-SHA256(exitKey, "pi-dispatch-inbox-ack\0" + runId + "\0" + id)`.
 * The transcript under /session is agent-writable, so the worker counts a delivery only when this MAC verifies under
 * the exit key it minted (issue #545), which the agent cannot read. Without a key there is no ack, so the runner
 * refuses PI_STEER outright (the worker arms steer only beside a key).
 *
 * NO SHADOW GUARD, deliberately, unlike await-input.mjs and report-progress.mjs. Those reserve a TOOL name another
 * extension could answer. Nothing here can be answered: the message is pushed by this module straight onto the
 * agent's queue. The one per-customType registration pi offers, `registerMessageRenderer`, is read only by the
 * interactive TUI (`getMessageRenderer`'s single caller is modes/interactive, pinned), never on this headless path,
 * so another extension's renderer for our type changes neither what the model sees nor what is persisted. And an
 * extension that sends a message of our type itself cannot forge the ack, so the worker never counts it.
 *
 * Logs carry ids, modes, sources and counts, never the text.
 */

export const INBOX_DIR = "/inbox";
export const INBOX_FACTORY = "job-inbox";
export const INBOX_CUSTOM_TYPE = "pi-dispatch-inbox";
export const INBOX_FILE_PATTERN = /^\d{6}-([0-9a-f]{32})\.json$/;
export const INBOX_FILE_MAX_BYTES = 16 * 1024;
export const INBOX_MODES = Object.freeze(["steer", "followUp"]);
export const INBOX_SOURCES = Object.freeze(["forge", "console", "cli", "panel"]);
const ACK_DOMAIN = "pi-dispatch-inbox-ack";
const ID_PATTERN = /^[0-9a-f]{32}$/;
/** The worker's cap on messages per run (STEER_MAX_MESSAGES), so the exit line's id list is bounded whatever arrives. */
export const MAX_DELIVERED_IDS = 16;
const ENTRY_KEYS = new Set(["v", "id", "mode", "source", "content"]);

/** The delivery ack for one message: the exit line's primitive (exit-line.mjs exitLineMac), domain-separated. */
export function inboxAck(key, runId, id) {
	return createHmac("sha256", key).update(`${ACK_DOMAIN}\0${runId}\0${id}`, "utf8").digest("hex");
}

function ackVerifies(key, runId, id, ack) {
	if (typeof ack !== "string" || !/^[0-9a-f]{64}$/.test(ack)) return false;
	return timingSafeEqual(Buffer.from(inboxAck(key, runId, id), "hex"), Buffer.from(ack, "hex"));
}

/**
 * A steer-armed job must be able to read its inbox and sign its acks, or it refuses before anything spends. Both are a
 * worker regression or a hand-run container: the worker mounts /inbox and mints a key for every steer job.
 *   - no key: the worker would count no delivery, report every message late and act on it a second time;
 *   - no readable /inbox: every message an operator sends would wait unread while the job reports success.
 */
export function assertSteerReady({ steer, exitKey, dir = INBOX_DIR, fs: fsys = fs }) {
	if (!steer) return;
	if (!exitKey) throw configError("PI_STEER is set but no exit key was delivered: the run could not sign the acks the worker counts deliveries by", "steer-no-exit-key");
	let isDir = false;
	try {
		isDir = fsys.statSync(dir).isDirectory();
		if (isDir) fsys.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
	} catch {
		isDir = false;
	}
	if (!isDir) throw configError(`PI_STEER is set but ${dir} is not a readable directory: the inbox mount did not land`, "steer-inbox-missing");
}

/** One file's message, or the reason it is refused. Pure: the tests pin each edge. */
export function parseInboxEntry(text, idFromName) {
	let entry;
	try {
		entry = JSON.parse(text);
	} catch {
		return { error: "not-json" };
	}
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { error: "not-an-object" };
	for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) return { error: "unknown-field" };
	if (entry.v !== 1) return { error: "version" };
	if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || entry.id !== idFromName) return { error: "id" };
	if (!INBOX_MODES.includes(entry.mode)) return { error: "mode" };
	if (!INBOX_SOURCES.includes(entry.source)) return { error: "source" };
	if (typeof entry.content !== "string" || entry.content.trim() === "") return { error: "content" };
	return { entry: { id: entry.id, mode: entry.mode, source: entry.source, content: entry.content } };
}

export function createInbox({ dir = INBOX_DIR, fs: fsys = fs, exitKey, runId, log = () => {}, pollMs = 1000, isParked = () => false, seenIds = [] }) {
	if (!exitKey) throw new Error("createInbox needs the exit key: the acks are signed with it");
	const seen = new Set(seenIds);
	// Names already refused (malformed, oversized), so a bad file is judged and logged once, not every second.
	const refused = new Set();
	const queue = [];
	let api = null;
	let active = false;
	let closed = false;
	let inFlight = null;
	let delivered = 0;
	let timer = null;
	let unreadable = false;
	let heldLogged = 0;
	// The ids this runner handed over and saw delivered, for the SIGNED exit line: the worker marks them delivered from
	// it even when it could not read the transcript (an agent can swap /session/current.jsonl for a symlink).
	const deliveredIds = [];
	// The last context pi handed a handler: its isIdle() is pi's own answer to "is a run active", read at each push.
	let ctx = null;

	/** Read the directory once and queue every new, valid message in file-name order (the worker's sequence). */
	function scan() {
		let names;
		try {
			names = fsys.readdirSync(dir);
		} catch (error) {
			// The mount was there at start (assertSteerReady). Said once, by code: messages then stay on the host as late.
			if (!unreadable) log("steer_inbox_unreadable", { code: typeof error?.code === "string" ? error.code : "unknown" });
			unreadable = true;
			return;
		}
		for (const name of names.filter((candidate) => INBOX_FILE_PATTERN.test(candidate)).sort()) {
			const id = INBOX_FILE_PATTERN.exec(name)[1];
			if (seen.has(id) || refused.has(name)) continue;
			const path = `${dir}/${name}`;
			let text;
			try {
				if (fsys.statSync(path).size > INBOX_FILE_MAX_BYTES) {
					refused.add(name);
					log("steer_file_refused", { id, reason: "too-large" });
					continue;
				}
				text = fsys.readFileSync(path, "utf8");
			} catch {
				// Gone between the listing and the read: the worker withdrew it. Not refused, so a rewrite is read again.
				continue;
			}
			if (Buffer.byteLength(text, "utf8") > INBOX_FILE_MAX_BYTES) {
				refused.add(name);
				log("steer_file_refused", { id, reason: "too-large" });
				continue;
			}
			const parsed = parseInboxEntry(text, id);
			if (parsed.error) {
				refused.add(name);
				log("steer_file_refused", { id, reason: parsed.error });
				continue;
			}
			seen.add(id);
			queue.push(parsed.entry);
		}
	}

	function pending() {
		return queue.length + (inFlight ? 1 : 0);
	}

	function noteHeld() {
		const count = pending();
		if (count > heldLogged) log("steer_held_parked", { pending: count });
		heldLogged = Math.max(heldLogged, count);
	}

	function sessionBusy() {
		try {
			return ctx !== null && ctx.isIdle() === false;
		} catch {
			// A context pi has invalidated (a disposed session) is no run.
			return false;
		}
	}

	/**
	 * Hand the next message to pi, when every rule in the header allows it. True when one was pushed. `atBoundary` is
	 * the agent_before_settle handler's push: after agent_end, but still inside pi's run, which is what makes it safe.
	 */
	function pump({ atBoundary = false } = {}) {
		if (api === null || closed || (!active && !atBoundary) || !sessionBusy() || inFlight !== null || queue.length === 0) return false;
		if (isParked()) {
			noteHeld();
			return false;
		}
		const next = queue.shift();
		inFlight = next;
		api.sendMessage(
			{
				customType: INBOX_CUSTOM_TYPE,
				content: [{ type: "text", text: next.content }],
				display: true,
				details: { id: next.id, mode: next.mode, source: next.source, ack: inboxAck(exitKey, runId, next.id) },
			},
			{ deliverAs: next.mode },
		);
		return true;
	}

	function poll() {
		scan();
		pump();
	}

	const factory = {
		name: INBOX_FACTORY,
		factory: (extensionApi) => {
			api = extensionApi;
			extensionApi.on("agent_start", (_event, context) => {
				if (context) ctx = context;
				if (closed) return;
				active = true;
				// pi polls its steering queue right after agent_start, so a message waiting from before the prompt goes
				// before the first model call.
				pump();
			});
			// Read at every turn's end too: the agent's loop awaits this handler before it polls its steering queue, so
			// a file that landed during the turn is delivered after that turn's tool results, not a poll interval later.
			extensionApi.on("turn_end", (_event, context) => {
				if (context) ctx = context;
				if (!closed) poll();
			});
			// The end of one low-level run (see the header): nothing is pushed from the timer until the next agent_start.
			extensionApi.on("agent_end", () => {
				active = false;
			});
			extensionApi.on("message_end", (event) => {
				const message = event?.message;
				if (message?.role !== "custom" || message.customType !== INBOX_CUSTOM_TYPE) return;
				if (inFlight === null || message.details?.id !== inFlight.id) return;
				delivered += 1;
				if (deliveredIds.length < MAX_DELIVERED_IDS) deliveredIds.push(inFlight.id);
				log("steer_delivered", { id: inFlight.id, mode: inFlight.mode, source: inFlight.source });
				inFlight = null;
				pump();
			});
			// The closing moment (see the header). Synchronous on purpose: the read and the push happen inside the
			// handler pi awaits, so nothing can land between "nothing waiting" and the close.
			extensionApi.on("agent_before_settle", (_event, context) => {
				if (context) ctx = context;
				if (closed) return;
				// One of ours is still queued in pi: it keeps the loop going by itself, and this is not the last moment.
				if (inFlight !== null) return;
				scan();
				if (pump({ atBoundary: true })) return;
				closed = true;
				active = false;
			});
			// A run that ends without the boundary (an abort) closes here. Nothing pushed after this would be answered.
			extensionApi.on("agent_settled", () => {
				closed = true;
				active = false;
			});
		},
	};

	return {
		factory,
		/**
		 * Mark every message this transcript already shows as delivered, so a resumed or recovered run never hands one
		 * over twice. Only an entry whose ack verifies counts: the transcript is agent-writable, and an entry the agent
		 * wrote itself must not suppress a real message.
		 */
		seed(sessionManager) {
			for (const entry of sessionManager.getEntries()) {
				if (entry?.type !== "custom_message" || entry.customType !== INBOX_CUSTOM_TYPE) continue;
				const id = entry.details?.id;
				if (typeof id === "string" && ID_PATTERN.test(id) && ackVerifies(exitKey, runId, id, entry.details?.ack)) seen.add(id);
			}
		},
		start() {
			if (timer !== null || closed) return;
			timer = setInterval(poll, pollMs);
			timer.unref?.();
		},
		poll,
		/** Stop for good. One last read, so `pending` counts what is on disk at exit and was never handed over. */
		close() {
			if (timer !== null) clearInterval(timer);
			timer = null;
			closed = true;
			active = false;
			scan();
		},
		/** The exit line's `steer` object: integers, and the delivered ids (32 hex each, never text). */
		counts() {
			return { delivered, pending: pending(), deliveredIds: deliveredIds.slice() };
		},
	};
}
