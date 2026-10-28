/**
 * The terminal chat's screens (issue #647, REQ-TERMINAL-CHAT): the LIVE view of a running job (its transcript as it is
 * written, a status line, and an editor that steers it) and the REPLY view of a parked one (its question and an editor
 * that answers it). Drawn with pi-tui, the renderer pi itself uses, so the operator sees a run the way pi shows a chat.
 *
 * EVERY ENTRY IS HOSTILE TEXT. The transcript is agent-written, and the agent read issues, files and web pages anyone
 * could have authored. The console redacts the job's secrets and the worker escapes control characters before an entry
 * is published, but a terminal is a far richer target than an HTML page (an escape sequence can retitle the window,
 * rewrite the clipboard over OSC 52, draw a fake prompt, or turn a link's visible text into another target over OSC 8),
 * so this module trusts neither and scrubs again: `scrubForTerminal` removes every C0 control but newline and tab, DEL,
 * every C1 control (0x80 to 0x9f: a lone 0x9b is CSI on some terminals), ESC with it, the bidi controls that reorder
 * what is shown (a U+202E makes `exe.txt` read as `txt.exe`), and the characters that are invisible or that pi-tui
 * measures at a width the terminal does not draw them at (zero-width spaces and joiners, U+2060, U+FEFF, the soft
 * hyphen, the tag block U+E0000 to U+E007F, Hangul fillers and leading jamo), so a line can neither hide text nor
 * misalign the screen; it clips an entry to 64 KiB. Hyperlinks are turned off in pi-tui
 * (`setCapabilityOverrides({hyperlinks: false})`; a test records that call and draws a link with and without it), so a
 * markdown link prints its target beside its text and nothing on the screen can point somewhere it does not say.
 * pi-tui's Markdown does not decode HTML entities, so an `&#x1b;` in the text stays those six characters (a test holds
 * that).
 *
 * MARKDOWN IS A PARSER WITH LIMITS, SO ITS INPUT IS BOUNDED FIRST. pi-tui's Markdown recurses per nesting level (a
 * blockquote 55 levels deep, or a LaTeX group 1,266 deep, overflows the stack) and its emphasis pass is quadratic (64
 * KiB of `*a ` takes 20 s). LaTeX recurses on commands as well as braces: `\sqrt\sqrt...x` and `\frac a\frac a...`
 * nest with no brace at all and overflow at 1,600 to 2,000 commands (measured, pi-tui 1.2.0, `$...$`, `$$...$$` and
 * `\[...\]` alike), so a brace bound alone is not one. `markdownPlan` therefore draws an entry as plain text when a
 * line stacks more than `MARKDOWN_MAX_DEPTH` quote or list markers or the entry holds more than
 * `MARKDOWN_MAX_DELIMITERS` emphasis and link delimiters, and turns LaTeX off when braces nest past
 * `LATEX_MAX_BRACE_DEPTH` or the entry holds more than `LATEX_MAX_COMMANDS` backslashes (every command starts with
 * one, so this bounds command nesting of every kind without parsing LaTeX); a render that throws anyway falls back
 * to plain text for that entry alone. And whatever throws, the terminal is given back: while a screen runs, an
 * uncaught exception, an unhandled rejection, SIGINT, SIGTERM and SIGHUP each leave the alternate screen, show the
 * cursor and end raw mode before the process exits (`guardTerminal`).
 *
 * pi-tui IS LOADED LAZILY (`loadPiTui`), so `chat-cli.mjs`, the fork path and every test of the pure helpers here run
 * without it, and the worker's boot path never touches it.
 *
 * WHEN THE EDITOR IS HIDDEN, THE SCREEN SAYS WHY. A viewer token (the console's role rule: viewers read status only, and
 * never a transcript), a read-only console, a run whose trigger did not arm steering, and an armed run whose inbox is
 * closed each have their own sentence (`editorAvailability`), so a missing box is never mistaken for a broken one.
 */

/** The most bytes of one entry's text the screen keeps; the rest is cut and the cut is said. */
export const ENTRY_MAX_BYTES = 64 * 1024;

/** How many lines of a tool call or result are shown until `e` expands them. */
export const TOOL_PREVIEW_LINES = 8;

/** The most entries one screen keeps; older ones scroll away for good (the run page keeps the rest for 24 hours). */
export const ENTRIES_MAX = 2000;

/** How often the status line asks `/api/run` again. */
export const STATUS_POLL_MS = 5000;

/** How long the reply view waits for the transcript stream to deliver the question before it points at the forge. */
export const QUESTION_TIMEOUT_MS = 10_000;

/** The most quote and list markers one line may stack and still be drawn as markdown. */
export const MARKDOWN_MAX_DEPTH = 8;

/** The most emphasis and link delimiters (`*`, `_`, `~`, `[`) an entry may hold and still be drawn as markdown. */
export const MARKDOWN_MAX_DELIMITERS = 2000;

/** The deepest brace nesting an entry may hold and still have its LaTeX rendered. */
export const LATEX_MAX_BRACE_DEPTH = 16;

/**
 * The most backslashes an entry may hold and still have its LaTeX rendered: about a sixth of the 1,600 nested commands
 * that overflow, since the stack left depends on where the render runs. A longer formula shows as its source.
 */
export const LATEX_MAX_COMMANDS = 256;

/**
 * How an assistant entry may be drawn: `{markdown, latex}`. Linear in the text, and run before pi-tui's Markdown ever
 * sees it (the module comment says why). Indentation-nested lists are not counted: pi-tui draws 80 levels of them in a
 * millisecond; it is quote and list MARKERS stacked on one line that recurse.
 */
export function markdownPlan(text) {
	const s = String(text ?? "");
	let delimiters = 0;
	let braces = 0;
	let deepest = 0;
	let commands = 0;
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		if (c === 42 || c === 95 || c === 126 || c === 91) delimiters += 1;
		else if (c === 92) commands += 1;
		else if (c === 123) deepest = Math.max(deepest, (braces += 1));
		else if (c === 125 && braces > 0) braces -= 1;
	}
	if (delimiters > MARKDOWN_MAX_DELIMITERS) return { markdown: false, latex: false };
	for (const line of s.split("\n")) {
		let depth = 0;
		let i = 0;
		for (;;) {
			while (line[i] === " " || line[i] === "\t") i += 1;
			if (line[i] === ">") {
				depth += 1;
				i += 1;
				continue;
			}
			const m = /^(?:[-*+]|[0-9]{1,9}[.)])(?=[ \t])/.exec(line.slice(i, i + 12));
			if (!m) break;
			depth += 1;
			i += m[0].length;
		}
		if (depth > MARKDOWN_MAX_DEPTH) return { markdown: false, latex: false };
	}
	return { markdown: true, latex: deepest <= LATEX_MAX_BRACE_DEPTH && commands <= LATEX_MAX_COMMANDS };
}

const EXIT_CODE_OF_SIGNAL = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

/**
 * While a screen runs, give the terminal back however the process ends: an uncaught exception or unhandled rejection
 * calls `restore()`, prints one scrubbed line naming the failure, and exits 1; SIGINT, SIGTERM and SIGHUP call
 * `restore()` and exit 130, 143 and 129. (Ctrl+C in raw mode is a key, not a signal, and is the screen's own detach; a
 * SIGINT here came from `kill`.) Without this a throw inside a render, which pi-tui runs from a timer, would leave the
 * shell in the alternate screen with no cursor and no echo. Returns the function that removes the handlers. `proc` is
 * the seam (`on`, `removeListener`, `exit`).
 */
export function guardTerminal({ restore, proc = process, err = (line) => process.stderr.write(`${line}\n`) }) {
	const handlers = {};
	const fail = (e) => {
		restore();
		err(`error: the chat screen failed (${scrubForTerminal(e?.message ?? String(e), { maxBytes: 512 }).replace(/\n/g, " ")}); the terminal was restored`);
		proc.exit(1);
	};
	handlers.uncaughtException = fail;
	handlers.unhandledRejection = fail;
	for (const [signal, code] of Object.entries(EXIT_CODE_OF_SIGNAL)) {
		handlers[signal] = () => {
			restore();
			proc.exit(code);
		};
	}
	for (const [event, handler] of Object.entries(handlers)) proc.on(event, handler);
	return () => {
		for (const [event, handler] of Object.entries(handlers)) proc.removeListener(event, handler);
	};
}

/** The pinned renderer, imported only when a screen is drawn. */
export function loadPiTui() {
	return import("@earendil-works/pi-tui");
}

// C0 but tab and newline, DEL, C1 (ESC is in C0), the bidi embedding, override, isolate and mark controls, the soft
// hyphen, zero-width space, non-joiner and joiner, word joiner, BOM, Hangul leading jamo and fillers, and the tag block.
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u1100-\u115f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

/**
 * Text that is safe to hand a terminal: `\r\n` and a lone `\r` become a newline (a bare CR would let a line overwrite
 * itself), a tab becomes four spaces, every other control and bidi character is removed, and the result is cut to
 * `maxBytes` of UTF-8 on a character boundary with "[cut: N more bytes]" said after it.
 */
export function scrubForTerminal(text, { maxBytes = ENTRY_MAX_BYTES } = {}) {
	let s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(UNSAFE_RE, "");
	const bytes = Buffer.byteLength(s, "utf8");
	if (bytes <= maxBytes) return s;
	let cut = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
	// A multi-byte character split by the byte cut decodes as U+FFFD; drop it rather than show a stray box.
	if (cut.endsWith("�")) cut = cut.slice(0, -1);
	s = `${cut}\n[cut: ${bytes - Buffer.byteLength(cut, "utf8")} more bytes]`;
	return s;
}

/**
 * What the operator typed into the live view's editor:
 *   - `/later <text>`: a follow-up, read once the agent would otherwise stop (`{kind: "followUp", text}`);
 *   - `/withdraw <id>`: take a queued or written message back (`{kind: "withdraw", id}`);
 *   - any other text: a steer, read after the current tool calls (`{kind: "steer", text}`);
 *   - blank: `{kind: "empty"}`; a slash word the view does not know: `{refusal}` (so `/latr fix it` is never sent to the
 *     agent as a message by a typo).
 * A message that should begin with a slash is sent with two (`//etc/hosts is wrong` sends `/etc/hosts is wrong`).
 */
export function parseChatInput(text) {
	const s = String(text ?? "");
	const trimmed = s.trim();
	if (trimmed === "") return { kind: "empty" };
	if (trimmed.startsWith("//")) return { kind: "steer", text: trimmed.slice(1) };
	if (!trimmed.startsWith("/")) return { kind: "steer", text: s };
	const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	const word = m?.[1] ?? "";
	const rest = (m?.[2] ?? "").trim();
	if (word === "later") return rest === "" ? { refusal: "/later needs the message after it: /later <text>" } : { kind: "followUp", text: rest };
	if (word === "withdraw") {
		if (!/^[0-9a-f]{32}$/.test(rest)) return { refusal: "/withdraw needs a message id (32 lowercase hex characters, as the send printed it)" };
		return { kind: "withdraw", id: rest };
	}
	return { refusal: `/${word.slice(0, 20)} is not a chat command (use /later <text> or /withdraw <id>; start a message with // to send a leading slash)` };
}

/**
 * Whether the editor is shown, and if not, the sentence the screen shows in its place. `mode` is `"live"` or
 * `"reply"`; `who` is `/api/whoami`'s `{role, readOnly}`; `info` is `/api/run`'s answer (`steer: {armed, open}`).
 */
export function editorAvailability({ mode, who, info }) {
	if (who?.role !== "operator") {
		return { shown: false, reason: mode === "reply" ? "You are signed in with a viewer token: only an operator can answer a parked run." : "You are signed in with a viewer token: you see the run's status only (transcripts and messages are an operator's)." };
	}
	if (who?.readOnly) return { shown: false, reason: "The console is read-only (PI_CONSOLE_READ_ONLY=1), so nothing can be sent from here." };
	if (mode === "reply") return { shown: true };
	// null is the console saying the inbox could not be read, which is not the same answer as "not armed".
	if (info?.steer?.armed === null) return { shown: false, reason: "Whether this run takes messages could not be read right now; the status line checks again every few seconds." };
	if (info?.steer?.armed !== true) return { shown: false, reason: "This run's trigger does not take messages (no \"steer\": true), so you can watch it but not steer it." };
	if (info?.steer?.open === null) return { shown: false, reason: "Whether the run's inbox is open could not be read right now; the status line checks again every few seconds." };
	if (info?.steer?.open !== true) return { shown: false, reason: "The run's inbox is closed (it has not started taking messages yet, or it is ending), so nothing can be sent right now." };
	return { shown: true };
}

const intOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The status line from `/api/run`'s answer: the run, its state, its progress counts and whether it takes messages. */
export function statusText(info) {
	const run = info?.run ?? {};
	const id = liveJobIdOf(info) ?? "?";
	const parts = [`run ${id}`];
	if (typeof run.target === "string" && run.target !== "") parts.push(run.target);
	if (typeof info?.state === "string") parts.push(info.state);
	const p = info?.progress ?? {};
	const counts = [["turns", intOf(p.turns)], ["steps", intOf(p.steps)], ["failed", intOf(p.failed)]].filter(([, n]) => n !== null).map(([k, n]) => `${k} ${n}`);
	if (counts.length > 0) parts.push(counts.join(", "));
	if (info?.steer?.armed === true) parts.push(info.steer.open === true ? "inbox open" : "inbox closed");
	if (info?.transcript?.ended === true) parts.push(`ended (${typeof info.transcript.outcome === "string" ? info.transcript.outcome : "unknown"})`);
	return scrubForTerminal(parts.join("  |  "), { maxBytes: 1024 }).replace(/\n/g, " ");
}

const KINDS = Object.freeze({ user: "user", assistant: "assistant", "tool-call": "tool call", "tool-result": "tool result", compaction: "compaction", note: "note", reset: "restart", skipped: "skipped", end: "end" });

/**
 * One JSON transcript entry (`{id, kind, ts, text, tool, error, truncated, outcome}`, the console's
 * `/api/transcript?format=json` data) as what the screen draws: a header, the scrubbed body, and whether it is drawn as
 * markdown (assistant text) or plain. Null for an event that is not an entry. Every field is re-checked here; nothing
 * the stream sent is used by shape alone.
 */
export function entryView(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const kind = Object.hasOwn(KINDS, raw.kind) ? raw.kind : "note";
	const tool = typeof raw.tool === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw.tool) ? raw.tool : null;
	const ts = Number.isSafeInteger(raw.ts) && raw.ts >= 0 && raw.ts < 8.64e15 ? new Date(raw.ts).toISOString().slice(11, 19) : null;
	const header = [KINDS[kind], tool, raw.error === true ? "error" : null, ts ? `${ts} UTC` : null, raw.truncated === true ? "truncated" : null].filter(Boolean).join("  ");
	let body;
	if (kind === "reset") body = "The session file was rewritten; what follows starts over.";
	else if (kind === "skipped") body = "A line was left out (too large or unreadable).";
	else if (kind === "end") body = `The run is over (${typeof raw.outcome === "string" ? scrubForTerminal(raw.outcome, { maxBytes: 64 }) : "unknown"}).`;
	else body = typeof raw.text === "string" ? scrubForTerminal(raw.text) : "";
	return { id: typeof raw.id === "string" ? raw.id : null, kind, header, body, markdown: kind === "assistant", tool: kind === "tool-call" || kind === "tool-result" };
}

/** A tool entry's body as shown: its first `TOOL_PREVIEW_LINES` lines and how many more, or all of it when expanded. */
export function toolBody(body, expanded) {
	const lines = String(body).split("\n");
	if (expanded || lines.length <= TOOL_PREVIEW_LINES) return lines.join("\n");
	return `${lines.slice(0, TOOL_PREVIEW_LINES).join("\n")}\n[${lines.length - TOOL_PREVIEW_LINES} more lines: press e to expand]`;
}

/** The last assistant entry's scrubbed text in a list of raw entries, or null: the parked run's question. */
export function lastAssistantText(entries) {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const v = entryView(entries[i]);
		if (v?.kind === "assistant" && v.body.trim() !== "") return v.body;
	}
	return null;
}

// Plain SGR, so the theme needs no colour library; tests strip exactly these and then require no ESC at all.
const sgr = (open, close) => (s) => `\u001b[${open}m${s}\u001b[${close}m`;
const ident = (s) => s;

/** The screen's colours. `plain` (identity everywhere) is what tests draw with. */
export function chatTheme({ plain = false } = {}) {
	const f = plain ? () => ident : sgr;
	const bold = f(1, 22);
	const dim = f(2, 22);
	return {
		bold,
		dim,
		accent: f(36, 39),
		warn: f(33, 39),
		bad: f(31, 39),
		markdown: { heading: bold, link: f(4, 24), linkUrl: dim, code: f(36, 39), codeBlock: ident, codeBlockBorder: dim, quote: f(3, 23), quoteBorder: dim, hr: dim, listBullet: f(36, 39), bold, italic: f(3, 23), strikethrough: f(9, 29), underline: f(4, 24) },
		editor: { borderColor: dim, selectList: { selectedPrefix: ident, selectedText: ident, description: dim, scrollInfo: dim, noMatch: dim } },
	};
}

/**
 * One chat screen on pi-tui: the transcript in a follow-the-end scroll view, a status line, a notice area (results,
 * refusals, a pending y/n), and an editor or the sentence that replaces it. Returns its handles; nothing here talks to
 * the console. `pi` is the pi-tui module, `terminal` a pi-tui Terminal (a `ProcessTerminal`, or a test's fake).
 *
 * KEYS: Ctrl+C detaches (`onDetach`); Esc moves focus between the editor and the transcript; with the transcript
 * focused (or no editor) `e` expands and folds every tool entry, and the arrows and PgUp/PgDn scroll (pi-tui's own
 * viewport keys); Enter in the editor calls `onSubmit(text)`, Shift+Enter starts a new line. While `confirm` waits, only
 * y, n, Esc and Ctrl+C are read (Ctrl+C answers no AND detaches).
 *
 * `proc` is the process seam `guardTerminal` hooks from `start` to `stop`.
 */
export function makeChatScreen({ pi, terminal, theme = chatTheme(), onSubmit = () => {}, onDetach = () => {}, proc = process, err }) {
	// No OSC 8: a link's target is printed beside its text, so nothing on the screen points somewhere it does not say.
	pi.setCapabilityOverrides({ hyperlinks: false, images: null });
	const tui = new pi.TuiAltScreen(terminal, true);
	const entries = [];
	let expanded = false;
	let pending = null;
	let running = false;
	let unguard = null;

	/** Leave the alternate screen, show the cursor, end raw mode: once, and never throwing. */
	const restore = () => {
		if (!running) return;
		running = false;
		try {
			tui.stop({ preserveScreen: true });
		} catch {
			try {
				terminal.write("\u001b[?2004l\u001b[?1049l\u001b[?25h");
			} catch {
				// nothing more can be written
			}
		}
		try {
			if (proc?.stdin?.isTTY) proc.stdin.setRawMode?.(false);
		} catch {
			// not a TTY after all
		}
	};

	const plainBody = (v) => new pi.Text(v.tool ? toolBody(v.body, expanded) : v.body, 1, 0);
	const blockOf = (v) => {
		const plan = v.markdown ? markdownPlan(v.body) : null;
		const plainNote = plan && !plan.markdown ? "  plain text (nested too deeply for markdown)" : "";
		const header = new pi.Text(theme.dim(`${v.header}${plainNote}`), 0, 0);
		const body = plan?.markdown ? new pi.Markdown(v.body, 1, 0, theme.markdown, undefined, { renderLatex: plan.latex }) : plainBody(v);
		return { v, header, body };
	};
	const transcriptDoc = {
		render(width) {
			const out = [];
			for (const b of entries) {
				let lines = [];
				if (b.v.body !== "") {
					try {
						lines = b.body.render(width);
					} catch {
						// A parser limit the plan did not foresee: this entry alone is drawn as plain text from now on.
						b.body = plainBody({ ...b.v, tool: false });
						b.header.setText(theme.dim(`${b.v.header}  plain text (markdown could not draw it)`));
						lines = b.body.render(width);
					}
				}
				out.push(...b.header.render(width), ...lines, "");
			}
			return out;
		},
		invalidate() {
			for (const b of entries) {
				b.header.invalidate();
				b.body.invalidate();
			}
		},
	};
	const transcript = new pi.ScrollView(transcriptDoc, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	const status = new pi.Text("", 0, 0);
	const notice = new pi.Text("", 0, 0);
	const hiddenReason = new pi.Text("", 0, 0);
	const editor = new pi.Editor(tui, theme.editor, { paddingX: 1 });
	let editorShown = false;
	const slot = {
		render: (width) => (editorShown ? editor.render(width) : hiddenReason.render(width)),
		invalidate() {
			editor.invalidate();
			hiddenReason.invalidate();
		},
		handleInput: (data) => (editorShown ? editor.handleInput(data) : undefined),
	};
	// Focus holder for the transcript: `e` toggles tool expansion; everything else is the viewport's.
	const transcriptKeys = { render: () => [], invalidate() {}, handleInput() {} };
	editor.onSubmit = (text) => {
		editor.addToHistory?.(text);
		onSubmit(text);
	};
	const dock = new pi.VStack([
		{ component: status, shrink: 1, minSize: 0 },
		{ component: notice, shrink: 1, minSize: 0 },
		{ component: slot, shrink: 1, minSize: 1 },
	]);
	const root = new pi.VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(root);

	tui.addInputListener((data) => {
		if (pi.isKeyRelease(data)) return undefined;
		if (pi.matchesKey(data, "ctrl+c")) {
			if (pending) settle(false);
			onDetach();
			return { consume: true };
		}
		if (pending) {
			if (data === "y" || data === "Y") settle(true);
			else if (data === "n" || data === "N" || pi.matchesKey(data, "escape")) settle(false);
			return { consume: true };
		}
		if (pi.matchesKey(data, "escape") && editorShown) {
			tui.setFocus(tui.getFocusedComponent() === editor ? transcriptKeys : editor);
			tui.requestRender();
			return { consume: true };
		}
		if (data === "e" && (!editorShown || tui.getFocusedComponent() !== editor)) {
			expanded = !expanded;
			for (const b of entries) if (b.v.tool) b.body.setText(toolBody(b.v.body, expanded));
			tui.requestRender();
			return { consume: true };
		}
		return undefined;
	});

	function settle(answer) {
		const p = pending;
		pending = null;
		setNotice(answer ? "sending..." : "not sent");
		p?.(answer);
	}

	function setNotice(text, tone = null) {
		const scrubbed = scrubForTerminal(text, { maxBytes: 4096 });
		notice.setText(scrubbed === "" ? "" : tone ? theme[tone](scrubbed) : scrubbed);
		tui.requestRender();
	}

	return {
		tui,
		root,
		editor,
		/** Add one raw transcript entry (the stream's JSON); returns false for a value that is not one. */
		addEntry(raw) {
			const v = entryView(raw);
			if (!v) return false;
			entries.push(blockOf(v));
			if (entries.length > ENTRIES_MAX) entries.splice(0, entries.length - ENTRIES_MAX);
			tui.requestRender();
			return true;
		},
		/** A plain block that is not a transcript entry (the reply view's question, a pointer to the forge). */
		addBlock(header, body, { markdown = false } = {}) {
			entries.push(blockOf({ id: null, kind: "note", header: scrubForTerminal(header, { maxBytes: 1024 }), body: scrubForTerminal(body), markdown, tool: false }));
			tui.requestRender();
		},
		setStatus(text) {
			status.setText(theme.bold(scrubForTerminal(text, { maxBytes: 1024 }).replace(/\n/g, " ")));
			tui.requestRender();
		},
		setNotice,
		/** Show the editor (focused) or, in its place, `reason`. */
		setEditor(availability) {
			editorShown = availability?.shown === true;
			hiddenReason.setText(editorShown ? "" : theme.warn(scrubForTerminal(availability?.reason ?? "", { maxBytes: 1024 })));
			tui.setFocus(editorShown ? editor : transcriptKeys);
			tui.requestRender();
		},
		get editorShown() {
			return editorShown;
		},
		get expanded() {
			return expanded;
		},
		/** Show `lines` and ask y/n in the notice area; resolves true for y. */
		confirm(lines) {
			if (pending) settle(false);
			setNotice([...lines, "Send it? y/n"].join("\n"), "accent");
			return new Promise((resolve) => {
				pending = resolve;
			});
		},
		start() {
			running = true;
			unguard = guardTerminal({ restore, proc, ...(err ? { err } : {}) });
			tui.start();
		},
		stop() {
			if (pending) settle(false);
			unguard?.();
			unguard = null;
			restore();
		},
	};
}

/** The id a run's messages and stream go to: its active (recovery) job when it has one, else its own. */
export function liveJobIdOf(info) {
	if (typeof info?.activeJobId === "string" && info.activeJobId !== "") return info.activeJobId;
	if (typeof info?.run?.jobId === "string" && info.run.jobId !== "") return info.run.jobId;
	// A running job has no record yet, so `run.jobId` is null and the id asked about is the job's own.
	return typeof info?.run?.id === "string" && info.run.id !== "" ? info.run.id : null;
}

/**
 * The live view. Streams the run's JSON transcript into the screen (operators only: a viewer gets the status line and
 * the sentence that says why), polls `/api/run` every `pollMs` for the status line and whether the inbox is open, and
 * sends what the editor submits as the console's `steer` or `steer-withdraw` action, each previewed and confirmed on
 * screen (y/n). Resolves `{detached: true}` on Ctrl+C (the run goes on), or `{ended: true, info}` once the run is no
 * longer live (its stream sent `done`, or the poll says another mode), with `/api/run`'s fresh answer so the caller can
 * switch to the reply or fork mode.
 *
 * `lookup` is the `/api/run` query (`{id}` or `{url}`); `timers` is the seam for the poll (`setInterval`/`clearInterval`);
 * `onScreen(screen)` hands a test the screen to draw and type into.
 */
export async function runLiveView({ client, lookup, info: first, who, pi, terminal, theme = chatTheme(), pollMs = STATUS_POLL_MS, timers = { setInterval, clearInterval }, onScreen = () => {}, proc = process }) {
	let info = first;
	let finished = false;
	let poller = null;
	let streaming = false;
	const abort = new AbortController();
	let resolveView;
	const result = new Promise((resolve) => {
		resolveView = resolve;
	});
	const finish = (value) => {
		if (finished) return;
		finished = true;
		abort.abort();
		if (poller !== null) timers.clearInterval(poller);
		screen.stop();
		resolveView(value);
	};
	const requery = async () => {
		const got = await client.run(lookup).catch(() => null);
		return got?.status === 200 && got.json ? got.json : null;
	};
	const screen = makeChatScreen({
		pi,
		terminal,
		theme,
		proc,
		onDetach: () => finish({ detached: true }),
		onSubmit: (text) => void submit(text),
	});
	onScreen(screen);
	const jobId = liveJobIdOf(info);

	async function submit(text) {
		// pi-tui's Editor empties itself on Enter; a message that is refused or not confirmed is put back to be fixed.
		const keep = () => screen.editor.getText() === "" && screen.editor.setText(text);
		const parsed = parseChatInput(text);
		if (parsed.kind === "empty") return;
		if (parsed.refusal) {
			keep();
			return screen.setNotice(parsed.refusal, "warn");
		}
		const target = liveJobIdOf(info) ?? jobId;
		const [name, body] = parsed.kind === "withdraw" ? ["steer-withdraw", { jobId: target, id: parsed.id }] : ["steer", { jobId: target, text: parsed.text, mode: parsed.kind }];
		const lines = [];
		let got;
		try {
			got = await client.act(name, body, { print: (l) => lines.push(l), confirm: () => screen.confirm(lines) });
		} catch (e) {
			keep();
			return screen.setNotice(e?.message ?? "the console could not be asked", "bad");
		}
		if (got.refusal) {
			keep();
			return screen.setNotice(got.refusal, "bad");
		}
		if (got.declined) {
			keep();
			return screen.setNotice("not sent");
		}
		if (got.unchanged) return screen.setNotice(lines.join("\n"));
		const r = got.result ?? {};
		if (name === "steer-withdraw") return screen.setNotice(`withdrew message ${r.id ?? parsed.id}${r.guaranteed === true ? " (it was still queued: the run never sees it)" : " (best effort: the agent may already have read it)"}`, "accent");
		screen.setNotice(`sent message ${r.id ?? "?"} as a ${parsed.kind === "followUp" ? "follow-up" : "steer"}${typeof r.state === "string" ? ` (${r.state})` : ""}; /withdraw ${r.id ?? "<id>"} takes it back`, "accent");
	}

	screen.setStatus(statusText(info));
	screen.setEditor(editorAvailability({ mode: "live", who, info }));
	if (who?.role !== "operator") screen.setNotice("Waiting for the run to end; Ctrl+C detaches.");
	screen.start();

	poller = timers.setInterval(async () => {
		const fresh = await requery();
		if (finished || !fresh) return;
		info = fresh;
		screen.setStatus(statusText(info));
		const keep = screen.editor.getText();
		const was = screen.editorShown;
		screen.setEditor(editorAvailability({ mode: "live", who, info }));
		if (was && screen.editorShown) screen.editor.setText(keep);
		// A viewer has no stream to say `done` (nor an operator whose stream failed or never existed): for them the poll
		// is the way to learn the run is no longer live. A running stream is left to reach `done`, so nothing is cut short.
		if (info.mode !== "live" && !streaming) finish({ ended: true, info });
	}, pollMs);

	if (who?.role === "operator" && jobId !== null && info?.transcript?.exists !== false) {
		streaming = true;
		const path = `/api/transcript?${new URLSearchParams({ id: jobId, format: "json" })}`;
		client
			.stream(path, {
				signal: abort.signal,
				onState: (s) => {
					if (s.relogin) screen.setNotice("the console ended this sign-in; signing in again");
					else if (s.waiting) screen.setNotice(`the stream dropped; reconnecting in ${Math.ceil(s.waiting / 1000)} s`);
				},
				onEvent: (ev) => {
					if (ev.event === "oversize") return screen.addBlock("skipped", "An entry larger than 256 KiB was left out.");
					if (ev.event !== "entry") return;
					let parsed = null;
					try {
						parsed = JSON.parse(ev.data);
					} catch {
						return;
					}
					screen.addEntry(parsed);
				},
			})
			.then(async (end) => {
				if (end?.detached || finished) return;
				const fresh = await requery();
				finish({ ended: true, info: fresh ?? info, outcome: end?.done ?? null });
			})
			.catch((e) => {
				// The poll is now the only way to learn the run ended.
				streaming = false;
				if (finished) return;
				screen.setNotice(`${e?.message ?? "the transcript stream failed"}. The status line still updates; Ctrl+C detaches.`, "bad");
			});
	} else if (who?.role === "operator") {
		screen.setNotice("No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired, or not started yet. The status line still updates.");
	}
	return result;
}

/**
 * The parked run's question: the last assistant entry of its JSON transcript (kept 24 hours after the run), read to the
 * stream's `done` within `timeoutMs`. Returns `{question}` or `{pointer}` (a sentence naming the forge link) when the
 * transcript cannot be read (a viewer, no stream, an expired one, nothing said).
 */
export async function questionOf({ client, info, who, timeoutMs = QUESTION_TIMEOUT_MS, timers = { setTimeout, clearTimeout } }) {
	const link = typeof info?.forgeLink === "string" && /^https?:\/\//.test(info.forgeLink) ? scrubForTerminal(info.forgeLink, { maxBytes: 2048 }) : null;
	const pointer = { pointer: link ? `The question is on ${link}` : "The question is in the run's last comment on its issue (no transcript to read it from)." };
	const jobId = typeof info?.run?.jobId === "string" ? info.run.jobId : null;
	if (who?.role !== "operator" || jobId === null || info?.transcript?.exists !== true) return pointer;
	const entries = [];
	const abort = new AbortController();
	const timer = timers.setTimeout(() => abort.abort(), timeoutMs);
	try {
		await client.stream(`/api/transcript?${new URLSearchParams({ id: jobId, format: "json" })}`, {
			signal: abort.signal,
			onEvent: (ev) => {
				if (ev.event !== "entry" || entries.length >= ENTRIES_MAX) return;
				try {
					entries.push(JSON.parse(ev.data));
				} catch {
					// not an entry
				}
			},
		});
	} catch {
		return pointer;
	} finally {
		timers.clearTimeout(timer);
	}
	const text = lastAssistantText(entries);
	return text === null ? pointer : { question: text };
}

/**
 * The reply view: the question (as markdown) and a multi-line editor whose Enter sends the console's `parked-answer`
 * action for the run's job, previewed and confirmed on screen. A refusal is printed as the console sent it, and the
 * editor stays for another try. Resolves `{answered: true, result}` or `{detached: true}`.
 */
export async function runReplyView({ client, info, who, question, pi, terminal, theme = chatTheme(), onScreen = () => {}, proc = process }) {
	let finished = false;
	let resolveView;
	const result = new Promise((resolve) => {
		resolveView = resolve;
	});
	const finish = (value) => {
		if (finished) return;
		finished = true;
		screen.stop();
		resolveView(value);
	};
	const jobId = typeof info?.run?.jobId === "string" ? info.run.jobId : null;
	const screen = makeChatScreen({ pi, terminal, theme, proc, onDetach: () => finish({ detached: true }), onSubmit: (text) => void submit(text) });
	onScreen(screen);

	async function submit(text) {
		if (String(text).trim() === "") return;
		// pi-tui's Editor empties itself on Enter; an answer that is refused or not confirmed is put back for another try.
		const keep = () => screen.editor.getText() === "" && screen.editor.setText(text);
		const lines = [];
		let got;
		try {
			got = await client.act("parked-answer", { jobId, text }, { print: (l) => lines.push(l), confirm: () => screen.confirm(lines) });
		} catch (e) {
			keep();
			return screen.setNotice(e?.message ?? "the console could not be asked", "bad");
		}
		if (got.refusal) {
			keep();
			return screen.setNotice(got.refusal, "bad");
		}
		if (got.declined) {
			keep();
			return screen.setNotice("not sent; edit the answer and press Enter again");
		}
		finish({ answered: true, result: got.result ?? {} });
	}

	screen.setStatus(statusText(info));
	const approval = info?.run?.reason === "awaiting-approval" ? info.run.approval : null;
	if (approval) screen.addBlock("approval gate", `${approval.action}\n${approval.action === "budget-raise" ? "Worker-enforced: the declared cap remains subject to deployment and scoped budgets." : "Advisory: the worker does not enforce this external action."}`);
	if (question?.question) screen.addBlock("the run asked", question.question, { markdown: true });
	else screen.addBlock("the run asked", question?.pointer ?? "The question could not be read.");
	screen.setEditor(editorAvailability({ mode: "reply", who, info }));
	screen.setNotice(screen.editorShown ? approval ? "Type /approve, /decline [reason], or a question (no approval). Enter previews it; Ctrl+C leaves without deciding." : "Type the answer: Enter previews it, Shift+Enter starts a new line, Ctrl+C leaves without answering." : "Ctrl+C leaves.");
	screen.start();
	return result;
}
