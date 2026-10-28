/**
 * The live transcript's entries as HTML (issue #747, DES-OPERATOR-CONSOLE "Live transcript"): what an operator's run
 * page stream and `/api/transcript` write as each `event: entry`'s `{html}`, and the static box the browser fills.
 *
 * THE TEXT IS AGENT-WRITTEN. The worker redacts the job's secrets and writes every control and bidi character as
 * `\u{XXXX}`, keeping only real newlines and tabs; this module treats it as untrusted anyway. Every value goes through
 * the `html` template (control scrub, then escape), line by line, so the `<pre>` keeps the text's real newlines and tabs
 * while a newline or tab can never carry anything else. No markdown is interpreted and no inline style is written.
 *
 * Issue #647 adds the same entry as structured JSON (`transcriptEntryJson`), for the terminal chat, which renders it
 * itself; the route, the role and the caps are the same, only the `data` differs.
 *
 * THE OPERATOR ALONE SEES IT. Only the operator's entry events render transcript text. The initial run page holds no
 * entry, only the empty `[data-transcript]` element the browser script fills, and a viewer gets a sentence instead.
 * Nothing here reaches `/api/state`, a hub panel or a list.
 */
import { LIVE_OUTCOMES, LIVE_TOOL_RE } from "@edgehero/pi-dispatch/live-transcript";
import { TRANSCRIPT_ID_RE, transcriptAbsentText } from "../read-model.mjs";
import { html } from "./html.mjs";
import { icon } from "./kit.mjs";
import { outcomeWord } from "../words.mjs";

/** The kinds that carry text worth folding: a tool call's arguments and a tool's result go in a `<details>`. */
const FOLDED = Object.freeze({ "tool-call": "arguments", "tool-result": "result" });

/** What a kind is called in an entry's header. */
const KIND_LABEL = Object.freeze({
  user: "user",
  assistant: "assistant",
  "tool-call": "tool call",
  "tool-result": "tool result",
  compaction: "compaction",
  note: "note",
  steer: "steer",
  reset: "restart",
  skipped: "skipped",
  end: "end",
});

/** An entry's time as `HH:MM:SS UTC` plus the ISO instant for `datetime`, or null for a time that is not one. */
function timeOf(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0 || ts > 8.64e15) return null;
  const iso = new Date(ts).toISOString();
  return { iso, text: `${iso.slice(11, 19)} UTC` };
}

/**
 * Text for a `<pre>`, escaped line by line: each newline and tab between the pieces is written as itself (a fragment
 * this module builds), every piece through `html`, so the template's control scrub never folds the text onto one line.
 */
export function preText(text) {
  const parts = String(text ?? "").split(/(\n|\t)/);
  return parts.map((p) => (p === "\n" ? html`\n` : p === "\t" ? html`\t` : html`${p}`));
}

/** A live stream's end outcome in the console's words (words.mjs, #710 round 2): `policy` reads "refused", "unknown" and any other value as itself. */
const endedWord = (o) => (typeof o === "string" && o !== "" ? (outcomeWord(o).word ?? o) : "unknown");

/**
 * One transcript entry (`readTranscriptSince`'s shape: `{id, kind, ts, text, tool, error, truncated, outcome}`) as an
 * `<article>`: a header (kind, tool, error marker, UTC time, truncated), then the text in an escaped `<pre>`, inside a
 * `<details>` for a tool call's arguments and a tool's result. `reset`, `skipped` and `end` carry no text and say what
 * they mean instead.
 */
export function transcriptEntryHtml(entry, options = {}) {
  const e = entry ?? {};
  const kind = Object.hasOwn(KIND_LABEL, e.kind) ? e.kind : "note";
  const time = timeOf(e.ts);
  // Use the sprite's stable icons; an unknown transcript kind is still a note.
  const marks = { user: "comment", assistant: "running", "tool-call": "terminal", "tool-result": e.error ? "failed" : "done", steer: "comment", compaction: "more", note: "info", reset: "rerun", skipped: "attention", end: "done" };
  const header = html`<span class="tx__k">${icon(marks[kind], { size: "sm" })}${KIND_LABEL[kind]}${typeof e.tool === "string" && e.tool !== "" ? html` <span class="code">${e.tool}</span>` : null}${e.error ? html` <span>error</span>` : null}</span>`;
  let body;
  if (kind === "reset") body = html`<p>The session file was rewritten; what follows starts over.</p>`;
  else if (kind === "skipped") body = html`<p>A line was left out (too large or unreadable).</p>`;
  else if (kind === "end") body = html`<p data-transcript-end>The run is over (${options.outcomeWord ?? endedWord(e.outcome)}).</p>`;
  else if (typeof e.text !== "string") body = null;
  else if (Object.hasOwn(FOLDED, kind)) body = html`<details${e.error ? html` open` : null}><summary>${FOLDED[kind]}</summary><pre>${preText(e.text)}</pre></details>`;
  else body = html`<pre>${preText(e.text)}</pre>`;
  return html`<article class="tx__e tx__entry tx__e--${kind === "reset" ? "restart" : kind}${e.error ? " tx__e--error" : ""}" data-kind="${kind}" data-entry-id="${typeof e.id === "string" && TRANSCRIPT_ID_RE.test(e.id) ? e.id : ""}"${typeof e.tool === "string" ? html` data-tool="${e.tool}"` : null}${time ? html` data-ts="${e.ts}"` : null}>${header}<div class="tx__b tx__body">${body}${e.truncated ? html`<span class="tx__trunc">truncated</span>` : null}${kind === "tool-call" ? html`<span data-tool-timer></span>` : null}</div>${time ? html`<time class="tx__t" datetime="${time.iso}">${time.text}</time>` : null}</article>`;
}

/** The formats `/api/transcript` writes an entry in: the run page's HTML, or the structured entry (issue #647). */
export const TRANSCRIPT_FORMATS = Object.freeze(["html", "json"]);

/**
 * One transcript entry as the JSON stream's `data` (issue #647, `/api/transcript?format=json`): `{ id, kind, ts, text,
 * tool, error, truncated, outcome }`, REBUILT BY NAME from `readTranscriptSince`'s entry, so a field another reader or a
 * later change put on the entry cannot ride along to a terminal. The text is the worker's, already redacted and with
 * every control and bidi character written as `\u{XXXX}`; it stays a JSON STRING (JSON.stringify escapes every newline,
 * so an entry can never break the SSE framing), and the terminal client scrubs it again before it reaches a screen.
 * The vocabularies are the worker's own (`LIVE_TOOL_RE`, `LIVE_OUTCOMES`) and the read model's id shape, imported, never
 * restated. An unknown kind is a `note`, as the HTML renderer reads it; a field that is not its type is null or false.
 * A `tool` that IS a string but falls outside `LIVE_TOOL_RE` is written as `"?"`, not null: the HTML renderer still draws
 * a tool header for any string, and the terminal client (worker/src/chat-view.mjs) draws `tool` as a header string, so
 * null would hide that a tool ran, while the name itself is not charset-checked and stays out.
 */
export function transcriptEntryJson(entry) {
  const e = entry ?? {};
  const kind = Object.hasOwn(KIND_LABEL, e.kind) ? e.kind : "note";
  return {
    id: typeof e.id === "string" && TRANSCRIPT_ID_RE.test(e.id) ? e.id : null,
    kind,
    ts: timeOf(e.ts) ? e.ts : null,
    text: typeof e.text === "string" ? e.text : null,
    tool: typeof e.tool === "string" ? (LIVE_TOOL_RE.test(e.tool) ? e.tool : "?") : null,
    error: e.error === true,
    truncated: e.truncated === true,
    outcome: kind === "end" ? (LIVE_OUTCOMES.includes(e.outcome) ? e.outcome : "unknown") : null,
  };
}

/**
 * Why a run on a venue that streams it has no stream: the stream cannot tell these apart, so the page names all three.
 * Issue #712: the page says `transcriptAbsentText(record)`, which is this sentence for such a venue, the record's named
 * skip when it has one (`liveSkipped`), and these three plus the venue's cause for a run on a venue that does not always
 * stream or whose venue the page cannot name yet (a running job has no record).
 */
export const TRANSCRIPT_ABSENT = transcriptAbsentText({ backend: "local" });

/**
 * The static transcript box, outside panel swaps but inside the run grid. It exists while queued too, so the page
 * stream can attach without a reload. The adjacent p-transcript names the stream's state; refused runs hide the box
 * while that panel is empty. A viewer gets a locked sentence and no browser attachment hook.
 */
export function runTranscriptSection(view) {
  if (view?.role !== "operator") return html`<div class="card"><p>Transcripts are shown to operators only. The run's messages, tool calls and results stay with operators. Its numbers are above.</p></div>`;
  const id = view?.query?.id;
  if (typeof id !== "string" || id === "") return html``;
  return html`<div class="card"><div class="tx__bar"><div class="seg" role="group" aria-label="Transcript filter"><button type="button" data-transcript-filter="all" aria-pressed="true">All</button><button type="button" data-transcript-filter="messages" aria-pressed="false">Messages</button><button type="button" data-transcript-filter="tools" aria-pressed="false">Tools</button></div><span data-transcript-following>Following</span><button class="btn btn--sm" type="button" data-transcript-newest hidden>Back to newest</button></div><div class="tx transcript" data-transcript data-job="${id}" tabindex="0" aria-label="Run transcript"></div></div>`;
}
