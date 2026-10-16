/**
 * The live transcript's entries as HTML (issue #643, DES-OPERATOR-CONSOLE "Live transcript"): what `/api/transcript`
 * writes as each `event: entry`'s `{html}`, and the run page's section that the stream fills.
 *
 * THE TEXT IS AGENT-WRITTEN. The worker redacts the job's secrets and writes every control and bidi character as
 * `\u{XXXX}`, keeping only real newlines and tabs; this module treats it as untrusted anyway. Every value goes through
 * the `html` template (control scrub, then escape), line by line, so the `<pre>` keeps the text's real newlines and tabs
 * while a newline or tab can never carry anything else. No markdown is interpreted and no inline style is written.
 *
 * THE OPERATOR ALONE SEES IT. Only `/api/transcript` (operator only) renders an entry; the run page's section holds no
 * entry, only the empty `[data-transcript]` element the browser script fills, and a viewer gets a sentence instead.
 * Nothing here reaches `/api/state`, a hub panel or a list.
 */
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

/** Why a run has no stream: the stream cannot tell these apart, so the page names all three. */
export const TRANSCRIPT_ABSENT = "No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired, or not started yet.";

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
  if (meta?.exists !== true) return html`${title}<p class="note">${TRANSCRIPT_ABSENT} Reload to check again.</p>`;
  const note = html`<p class="note">${meta.ended ? `The run has ended (${meta.outcome ?? "unknown"}); its stream is kept 24 hours.` : "The run is publishing its transcript."}</p>`;
  return html`${title}${note}<p class="t-status" data-transcript-status role="status" aria-live="polite">not live</p><div class="transcript" data-transcript data-job="${id}" tabindex="0"></div>`;
}
