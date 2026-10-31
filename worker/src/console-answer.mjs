/**
 * An answer to a parked run typed into the operator console (issue #642, REQ-AWAIT-INPUT's console source).
 *
 * Shared by the two sides that must agree on it: the admin, which bounds and scrubs the text before it builds the
 * reply job (`planParkedAnswer`), and the worker, which posts the one trail comment that says on the forge who
 * answered (processor.mjs, after the `not-parked` gate and before any spend). One module, so the text the job carries
 * and the text the trail quotes are scrubbed by one rule.
 *
 * WHY A TRAIL AT ALL. A forge reply leaves its own comment on the issue: anyone reading the thread sees who answered
 * and what. A console answer reaches the job without one, so without the trail the issue would show a question, then
 * a run, with the answer that steered it visible nowhere a reviewer looks. The trail is posted as the deployment's own
 * identity (the `comment` adapter), which the receiver's self-guard drops as `self`, so it never starts a job.
 *
 * Import-light (console-tokens.mjs for the name rule, which imports only node built-ins), so the receiver-free admin
 * bundle can take it.
 */

import { TOKEN_NAME_RE } from "./console-tokens.mjs";

/**
 * The `by` an answer from the panel's `/dispatch chat` carries (issue #647, part 2): it has no console token, so it is
 * signed with this reserved word, and its trail says it came from the panel rather than naming a token. RESERVED: the
 * console refuses to answer as a token of this name (`planParkedAnswer`'s `from`), so no token can sign as the panel.
 */
export const PANEL_ANSWER_BY = "panel";

/** The most an answer may carry, in UTF-8 bytes AFTER scrubbing. A person's reply to a question, not a document. */
export const ANSWER_TEXT_MAX_BYTES = 8 * 1024;

/**
 * Who answered, as `job.console.by` carries it: a console token's name (`TOKEN_NAME_RE`: lowercase letters, digits,
 * dot, dash and underscore, at most 32), else null. The charset is what makes it safe to print on a forge: no `@`, no
 * markdown, no control byte, no space.
 */
export function consoleAnswerBy(meta) {
	const by = meta?.by;
	return typeof by === "string" && TOKEN_NAME_RE.test(by) ? by : null;
}

/** The provenance is all-or-none. A model's free-text source label never reaches the trail or touch index. */
export function consoleDraftOf(meta) {
	const fields = ["draftRunId", "draftDigest", "draftSourceRunId"];
	if (!fields.some(k => meta && Object.hasOwn(meta, k))) return null;
	if (!/^[A-Za-z0-9._:-]{1,200}$/.test(meta?.draftRunId ?? "") || !/^[a-f0-9]{64}$/.test(meta?.draftDigest ?? "") || !/^[A-Za-z0-9._:-]{1,200}$/.test(meta?.draftSourceRunId ?? "")) return { invalid: true };
	return { draftRunId: meta.draftRunId, draftDigest: meta.draftDigest, draftSourceRunId: meta.draftSourceRunId };
}

/**
 * The answer text as a job may carry it. Never throws; a non-string is "". Newlines are kept: a reply can be several
 * lines.
 *   - LINE ENDINGS: `\r\n` and a lone `\r` become `\n`, and so do the Unicode line and paragraph separators (U+2028,
 *     U+2029). Made newlines rather than removed: a person who typed a separator meant a line break, and removing it
 *     would join two words the person kept apart. On a forge they would otherwise render as a break INSIDE one quoted
 *     line, or not at all, so they never reach the trail as themselves.
 *   - A TAB becomes a space; every other C0 control, DEL and every C1 control is removed.
 *   - EVERY BIDIRECTIONAL FORMAT CHARACTER is removed: the embeddings and overrides (U+202A-U+202E), the isolates
 *     (U+2066-U+2069) and the marks (U+200E, U+200F and the Arabic letter mark U+061C). A forge renders them, so a quoted
 *     line could otherwise display in an order that is not the order it was typed (the "Trojan Source" class), in a
 *     comment that claims to quote the operator verbatim. The marks are not overrides, but a mark beside a neutral
 *     character moves it across a run boundary, which is the same lie at a smaller scale; nothing an operator types to
 *     answer a question needs one.
 */
export function scrubAnswerText(text) {
	if (typeof text !== "string") return "";
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u2028\u2029]/g, "\n")
		.replace(/\t/g, " ")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * Bound a scrubbed answer: `{ text }` when it has something to say and fits `ANSWER_TEXT_MAX_BYTES`, else `{ refusal }`.
 * Refused rather than cut: a truncated answer is an answer the person did not give.
 */
export function boundAnswerText(raw) {
	const text = scrubAnswerText(raw);
	if (text.trim() === "") return { refusal: "the answer is empty (after control characters are removed); nothing was queued" };
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > ANSWER_TEXT_MAX_BYTES) return { refusal: `the answer is ${bytes} bytes, above the ${ANSWER_TEXT_MAX_BYTES}-byte limit; shorten it. Nothing was queued` };
	return { text };
}

/**
 * The trail comment for an answer: the name, then the text as a markdown blockquote, one `> ` per line (an empty line
 * too, `> ` alone, so the quote never breaks and nothing below it reads as the deployment's own words).
 *
 * HTML IS ESCAPED FIRST: `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`. Every forge renders HTML inside a comment's
 * markdown, so without it an answer holding `<!--` hid every quoted line after it (the forge showed a truncated quote
 * under the operator's name), a tag could restyle or hide the rest, and an entity such as `&#64;` decoded to an `@`
 * AFTER the mention neutraliser below had looked for one. With `&` escaped no entity survives, with `<` escaped no
 * comment or tag opens, and with `>` escaped a line cannot nest a deeper quote. The escape runs before the
 * neutraliser, so the zero-width space it adds is never inside an entity.
 *
 * MENTIONS ARE NEUTRALISED by a zero-width space (U+200B) after every `@`: `@alice` renders as the same text but is no
 * longer a mention, so an operator's answer cannot ping people or teams on the forge under the deployment's identity.
 * Chosen over wrapping in backticks, which a backtick in the text could close. U+200B is a format character, not a
 * control one, and the scrub above has already removed every control the text had. The name needs no neutralising:
 * its charset holds no `@`. The panel's reserved name (`PANEL_ANSWER_BY`) gets its own head line.
 */
export function answerTrailComment(by, text, draftRunId = null) {
	const quoted = scrubAnswerText(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/@/g, "@\u200b")
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const head = by === PANEL_ANSWER_BY ? "Answered from an operator's /dispatch panel" : `Answered from the operator console by ${by}`;
	const draft = typeof draftRunId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(draftRunId) ? `\n\nDrafted in run ${draftRunId}.` : "";
	return `${head}:\n\n${quoted}${draft}`;
}
