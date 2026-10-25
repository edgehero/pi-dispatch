/**
 * The two-step write's markup (issue #737, REQ-OPERATOR-CONSOLE-ACTIONS, the ConfirmStates, Actions, FieldsDiffCommand
 * and CardsAndBanners cards): the one confirm slot a page carries, every bar the preview and the confirm answer put in
 * it, the banner a page shows after a write, and the diff. Pulse markup through the kit, never the compatibility layer:
 * the slot sits outside every `.legacy` wrapper (the browser script moves it after the section that asked), so nothing
 * here is restyled by `compat-css.mjs`.
 *
 * EVERY STATE IS SERVER MARKUP. The browser script only moves the slot, toggles `hidden`, sets `textContent` and puts an
 * answer's `html` into the slot (`slot.innerHTML`, the one markup write it makes for a write). So the skeleton it shows
 * while it waits, the preview, the no-change bar, each refusal and the bulk results are all drawn here, escaped by `html`
 * like any panel, and each can be pinned by a panel golden. A preview answer without `html` (a proxy's error page, a
 * dropped connection) is said through `[data-slot-message]` as text, never as markup.
 *
 * The buttons the script wires are named by data attributes, a closed set (`ACT_ATTRS`): `data-confirm` (send the
 * ticket), `data-cancel` and `data-close` (restore the skeleton and hide the slot), `data-again` (submit the same form
 * again: a new preview, a new ticket) and `data-reload` (reload the page); the countdown reads `data-expires`. They are
 * drawn here by hand with the kit's class names because the kit's button takes no data attribute, and the slot's own id
 * is one the kit refuses to write (`kit.mjs` `RESERVED_IDS`), since the script finds it by that id.
 *
 * It imports no worker module itself: the html builder, the kit and the page table, all console modules. The page
 * table is read inside the functions only, never at load, since `pages.mjs` reaches this module back through the shell.
 */
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";
import { PAGES } from "./pages.mjs";

/**
 * A count with the words that agree with it, "1 job" or "3 jobs", "1 job waits" or "3 jobs wait", never "job(s)"
 * (issue #737: the design's copy rules). ONE RULE for every count a bar, a banner or an action's sentence
 * says: the count and every word whose form follows it (the noun, and a verb after it) are one call, so a sentence
 * cannot pair "1" with "wait" or "0" with "window". `many` defaults to `one` with an "s", which serves a bare noun; a
 * phrase with a verb names both forms. The read model's `plural` is the same rule for nouns; the console's modules
 * import no read-model code, so they share this one (`actions.mjs` re-exports it).
 */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A sentence with its full stop: as it is when it already ends with one (or with ? or !), else with "." added. */
const stopped = (s) => `${s}${/[.!?]$/.test(s) ? "" : "."}`;

/** The slot's id: the one element the script moves under the section that asked. Embedded in the script as JSON. */
export const CONFIRM_SLOT_ID = "confirm-slot";

/**
 * What the slot says when a confirm got no answer at all (the connection dropped after the request left). A ticket is
 * single use, so the script never sends it again: the change may have been made, and the audit log is where to look.
 */
export const CONFIRM_NO_ANSWER = "The console did not answer, so the change may or may not have been made. Reload to see; the audit log says which.";

/**
 * What the slot says when a write's request was answered 401 (the session ended before the change was sent, so the
 * server refused it before any action ran): said in the slot first, as text, so it never stays on the previewing
 * skeleton while the script asks the console where the session went, which may take a while when a stream's own
 * question is already out. The sign-in page the answer leads to then says why. Embedded in the script as JSON.
 */
export const CONFIRM_SIGNED_OUT = "This session ended before the change was sent, so nothing was changed. The console is asked where it went.";

/**
 * Every class this module draws for the stylesheet beyond the kit's own (`btn`, `banner`, `tile`, `ic`, `tone-*`,
 * `chip`, `link`, `code`): the Actions card's `.confirm` with its paid and danger rings, the ConfirmStates card's busy,
 * no-change and results states (renamed from the card's demo `cs-` names), the held note and the diff's. Each has a
 * rule (`pulse-css.mjs`, or `page-css.mjs` `SHELL_CSS`; `console-stylesheet.test.mjs` holds that), and the script writes
 * none of them. The Undo form's `undo` is a hook, not a style, and is not listed. Derived, not trusted:
 * `console-confirm.test.mjs` renders every state and holds the classes it finds to this list, both ways.
 */
export const CONFIRM_CLASSES = Object.freeze(["cslot", "confirm", "confirm--paid", "confirm--danger", "confirm--busy", "confirm--none", "confirm__h", "confirm__list", "confirm__ghost", "confirm__note", "confirm__undo", "confirm__act", "confirm__results", "ticket", "held", "held__s", "diff", "diff__h", "diff__b", "d-ctx", "d-add", "d-del", "d-gap"]);

/**
 * The data attributes the script wires, a closed set: a button names one, and only one, of these. Each is its own
 * literal fragment, so an attribute name never comes from a caller's value.
 */
const ACT_ATTRS = Object.freeze({ "data-confirm": html` data-confirm`, "data-cancel": html` data-cancel`, "data-close": html` data-close`, "data-again": html` data-again`, "data-reload": html` data-reload` });

/**
 * A button the script wires: the kit's `btn` classes (each kind held to `BTN_KINDS`, as `ui.btn` holds them) and one
 * data attribute from `ACT_ATTRS`. Drawn by hand because `ui.btn` takes no data attribute; the class names are the kit's.
 */
function actBtn({ kind = [], attr, label, icon = null, disabled = false }) {
  const kinds = Array.isArray(kind) ? kind : [kind];
  for (const k of kinds) if (!ui.BTN_KINDS.includes(k)) throw new RangeError(`confirm-view: unknown button kind ${JSON.stringify(k)}`);
  if (!Object.hasOwn(ACT_ATTRS, attr)) throw new RangeError(`confirm-view: unknown control ${JSON.stringify(attr)}`);
  const cls = ["btn", ...kinds.map((k) => `btn--${k}`)].join(" ");
  return html`<button class="${cls}" type="button"${ACT_ATTRS[attr]}${disabled ? html` disabled` : null}>${icon === null ? null : ui.icon(icon, { size: "sm" })}${label}</button>`;
}

// ---- the slot -------------------------------------------------------------------------------------------------------

/**
 * The previewing skeleton, the slot's content until an answer arrives: the busy bar with an hourglass and a title the
 * script fills ("Previewing: <the button's words>"), two grey ghost lines, a hidden message line for an answer that
 * carries no `html`, a disabled Confirm (it waits for a ticket) and Cancel. The script reads this markup once, from
 * the slot as the server drew it, to restore it after Cancel or Close.
 *
 * THE MESSAGE STATE HAS AN ICON OF ITS OWN. When an answer carries no `html` (a proxy's page, no answer at all, a field
 * the form could not read), the script says so in this skeleton: it drops the busy mark (`aria-busy` and
 * `confirm--busy`), hides the ghost lines and shows the message line. The head therefore holds two icons, the
 * hourglass (`data-slot-icon="busy"`) and the attention mark (`data-slot-icon="said"`), and the stylesheet shows the one
 * the bar's busy class asks for (`page-css.mjs` `SHELL_CSS`), so a sentence saying nothing was previewed never sits
 * under an hourglass that says something still is. The script switches no icon: it only ever removed the busy class.
 */
function skeletonHtml() {
  return html`<div class="confirm confirm--busy" aria-busy="true"><p class="confirm__h"><span data-slot-icon="busy">${ui.icon("hourglass")}</span><span data-slot-icon="said">${ui.icon("attention")}</span><span data-slot-title>Previewing</span></p><ul class="confirm__list confirm__ghost"><li><span></span></li><li><span></span></li></ul><p class="confirm__note" data-slot-message hidden></p><div class="confirm__act">${actBtn({ kind: "confirm", attr: "data-confirm", label: "Confirm", disabled: true })}${actBtn({ kind: "ghost", attr: "data-cancel", label: "Cancel" })}</div></div>`;
}

/**
 * The one confirm slot of a page (`#confirm-slot`): a polite live region, hidden until a form asks for a preview,
 * holding the previewing skeleton (or `inner`, for a golden of another state). The shell draws it once, after the
 * page's content, for an operator on a console that is not read-only; a viewer never gets one.
 */
export function confirmSlotHtml({ open = false, inner = null } = {}) {
  return html`<div id="${CONFIRM_SLOT_ID}" class="cslot" role="region" aria-live="polite" aria-label="Preview"${open ? null : html` hidden`}>${inner ?? skeletonHtml()}</div>`;
}

// ---- the preview ----------------------------------------------------------------------------------------------------

/** Milliseconds as the countdown shows them, "M:SS" (300000 is "5:00"); anything not a finite count of 0 or more is 0:00. */
export function countdownText(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A preview: what will happen and the button that does it (the Actions card's bar).
 *   - `.confirm`, ringed `confirm--paid` for a paid act or `confirm--danger` for a destructive one (never both: the
 *     action table holds the two apart), with the spend, attention or done icon in its head and `title` beside it;
 *   - `lines`, the summary's other lines, one `<li>` each (a string, or a fragment for a line with markup: a change's
 *     values in bold), then `reserve` (the reserve sentence, `reserveText`), the `diff` (a fragment from `diffHtmlOf` or
 *     `textHtml`), and the Undo line (`undoLineHtml`);
 *   - Confirm in the act's fill with `confirmLabel` ("Retry for up to $2.00", "Pause the fleet"), Cancel, and the expiry.
 *
 * THE EXPIRY IS A DURATION. `data-expires` holds the milliseconds the ticket had left when the server drew the bar
 * (`expiresAt - now`), and the script counts down from that: a browser whose clock differs from the console host's
 * (a tunnel from a laptop) still counts the same five minutes. The script disables Confirm at 0:00; the server refuses
 * an expired ticket whatever the page says.
 */
export function previewBarHtml({ title, lines = [], reserve = null, diff = null, undo = null, undoable = true, confirmLabel = "Confirm", paid = false, danger = false, expiresAt = null, now = null }) {
  if (paid && danger) throw new RangeError("confirm-view: an act is paid or destructive, never both");
  const ring = paid ? "confirm confirm--paid" : danger ? "confirm confirm--danger" : "confirm";
  const fill = paid ? "confirm-paid" : danger ? "confirm-danger" : "confirm";
  const left = Number.isFinite(expiresAt) && Number.isFinite(now) ? Math.max(0, expiresAt - now) : null;
  return html`<div class="${ring}"><p class="confirm__h">${ui.icon(paid ? "spend" : danger ? "attention" : "done")}${title}</p>${lines.length > 0 ? html`<ul class="confirm__list">${lines.map((l) => html`<li>${l}</li>`)}</ul>` : null}${reserve ? html`<p class="confirm__note">${reserve}</p>` : null}${diff ?? null}${undo ? undoLineHtml(undo, undoable) : null}<div class="confirm__act">${actBtn({ kind: fill, attr: "data-confirm", label: confirmLabel })}${actBtn({ kind: "ghost", attr: "data-cancel", label: "Cancel" })}${left === null ? null : html`<span class="ticket">Preview expires in <b data-expires="${String(left)}">${countdownText(left)}</b></span>`}</div></div>`;
}

/**
 * The bar's Undo line (issue #737, the Actions and ConfirmStates cards): the icon, then ONE inline run, so the
 * sentence wraps as text beside it (`.confirm__undo` is a flex row; a bare text node and a `<b>` were two flex items,
 * and a long act broke into a column of its own at 375 px). An act a write can undo reads "Undo: <b>the act</b>", the act
 * alone in bold; one with no inverse reads "No undo: <sentence>", in the line's muted ink with nothing bold, since the
 * sentence is what to do by hand, not a button's act.
 */
function undoLineHtml(undo, undoable) {
  return html`<p class="confirm__undo">${ui.icon("rerun", { size: "sm" })}<span>${undoable ? html`Undo: <b>${undo}</b>` : html`No undo: ${undo}`}</span></p>`;
}

/**
 * The no-change bar: the change would write what is already there, so there is nothing to confirm, only Close. The
 * sentence says why (the summary, capitalised, with its full stop), or `sentenceHtml`, the action's own markup of the
 * same words (a setting's key as code: "The file already says this: maxTurns is 40.").
 */
export function unchangedBarHtml({ summary, sentenceHtml = null }) {
  const said = capitalised((Array.isArray(summary) ? summary.map(String).join(" ") : String(summary ?? "")).trim());
  return html`<div class="confirm confirm--none"><p class="confirm__h">${ui.icon("done")}No change</p><p class="confirm__note">${sentenceHtml ?? stopped(said)}</p><div class="confirm__act">${actBtn({ attr: "data-close", label: "Close" })}</div></div>`;
}

// ---- refusals -------------------------------------------------------------------------------------------------------

/**
 * Each refusal the slot can show, the ConfirmStates card's sections 4 and 5: its tone and icon, its title, and the one
 * next step it offers.
 *   - ticket: the confirmation expired, was used, or belongs to another sign-in or action (`confirm.mjs` `redeem`);
 *     Preview again submits the same form, which issues a new ticket.
 *   - changed: the write was refused at the confirm (the file or the job changed since the preview, a dedup window,
 *     a worker that did not acknowledge); Look again reloads, since the page is what changed.
 *   - valkey: Valkey could not be reached; Try again submits the same form.
 *   - audit: the audit log could not take its row, so nothing was written; nothing in the page fixes that, so Close,
 *     which puts the slot away and lets the panel it held take its live updates again (with no button the slot stayed
 *     open and its panel held until a reload).
 *   - failed: the write threw at the confirm; the console's log has the reason; Close, for the same reason.
 *   - refused: the preview refused the change (a field rule, a planner's sentence, a value the funnel's parser refuses);
 *     Close, and the form is still there to fix.
 *   - setup: the console cannot take the action as it runs: it was started without what the action needs (a
 *     preview's 503, `actions.mjs`), or its tokens file cannot be used right now, so no session can be judged (a
 *     write's 503, preview or confirm, `server.mjs` `tokensUnusableBar`, which says to run `pi-dispatch doctor`);
 *     nothing in the page fixes either, so Close.
 *   - preview-failed: the preview threw; Close.
 *   - partial: the write stopped after doing part of its work (the kill switch reached some queues and not others, a
 *     bulk apply threw part-way through its jobs). It is the one state that never says "Nothing was changed"
 *     (`mayHaveChanged`): it says some of it may have been done instead (`PARTIAL_NOTE`), and Look again reloads, so the
 *     person sees what did change before trying again.
 *
 * Every state but `partial` is a refusal that came before anything was written (the ticket store's, the audit log's, a
 * funnel's re-check of the file or the job, a Valkey that never answered), so the bar may add "Nothing was changed."
 * The action decides which it is (an apply's `partial: true`, the bulk pipeline's catch), never a reading of the text.
 */
export const REFUSAL_STATES = Object.freeze({
  ticket: Object.freeze({ status: "attention", icon: "clock", title: "This confirmation cannot be used", act: Object.freeze({ attr: "data-again", label: "Preview again", kind: ["sm", "primary"] }) }),
  changed: Object.freeze({ status: "attention", icon: "attention", title: "The change did not go through", act: Object.freeze({ attr: "data-reload", label: "Look again", kind: ["sm"] }) }),
  valkey: Object.freeze({ status: "failed", icon: "failed", title: "The deployment's Valkey could not be reached", act: Object.freeze({ attr: "data-again", label: "Try again", kind: ["sm"] }) }),
  audit: Object.freeze({ status: "failed", icon: "audit", title: "The audit log could not be written", act: Object.freeze({ attr: "data-close", label: "Close", kind: ["sm"] }) }),
  failed: Object.freeze({ status: "failed", icon: "failed", title: "The change could not be made", act: Object.freeze({ attr: "data-close", label: "Close", kind: ["sm"] }) }),
  refused: Object.freeze({ status: "refused", icon: "refused", title: "The change was refused", act: Object.freeze({ attr: "data-close", label: "Close", kind: ["sm"] }) }),
  setup: Object.freeze({ status: "refused", icon: "config", title: "This console cannot take this action", act: Object.freeze({ attr: "data-close", label: "Close", kind: ["sm"] }) }),
  "preview-failed": Object.freeze({ status: "refused", icon: "refused", title: "The preview failed", act: Object.freeze({ attr: "data-close", label: "Close", kind: ["sm"] }) }),
  partial: Object.freeze({ status: "attention", icon: "attention", title: "The change did not finish", mayHaveChanged: true, act: Object.freeze({ attr: "data-reload", label: "Look again", kind: ["sm"] }) }),
});

/** What a `partial` refusal says after its sentence, where every other refusal says "Nothing was changed." */
export const PARTIAL_NOTE = "Some of it may have been done, so this page may be out of date.";

/**
 * The words a sentence uses to say that nothing changed. A planner's sentence is sent as it is (the `error` a tool and
 * the console share, byte for byte), and many already say so in their own words ("nothing was written", "Nothing was
 * sent", "nothing to cancel"); the slot adds "Nothing was changed." only to one that says none of them.
 */
const SAYS_NOTHING_CHANGED = /\bnothing (?:was|is) (?:changed|done|applied|reverted|queued|sent|written)\b|\bnothing to (?:do|cancel)\b/i;

/** The ticket store's instruction, which every `redeem` refusal ends with (`confirm.mjs` `PREVIEW_AGAIN`'s opening). */
const TICKET_TAIL = /Preview the change again and confirm the new preview$/;

/** A sentence's first letter in capitals: the planners write theirs in lower case, as the tools' errors read. */
function capitalised(s) {
  const t = String(s ?? "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The refusal's state when the caller names none, by where it happened and its status: at the confirm a 409 is a ticket
 * refusal when the sentence ends with the ticket store's instruction, else a write the funnel refused; 503 is Valkey; a
 * 500 is the audit log or a write that threw. At the preview a 503 is Valkey (a read the preview needed), a 500 the
 * preview itself, anything else the change refused.
 */
function refusalStateOf(where, status, sentence) {
  if (where === "confirm") {
    if (status === 409) return TICKET_TAIL.test(sentence) ? "ticket" : "changed";
    if (status === 503) return "valkey";
    if (status === 500) return /\baudit log\b/.test(sentence) ? "audit" : "failed";
    return "changed";
  }
  if (status === 503) return "valkey";
  if (status === 500) return "preview-failed";
  return "refused";
}

/**
 * A refusal in the slot (`where` "preview" or "confirm"): a small banner in the state's tone (`REFUSAL_STATES`, named by
 * `state` or derived from `where` and `status`), its title, the sentence (capitalised, ending with a full stop), what it
 * left unchanged, and the state's next step. Every state but `partial` adds "Nothing was changed." when the sentence does
 * not already say so; `partial` adds `PARTIAL_NOTE` and never that. `sentenceHtml` is the caller's markup of the same
 * sentence (a field or an action named as code), a whole sentence with its full stop, drawn in place of the text. The
 * `error` the JSON answer carries stays the sentence exactly as it was; only this markup adds to it.
 */
export function refusalHtml({ where, sentence, status, state = null, sentenceHtml = null }) {
  const name = state ?? refusalStateOf(where, status, String(sentence ?? ""));
  if (!Object.hasOwn(REFUSAL_STATES, name)) throw new RangeError(`confirm-view: unknown refusal state ${JSON.stringify(name)}`);
  const s = REFUSAL_STATES[name];
  const text = capitalised(String(sentence ?? "").trim());
  const tail = s.mayHaveChanged ? ` ${PARTIAL_NOTE}` : SAYS_NOTHING_CHANGED.test(text) ? "" : " Nothing was changed.";
  const body = sentenceHtml === null ? `${stopped(text)}${tail}` : html`${sentenceHtml}${tail}`;
  return ui.banner({ status: s.status, icon: s.icon, sm: true, title: s.title, body, actions: s.act ? actBtn({ kind: s.act.kind, attr: s.act.attr, label: s.act.label }) : null });
}

// ---- after the confirm ----------------------------------------------------------------------------------------------

/** The audit page's link to row `seq` (`/audit?seq=N#seq-N`), or null for anything that is not a row's seq. */
function auditHref(seq) {
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  const path = ui.pageHref(PAGES, "audit", { seq });
  return path === null ? null : `${path}#seq-${seq}`;
}

/**
 * "Audit row 44" or "3 audit rows, from row 41", linked to the first, or "The audit log holds its row" when no row's seq
 * is known. `rows` is how many rows the confirm itself appended (one per job of a bulk act, all `ok` rows written before
 * any job is touched). Never a range "rows 41 to 43" (issue #737): the audit writer takes its lock per row, so
 * another session's row can land between a bulk confirm's own, and a range from the first to the last of them would
 * name it as this write's.
 */
function auditRowsHtml(first, rows) {
  const href = auditHref(first);
  if (href === null) return html`The audit log holds its row`;
  return html`<a class="link" href="${href}">${Number.isSafeInteger(rows) && rows > 1 ? `${rows} audit rows, from row ${first}` : `Audit row ${first}`}</a>`;
}

/** What each bulk kind did to a job, for the results banner's title ("2 of 3 retried"). */
const BULK_DONE_WORD = Object.freeze({ "failed-retry-all": "retried", "failed-remove-all": "removed", "held-cancel-all": "cancelled" });

/**
 * A bulk confirm's results (the ConfirmStates card's section 3): "2 of 3 retried" in the attention tone when any job
 * was refused (else ok), one line per job ("done", "not done, <its reason>", or "did not finish, <its reason>" for a
 * job whose answer is `partial`, part of whose change may have been made: issue #737) with the done or failed icon, the
 * audit rows the confirm wrote (its `count` `ok` rows, from `auditSeq`, never as a range: `auditRowsHtml`), and Reload
 * as the one step forward, since the page's lists are what moved.
 */
export function bulkResultsHtml({ kind, results = [], count, done, auditSeq = null }) {
  const rows = Array.isArray(results) ? results : [];
  const status = rows.some((r) => !r?.ok) ? "attention" : "ok";
  const word = BULK_DONE_WORD[kind] ?? "done";
  const said = (r) => (r?.ok ? "done" : html`${r?.partial === true ? "did not finish" : "not done"}, ${String(r?.reason ?? "refused")}`);
  const list = html`<ul class="confirm__results">${rows.map((r) => html`<li>${ui.icon(r?.ok ? "done" : "failed", { size: "sm" })}<span><span class="code">${String(r?.jobId ?? "-")}</span>: ${said(r)}</span></li>`)}</ul>`;
  // `ui.banner`'s markup with a list between its title and its sentence (the ConfirmStates card's section 3): the kit's
  // banner puts its body in a `<p>`, which cannot hold a list (a parser closes the paragraph at the `<ul>`), so this
  // one banner is drawn here, in the kit's classes, its tone and icon from the kit's `STATUS`.
  const s = ui.STATUS[status];
  return html`<div class="banner tone-${s.tone}" role="status"><span class="tile">${ui.icon(s.icon)}</span><div><p class="banner__t">${done} of ${count} ${word}</p>${list}<p class="banner__s">${auditRowsHtml(auditSeq, count)}.</p></div><div class="banner__act">${actBtn({ kind: ["sm", "primary"], attr: "data-reload", label: "Reload" })}</div></div>`;
}

/**
 * One hidden input of the Undo form, typed so the script's `bodyOf` reads back exactly the value the inverse names: a
 * string as text; a whole number `data-type="int"`; anything else (an object, a list, a boolean, null) as JSON, and so
 * is an EMPTY string, which `bodyOf` would otherwise skip as an unfilled field (a project edit's `name: ""` is what
 * removes a name, so it must arrive as `""`, not be dropped).
 */
function hiddenInput(name, value) {
  if (typeof value === "string" && value !== "") return html`<input type="hidden" name="${name}" value="${value}">`;
  if (Number.isSafeInteger(value)) return html`<input type="hidden" name="${name}" value="${String(value)}" data-type="int">`;
  return html`<input type="hidden" name="${name}" value="${JSON.stringify(value ?? null)}" data-type="json">`;
}

/**
 * The banner a page shows once, after a write landed (the session's flash, `sessions.mjs` `takeFlash`): what happened
 * (`summary`, the past-tense sentence of the action's `done`), who did it, its audit rows linked, and the Undo. When the
 * change has an inverse, it reads "<b>Undo:</b> <the act>" and Undo is a form for that action with the inverse's body in
 * hidden inputs, so pressing it PREVIEWS the inverse like any other write (a new ticket, the diff, a confirm): an Undo
 * never writes without being shown first. With none it reads "No undo: <what to do by hand>", nothing bold. With no
 * audit seq known (an audit writer that returned no row) it says the log holds the row, with no link.
 *
 * THE TONE. A bulk act where fewer of its jobs landed (`done`) than it listed (`count`) is in the attention tone and its
 * title says how many; every other banner is ok. (A bulk act where none landed leaves no banner at all.)
 */
export function doneBannerHtml(change) {
  const c = change ?? {};
  const inverse = c.inverse && typeof c.inverse === "object" && typeof c.inverse.action === "string" && /^[a-z0-9-]{1,40}$/.test(c.inverse.action) ? c.inverse : null;
  // The Undo is the banner's last sentence, so it ends with its full stop as the CardsAndBanners card's does ("<b>Undo:</b>
  // set maxTurns back to 30."); an act's words ("Resume the fleet") are a sentence here, where the bar's are a button's.
  const undo = c.undo ? (inverse ? html` <b>Undo:</b> ${stopped(String(c.undo))}` : html` No undo: ${stopped(String(c.undo))}`) : null;
  const body = html`Changed by ${String(c.by ?? "an operator")}. ${auditRowsHtml(c.auditSeq, c.count)}.${undo}`;
  const form = inverse
    ? html`<form data-action="${inverse.action}" class="undo" autocomplete="off">${Object.entries(inverse.body ?? {}).map(([k, v]) => hiddenInput(k, v))}<button class="btn btn--sm btn--ghost" type="submit">Undo</button></form>`
    : null;
  const partial = Number.isSafeInteger(c.done) && Number.isSafeInteger(c.count) && c.done < c.count;
  return ui.banner({ status: partial ? "attention" : "ok", title: String(c.summary ?? "Changed"), body, actions: form });
}

/**
 * The note a panel the script keeps still carries (a form in it is being edited, or its preview is open), cloned from
 * the shell's `<template id="held-note">` as the panel's first child: the swap is waiting, and when it lands.
 */
export function heldNoteHtml() {
  // A space between the chip and the sentence, so a screen reader announcing the status reads two phrases, not one word.
  return html`<div class="held" role="status">${ui.chip("Updates paused while you edit", { icon: "pause" })} <span class="held__s">Newer data is waiting. It shows when you close the preview or leave the field.</span></div>`;
}

// ---- the diff -------------------------------------------------------------------------------------------------------

/** A JSON value with every `secrets` map's values replaced by a marker: the diff shows that one changed, not what. */
function redacted(value, keyName = null) {
  if (Array.isArray(value)) return value.map((v) => redacted(v));
  if (value === null || typeof value !== "object") return value;
  if (keyName === "secrets") return Object.fromEntries(Object.keys(value).map((k) => [k, "(a secret reference, not shown)"]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v, k)]));
}

/** A file's text as the diff shows it: parsed, redacted and re-indented when it is JSON, else its lines as they are. */
function displayLines(text) {
  if (text === null || text === undefined) return [];
  try {
    return JSON.stringify(redacted(JSON.parse(text)), null, 2).split("\n");
  } catch {
    return String(text).replace(/\n$/, "").split("\n");
  }
}

/**
 * The largest diff table the preview computes (changed lines before times changed lines after, once the common prefix
 * and suffix are cut); past it, the changed middle is shown as removed then added.
 */
const DIFF_CELLS_MAX = 4_000_000;
/** Unchanged lines kept around each change. */
const DIFF_CONTEXT = 2;
/** The most diff lines a preview renders; past it, the count of the lines left out. */
export const DIFF_LINES_MAX = 2000;

/**
 * A line diff of `a` to `b`: `[{ t: " " | "-" | "+" | "gap", line }]`, unchanged runs cut to `DIFF_CONTEXT` lines.
 *
 * The common prefix and suffix are cut FIRST (linear, and the usual edit touches one entry of a long file), so only the
 * changed middle meets the quadratic table: a one-entry change to a 150-trigger file is a small table and a small
 * preview, where diffing the whole file passed `DIFF_CELLS_MAX` and showed both files whole (159 KB).
 */
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const same = (line) => ({ t: " ", line });
  const ops = [...a.slice(0, pre).map(same), ...middleDiff(midA, midB), ...a.slice(a.length - suf).map(same)];
  const changed = ops.map((op) => op.t !== " ");
  const out = [];
  let last = -Infinity;
  // The index of the next change at or after k, so "near a change" is one look each way rather than a slice per line.
  const nextChange = new Array(ops.length + 1).fill(Infinity);
  for (let k = ops.length - 1; k >= 0; k -= 1) nextChange[k] = changed[k] ? k : nextChange[k + 1];
  for (let k = 0; k < ops.length; k += 1) {
    if (changed[k]) last = k;
    if (changed[k] || k - last <= DIFF_CONTEXT || nextChange[k] - k <= DIFF_CONTEXT) out.push(ops[k]);
    else if (out.at(-1)?.t !== "gap") out.push({ t: "gap", line: "" });
  }
  return out;
}

/** The diff of the changed middle: a longest common subsequence, or removed then added past `DIFF_CELLS_MAX`. */
function middleDiff(a, b) {
  if (a.length * b.length > DIFF_CELLS_MAX) return [...a.map((line) => ({ t: "-", line })), ...b.map((line) => ({ t: "+", line }))];
  // Longest common subsequence, from the end, so the walk below reads forward.
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) {
      // A removal before an addition, so a changed line reads as the old one then the new one.
      ops.push({ t: "-", line: a[i] });
      i += 1;
    } else {
      ops.push({ t: "+", line: b[j] });
      j += 1;
    }
  }
  return ops;
}

/** The ellipsis a cut run shows, written as an escape (the console's rule for any character a reader may not see typed). */
const GAP = "\u2026";

/** The class each diff op draws in: the stylesheet puts the `-` and `+` before a removed and an added line. */
const OP_CLASS = Object.freeze({ " ": "d-ctx", "-": "d-del", "+": "d-add", gap: "d-gap" });

/** A file's name as the diff head shows it: the last part of its path only, never the directory (a host's path). */
function fileName(file) {
  const parts = String(file).split(/[\\/]/).filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * The diff of two file texts as escaped HTML (the FieldsDiffCommand card's diff): `div.diff`, a head with the config
 * icon and the file's name when `file` is given (its basename alone: a deployment's directory is a path of this host,
 * which no page names), then `div.diff__b` with one `span` per line, `d-ctx`, `d-del`, `d-add` or `d-gap`, at most
 * `DIFF_LINES_MAX` of them and then one saying how many more. Every line escaped by `html`, every `secrets` value
 * replaced by a marker.
 */
export function diffHtmlOf(beforeText, afterText, { file = null } = {}) {
  const ops = lineDiff(displayLines(beforeText), displayLines(afterText));
  const shown = ops.slice(0, DIFF_LINES_MAX);
  const more = ops.length - shown.length;
  const name = file === null || file === undefined ? null : fileName(file);
  return html`<div class="diff">${name === null ? null : html`<div class="diff__h">${ui.icon("config", { size: "sm" })}${name}</div>`}<div class="diff__b">${shown.map((o) => html`<span class="${OP_CLASS[o.t]}">${o.t === "gap" ? GAP : o.line}</span>`)}${more > 0 ? html`<span class="d-gap">${GAP} and ${plural(more, "more diff line")}, not shown</span>` : null}</div></div>`;
}

/** A text shown as it is, one context line per line (the answer to a parked run, a steer's message, as it will be sent). */
export function textHtml(text) {
  return html`<div class="diff"><div class="diff__b">${String(text).split("\n").map((line) => html`<span class="d-ctx">${line}</span>`)}</div></div>`;
}
