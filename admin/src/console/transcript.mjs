/**
 * The live transcript's entries as HTML (issue #643, DES-OPERATOR-CONSOLE "Live transcript"): what `/api/transcript`
 * writes as each `event: entry`'s `{html}`, and the run page's section that the stream fills.
 *
 * THE TEXT IS AGENT-WRITTEN. The worker redacts the job's secrets and writes every control and bidi character as
 * `\u{XXXX}`, keeping only real newlines and tabs; this module treats it as untrusted anyway. Every value goes through
 * the `html` template (control scrub, then escape), line by line, so the `<pre>` keeps the text's real newlines and tabs
 * while a newline or tab can never carry anything else. No markdown is interpreted and no inline style is written.
 *
 * Issue #647 adds the same entry as structured JSON (`transcriptEntryJson`), for the terminal chat, which renders it
 * itself; the route, the role and the caps are the same, only the `data` differs.
 *
 * THE OPERATOR ALONE SEES IT. Only `/api/transcript` (operator only) renders an entry; the run page's section holds no
 * entry, only the empty `[data-transcript]` element the browser script fills, and a viewer gets a sentence instead.
 * Nothing here reaches `/api/state`, a hub panel or a list.
 */
import { LIVE_OUTCOMES, LIVE_TOOL_RE } from "@edgehero/pi-dispatch/live-transcript";
import { TRANSCRIPT_ID_RE, transcriptAbsentText } from "../read-model.mjs";
import { html } from "./html.mjs";

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

/**
 * One transcript entry (`readTranscriptSince`'s shape: `{id, kind, ts, text, tool, error, truncated, outcome}`) as an
 * `<article>`: a header (kind, tool, error marker, UTC time, truncated), then the text in an escaped `<pre>`, inside a
 * `<details>` for a tool call's arguments and a tool's result. `reset`, `skipped` and `end` carry no text and say what
 * they mean instead.
 */
export function transcriptEntryHtml(entry) {
  const e = entry ?? {};
  const kind = Object.hasOwn(KIND_LABEL, e.kind) ? e.kind : "note";
  const time = timeOf(e.ts);
  const header = html`<header><span class="t-kind">${KIND_LABEL[kind]}</span>${typeof e.tool === "string" && e.tool !== "" ? html` <span class="t-tool mono">${e.tool}</span>` : null}${e.error ? html` <span class="t-error bad">error</span>` : null}${time ? html` <time datetime="${time.iso}">${time.text}</time>` : null}${e.truncated ? html` <span class="t-trunc warn">truncated</span>` : null}</header>`;
  let body;
  if (kind === "reset") body = html`<p class="note">The session file was rewritten; what follows starts over.</p>`;
  else if (kind === "skipped") body = html`<p class="note">A line was left out (too large or unreadable).</p>`;
  else if (kind === "end") body = html`<p class="note">The run is over (${typeof e.outcome === "string" && e.outcome !== "" ? e.outcome : "unknown"}).</p>`;
  else if (typeof e.text !== "string") body = null;
  else if (Object.hasOwn(FOLDED, kind)) body = html`<details><summary>${FOLDED[kind]}</summary><pre>${preText(e.text)}</pre></details>`;
  else body = html`<pre>${preText(e.text)}</pre>`;
  return html`<article class="t-entry t-${kind}">${header}${body}</article>`;
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
 * The run page's "Live transcript" section (operator only), from the page data's `transcript` (the fleet reader's
 * `transcriptMeta`, without text). The stream is opened only while one exists: a run's record is written at its end,
 * so "no record and no stream" is a run that has not started publishing, or no run at all (the page's 404), and a
 * stream opened for it would wait on a slot forever; the page says why there is none, and a reload picks up a stream
 * that has started since.
 */
export function runTranscriptSection(view) {
  const title = html`<h2>Live transcript</h2>`;
  if (view?.role !== "operator") return html`${title}<p class="note">Transcripts are shown to operators only.</p>`;
  const id = view?.query?.id;
  if (typeof id !== "string" || id === "") return title;
  const meta = view?.data?.transcript ?? null;
  if (meta?.unreachable) return html`${title}<p class="warn">The live transcript could not be read (is Valkey reachable?). Reload to try again.</p>`;
  if (meta?.exists !== true) return html`${title}<p class="note">${transcriptAbsentText(view?.data?.run?.record ?? null)} Reload to check again.</p>`;
  const note = html`<p class="note">${meta.ended ? `The run has ended (${meta.outcome ?? "unknown"}); its stream is kept 24 hours.` : "The run is publishing its transcript."}</p>`;
  return html`${title}${note}<p class="t-status" data-transcript-status role="status" aria-live="polite">not live</p><div class="transcript" data-transcript data-job="${id}" tabindex="0"></div>`;
}
