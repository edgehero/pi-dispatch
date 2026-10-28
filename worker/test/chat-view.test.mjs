import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { chatTheme, editorAvailability, ENTRY_MAX_BYTES, entryView, guardTerminal, lastAssistantText, LATEX_MAX_BRACE_DEPTH, LATEX_MAX_COMMANDS, liveJobIdOf, loadPiTui, makeChatScreen, MARKDOWN_MAX_DEPTH, markdownPlan, parseChatInput, questionOf, runLiveView, runReplyView, scrubForTerminal, statusText, TOOL_PREVIEW_LINES } from "../src/chat-view.mjs";

// Issue #647: the terminal chat's screens, drawn headless by the pinned pi-tui on a fake terminal. The plain theme
// writes no escape of its own, so any ESC in a drawn line came from an entry: the hostile-text tests require none.

const pi = await loadPiTui();

/** A pi-tui Terminal that draws nowhere: `type(data)` is a key press, `out` collects what the renderer wrote. */
class FakeTerminal {
	constructor(columns = 80, rows = 24) {
		this.c = columns;
		this.r = rows;
		this.out = "";
		this.onInput = null;
	}
	start(onInput) {
		this.onInput = onInput;
	}
	stop() {}
	async drainInput() {}
	write(data) {
		this.out += data;
	}
	get columns() {
		return this.c;
	}
	get rows() {
		return this.r;
	}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
	type(data) {
		this.onInput?.(data);
	}
}

const plain = chatTheme({ plain: true });

/** A process for the screen's terminal guard: records handlers and exit codes, and never exits. */
function fakeProc() {
	const proc = new EventEmitter();
	proc.exits = [];
	proc.exit = (code) => proc.exits.push(code);
	return proc;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const ESC = "\u001b";
const OSC8_OPEN = /\u001b\]8;[^;\u0007]*;[^\u0007\u001b]+/;
// pi-tui ends every terminal row with an SGR reset and an empty OSC 8 (a CLOSE, naming no target): the renderer's own.
const LINE_RESET = /\u001b\[0m\u001b\]8;;\u0007$/;

/** Every hostile shape an entry can carry: CSI, OSC 8 with a target, OSC 52, a C1 CSI, bidi, CR overwrite, NUL, DEL. */
const HOSTILE = `ok ${ESC}[31mred${ESC}[0m ${ESC}]8;;http://evil.test/${"\u0007"}click${ESC}]8;;${"\u0007"} ${ESC}]52;c;cGF5bG9hZA==${"\u0007"} \u009b2J ‮exe.txt‬ ⁦iso⁩ fake\rOVERWRITE \u0000nul\u007fdel &#x1b;[31m`;

/**
 * The rows the terminal shows at `width`, drawn now by pi-tui itself (the screen must be started), each with the
 * renderer's own line reset taken off: what is left is exactly what the screen drew.
 */
function drawn(screen, width) {
	screen.tui.terminal.c = width;
	screen.tui.renderNow();
	return screen.tui.getScreenLines().map((row) => row.replace(LINE_RESET, ""));
}

test("scrubForTerminal removes C0 but newline, DEL, C1, ESC and bidi; tabs become spaces; CR cannot overwrite", () => {
	const s = scrubForTerminal(HOSTILE);
	assert.ok(!s.includes(ESC));
	assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(s), "nothing but newline survives below 0x20, and no C1 or bidi control");
	assert.match(s, /fake\nOVERWRITE/);
	assert.equal(scrubForTerminal("a\tb\r\nc"), "a    b\nc");
	assert.equal(scrubForTerminal(null), "");
});

test("scrubForTerminal clips at 64 KiB on a character boundary and says how much was cut", () => {
	const text = "é".repeat(ENTRY_MAX_BYTES);
	const out = scrubForTerminal(text);
	const [kept, note] = out.split("\n");
	assert.ok(Buffer.byteLength(kept, "utf8") <= ENTRY_MAX_BYTES);
	assert.ok(!kept.includes("�"), "no half character");
	assert.match(note, /^\[cut: \d+ more bytes\]$/);
	assert.equal(Buffer.byteLength(kept, "utf8") + Number(/\d+/.exec(note)[0]), Buffer.byteLength(text, "utf8"));
});

test("parseChatInput: a steer, /later, /withdraw <id>, // for a leading slash, and a typo refused", () => {
	assert.deepEqual(parseChatInput("  "), { kind: "empty" });
	assert.deepEqual(parseChatInput("use the staging bucket"), { kind: "steer", text: "use the staging bucket" });
	assert.deepEqual(parseChatInput("/later then write the docs"), { kind: "followUp", text: "then write the docs" });
	assert.deepEqual(parseChatInput(`/withdraw ${"ab".repeat(16)}`), { kind: "withdraw", id: "ab".repeat(16) });
	assert.deepEqual(parseChatInput("//etc/hosts is wrong"), { kind: "steer", text: "/etc/hosts is wrong" });
	assert.match(parseChatInput("/later").refusal, /needs the message/);
	assert.match(parseChatInput("/withdraw 123").refusal, /32 lowercase hex/);
	assert.match(parseChatInput("/latr fix it").refusal, /not a chat command/);
});

test("the editor is hidden with a reason for a viewer, a read-only console, an unarmed run and a closed inbox", () => {
	const op = { role: "operator", readOnly: false };
	const armed = { steer: { armed: true, open: true } };
	assert.deepEqual(editorAvailability({ mode: "live", who: op, info: armed }), { shown: true });
	const cases = [
		[{ mode: "live", who: { role: "viewer" }, info: armed }, /viewer token: you see the run's status only/],
		[{ mode: "reply", who: { role: "viewer" }, info: {} }, /only an operator can answer/],
		[{ mode: "live", who: { ...op, readOnly: true }, info: armed }, /read-only \(PI_CONSOLE_READ_ONLY=1\)/],
		[{ mode: "live", who: op, info: { steer: { armed: false, open: false } } }, /does not take messages/],
		[{ mode: "live", who: op, info: { steer: { armed: true, open: false } } }, /inbox is closed/],
		[{ mode: "live", who: op, info: { steer: { armed: true, open: null } } }, /could not be read right now/],
		[{ mode: "live", who: op, info: { steer: { armed: null, open: null } } }, /takes messages could not be read right now/],
		[{ mode: "live", who: op, info: { steer: { armed: true } } }, /inbox is closed/],
		[{ mode: "live", who: op, info: { steer: { armed: true, open: "true" } } }, /inbox is closed/],
		[{ mode: "live", who: {}, info: armed }, /viewer token/],
		[{ mode: "live", who: { role: "admin" }, info: armed }, /viewer token/],
		[{ mode: "reply", who: null, info: {} }, /only an operator can answer/],
	];
	for (const [input, reason] of cases) {
		const got = editorAvailability(input);
		assert.equal(got.shown, false);
		assert.match(got.reason, reason);
	}
	assert.deepEqual(editorAvailability({ mode: "reply", who: op, info: {} }), { shown: true });
});

test("statusText and entryView read only checked fields; a hostile tool name or kind is not drawn as given", () => {
	assert.equal(statusText({ run: { jobId: "j1", target: "o/r#7" }, activeJobId: "j1.r1", state: "active", progress: { turns: 3, steps: 5, failed: -1 }, steer: { armed: true, open: true } }), "run j1.r1  |  o/r#7  |  active  |  turns 3, steps 5  |  inbox open");
	assert.ok(!statusText({ run: { jobId: "j1" }, progress: { turn: 3 } }).includes("turn"), "the console's field is turns; a turn field is not read");
	assert.ok(!statusText({ run: { target: `x${ESC}]0;title${"\u0007"}` } }).includes(ESC));
	const v = entryView({ id: "1-1", kind: "tool-call", tool: `bash${ESC}[2J`, text: "ls", ts: 0, error: true });
	assert.equal(v.tool, true);
	assert.equal(v.header, "tool call  error  00:00:00 UTC");
	assert.equal(entryView({ kind: "<script>", text: "x" }).kind, "note");
	assert.equal(entryView("nope"), null);
	assert.equal(entryView({ kind: "end", outcome: "completed" }).body, "The run is over (completed).");
	assert.equal(lastAssistantText([{ kind: "assistant", text: "first?" }, { kind: "tool-call", text: "x" }, { kind: "assistant", text: "Which branch?" }, { kind: "user", text: "a" }]), "Which branch?");
	assert.equal(liveJobIdOf({ activeJobId: "", run: { jobId: "j1" } }), "j1");
	assert.equal(liveJobIdOf({ activeJobId: null, run: { id: "j5", jobId: null } }), "j5", "a running job without a record is the id asked about");
});

test("hostile entries draw no ESC, no OSC 8 link, no C1 or bidi control, at any width; link targets show in text", async () => {
	const t = new FakeTerminal(80, 400);
	const screen = makeChatScreen({ proc: fakeProc(), pi, terminal: t, theme: plain });
	screen.setStatus(`run j1 ${ESC}]0;pwned${"\u0007"}`);
	screen.setEditor({ shown: true });
	screen.addEntry({ id: "1-1", kind: "assistant", text: `${HOSTILE}\n\nsee [the docs](http://evil.test/x) and <b>&#x1b;</b>` });
	screen.addEntry({ id: "1-2", kind: "user", text: HOSTILE });
	screen.addEntry({ id: "1-3", kind: "tool-result", tool: "bash", text: HOSTILE });
	screen.start();
	for (const width of [13, 40, 80, 200]) {
		const lines = drawn(screen, width);
		const all = lines.join("\n");
		assert.ok(!all.includes(ESC), `no ESC at width ${width}`);
		assert.ok(!/[\u0080-\u009f‪-‮⁦-⁩]/.test(all), `no C1 or bidi at width ${width}`);
		for (const line of lines) assert.ok(pi.visibleWidth(line) <= width, `a line fits width ${width}: ${JSON.stringify(line)}`);
	}
	const wide = drawn(screen, 200).join("\n");
	assert.match(wide, /the docs \(http:\/\/evil\.test\/x\)/, "a markdown link prints its target");
	assert.match(wide, /&#x1b;/, "an HTML entity is not decoded into a control");
	// What reaches the terminal: every row's escapes are the renderer's own, and no row opens a hyperlink.
	for (const row of screen.tui.getScreenLines()) {
		assert.ok(!OSC8_OPEN.test(row), `no OSC 8 target in ${JSON.stringify(row)}`);
		assert.ok(!row.replace(LINE_RESET, "").includes(ESC), `no stray ESC in ${JSON.stringify(row)}`);
	}
	assert.ok(!OSC8_OPEN.test(t.out));
	screen.stop();
});

test("keys: e folds tool output when the editor is hidden or unfocused, Esc moves focus, Enter submits, Ctrl+C detaches", async () => {
	const t = new FakeTerminal(60, 60);
	const submitted = [];
	let detached = 0;
	const screen = makeChatScreen({ proc: fakeProc(), pi, terminal: t, theme: plain, onSubmit: (x) => submitted.push(x), onDetach: () => (detached += 1) });
	screen.addEntry({ id: "1-1", kind: "tool-result", tool: "bash", text: Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n") });
	screen.setEditor({ shown: false, reason: "You are signed in with a viewer token." });
	screen.start();
	const text = () => drawn(screen, 60).join("\n");
	assert.match(text(), new RegExp(`\\[${20 - TOOL_PREVIEW_LINES} more lines: press e to expand\\]`));
	assert.ok(!text().includes("row 19"));
	assert.match(text(), /viewer token/, "the hidden editor's reason is drawn in its place");
	t.type("e");
	assert.equal(screen.expanded, true);
	assert.match(text(), /row 19/);
	screen.setEditor({ shown: true });
	t.type("e");
	assert.equal(screen.expanded, true, "with the editor focused, e is typed, not a key");
	assert.equal(screen.editor.getText(), "e");
	t.type("\u001b");
	await tick();
	t.type("e");
	assert.equal(screen.expanded, false, "after Esc the transcript has focus, and e folds again");
	t.type("\u001b");
	await tick();
	screen.editor.setText("");
	for (const ch of "go") t.type(ch);
	t.type("\r");
	assert.deepEqual(submitted, ["go"]);
	t.type("\u0003");
	assert.equal(detached, 1);
	screen.stop();
});

test("confirm reads only y, n, Esc and Ctrl+C while it waits", async () => {
	const t = new FakeTerminal(60, 20);
	const screen = makeChatScreen({ proc: fakeProc(), pi, terminal: t, theme: plain });
	screen.setEditor({ shown: true });
	screen.start();
	const asked = screen.confirm(["Send a steer to running job j1"]);
	assert.match(drawn(screen, 60).join("\n"), /Send it\? y\/n/);
	t.type("x");
	t.type("y");
	assert.equal(await asked, true);
	assert.equal(screen.editor.getText(), "", "the x was not typed into the editor");
	const again = screen.confirm(["again"]);
	t.type("n");
	assert.equal(await again, false);
	screen.stop();
});

/** A fake console client for the views: scripted `/api/run` answers, a scripted stream, and recorded actions. */
function fakeClient({ runs = [], stream = async () => ({ done: "completed" }), act = async () => ({ ok: true, result: {} }) } = {}) {
	const calls = { run: 0, stream: [], act: [] };
	return {
		calls,
		async run() {
			const next = runs[Math.min(calls.run, runs.length - 1)];
			calls.run += 1;
			return { status: 200, json: next };
		},
		async stream(path, opts) {
			calls.stream.push(path);
			return stream(path, opts);
		},
		async act(name, body, opts) {
			calls.act.push({ name, body });
			return act(name, body, opts);
		},
	};
}

const LIVE = { run: { jobId: "j1", target: "o/r#7" }, state: "active", mode: "live", activeJobId: null, steer: { armed: true, open: true }, transcript: { exists: true, ended: false }, progress: { turn: 1 } };

test("viewer layout: no transcript stream is opened, the status line shows, and the poll ends the view when the run is not live", async () => {
	let poll = null;
	const client = fakeClient({ runs: [{ ...LIVE, state: "completed", mode: "fork" }] });
	let screen;
	const t = new FakeTerminal(70, 20);
	const view = runLiveView({ proc: fakeProc(), client, lookup: { id: "j1" }, info: LIVE, who: { role: "viewer" }, pi, terminal: t, theme: plain, timers: { setInterval: (fn) => ((poll = fn), 1), clearInterval: () => {} }, onScreen: (s) => (screen = s) });
	const lines = drawn(screen, 70).join("\n");
	assert.match(lines, /run j1  \|  o\/r#7  \|  active/);
	assert.match(lines, /viewer token: you see the run's status only/);
	assert.equal(screen.editorShown, false);
	assert.deepEqual(client.calls.stream, [], "a viewer never asks for a transcript");
	await poll();
	const got = await view;
	assert.equal(got.ended, true);
	assert.equal(got.info.mode, "fork");
});

test("operator live view: entries stream in, Enter steers through preview and y, /withdraw withdraws, done ends with a fresh lookup", async () => {
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	const client = fakeClient({
		runs: [{ ...LIVE, state: "completed", mode: "reply" }],
		stream: async (path, { onEvent }) => {
			onEvent({ event: "entry", data: JSON.stringify({ id: "1-1", kind: "assistant", text: `Working on it ${ESC}[2J` }) });
			onEvent({ event: "entry", data: "not json" });
			onEvent({ event: "oversize", data: null });
			await held;
			return { done: "awaiting-input" };
		},
		act: async (name, body, { print, confirm }) => {
			print(`Send a ${body.mode ?? "withdraw"} to running job ${body.jobId}`);
			if (!(await confirm())) return { declined: true };
			return name === "steer" ? { ok: true, result: { id: "cd".repeat(16), state: "queued" } } : { ok: true, result: { id: body.id, guaranteed: true } };
		},
	});
	let screen;
	const t = new FakeTerminal(160, 24);
	const view = runLiveView({ proc: fakeProc(), client, lookup: { id: "j1" }, info: LIVE, who: { role: "operator", readOnly: false }, pi, terminal: t, theme: plain, timers: { setInterval: () => 1, clearInterval: () => {} }, onScreen: (s) => (screen = s) });
	await tick();
	assert.deepEqual(client.calls.stream, ["/api/transcript?id=j1&format=json"]);
	let text = drawn(screen, 160).join("\n");
	assert.match(text, /Working on it/);
	assert.match(text, /larger than 256 KiB was left out/);
	assert.ok(!text.includes(ESC));
	for (const ch of "use main") t.type(ch);
	t.type("\r");
	await tick();
	assert.match(drawn(screen, 160).join("\n"), /Send it\? y\/n/);
	t.type("y");
	await tick();
	assert.deepEqual(client.calls.act[0], { name: "steer", body: { jobId: "j1", text: "use main", mode: "steer" } });
	text = drawn(screen, 160).join("\n");
	assert.match(text, /sent message c{1}d/);
	screen.editor.setText(`/withdraw ${"cd".repeat(16)}`);
	t.type("\r");
	await tick();
	t.type("y");
	await tick();
	assert.deepEqual(client.calls.act[1], { name: "steer-withdraw", body: { jobId: "j1", id: "cd".repeat(16) } });
	assert.match(drawn(screen, 160).join("\n"), /withdrew message .* the run never sees it/);
	screen.editor.setText("/later");
	t.type("\r");
	await tick();
	assert.equal(client.calls.act.length, 2, "a refused input is not sent");
	assert.match(drawn(screen, 160).join("\n"), /needs the message/);
	release();
	const got = await view;
	assert.equal(got.ended, true);
	assert.equal(got.info.mode, "reply");
	assert.equal(got.outcome, "awaiting-input");
});

test("Ctrl+C detaches the live view and aborts its stream", async () => {
	let aborted = false;
	const client = fakeClient({
		stream: (path, { signal }) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve({ detached: true });
				});
			}),
	});
	const t = new FakeTerminal(60, 20);
	const view = runLiveView({ proc: fakeProc(), client, lookup: { id: "j1" }, info: LIVE, who: { role: "operator" }, pi, terminal: t, theme: plain, timers: { setInterval: () => 1, clearInterval: () => {} } });
	await tick();
	t.type("\u0003");
	assert.deepEqual(await view, { detached: true });
	assert.equal(aborted, true);
});

test("the reply view shows the question and sends parked-answer; a refusal is printed verbatim and the editor stays", async () => {
	let first = true;
	const client = fakeClient({
		act: async (name, body, { confirm }) => {
			if (!(await confirm())) return { declined: true };
			if (first) {
				first = false;
				return { refusal: "this parked run's job data has expired (kept 7 days); answer on the issue instead", status: 409 };
			}
			return { ok: true, result: { jobIds: ["j2"] } };
		},
	});
	let screen;
	const t = new FakeTerminal(160, 24);
	const info = { run: { jobId: "j1", target: "o/r#7" }, state: "awaiting-input", mode: "reply" };
	const view = runReplyView({ proc: fakeProc(), client, info, who: { role: "operator" }, question: { question: "Which **branch** should I use?" }, pi, terminal: t, theme: plain, onScreen: (s) => (screen = s) });
	assert.match(drawn(screen, 160).join("\n"), /Which branch should I use\?/);
	assert.equal(screen.editorShown, true);
	screen.editor.setText("main, please");
	t.type("\r");
	await tick();
	t.type("y");
	await tick();
	assert.match(drawn(screen, 160).join("\n"), /job data has expired \(kept 7 days\); answer on the issue instead/);
	assert.equal(screen.editor.getText(), "main, please", "the answer is kept for another try");
	t.type("\r");
	await tick();
	t.type("y");
	const got = await view;
	assert.deepEqual(got, { answered: true, result: { jobIds: ["j2"] } });
	assert.deepEqual(client.calls.act.map((c) => c.body), [{ jobId: "j1", text: "main, please" }, { jobId: "j1", text: "main, please" }]);
});

test("an approval reply names its gate, explains typed decisions and sends the command through the existing confirmation", async () => {
	for (const action of ["budget-raise", "deploy:staging"]) {
		const client = fakeClient({ act: async (_name, _body, { confirm }) => (await confirm()) ? { ok: true, result: { jobIds: ["j2"] } } : { declined: true } });
		let screen;
		const terminal = new FakeTerminal(160, 24);
		const info = { run: { jobId: "j1", reason: "awaiting-approval", approval: { requestId: "a".repeat(64), action } }, state: "awaiting-approval", mode: "reply" };
		const view = runReplyView({ proc: fakeProc(), client, info, who: { role: "operator" }, question: { pointer: "Read the request on its issue." }, pi, terminal, theme: plain, onScreen: (s) => (screen = s) });
		const text = drawn(screen, 160).join("\n");
		assert.ok(text.includes(action));
		assert.match(text, /\/approve, \/decline \[reason\], or a question \(no approval\)/);
		assert.match(text, action === "budget-raise" ? /Worker-enforced/ : /Advisory/);
		screen.editor.setText("/approve");
		terminal.type("\r");
		await tick();
		terminal.type("y");
		assert.equal((await view).answered, true);
		assert.deepEqual(client.calls.act.map((c) => [c.name, c.body]), [["parked-answer", { jobId: "j1", text: "/approve" }]]);
	}
});

test("questionOf: a viewer or a missing transcript points at the forge; an operator gets the last assistant entry", async () => {
	const info = { run: { jobId: "j1" }, forgeLink: "https://github.com/o/r/issues/7", transcript: { exists: true } };
	assert.deepEqual(await questionOf({ client: fakeClient(), info, who: { role: "viewer" } }), { pointer: "The question is on https://github.com/o/r/issues/7" });
	assert.match((await questionOf({ client: fakeClient(), info: { ...info, transcript: { exists: false }, forgeLink: null }, who: { role: "operator" } })).pointer, /last comment/);
	const client = fakeClient({
		stream: async (path, { onEvent }) => {
			onEvent({ event: "entry", data: JSON.stringify({ kind: "assistant", text: "draft" }) });
			onEvent({ event: "entry", data: JSON.stringify({ kind: "assistant", text: `Which branch? ${ESC}[31m` }) });
			onEvent({ event: "entry", data: JSON.stringify({ kind: "end", outcome: "awaiting-input" }) });
			return { done: "awaiting-input" };
		},
	});
	assert.deepEqual(await questionOf({ client, info, who: { role: "operator" } }), { question: "Which branch? [31m" });
	const failing = fakeClient({ stream: async () => Promise.reject(new Error("down")) });
	assert.match((await questionOf({ client: failing, info, who: { role: "operator" } })).pointer, /issues\/7/);
});

test("scrubForTerminal also drops invisible and mismeasured characters, and keeps newlines", () => {
	const sneaky = "a\u200bb\u200cc\u200dd\u2060e\ufefff\u00adg\u{e0041}\u{e007f}h\u1100i\u115fj\u3164k\uffa0l\nm";
	assert.equal(scrubForTerminal(sneaky), "abcdefgh" + "ijkl\nm");
	assert.equal(scrubForTerminal("한국어 ok"), "한국어 ok", "precomposed Hangul syllables are kept");
});

test("markdownPlan: deep quote or list markers and too many delimiters go plain; deep braces turn LaTeX off", () => {
	assert.deepEqual(markdownPlan("> a\n> > b\n- x\n  - y"), { markdown: true, latex: true });
	assert.deepEqual(markdownPlan(`${">".repeat(MARKDOWN_MAX_DEPTH)} ok`), { markdown: true, latex: true });
	assert.equal(markdownPlan(`${">".repeat(MARKDOWN_MAX_DEPTH + 1)} x`).markdown, false);
	assert.equal(markdownPlan(`${"> ".repeat(MARKDOWN_MAX_DEPTH + 1)}x`).markdown, false);
	assert.equal(markdownPlan(`${"> - ".repeat(5)}x`).markdown, false, "quote and list markers count together");
	assert.equal(markdownPlan(`${"1. ".repeat(9)}x`).markdown, false);
	assert.equal(markdownPlan("*a ".repeat(2001)).markdown, false);
	assert.deepEqual(markdownPlan(`$${"{".repeat(LATEX_MAX_BRACE_DEPTH)}x${"}".repeat(LATEX_MAX_BRACE_DEPTH)}$`), { markdown: true, latex: true });
	assert.deepEqual(markdownPlan(`$${"x^{".repeat(LATEX_MAX_BRACE_DEPTH + 1)}$`), { markdown: true, latex: false });
	assert.deepEqual(markdownPlan(`$${"\\sqrt".repeat(LATEX_MAX_COMMANDS)} x$`), { markdown: true, latex: true });
	assert.deepEqual(markdownPlan(`$${"\\sqrt".repeat(LATEX_MAX_COMMANDS + 1)} x$`), { markdown: true, latex: false }, "nested commands count, braces or not");
});

test("brace-free nested LaTeX commands never reach the render fallback: \\frac, \\sqrt, inline, display and \\[ \\]", () => {
	const payloads = {
		frac2000: `$${"\\frac a".repeat(2000)}b$`,
		sqrt1640: `$${"\\sqrt".repeat(1640)} x$`,
		sqrt8000: `$${"\\sqrt".repeat(8000)} x$`,
		displaySqrt: `$$${"\\sqrt".repeat(8000)} x$$`,
		bracketSqrt: `\\[${"\\sqrt".repeat(8000)} x\\]`,
		bracketFrac: `\\[${"\\frac a".repeat(8000)}b\\]`,
	};
	const render = (text, renderLatex) => new pi.Markdown(text, 1, 0, plain.markdown, undefined, { renderLatex }).render(100);
	// Positive control: with LaTeX on, the 8000-deep payloads do overflow pi-tui's renderer, so they are the real thing.
	for (const name of ["sqrt8000", "displaySqrt", "bracketSqrt", "bracketFrac"]) assert.throws(() => render(payloads[name], true), RangeError, `${name} overflows with LaTeX on`);
	for (const [name, text] of Object.entries(payloads)) {
		const plan = markdownPlan(text);
		const started = performance.now();
		let lines;
		assert.doesNotThrow(() => {
			lines = render(text, plan.latex);
		}, `${name} renders under its plan without throwing`);
		const ms = performance.now() - started;
		assert.ok(ms < 2000, `${name} drew in ${Math.round(ms)} ms`);
		assert.ok(lines.length > 0);
	}
});

test("pathological markdown draws fast and never throws: deep quotes, deep LaTeX, quadratic emphasis", () => {
	const t = new FakeTerminal(100, 60);
	const screen = makeChatScreen({ proc: fakeProc(), pi, terminal: t, theme: plain });
	screen.start();
	const payloads = {
		quotes44: `${">".repeat(44)} deep`,
		quotes20k: `${">".repeat(20_000)} x`,
		spacedQuotes: "> ".repeat(4096),
		mixed: `${"> - ".repeat(40)}x`,
		latexSup: `$$${"x^{".repeat(8000)}$$`,
		latexBraces: `$${"{".repeat(8000)}$`,
		emphasis64k: "*a ".repeat(21_000),
		underscore64k: "_a ".repeat(21_000),
		links: "[a](".repeat(16_000),
	};
	for (const [name, text] of Object.entries(payloads)) {
		const started = performance.now();
		screen.addEntry({ id: name, kind: "assistant", text });
		const lines = drawn(screen, 100);
		const ms = performance.now() - started;
		assert.ok(ms < 2000, `${name} drew in ${Math.round(ms)} ms`);
		assert.ok(lines.length > 0);
	}
	screen.addEntry({ id: "after", kind: "user", text: "after the storm" });
	assert.match(drawn(screen, 100).join("\n"), /after the storm/, "the screen still draws");
	screen.stop();
});

test("an entry whose markdown render throws is drawn as plain text, alone, and says so", () => {
	class ThrowingMarkdown {
		render() {
			throw new RangeError("Maximum call stack size exceeded");
		}
		invalidate() {}
	}
	const t = new FakeTerminal(80, 30);
	const screen = makeChatScreen({ proc: fakeProc(), pi: { ...pi, Markdown: ThrowingMarkdown }, terminal: t, theme: plain });
	screen.start();
	screen.addEntry({ id: "1", kind: "assistant", text: "**bold** words" });
	screen.addEntry({ id: "2", kind: "user", text: "next" });
	const text = drawn(screen, 80).join("\n");
	assert.match(text, /plain text \(markdown could not draw it\)/);
	assert.match(text, /\*\*bold\*\* words/);
	assert.match(text, /next/);
	screen.stop();
});

test("the terminal is given back on an uncaught exception, an unhandled rejection, SIGINT, SIGTERM and SIGHUP", () => {
	for (const [event, arg, code] of [["uncaughtException", new Error(`boom\n\u001b[2J`), 1], ["unhandledRejection", new Error("nope"), 1], ["SIGINT", undefined, 130], ["SIGTERM", undefined, 143], ["SIGHUP", undefined, 129]]) {
		const proc = fakeProc();
		let raw = null;
		proc.stdin = { isTTY: true, setRawMode: (on) => (raw = on) };
		const errs = [];
		const t = new FakeTerminal(40, 10);
		const screen = makeChatScreen({ proc, err: (l) => errs.push(l), pi, terminal: t, theme: plain });
		screen.start();
		assert.equal(proc.listenerCount(event), 1, `${event} is hooked while the screen runs`);
		t.out = "";
		proc.emit(event, arg);
		assert.ok(t.out.includes("\u001b[?1049l"), `${event}: the alternate screen is left`);
		assert.ok(t.out.includes("\u001b[?25h"), `${event}: the cursor is shown`);
		assert.equal(raw, false, `${event}: raw mode is ended`);
		assert.deepEqual(proc.exits, [code]);
		if (code === 1) {
			assert.equal(errs.length, 1);
			assert.match(errs[0], /^error: the chat screen failed \(.+\); the terminal was restored$/);
			assert.ok(!errs[0].includes("\u001b") && !errs[0].includes("\n"));
		}
		screen.stop();
		assert.equal(proc.listenerCount(event), 0, `${event} is unhooked once the screen stops`);
	}
	// The guard alone: its remover takes every handler off.
	const proc = fakeProc();
	const off = guardTerminal({ restore: () => {}, proc, err: () => {} });
	assert.equal(proc.listenerCount("SIGHUP"), 1);
	off();
	assert.deepEqual(["uncaughtException", "unhandledRejection", "SIGINT", "SIGTERM", "SIGHUP"].map((e) => proc.listenerCount(e)), [0, 0, 0, 0, 0]);
});

test("hyperlinks: the screen turns them off in pi-tui, so a link that would be OSC 8 prints its target instead", () => {
	const link = "see [the docs](http://evil.test/x)";
	// The positive control: with hyperlinks on, pi-tui's Markdown really does write an OSC 8 opener for this link.
	pi.setCapabilityOverrides({ hyperlinks: true });
	assert.ok(OSC8_OPEN.test(new pi.Markdown(link, 0, 0, plain.markdown).render(80).join("")), "the test can see an OSC 8 link");
	const calls = [];
	const recording = { ...pi, setCapabilityOverrides: (o) => (calls.push(o), pi.setCapabilityOverrides(o)) };
	const t = new FakeTerminal(120, 20);
	const screen = makeChatScreen({ proc: fakeProc(), pi: recording, terminal: t, theme: plain });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].hyperlinks, false);
	assert.equal(pi.getCapabilities().hyperlinks, false);
	screen.start();
	screen.addEntry({ id: "1", kind: "assistant", text: link });
	const text = drawn(screen, 120).join("\n");
	assert.match(text, /the docs \(http:\/\/evil\.test\/x\)/);
	assert.ok(!OSC8_OPEN.test(t.out), "no OSC 8 opener reached the terminal");
	screen.stop();
});

test("Ctrl+C while a y/n waits answers no AND detaches", async () => {
	const t = new FakeTerminal(60, 20);
	let detached = 0;
	const screen = makeChatScreen({ proc: fakeProc(), pi, terminal: t, theme: plain, onDetach: () => (detached += 1) });
	screen.setEditor({ shown: true });
	screen.start();
	const asked = screen.confirm(["Send a steer"]);
	t.type("\u0003");
	assert.equal(await asked, false);
	assert.equal(detached, 1);
	screen.stop();
});

test("the poll leaves an open stream to reach done, and a steer goes to the job the latest poll names", async () => {
	let poll = null;
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	const recovered = { ...LIVE, activeJobId: "j1.r1" };
	const client = fakeClient({
		runs: [recovered, { ...LIVE, state: "completed", mode: "fork" }, { ...LIVE, state: "completed", mode: "fork" }],
		stream: async () => {
			await held;
			return { done: "completed" };
		},
		act: async (name, body, { confirm }) => ((await confirm()) ? { ok: true, result: { id: "ef".repeat(16), state: "queued" } } : { declined: true }),
	});
	let screen;
	const t = new FakeTerminal(120, 24);
	let settled = false;
	const view = runLiveView({ proc: fakeProc(), client, lookup: { id: "j1" }, info: LIVE, who: { role: "operator", readOnly: false }, pi, terminal: t, theme: plain, timers: { setInterval: (fn) => ((poll = fn), 1), clearInterval: () => {} }, onScreen: (s) => (screen = s) });
	view.then(() => (settled = true));
	await tick();
	await poll();
	screen.editor.setText("go on");
	t.type("\r");
	await tick();
	t.type("y");
	await tick();
	assert.deepEqual(client.calls.act[0].body, { jobId: "j1.r1", text: "go on", mode: "steer" }, "the recovery job the poll named, not the first id");
	await poll();
	await tick();
	assert.equal(settled, false, "a poll saying the run is no longer live does not cut a stream that is still open");
	release();
	const got = await view;
	assert.equal(got.ended, true);
	assert.equal(got.outcome, "completed");
});
