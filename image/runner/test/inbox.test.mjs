import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseRunnerEnv } from "../src/config.mjs";
import { captureTerminal, EXIT_POLICY } from "../src/outcome.mjs";
import { createAwaitInput, parkedTerminal } from "../src/await-input.mjs";
import { assertSteerReady, createInbox, INBOX_CUSTOM_TYPE, INBOX_FILE_MAX_BYTES, inboxAck, MAX_DELIVERED_IDS, parseInboxEntry } from "../src/inbox.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { sessionFixture, scriptedSession } from "./helpers/recover-session.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #646, the container's half of steering a running job: the env that arms it, the inbox files it reads, when it
 * hands a message to pi and when it must not, and the ack the worker counts deliveries by. The real-session tests run a
 * scripted offline model over a real persisted SessionManager; they skip where pi cannot load and fail instead under
 * PI_DISPATCH_REQUIRE_LOADER_TESTS=1, like recover.test.mjs.
 */
let deps;
let importError;
try {
	deps = {
		pi: await import("@earendil-works/pi-coding-agent"),
		piAi: await import("@earendil-works/pi-ai"),
		loaderModule: await import("../src/loader.mjs"),
		createJobModelRuntime,
	};
} catch (error) {
	importError = error;
}
if (!deps && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`inbox tests are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = deps ? false : `pi not installed (node ${process.version}); CI runs these`;

const BASE = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-5-20250929", PI_MAX_TURNS: "10" };
const KEY = "ab".repeat(32);
const RUN_ID = "run-646";
const policy = (error) => error.piDispatchExit === EXIT_POLICY;
const id = (n) => n.toString(16).padStart(32, "0");
const fileName = (seq, messageId) => `${String(seq).padStart(6, "0")}-${messageId}.json`;
const entryText = ({ messageId, mode = "steer", source = "cli", content = "a message" }) => JSON.stringify({ v: 1, id: messageId, mode, source, content });
/** Write one inbox file the way the worker does (mode 0444). */
function writeEntry(dir, seq, fields) {
	const path = join(dir, fileName(seq, fields.messageId));
	writeFileSync(path, entryText(fields));
	chmodSync(path, 0o444);
}
/** The test's own HMAC, so the ack is checked against the contract rather than against inboxAck itself. */
const expectedAck = (key, runId, messageId) => createHmac("sha256", key).update(`pi-dispatch-inbox-ack\0${runId}\0${messageId}`).digest("hex");

// ── The env and the refusals ───────────────────────────────────────────────────────────────────────────────────

test("PI_STEER: absent or empty is off, \"1\" is on, anything else is a config error", () => {
	assert.equal(parseRunnerEnv(BASE).steer, false);
	assert.equal(parseRunnerEnv({ ...BASE, PI_STEER: "" }).steer, false);
	assert.equal(parseRunnerEnv({ ...BASE, PI_STEER: "1" }).steer, true);
	for (const bad of ["0", "true", "yes", " 1", "1 "]) assert.throws(() => parseRunnerEnv({ ...BASE, PI_STEER: bad }), policy, bad);
});

test("assertSteerReady: no key is steer-no-exit-key, no readable directory is steer-inbox-missing, an unarmed job checks nothing", () => {
	const root = tempDir("pi-dispatch-inbox-ready-");
	const dir = join(root, "inbox");
	assert.doesNotThrow(() => assertSteerReady({ steer: false, exitKey: null, dir }));
	assert.throws(() => assertSteerReady({ steer: true, exitKey: null, dir }), (error) => policy(error) && error.piDispatchReason === "steer-no-exit-key");
	assert.throws(() => assertSteerReady({ steer: true, exitKey: KEY, dir }), (error) => policy(error) && error.piDispatchReason === "steer-inbox-missing");
	writeFileSync(dir, "a file, not a directory");
	assert.throws(() => assertSteerReady({ steer: true, exitKey: KEY, dir }), (error) => error.piDispatchReason === "steer-inbox-missing");
	const real = join(root, "real");
	mkdirSync(real);
	assert.doesNotThrow(() => assertSteerReady({ steer: true, exitKey: KEY, dir: real }));
	if (process.getuid?.() !== 0) {
		chmodSync(real, 0o000);
		try {
			assert.throws(() => assertSteerReady({ steer: true, exitKey: KEY, dir: real }), (error) => error.piDispatchReason === "steer-inbox-missing", "present but unreadable");
		} finally {
			chmodSync(real, 0o700);
		}
	}
});

test("parseInboxEntry: the contract's shape, the id agreeing with the file name, closed modes and sources", () => {
	const good = { v: 1, id: id(1), mode: "steer", source: "forge", content: "text" };
	assert.deepEqual(parseInboxEntry(JSON.stringify(good), id(1)), { entry: { id: id(1), mode: "steer", source: "forge", content: "text" } });
	assert.equal(parseInboxEntry(JSON.stringify({ ...good, mode: "followUp", source: "panel" }), id(1)).entry.mode, "followUp");
	const cases = [
		["{", "not-json"],
		["[]", "not-an-object"],
		[JSON.stringify({ ...good, text: "x" }), "unknown-field"],
		[JSON.stringify({ ...good, v: 2 }), "version"],
		[JSON.stringify({ ...good, id: id(2) }), "id"],
		[JSON.stringify({ ...good, id: 1 }), "id"],
		[JSON.stringify({ ...good, mode: "nextTurn" }), "mode"],
		[JSON.stringify({ ...good, source: "email" }), "source"],
		[JSON.stringify({ ...good, content: " \n" }), "content"],
		[JSON.stringify({ ...good, content: 5 }), "content"],
	];
	for (const [text, error] of cases) assert.deepEqual(parseInboxEntry(text, id(1)), { error }, text);
});

test("(g) the ack is HMAC-SHA256 under the exit key of the domain, the run id and the message id", () => {
	assert.equal(inboxAck(KEY, RUN_ID, id(7)), expectedAck(KEY, RUN_ID, id(7)));
	assert.notEqual(inboxAck(KEY, RUN_ID, id(7)), inboxAck(KEY, "other-run", id(7)), "bound to the run");
	assert.notEqual(inboxAck(KEY, RUN_ID, id(7)), inboxAck("cd".repeat(32), RUN_ID, id(7)), "bound to the key");
	// Domain-separated from the exit line's MAC of the same bytes.
	assert.notEqual(inboxAck(KEY, RUN_ID, id(7)), createHmac("sha256", KEY).update(`${RUN_ID}\0${id(7)}`).digest("hex"));
});

// ── The rules, on a stand-in extension API ─────────────────────────────────────────────────────────────────────

/** A stand-in for pi's extension API. Each handler gets a context whose isIdle() answers from `state.idle`, as pi's does. */
function fakeApi() {
	const handlers = {};
	const sent = [];
	const state = { idle: false };
	const ctx = { isIdle: () => state.idle };
	return {
		handlers,
		sent,
		state,
		on: (event, handler) => {
			handlers[event] = (payload = {}) => handler(payload, ctx);
		},
		sendMessage: (message, options) => sent.push({ message, options }),
	};
}

function standIn({ parked = false, logs = [] } = {}) {
	const dir = tempDir("pi-dispatch-inbox-unit-");
	const inbox = createInbox({ dir, exitKey: KEY, runId: RUN_ID, log: (event, fields) => logs.push({ event, ...fields }), pollMs: 1_000_000, isParked: () => parked });
	const api = fakeApi();
	inbox.factory.factory(api);
	const deliver = (n) => api.handlers.message_end({ message: { role: "custom", customType: INBOX_CUSTOM_TYPE, details: { id: api.sent[n].message.details.id } } });
	return { dir, inbox, api, logs, deliver };
}

test("the inbox pushes nothing before agent_start, one at a time in file order, the next on the last one's message_end", () => {
	const { dir, inbox, api, logs, deliver } = standIn();
	assert.equal(inbox.factory.name, "job-inbox");
	// Both steers: order across modes is no longer one FIFO (issue #670, the tests below), so this keeps to one mode.
	writeEntry(dir, 2, { messageId: id(2), source: "console", content: "second" });
	writeEntry(dir, 1, { messageId: id(1), content: "first" });
	writeFileSync(join(dir, ".tmp-not-yet"), "x");
	writeFileSync(join(dir, `1-${id(3)}.json`), entryText({ messageId: id(3) }));
	inbox.poll();
	assert.equal(api.sent.length, 0, "no run is active yet");
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 2, deliveredIds: [] }, "only names of the contract's shape are read");
	api.handlers.agent_start();
	assert.equal(api.sent.length, 1);
	assert.deepEqual(api.sent[0], {
		message: { customType: INBOX_CUSTOM_TYPE, content: [{ type: "text", text: "first" }], display: true, details: { id: id(1), mode: "steer", source: "cli", ack: expectedAck(KEY, RUN_ID, id(1)) } },
		options: { deliverAs: "steer" },
	});
	inbox.poll();
	api.handlers.turn_end();
	assert.equal(api.sent.length, 1, "at most one of ours in flight");
	api.handlers.message_end({ message: { role: "custom", customType: "someone-else", details: { id: id(1) } } });
	api.handlers.message_end({ message: { role: "user", content: "first" } });
	assert.equal(api.sent.length, 1, "only our own message_end clears it");
	deliver(0);
	assert.equal(api.sent.length, 2);
	assert.deepEqual(api.sent[1].options, { deliverAs: "steer" });
	assert.equal(api.sent[1].message.details.id, id(2));
	deliver(1);
	assert.deepEqual(inbox.counts(), { delivered: 2, pending: 0, deliveredIds: [id(1), id(2)] });
	assert.deepEqual(logs.filter((line) => line.event === "steer_delivered"), [
		{ event: "steer_delivered", id: id(1), mode: "steer", source: "cli" },
		{ event: "steer_delivered", id: id(2), mode: "steer", source: "console" },
	]);
	assert.equal(JSON.stringify(logs).includes("first"), false, "never the text");
	// The same id under a later sequence number is the same message.
	writeEntry(dir, 9, { messageId: id(1), content: "first, again" });
	inbox.poll();
	assert.equal(api.sent.length, 2);
});

test("a malformed or oversized file is refused once, by id and reason, and never sent", () => {
	const { dir, inbox, api, logs } = standIn();
	api.handlers.agent_start();
	writeFileSync(join(dir, fileName(1, id(1))), "{not json");
	writeFileSync(join(dir, fileName(2, id(2))), entryText({ messageId: id(2), content: "x".repeat(INBOX_FILE_MAX_BYTES) }));
	inbox.poll();
	inbox.poll();
	assert.equal(api.sent.length, 0);
	assert.deepEqual(logs, [
		{ event: "steer_file_refused", id: id(1), reason: "not-json" },
		{ event: "steer_file_refused", id: id(2), reason: "too-large" },
	]);
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 0, deliveredIds: [] });
});

test("agent_before_settle: a waiting message is pushed from the handler; with none the inbox closes for good", () => {
	const { dir, inbox, api } = standIn();
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 1, "read and pushed synchronously, inside the boundary");
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 1, "one in flight: pi continues for it, so this is not the last moment");
	api.handlers.message_end({ message: { role: "custom", customType: INBOX_CUSTOM_TYPE, details: { id: id(1) } } });
	api.handlers.agent_before_settle();
	writeEntry(dir, 2, { messageId: id(2) });
	inbox.poll();
	api.handlers.agent_start();
	api.handlers.turn_end();
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 1, "closed: nothing after the last answer");
	assert.deepEqual(inbox.counts(), { delivered: 1, pending: 1, deliveredIds: [id(1)] });
});

test("parked: nothing is pushed once await_human_input has run, and the held count is logged", () => {
	const { dir, inbox, api, logs } = standIn({ parked: true });
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	api.handlers.turn_end();
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 0);
	assert.deepEqual(logs, [{ event: "steer_held_parked", pending: 1 }], "said once");
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
});

test("the poll timer reads the directory on its own, and close stops it and counts what is left", async () => {
	const dir = tempDir("pi-dispatch-inbox-timer-");
	const inbox = createInbox({ dir, exitKey: KEY, runId: RUN_ID, pollMs: 5 });
	const api = fakeApi();
	inbox.factory.factory(api);
	api.handlers.agent_start();
	inbox.start();
	writeEntry(dir, 1, { messageId: id(1) });
	for (let i = 0; i < 200 && api.sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(api.sent.length, 1, "delivered by the timer, with no event");
	inbox.close();
	writeEntry(dir, 2, { messageId: id(2) });
	await new Promise((resolve) => setTimeout(resolve, 30));
	inbox.close();
	assert.equal(api.sent.length, 1);
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 2, deliveredIds: [] }, "the one in flight and the one on disk");
	assert.throws(() => createInbox({ dir, exitKey: null, runId: RUN_ID }), /exit key/);
});

test("before_settle with one in flight does not close: the next file is still pushed after that one's message_end (N04)", () => {
	const { dir, api, deliver } = standIn();
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	writeEntry(dir, 2, { messageId: id(2) });
	api.handlers.turn_end();
	assert.equal(api.sent.length, 1);
	api.handlers.agent_before_settle();
	deliver(0);
	assert.equal(api.sent.length, 2, "still open");
	assert.equal(api.sent[1].message.details.id, id(2));
});

test("after a push from before_settle the inbox stays open for the next file (N05)", () => {
	const { dir, api, deliver } = standIn();
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 1, "the boundary pushes after agent_end");
	api.handlers.agent_start();
	deliver(0);
	writeEntry(dir, 2, { messageId: id(2) });
	api.handlers.turn_end();
	assert.equal(api.sent.length, 2);
});

test("an aborted run (agent_end, agent_settled, no before_settle) and an idle session get nothing from the timer (F4, N19)", () => {
	const ended = standIn();
	ended.api.handlers.agent_start();
	ended.api.handlers.agent_end();
	writeEntry(ended.dir, 1, { messageId: id(1) });
	ended.inbox.poll();
	assert.equal(ended.api.sent.length, 0, "between agent_end and the settled handlers: pi would append it unanswered");
	ended.api.handlers.agent_settled();
	ended.inbox.poll();
	assert.equal(ended.api.sent.length, 0, "settled");
	ended.api.handlers.agent_start();
	ended.inbox.poll();
	assert.equal(ended.api.sent.length, 0, "and closed for good");
	assert.deepEqual(ended.inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
	const idle = standIn();
	idle.api.handlers.agent_start();
	idle.api.state.idle = true;
	writeEntry(idle.dir, 1, { messageId: id(1) });
	idle.inbox.poll();
	assert.equal(idle.api.sent.length, 0, "pi says no run is active");
	idle.api.state.idle = false;
	idle.inbox.poll();
	assert.equal(idle.api.sent.length, 1);
});

test("a message_end of our type with another id does not clear the one in flight (N13)", () => {
	const { dir, api } = standIn();
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	writeEntry(dir, 2, { messageId: id(2) });
	api.handlers.turn_end();
	api.handlers.message_end({ message: { role: "custom", customType: INBOX_CUSTOM_TYPE, details: { id: id(9) } } });
	api.handlers.turn_end();
	assert.equal(api.sent.length, 1);
	assert.equal(api.sent[0].message.details.id, id(1));
});

// All steers: file order is the rule within a mode; across modes a steer goes first (issue #670, the tests above).
test("files are pushed in file-name order whatever order readdir lists them in (N16)", async () => {
	const dir = tempDir("pi-dispatch-inbox-order-");
	const realFs = (await import("node:fs")).default;
	const reversed = { ...realFs, readdirSync: (path) => realFs.readdirSync(path).sort().reverse() };
	const inbox = createInbox({ dir, fs: reversed, exitKey: KEY, runId: RUN_ID, pollMs: 1_000_000 });
	const api = fakeApi();
	inbox.factory.factory(api);
	api.handlers.agent_start();
	for (const n of [3, 1, 2]) writeEntry(dir, n, { messageId: id(n) });
	const order = [];
	for (let i = 0; i < 3; i++) {
		inbox.poll();
		order.push(api.sent[i].message.details.id);
		api.handlers.message_end({ message: { role: "custom", customType: INBOX_CUSTOM_TYPE, details: { id: order[i] } } });
	}
	assert.deepEqual(order, [id(1), id(2), id(3)]);
});

// Issue #670: a follow-up means "when the agent would stop", and pi drains its follow-up queue only then. Handed to pi
// early it held the runner's one in-flight slot and every later steer waited behind it, so follow-ups now wait in the
// runner and only the settle boundary hands one over. Order holds within each mode, not across them.
// Each push as [id, the mode its details carry, how pi was asked to queue it]: always a pi steer, a follow-up only at the
// settle boundary (review round 1: after a run a terminating tool ended, pi's continuation polls only steering first).
const pushed = (api) => api.sent.map((sent) => [sent.message.details.id, sent.message.details.mode, sent.options.deliverAs]);

test("a steer sent after a follow-up goes at the next turn_end; the follow-up waits for agent_before_settle (issue #670)", () => {
	const { dir, inbox, api, deliver } = standIn();
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1), mode: "followUp", content: "later" });
	api.handlers.turn_end();
	assert.equal(api.sent.length, 0, "a follow-up is not handed to pi mid-run");
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] }, "but it is pending");
	writeEntry(dir, 2, { messageId: id(2), content: "now" });
	api.handlers.turn_end();
	assert.deepEqual(pushed(api), [[id(2), "steer", "steer"]], "the steer is not held behind the follow-up");
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 2, deliveredIds: [] }, "the follow-up waiting and the steer in flight");
	deliver(0);
	api.handlers.turn_end();
	inbox.poll();
	assert.equal(api.sent.length, 1, "still waiting: the agent has not stopped");
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.deepEqual(pushed(api), [[id(2), "steer", "steer"], [id(1), "followUp", "steer"]], "handed over at the boundary as a pi steer, its details still a follow-up");
	api.handlers.agent_start();
	deliver(1);
	assert.deepEqual(inbox.counts(), { delivered: 2, pending: 0, deliveredIds: [id(2), id(1)] });
});

test("interleaved follow-ups and steers keep file order within each mode; at the boundary a waiting steer goes first; it closes only with both empty (issue #670)", () => {
	const { dir, inbox, api, deliver } = standIn();
	writeEntry(dir, 1, { messageId: id(1), mode: "followUp" });
	writeEntry(dir, 2, { messageId: id(2) });
	writeEntry(dir, 3, { messageId: id(3), mode: "followUp" });
	writeEntry(dir, 4, { messageId: id(4) });
	inbox.poll();
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 4, deliveredIds: [] }, "both FIFOs count");
	api.handlers.agent_start();
	deliver(0);
	api.handlers.turn_end();
	assert.deepEqual(pushed(api), [[id(2), "steer", "steer"], [id(4), "steer", "steer"]], "the steers, in file order, past the first follow-up");
	deliver(1);
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.deepEqual(pushed(api).at(-1), [id(1), "followUp", "steer"], "the oldest follow-up");
	api.handlers.agent_start();
	deliver(2);
	assert.equal(api.sent.length, 3, "the next follow-up waits for the next boundary");
	// A steer that lands now goes before the follow-up still waiting, at the next boundary too.
	writeEntry(dir, 5, { messageId: id(5) });
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.deepEqual(pushed(api).at(-1), [id(5), "steer", "steer"], "a waiting steer first");
	api.handlers.agent_start();
	deliver(3);
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.deepEqual(pushed(api).at(-1), [id(3), "followUp", "steer"], "follow-ups waiting keep the inbox open");
	api.handlers.agent_start();
	deliver(4);
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	writeEntry(dir, 6, { messageId: id(6) });
	api.handlers.agent_start();
	api.handlers.turn_end();
	assert.equal(api.sent.length, 5, "both FIFOs empty at the boundary: closed for good");
	inbox.close();
	assert.deepEqual(inbox.counts(), { delivered: 5, pending: 1, deliveredIds: [id(2), id(4), id(1), id(5), id(3)] });
});

test("a follow-up whose file is unlinked while held is never pushed, not pending, and logged; at close too (issue #670)", () => {
	const logs = [];
	const { dir, inbox, api } = standIn({ logs });
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1), mode: "followUp", source: "console", content: "withdrawn text" });
	api.handlers.turn_end();
	assert.equal(inbox.counts().pending, 1);
	// The worker withdrew it: its relay unlinks the file.
	unlinkSync(join(dir, fileName(1, id(1))));
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 0, "a withdrawn message never becomes a delivery");
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 0, deliveredIds: [] });
	assert.deepEqual(logs, [{ event: "steer_withdrawn_held", id: id(1), mode: "followUp", source: "console" }]);
	assert.equal(JSON.stringify(logs).includes("withdrawn text"), false, "never the text");
	// Nothing was pushed, so the boundary closed: a later file is never handed over, even if pi starts a run again.
	writeEntry(dir, 2, { messageId: id(2) });
	api.handlers.agent_start();
	api.handlers.turn_end();
	inbox.poll();
	assert.equal(api.sent.length, 0, "every held entry withdrawn at the boundary closes the inbox");
	// A run that ends without the boundary (an abort): close's last check still drops it from the count.
	const aborted = standIn();
	aborted.api.handlers.agent_start();
	writeEntry(aborted.dir, 1, { messageId: id(1), mode: "followUp" });
	writeEntry(aborted.dir, 2, { messageId: id(2), mode: "followUp" });
	aborted.api.handlers.turn_end();
	unlinkSync(join(aborted.dir, fileName(1, id(1))));
	aborted.api.handlers.agent_end();
	aborted.api.handlers.agent_settled();
	aborted.inbox.close();
	assert.deepEqual(aborted.inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] }, "only the one still on disk");
	assert.deepEqual(aborted.logs, [{ event: "steer_withdrawn_held", id: id(1), mode: "followUp", source: "cli" }]);
	// The same for a steer held behind the one in flight: withdrawn, then aborted, it is not counted at the close.
	const steers = standIn();
	steers.api.handlers.agent_start();
	for (const n of [1, 2, 3]) writeEntry(steers.dir, n, { messageId: id(n) });
	steers.api.handlers.turn_end();
	assert.deepEqual(pushed(steers.api), [[id(1), "steer", "steer"]]);
	unlinkSync(join(steers.dir, fileName(2, id(2))));
	steers.api.handlers.agent_end();
	steers.api.handlers.agent_settled();
	steers.inbox.close();
	assert.deepEqual(steers.inbox.counts(), { delivered: 0, pending: 2, deliveredIds: [] }, "the one in flight and the one still on disk");
	assert.deepEqual(steers.logs, [{ event: "steer_withdrawn_held", id: id(2), mode: "steer", source: "cli" }]);
});

test("a steer whose file is unlinked while held behind another is never pushed, not pending, and logged (issue #670)", () => {
	const { dir, inbox, api, logs, deliver } = standIn();
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	writeEntry(dir, 2, { messageId: id(2) });
	writeEntry(dir, 3, { messageId: id(3) });
	api.handlers.turn_end();
	assert.deepEqual(pushed(api), [[id(1), "steer", "steer"]]);
	unlinkSync(join(dir, fileName(2, id(2))));
	deliver(0);
	assert.deepEqual(pushed(api), [[id(1), "steer", "steer"], [id(3), "steer", "steer"]], "the withdrawn one is skipped, the next goes");
	deliver(1);
	assert.deepEqual(inbox.counts(), { delivered: 2, pending: 0, deliveredIds: [id(1), id(3)] });
	assert.deepEqual(logs.filter((line) => line.event === "steer_withdrawn_held"), [{ event: "steer_withdrawn_held", id: id(2), mode: "steer", source: "cli" }]);
});

test("parked: neither a steer nor a follow-up is pushed, and the held count says both (issue #670)", () => {
	const { dir, inbox, api, logs } = standIn({ parked: true });
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1), mode: "followUp" });
	writeEntry(dir, 2, { messageId: id(2) });
	api.handlers.turn_end();
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 0);
	assert.deepEqual(logs, [{ event: "steer_held_parked", pending: 2 }]);
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 2, deliveredIds: [] });
});

test("parked with only follow-ups held: nothing is logged mid-run, and the boundary logs the count without a withdrawn one (issue #670)", () => {
	const { dir, inbox, api, logs } = standIn({ parked: true });
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1), mode: "followUp" });
	writeEntry(dir, 2, { messageId: id(2), mode: "followUp" });
	api.handlers.turn_end();
	assert.deepEqual(logs, [], "a follow-up is not a mid-run push, so there is nothing held from one yet");
	unlinkSync(join(dir, fileName(2, id(2))));
	api.handlers.agent_end();
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 0);
	assert.deepEqual(logs, [
		{ event: "steer_withdrawn_held", id: id(2), mode: "followUp", source: "cli" },
		{ event: "steer_held_parked", pending: 1 },
	], "pruned before it is counted");
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
});

test("parked at before_settle: the held message is logged there (N29)", () => {
	const { dir, api, logs, inbox } = standIn({ parked: true });
	api.handlers.agent_start();
	writeEntry(dir, 1, { messageId: id(1) });
	api.handlers.agent_before_settle();
	assert.equal(api.sent.length, 0);
	assert.deepEqual(logs, [{ event: "steer_held_parked", pending: 1 }]);
	assert.deepEqual(inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
});

test("deliveredIds lists the delivered ids in order, at most MAX_DELIVERED_IDS (16) of them", () => {
	const { dir, api, inbox, deliver } = standIn();
	api.handlers.agent_start();
	for (let n = 1; n <= 17; n++) writeEntry(dir, n, { messageId: id(n) });
	inbox.poll();
	for (let n = 0; n < 17; n++) deliver(n);
	const counts = inbox.counts();
	assert.equal(counts.delivered, 17);
	assert.equal(MAX_DELIVERED_IDS, 16);
	assert.deepEqual(counts.deliveredIds, Array.from({ length: 16 }, (_, n) => id(n + 1)));
	counts.deliveredIds.push("x");
	assert.equal(inbox.counts().deliveredIds.length, 16, "a copy");
});

// ── Real sessions ──────────────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_BODY = "EXPANDED TEMPLATE BODY, which a steer must never become";
const lsCall = (callId) => [{ type: "toolCall", id: callId, name: "ls", arguments: { path: "." } }];
const text = (value) => [{ type: "text", text: value }];
const userText = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
const entries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** A real session on the persisted transcript with the inbox (and any other factories) loaded. */
async function steerSession(name, { script, onCall, first = [], extra = [], parked = false, before = () => {}, seenIds } = {}) {
	const f = sessionFixture(tempDir(`pi-dispatch-inbox-${name}-`));
	const inboxDir = join(f.root, "inbox");
	mkdirSync(inboxDir);
	const logs = [];
	const awaitInput = parked ? createAwaitInput() : null;
	const inbox = createInbox({ dir: inboxDir, exitKey: KEY, runId: RUN_ID, log: (event, fields) => logs.push({ event, ...fields }), pollMs: 1_000_000, isParked: () => awaitInput?.state.called === true, seenIds });
	const { openSessionManager } = await import("../src/session.mjs");
	const { sessionManager } = openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
	before({ f, inboxDir, sessionManager });
	const built = await scriptedSession(deps, f, {
		api: `pi-dispatch-inbox-${name}`,
		script,
		sessionManager,
		onCall: onCall ? (n) => onCall(n, inboxDir) : undefined,
		extensionFactories: [...first, ...(awaitInput?.factories ?? []), inbox.factory, ...extra],
	});
	inbox.seed(sessionManager);
	let terminal;
	const customEnds = [];
	built.session.subscribe((event) => {
		terminal = captureTerminal(terminal, event);
		if (event.type === "message_end" && event.message.role === "custom") customEnds.push(event.message);
	});
	return { f, inbox, inboxDir, logs, ...built, sessionManager, terminal: () => terminal, customEnds };
}

const writeOnCall = (call, fields) => (n, inboxDir) => {
	if (n === call) writeEntry(inboxDir, 1, fields);
};

test("(a) a steer written mid-turn lands after that turn's tool results and before the next model call, verbatim: a leading /name is not expanded", { skip }, async () => {
	const content = "/sometemplate do this instead\n\n(framed by the worker)";
	const s = await steerSession("mid-turn", {
		script: [lsCall("call-ls"), text("done")],
		onCall: writeOnCall(1, { messageId: id(1), content }),
		before: ({ f }) => {
			mkdirSync(join(f.workspace, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(f.workspace, ".pi", "prompts", "sometemplate.md"), `---\ndescription: a staged template\n---\n${TEMPLATE_BODY}\n`);
		},
	});
	try {
		assert.ok(s.loader.getPrompts().prompts.some((prompt) => prompt.name === "sometemplate"), "the control: a template of that name is loaded");
		await s.session.prompt("start");
		assert.equal(s.contexts.length, 2, "the steer adds no model call of its own: it rides the next one");
		assert.equal(userText(s.contexts[0].messages.at(-1)), "start", "the file landed while call 1 was in flight, after it was sent");
		const second = s.contexts[1].messages;
		assert.equal(second.at(-2).role, "toolResult", "after the tool results");
		assert.equal(second.at(-2).toolCallId, "call-ls");
		assert.equal(second.at(-1).role, "user");
		assert.equal(userText(second.at(-1)), content, "exactly the framed text, as user text");
		assert.equal(JSON.stringify(second).includes(TEMPLATE_BODY), false, "not expanded");
		assert.deepEqual(s.inbox.counts(), { delivered: 1, pending: 0, deliveredIds: [id(1)] });
		assert.deepEqual(s.logs, [{ event: "steer_delivered", id: id(1), mode: "steer", source: "cli" }]);
		// Persisted as our custom entry, with an ack that verifies under the key (g).
		const persisted = entries(s.f.sessionFile).filter((entry) => entry.type === "custom_message");
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0].customType, INBOX_CUSTOM_TYPE);
		assert.deepEqual(persisted[0].details, { id: id(1), mode: "steer", source: "cli", ack: expectedAck(KEY, RUN_ID, id(1)) });
		// The control, completed: the same words as a prompt DO expand, so the absence above is the inbox's doing.
		await s.session.prompt("/sometemplate do this instead");
		assert.equal(JSON.stringify(s.contexts.at(-1).messages).includes(TEMPLATE_BODY), true, "pi's prompt path expands the template");
	} finally {
		s.session.dispose();
	}
});

test("(b) a follow-up waits for a tool-free turn, then restarts the loop", { skip }, async () => {
	const s = await steerSession("follow-up", {
		script: [lsCall("call-ls"), text("first done"), text("second done")],
		onCall: writeOnCall(1, { messageId: id(1), mode: "followUp", content: "afterwards, also do this" }),
	});
	try {
		await s.session.prompt("start");
		assert.equal(s.contexts.length, 3, "one more model call, for the follow-up");
		assert.equal(s.contexts[1].messages.at(-1).role, "toolResult", "not delivered after a turn with tool calls");
		assert.equal(JSON.stringify(s.contexts[1].messages).includes("afterwards, also do this"), false);
		const third = s.contexts[2].messages;
		assert.equal(third.at(-2).role, "assistant", "after the turn that would have ended the run");
		assert.equal(userText(third.at(-2)), "first done");
		assert.equal(userText(third.at(-1)), "afterwards, also do this");
		assert.equal(userText(s.terminal()), "second done");
		assert.deepEqual(s.inbox.counts(), { delivered: 1, pending: 0, deliveredIds: [id(1)] });
		assert.deepEqual(s.logs, [{ event: "steer_delivered", id: id(1), mode: "followUp", source: "cli" }]);
	} finally {
		s.session.dispose();
	}
});

test("(b2) a follow-up sent first and a steer next, while tools keep running: the steer lands within a turn, the follow-up after the last tool-free turn (issue #670)", { skip }, async () => {
	const s = await steerSession("follow-up-then-steer", {
		script: [lsCall("call-1"), lsCall("call-2"), lsCall("call-3"), text("tools done"), text("follow-up answered")],
		onCall: (n, inboxDir) => {
			if (n === 1) writeEntry(inboxDir, 1, { messageId: id(1), mode: "followUp", content: "FOLLOW-UP: afterwards" });
			if (n === 2) writeEntry(inboxDir, 2, { messageId: id(2), content: "STEER: now" });
		},
	});
	try {
		await s.session.prompt("start");
		assert.equal(s.contexts.length, 5, "one more model call, for the follow-up; the steer rides call 3");
		const third = s.contexts[2].messages;
		assert.equal(third.at(-2).role, "toolResult", "the steer after call 2's tool results");
		assert.equal(third.at(-2).toolCallId, "call-2");
		assert.equal(userText(third.at(-1)), "STEER: now", "not held behind the follow-up");
		assert.equal(JSON.stringify(s.contexts[3].messages).includes("FOLLOW-UP"), false, "the follow-up waits while tools run");
		const fifth = s.contexts[4].messages;
		assert.equal(fifth.at(-2).role, "assistant");
		assert.equal(userText(fifth.at(-2)), "tools done", "after the turn that would have ended the run");
		assert.equal(userText(fifth.at(-1)), "FOLLOW-UP: afterwards");
		assert.equal(userText(s.terminal()), "follow-up answered");
		assert.deepEqual(s.customEnds.map((message) => message.details.id), [id(2), id(1)]);
		assert.deepEqual(s.inbox.counts(), { delivered: 2, pending: 0, deliveredIds: [id(2), id(1)] });
		assert.deepEqual(s.logs, [
			{ event: "steer_delivered", id: id(2), mode: "steer", source: "cli" },
			{ event: "steer_delivered", id: id(1), mode: "followUp", source: "cli" },
		]);
	} finally {
		s.session.dispose();
	}
});

test("(b3) a follow-up held across a run a terminating tool ended is the very next message, and a steer after it is not delayed (issue #670, review round 1)", { skip }, async () => {
	// A tool that ends the run on purpose (`terminate: true`), not the await tool: the run is not parked. The transcript
	// then ends on a tool result, so pi's continue() takes runContinuation, which polls only steering at its start.
	const stopper = {
		name: "test-stopper",
		factory: (api) =>
			api.registerTool({
				name: "stop_now",
				label: "stop now",
				description: "ends the run",
				parameters: { type: "object", properties: {} },
				async execute() {
					return { content: [{ type: "text", text: "stopped" }], details: {}, terminate: true };
				},
			}),
	};
	const s = await steerSession("follow-up-terminate", {
		extra: [stopper],
		script: [lsCall("call-1"), [{ type: "toolCall", id: "call-stop", name: "stop_now", arguments: {} }], lsCall("call-3"), lsCall("call-4"), text("done")],
		onCall: (n, inboxDir) => {
			if (n === 1) writeEntry(inboxDir, 1, { messageId: id(1), mode: "followUp", content: "FOLLOW-UP: afterwards" });
			if (n === 3) writeEntry(inboxDir, 2, { messageId: id(2), content: "STEER: now" });
		},
	});
	try {
		await s.session.prompt("start");
		assert.equal(s.contexts.length, 5, "no model call asked again with nothing new");
		const third = s.contexts[2].messages;
		assert.equal(third.at(-2).role, "toolResult");
		assert.equal(third.at(-2).toolCallId, "call-stop", "right after the run the tool ended");
		assert.equal(userText(third.at(-1)), "FOLLOW-UP: afterwards", "the follow-up is the very next message");
		const fourth = s.contexts[3].messages;
		assert.equal(fourth.at(-2).toolCallId, "call-3");
		assert.equal(userText(fourth.at(-1)), "STEER: now", "the steer goes at the next turn, not held behind the follow-up");
		assert.equal(userText(s.terminal()), "done");
		assert.deepEqual(s.customEnds.map((message) => [message.details.id, message.details.mode]), [[id(1), "followUp"], [id(2), "steer"]], "the record still says follow-up");
		assert.deepEqual(s.inbox.counts(), { delivered: 2, pending: 0, deliveredIds: [id(1), id(2)] });
		assert.deepEqual(s.logs, [
			{ event: "steer_delivered", id: id(1), mode: "followUp", source: "cli" },
			{ event: "steer_delivered", id: id(2), mode: "steer", source: "cli" },
		]);
	} finally {
		s.session.dispose();
	}
});

test("(c) a file that lands during the final turn is delivered from agent_before_settle, and the run goes on", { skip }, async () => {
	let written = false;
	// Written on agent_end: after the last turn_end read and after pi's own queue checks, so only the boundary sees it.
	const lateWriter = {
		name: "late-writer",
		factory: (api) =>
			api.on("agent_end", () => {
				if (written) return;
				written = true;
				writeEntry(s.inboxDir, 1, { messageId: id(1), content: "one more thing" });
			}),
	};
	// Declared before the factory that closes over it; assigned once the session exists.
	let s = null;
	s = await steerSession("before-settle", { script: [text("done"), text("done again")], extra: [lateWriter] });
	try {
		await s.session.prompt("start");
		assert.equal(written, true);
		assert.equal(s.contexts.length, 2, "the boundary's push kept the run going");
		assert.equal(userText(s.contexts[1].messages.at(-2)), "done");
		assert.equal(userText(s.contexts[1].messages.at(-1)), "one more thing");
		assert.equal(userText(s.terminal()), "done again");
		assert.deepEqual(s.inbox.counts(), { delivered: 1, pending: 0, deliveredIds: [id(1)] });
	} finally {
		s.session.dispose();
	}
});

test("(d) a file that lands after the inbox closed is never sent: no message, no entry, counted pending", { skip }, async () => {
	const s = await steerSession("after-close", { script: [text("done")] });
	try {
		await s.session.prompt("start");
		writeEntry(s.inboxDir, 1, { messageId: id(1), content: "too late" });
		s.inbox.poll();
		s.inbox.close();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(s.customEnds, [], "no message_end of ours");
		assert.equal(s.contexts.length, 1);
		assert.equal(entries(s.f.sessionFile).some((entry) => entry.type === "custom_message"), false, "nothing appended unanswered");
		assert.deepEqual(s.inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
	} finally {
		s.session.dispose();
	}
});

test("(F4) an aborted run: a poll from an earlier extension's agent_settled handler appends nothing the model never saw", { skip }, async () => {
	const seen = { beforeSettle: false, settledPoll: false };
	let s = null;
	// Loaded BEFORE the inbox, as a file extension is: its agent_settled handler runs while ours has not, after pi cleared
	// its run flag. The poll there stands in for the 1 s timer firing in that gap.
	const earlier = {
		name: "earlier-settled",
		factory: (api) => {
			api.on("agent_before_settle", () => {
				seen.beforeSettle = true;
			});
			api.on("agent_settled", () => {
				writeEntry(s.inboxDir, 1, { messageId: id(1), content: "after the abort" });
				s.inbox.poll();
				seen.settledPoll = true;
			});
		},
	};
	s = await steerSession("aborted", {
		first: [earlier],
		script: [lsCall("call-ls"), text("must not matter")],
		onCall: (n) => {
			if (n === 1) void s.session.abort();
		},
	});
	try {
		await s.session.prompt("start");
		await s.session.waitForIdle();
		assert.equal(seen.settledPoll, true);
		assert.equal(seen.beforeSettle, false, "the abort skipped the boundary");
		assert.deepEqual(s.customEnds, []);
		assert.equal(entries(s.f.sessionFile).some((entry) => entry.type === "custom_message"), false, "nothing appended unanswered");
		assert.deepEqual(s.inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
	} finally {
		s.session.dispose();
	}
});

test("(e) once await_human_input has run, a message is held and the run ends parked", { skip }, async () => {
	const s = await steerSession("parked", {
		parked: true,
		script: [[{ type: "toolCall", id: "call-park", name: "await_human_input", arguments: {} }], text("must not be asked")],
		onCall: writeOnCall(1, { messageId: id(1), content: "while you wait" }),
	});
	try {
		await s.session.prompt("start");
		assert.equal(s.contexts.length, 1, "the held message did not un-park the run");
		assert.equal(parkedTerminal(s.terminal()), true, "ended on the tool: awaiting-input");
		assert.deepEqual(s.customEnds, []);
		assert.deepEqual(s.inbox.counts(), { delivered: 0, pending: 1, deliveredIds: [] });
		assert.deepEqual(s.logs, [{ event: "steer_held_parked", pending: 1 }]);
	} finally {
		s.session.dispose();
	}
});

test("(f) a message the transcript already delivered is not delivered again; an entry whose ack does not verify does not count", { skip }, async () => {
	const s = await steerSession("seeded", {
		script: [text("done"), text("done again")],
		before: ({ inboxDir, sessionManager }) => {
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "the earlier run" }], timestamp: 1 });
			sessionManager.appendCustomMessageEntry(INBOX_CUSTOM_TYPE, text("delivered before"), true, { id: id(1), mode: "steer", source: "cli", ack: expectedAck(KEY, RUN_ID, id(1)) });
			// What an agent could write into its own transcript: the right shape, a MAC it cannot compute.
			sessionManager.appendCustomMessageEntry(INBOX_CUSTOM_TYPE, text("forged"), true, { id: id(2), mode: "steer", source: "cli", ack: "00".repeat(32) });
			writeEntry(inboxDir, 1, { messageId: id(1), content: "delivered before" });
			writeEntry(inboxDir, 2, { messageId: id(2), content: "never delivered" });
		},
	});
	try {
		await s.session.prompt("start");
		assert.deepEqual(s.customEnds.map((message) => message.details.id), [id(2)]);
		assert.deepEqual(s.logs, [{ event: "steer_delivered", id: id(2), mode: "steer", source: "cli" }]);
		assert.deepEqual(s.inbox.counts(), { delivered: 1, pending: 0, deliveredIds: [id(2)] });
	} finally {
		s.session.dispose();
	}
});

// ── The real run-job.mjs ──────────────────────────────────────────────────────────────────────────────────────

const RUN_JOB = fileURLToPath(new URL("../run-job.mjs", import.meta.url));
const REMAP = fileURLToPath(new URL("./fixtures/remap-roots.mjs", import.meta.url));

/**
 * An OpenAI-compatible endpoint: request 1 asks for `ls` and, before answering, writes a steer into the job's inbox
 * (as the worker's relay would mid-turn); every later request is answered with a short text.
 */
async function steerServer(root, messageId) {
	const { createServer } = await import("node:http");
	const bodies = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			bodies.push(JSON.parse(body));
			const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "r", object: "chat.completion.chunk", created: 0, model: "m1" };
			const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
			if (bodies.length === 1) {
				writeEntry(join(root, "inbox"), 1, { messageId, source: "console", content: "STEERED: look at the README first" });
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_ls", type: "function", function: { name: "ls", arguments: "{}" } }] }, finish_reason: null }] });
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
			} else {
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { bodies, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The job's tree under `root`, for the remap-roots preload, with `inbox/` when asked. */
function jobTree(root, { inbox = true, base = "http://127.0.0.1:1/v1" } = {}) {
	for (const dir of ["job/pi/skills", "workspace", "session", "outbox", "opt/pi-global", "opt/pi-dispatch", "home", "tmp", ...(inbox ? ["inbox"] : [])]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "job", "prompt.md"), "do the task\n");
	for (const name of ["HARD_RULES.md", "OUTBOX_PROTOCOL.md", "PORTFOLIO_PROTOCOL.md"]) writeFileSync(join(root, "opt", "pi-dispatch", name), `## ${name}\n`);
	writeFileSync(join(root, "workspace", "README.md"), "readme\n");
	writeFileSync(join(root, "session", "current.jsonl"), "");
	const model = { id: "m1", name: "m1", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } };
	writeFileSync(join(root, "opt", "pi-global", "models.json"), `${JSON.stringify({ providers: { "steer-fake": { baseUrl: base, apiKey: "steer-fake-key", api: "openai-completions", models: [model] } } })}\n`);
}

/** Run the real runner as a child; the key, when given, on stdin as the worker hands it over. */
async function runJob(root, { key = null, env = {} } = {}) {
	const childEnv = {
		PATH: process.env.PATH,
		HOME: join(root, "home"),
		TMPDIR: join(root, "tmp"),
		PI_DISPATCH_TEST_ROOT: root,
		PI_JOB_ID: RUN_ID,
		PI_PROVIDER: "steer-fake",
		PI_MODEL: "m1",
		PI_MAX_TURNS: "5",
		PI_SESSION_FILE: "/session/current.jsonl",
		PI_STEER: "1",
		...(key ? { PI_EXIT_AUTH: "stdin" } : {}),
		...env,
	};
	const child = spawn(process.execPath, [`--import=${REMAP}`, RUN_JOB], { env: childEnv, cwd: join(root, "workspace"), stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.end(key ? `${key}\n` : "");
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const code = await new Promise((resolve) => child.on("exit", resolve));
	const lines = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
	const exit = lines.find((line) => line.event === "exit");
	assert.ok(exit, `no exit line:\n${stdout}\n${stderr}`);
	return { code, exit, lines, stderr };
}

test("(h) the real run-job: PI_STEER with no /inbox exits 2 steer-inbox-missing, and with no exit key steer-no-exit-key, before any model call", { skip }, async () => {
	const missing = tempDir("pi-dispatch-inbox-missing-");
	jobTree(missing, { inbox: false });
	const noInbox = await runJob(missing, { key: KEY });
	assert.equal(noInbox.code, 2, noInbox.stderr);
	assert.deepEqual([noInbox.exit.code, noInbox.exit.reason], [2, "steer-inbox-missing"]);
	const unkeyed = tempDir("pi-dispatch-inbox-unkeyed-");
	jobTree(unkeyed);
	const noKey = await runJob(unkeyed);
	assert.equal(noKey.code, 2, noKey.stderr);
	assert.deepEqual([noKey.exit.code, noKey.exit.reason], [2, "steer-no-exit-key"]);
});

test("the real run-job, steered: a message written during request 1 is in request 2, acked under the exit key, and counted on the exit line", { skip }, async () => {
	const root = tempDir("pi-dispatch-inbox-runjob-");
	const messageId = id(0xbeef);
	const server = await steerServer(root, messageId);
	try {
		jobTree(root, { base: server.base });
		const { code, exit, lines, stderr } = await runJob(root, { key: KEY });
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		assert.equal(exit.code, 0);
		assert.deepEqual(exit.steer, { delivered: 1, pending: 0, deliveredIds: [messageId] }, "the counts ride the exit line");
		assert.match(exit.auth, /^[0-9a-f]{64}$/, "a signed line");
		assert.deepEqual(lines.find((line) => line.event === "steer_delivered"), { event: "steer_delivered", jobId: RUN_ID, id: messageId, mode: "steer", source: "console" });
		assert.equal(server.bodies.length, 2);
		assert.equal(JSON.stringify(server.bodies[0].messages).includes("STEERED"), false);
		const second = server.bodies[1].messages;
		assert.equal(second.at(-2).role, "tool", "after the ls result");
		assert.equal(second.at(-1).role, "user");
		const last = second.at(-1);
		assert.equal(typeof last.content === "string" ? last.content : last.content.map((part) => part.text).join(""), "STEERED: look at the README first");
		// The transcript the worker tails holds the ack, and it verifies under the key the worker minted.
		const persisted = entries(join(root, "session", "current.jsonl")).filter((entry) => entry.type === "custom_message");
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0].details.ack, expectedAck(KEY, RUN_ID, messageId));
	} finally {
		await server.close();
	}
});

test("run-job: the steer refusals run pre-spend, the inbox is seeded before and closed after the prompt, and both exit lines carry its counts", () => {
	const src = readFileSync(RUN_JOB, "utf8");
	const ready = src.indexOf("assertSteerReady({ steer: cfg.steer, exitKey: exitKey.key });");
	assert.ok(ready > 0 && ready < src.indexOf("readPrompt(PROMPT_PATH)") && ready < src.indexOf("createJobModelRuntime({"), "before the prompt is read and before any model lookup");
	assert.match(src, /const inbox = cfg\.steer \? createInbox\(\{ exitKey: exitKey\.key, runId: process\.env\.PI_JOB_ID, log, isParked: \(\) => awaitInput\?\.state\.called === true \}\) : null;/);
	const seed = src.indexOf("inbox?.seed(sessionManager);");
	assert.ok(seed > src.indexOf("await createAgentSession({") && seed < src.indexOf("inbox?.start();"), "seeded from the transcript before it starts reading");
	assert.match(src, /\} finally \{\n\t\t\/\/ [^\n]*\n\t\tinbox\?\.close\(\);\n\t\tbudget\.unsubscribe\(\);/, "closed first in the prompt's finally");
	assert.match(src, /const steerField = \(\{ closing = false \} = \{\}\) => \{\n\t\tif \(!inbox\) return \{\};\n\t\tif \(closing\) \{\n\t\t\ttry \{\n\t\t\t\tinbox\.close\(\);\n\t\t\t\} catch \{\n[^\n]*\n\t\t\t\}\n\t\t\}\n\t\treturn \{ steer: inbox\.counts\(\) \};\n\t\};/, "absent on every unarmed run, so their exit lines are unchanged");
	// Issue #670: the SIGTERM line closes the inbox before it counts, so a message withdrawn while held is not pending.
	assert.match(src, /liveExitFields = \(\) => \(\{ [^\n]*\.\.\.steerField\(\{ closing: true \}\) \}\);/, "the SIGTERM line closes the inbox, then carries the counts");
	assert.match(src, /\.\.\.recoveryField\(\), \.\.\.steerField\(\) \}\);\n\treturn outcome\.code;/, "the decided line carries the counts");
});
