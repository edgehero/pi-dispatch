/**
 * The audit screen's panels (issue #737, the AuditScreen card), split out of `../panels.mjs` (issue #737), which
 * re-exports what this module exports. The rules every panel keeps (one pure, deterministic renderer per region, every
 * value through `html`, the role and run-text rule) are stated once, in `../panels.mjs`'s header.
 *
 * Four panels, in page order: the chain's state first (`p-audit-chain`, a banner that says how far the hash chain is
 * verified and, when a row is damaged, what to do), the filters (`p-audit-filter`, a plain GET form), the log itself
 * (`p-audit`), and what the log is (`p-audit-about`). Each reads `view.data.audit`, the view `audit-view.mjs`
 * `readAuditView` builds, and `view.query`, its `parseAuditQuery` result. Drawn in the Pulse kit's markup: the screen
 * left the legacy layer with this module.
 *
 * THE ROLE RULE. The audit log is an operator's page (the route refuses a viewer, and `renderPage`'s belt draws no
 * panel for one); each panel draws nothing for another role all the same, the log's panel the role's sentence, so a
 * view a caller mis-wires still carries no row.
 *
 * WHAT A ROW SAYS ABOUT ITSELF IS SHOWN AS ITS STATE ALLOWS. A verified row shows the outcome it was written with; a
 * damaged one, one after it, the one before a broken link and one written since the last check show their state in the
 * outcome column (the outcome as written moves to a note under the reason), since the chain does not vouch for what
 * such a row says.
 */
import { CONSOLE_AUDIT_ACTIONS, CONSOLE_AUDIT_OUTCOMES } from "@edgehero/pi-dispatch/console-audit";
import { AUDIT_ACTOR_ROLES, AUDIT_EXAMINE_MAX, AUDIT_OUTCOME_WORDS, AUDIT_Q_MAX, auditFiltered, auditQueryString, isAuditRow } from "../audit-view.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { msOf, timeHtml, usdText } from "./common.mjs";

/** What a role that is not an operator reads in the log's panel (the belt; see the header). */
export const AUDIT_OPERATORS_ONLY = "The audit log is shown to operators only.";

/**
 * The command that walks the same chain on the host, named wherever the page cannot vouch for a row: in the code face,
 * each word a box of its own (`page-css.mjs` AUDIT_CSS), so a sentence wraps it only between its words.
 */
const VERIFY_CMD = html`<span class="code">${"pi-dispatch-console audit verify".split(" ").map((w, i) => html`${i === 0 ? null : " "}<span>${w}</span>`)}</span>`;

const GROUPED = new Intl.NumberFormat("en-US");

/** The audit page's path with a query (`auditQueryString`'s form), or the bare path for none. */
function auditHref(query, over = {}) {
  const s = auditQueryString(query, over);
  return s === "" ? "/audit" : `/audit?${s}`;
}

/** A place, `YYYY-MM:<line>`, as `[month, line]`, or null. */
function placeOf(pos) {
  const m = typeof pos === "string" ? /^(\d{4}-\d{2}):(\d{1,16})$/.exec(pos) : null;
  return m === null ? null : [m[1], Number(m[2])];
}

/**
 * The id of the table row at `pos`: `seq-<n>` for a row whose seq this page has not used yet, so a link to a row by its
 * number lands on it (`/audit?seq=41#seq-41`, the done banner's), and `line-<yyyy>-<mm>-<line>` for a damaged entry, a
 * row at the broken place and a repeated seq, so every id is once on the page whatever a tampered file holds, and a
 * damaged place's id is known from the verifier's place alone (the chain banner's Show link).
 */
function rowId(entry, pos, state, used) {
  if (isAuditRow(entry) && state !== "damaged" && !used.has(entry.seq)) {
    used.add(entry.seq);
    return `seq-${entry.seq}`;
  }
  const at = placeOf(pos);
  return at === null ? null : `line-${at[0]}-${at[1]}`;
}

/** The outcome column's badge for a row in `state` (see the header and `AUDIT_OUTCOME_WORDS`). */
function outcomeCell(entry, state) {
  const key = state === "ok" ? entry.outcome : state;
  const w = typeof key === "string" && Object.hasOwn(AUDIT_OUTCOME_WORDS, key) ? AUDIT_OUTCOME_WORDS[key] : { status: "attention", icon: null, word: String(entry.outcome ?? "unknown") };
  return ui.badge(w.status, w.word, { icon: w.icon });
}

/**
 * A missing value, drawn faint; on a damaged row's tint, muted instead: `ink-faint` is a hint colour held to 4.5:1 on the
 * surfaces only and reads 4.34:1 on `failed-tint` in the light theme, while `ink-muted` is a pinned pair on that tint
 * (`console-contrast.test.mjs`).
 */
const NONE = html`<span class="faint">-</span>`;
const NONE_ON_TINT = html`<span class="muted">-</span>`;

/**
 * The damaged place, as the page names it everywhere (the banner's title and sentence, About): the line the chain check
 * names, "line 8 of 2026-10.jsonl", the one `audit verify` prints. Never "row 8": the number a damaged line carries is
 * what the chain does not vouch for (a line that is no row carries none), and the first version, which said "row 8"
 * only when this page had read that line, named one place two ways, by its row on the page that held it and by its
 * line on every other.
 */
function damagedLabel(a) {
  const b = a?.chain?.broken;
  return b ? `line ${b.line} of ${b.file}` : null;
}

/** A sentence's first letter in capitals ("row 7" leads one as "Row 7"). */
const lead = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The note under a row's reason for a state the chain does not vouch for, with the outcome it was written with. */
function stateNote(entry, state, chain) {
  const written = typeof entry.outcome === "string" ? ` Written as ${entry.outcome}.` : "";
  if (state === "unverified") return html`<span class="reason">Not verified: it follows the damaged row.${written}</span>`;
  // The row before a break whose line shows no prev that matches it: nothing vouches for it (audit-view.mjs header).
  if (state === "suspect") return html`<span class="reason">Not verified: the link to the row after it does not hold.${written}</span>`;
  if (state === "unchecked") {
    const why = chain?.state === "unreadable" ? "Not checked: the chain could not be checked." : "Written after the last check; the next one covers it.";
    return html`<span class="reason">${why}${written}</span>`;
  }
  return null;
}

/**
 * The reason column's cell: never narrower than `AUDIT_LAYOUT.reasonMin` (`page-css.mjs`), whatever the cells beside it
 * hold, so a damaged row's sentence reads as a few lines and not as a column of single words (16
 * lines at 1440 px without it).
 */
const reasonCell = (inner) => ({ wide: true, html: html`<span class="au-why">${inner}</span>` });

/**
 * What a row's `count` counts depends on its write kind: a bulk write's row is one of `count` rows, one per job the
 * write listed; a resume's is the jobs that were waiting to start when it was confirmed (`actions.mjs`
 * `resumeWaiting`). Read as bulk membership, a single resume read "one of 2 in a bulk write". `AUDIT_BULK_KINDS` is the
 * kinds of the actions with `bulk: true` and `AUDIT_WAITING_KINDS` the resumes', both held to the action table by the
 * test; a count on any other kind is said as it is stored.
 */
export const AUDIT_BULK_KINDS = Object.freeze(["held-cancel-all", "failed-retry-all", "failed-remove-all"]);
export const AUDIT_WAITING_KINDS = Object.freeze(["fleet-resume", "queue-resume"]);

/** A row's `count` in words, `alone` when no reason comes before it (see `AUDIT_BULK_KINDS`). */
function countText(kind, n, alone) {
  if (AUDIT_BULK_KINDS.includes(kind)) return alone ? `one of ${n} in a bulk write` : `one of ${n}`;
  if (AUDIT_WAITING_KINDS.includes(kind)) return `${n} ${n === 1 ? "job was" : "jobs were"} waiting`;
  return `count ${n}`;
}

/** One table row of the log (`kit.tbl`'s `{ cells, mark, id }`). */
function rowOf({ entry, pos, state }, chain, used) {
  const id = rowId(entry, pos, state, used);
  if (!isAuditRow(entry)) {
    const file = typeof entry?.file === "string" ? entry.file : "an audit file";
    const line = Number.isSafeInteger(entry?.line) ? entry.line : 0;
    const reason = typeof entry?.reason === "string" && entry.reason !== "" ? entry.reason : null;
    const what = line > 0
      ? html`<b>Not an audit row: line ${line} of ${file}.</b> Changed, or written by something else.`
      : html`<b>Not an audit row: the file ${file} could not be read${reason ? ` (${reason})` : ""}.</b> Its rows are not shown.`;
    const at = line > 0 ? html`<span class="code au-tgt">${file}:${line}</span>` : html`<span class="code au-tgt">${file}</span>`;
    return { id, mark: "failed", cells: [NONE_ON_TINT, NONE_ON_TINT, NONE_ON_TINT, NONE_ON_TINT, { wide: true, html: at }, outcomeCell(entry, "damaged"), reasonCell(html`<span class="au-dmg">${what}</span>`)] };
  }
  const none = state === "damaged" ? NONE_ON_TINT : NONE;
  const actor = entry.actor && typeof entry.actor === "object" ? entry.actor : null;
  const who = actor ? html`<span class="au-who">${actor.name ?? "-"}<small>${actor.role ?? "-"}</small></span>` : none;
  // The cells beside the reason are bounded (`page-css.mjs` `AUDIT_LAYOUT`): a long name, write kind or target wraps
  // inside its own width instead of taking the reason's.
  const action = html`<span class="code">${entry.action ?? "-"}</span>${typeof entry.kind === "string" ? html`<span class="reason au-kind">${entry.kind}</span>` : null}`;
  const target = typeof entry.target === "string" && entry.target !== "" ? html`<span class="code au-tgt">${entry.target}</span>` : none;
  const said = [typeof entry.reason === "string" && entry.reason !== "" ? entry.reason : null, Number.isSafeInteger(entry.reserve) ? `reserve ${usdText(entry.reserve)}` : null].filter(Boolean).join(", ");
  // The count after the reason in brackets, or alone as its own words (a bracket with nothing before it read as a stray
  // aside).
  const count = Number.isSafeInteger(entry.count) ? (said === "" ? countText(entry.kind, entry.count, true) : ` (${countText(entry.kind, entry.count, false)})`) : "";
  // The faint dash stands for a cell with nothing in it: a row whose state note fills the cell has no dash before it.
  const note = stateNote(entry, state, chain);
  const reasonText = said === "" && count === "" ? (note === null ? none : null) : html`${said}${count}`;
  const reason = state === "damaged"
    ? html`<span class="au-dmg"><b>The chain check says:</b> ${chain?.broken?.reason ?? "this row's link to the one before it does not hold"}.</span>`
    : html`${reasonText}${note}`;
  return {
    id,
    mark: state === "damaged" ? "failed" : null,
    cells: [html`<b>${entry.seq}</b>`, { when: true, html: html`<span class="au-at">${timeHtml(msOf(entry.at))}</span>` }, who, action, { wide: true, html: target }, outcomeCell(entry, state), reasonCell(reason)],
  };
}

/** `k` rows, grouped ("2,000 rows", "1 row"). */
const rowsText = (k) => `${GROUPED.format(k)} ${k === 1 ? "row" : "rows"}`;

/**
 * Why a seq page read the log from its newest row rather than at the place the chain check counted for its row: one
 * clause for each way the check could not place it (`view.seek.by`, audit-view.mjs; an unplaced row's by the chain's
 * state, since that is what left it uncounted), or null when the row was read at its place. The same clause says how a
 * row was found and why one was not, so the page never reports a walk without its reason.
 */
function walkWhy(a, s) {
  const by = a.seek?.by;
  if (by === "newer") return Number.isSafeInteger(a.chain?.through) ? `the last chain check counted rows up to row ${a.chain.through}` : `the last chain check did not count row ${s}`;
  if (by === "misplaced") return `row ${s} is not where the chain check counted it (the files changed since it ran)`;
  if (by !== "unplaced") return null;
  if (a.chain?.state === "broken") return `the chain check stops at the damaged row, so it cannot count to row ${s}`;
  if (a.chain?.state === "unreadable") return `the chain could not be checked, so row ${s} cannot be found by its number`;
  return `the chain check gave no place for row ${s}`;
}

/**
 * What a seq page says about its row (`view.seek`, audit-view.mjs): found, and how when it took a walk; not written yet;
 * reaped; or, after a walk, why the walk ran and where it got to. Said once: in the foot over rows, in the empty state
 * over none.
 */
function seqSentence(a, s) {
  const k = a.seek ?? {};
  const why = walkWhy(a, s);
  if (a.found) return why === null ? `The page that holds row ${s}.` : `The page that holds row ${s}, found by reading from the newest row: ${why}.`;
  if (Number.isSafeInteger(k.newest) && s > k.newest) return `Row ${s} does not exist yet: the newest row is ${k.newest}.`;
  if (Number.isSafeInteger(k.first) && s < k.first) return `The log starts at row ${k.first}: row ${s} was reaped by retention, or removed.`;
  const said = why === null ? "" : `${lead(why)}. `;
  if (a.stopped) return `${said}Row ${s} is not among the newest ${rowsText(a.examined)}; Older lists the rows below them.`;
  // A walk run because the files changed since the check stops at the first row below the chunk, and a changed file can
  // hold that row out of its order, so such a walk cannot say the row is gone.
  return k.by === "misplaced" ? `${said}Reading from the newest row did not find it either.` : `${said}The log holds no row ${s} now.`;
}

/**
 * The table's foot line over rows: what the page shows, and where a search or a seq stopped. A filtered page counts its
 * matches apart from the damaged entries it shows whatever the filters say (audit-view.mjs header).
 */
function footText(a, query) {
  if (Number.isSafeInteger(query?.seq)) return seqSentence(a, query.seq);
  if (auditFiltered(query)) {
    const damaged = a.rows.filter((r) => r.state === "damaged").length;
    const n = a.rows.length - damaged;
    const from = query.before ? " from here" : "";
    const found = `${n === 0 ? "No row matches" : `${rowsText(n)} ${n === 1 ? "matches" : "match"}`} among the ${rowsText(a.examined)} searched${from}.`;
    const shown = damaged === 0 ? "" : damaged === 1 ? " The damaged one is shown whatever the filters say." : ` The ${damaged} damaged ones are shown whatever the filters say.`;
    return `${found}${shown}${a.stopped ? ` The search stops at ${GROUPED.format(AUDIT_EXAMINE_MAX)} rows; Older searches on from there.` : ""}`;
  }
  const n = a.rows.length;
  const seqs = a.rows.map((r) => r.entry).filter(isAuditRow).map((e) => e.seq);
  return seqs.length > 1 ? `Showing ${rowsText(n)}, row ${seqs[0]} down to row ${seqs[seqs.length - 1]}` : `Showing ${rowsText(n)}`;
}

/**
 * The log's empty state: none written, none matching, a seq page without its row, or a page past the end. It carries
 * the page's one sentence (the foot then has none), and it never says nothing older exists while Older leads somewhere.
 */
function emptyOf(a, query) {
  if (auditFiltered(query)) {
    const body = a.stopped
      ? `None of the ${rowsText(a.examined)} searched ${query.before ? "from here" : "from the newest"} matches; Older searches on from there.`
      : query.before ? "No row from here to the oldest matches these filters." : "No row in the log matches these filters.";
    return ui.empty({ status: "idle", icon: "search", title: "No row matches", body });
  }
  if (Number.isSafeInteger(query?.seq)) {
    const s = query.seq;
    const k = a.seek ?? {};
    const title = Number.isSafeInteger(k.newest) && s > k.newest ? `No row ${s} yet` : Number.isSafeInteger(k.first) && s < k.first ? `No row ${s} now` : a.stopped ? `Row ${s} was not reached` : k.by === "misplaced" ? `Row ${s} was not found` : `No row ${s}`;
    return ui.empty({ status: "idle", icon: "audit", title, body: seqSentence(a, s) });
  }
  // A plain page below a cursor with no rows read none there, so there is no Older (`next` is null) and the sentence holds.
  if (query?.before) return ui.empty({ status: "idle", icon: "audit", title: "No rows here", body: "Nothing older is in the log. Newest goes back to the top." });
  return ui.empty({ status: "idle", icon: "audit", title: "The audit log is empty", body: "Every write, sign-in and refusal the console makes is written here." });
}

/**
 * Newest and Older, as the kit's pager draws them (Newest quiet, Older the plain button) while each leads somewhere; a
 * control that leads nowhere is drawn quiet whichever it is, so two disabled controls look alike rather than one of them
 * looking like the live one.
 */
function auditPager(newer, older) {
  const one = (label, href, kind) => ui.btn({ kind: href === null ? ["sm", "ghost"] : kind, label, href: href ?? "", disabled: href === null });
  return html`<span class="pager">${one("Newest", newer, ["sm", "ghost"])}${one("Older", older, "sm")}</span>`;
}

/**
 * The log: newest first, 50 a page, each row by its place in the chain (see the header), a damaged row tinted with the
 * check's sentence beside it, and the pager (Newest goes back to the top with the same filters, Older continues below
 * the page or where a search stopped).
 */
export function auditLog(view) {
  if (view.role !== "operator") return html`<p class="muted">${AUDIT_OPERATORS_ONLY}</p>`;
  const a = view.data?.audit;
  const q = view.query ?? {};
  const head = { title: "Audit log", sub: "newest first; every write, sign-in and refusal", flush: true };
  if (!a || typeof a.unreadable === "string") {
    const body = a ? `${lead(a.unreadable)}. The next load tries again.` : "The console's log has the reason. The next load tries again.";
    return ui.card({ ...head, body: html`<div class="au-empty">${ui.empty({ status: "attention", icon: "audit", title: "The audit log could not be read", body })}</div>` });
  }
  const used = new Set();
  const rows = a.rows.map((r) => rowOf(r, a.chain, used));
  const table = rows.length === 0
    ? html`<div class="au-empty">${emptyOf(a, q)}</div>`
    : ui.tbl({ caption: "Audit log", heads: [{ label: "Seq", num: true }, "At", "Who", "Action", "Target", "Outcome", "Reason"], rows, stack: true });
  const paged = (typeof q.before === "string" && q.before !== "") || Number.isSafeInteger(q.seq);
  const pager = auditPager(paged ? auditHref(q, { before: null, seq: null }) : null, typeof a.next === "string" ? auditHref(q, { before: a.next, seq: null }) : null);
  return ui.card({ ...head, body: html`${table}${ui.tblFoot(rows.length === 0 ? "" : footText(a, q), pager)}` });
}

/**
 * The chain's state, first on the page (the AuditScreen card): how far the chain is verified, and when a row is damaged
 * what that means, what to do, and a link to the page that opens at it (`?before=` the place under it, so the damaged
 * row leads that page, and its row id as the fragment). When the line at the break shows no prev that matches the row
 * before it, that row is named too: only such a prev vouches for a row (audit-view.mjs header), so the verified range
 * ends before it and the banner says why.
 */
export function auditChain(view) {
  if (view.role !== "operator") return html``;
  const a = view.data?.audit;
  const c = a?.chain;
  if (!a || !c) return ui.banner({ status: "attention", icon: "chain", title: "The chain could not be checked", body: html`The audit log could not be read, so no row is verified here. ${VERIFY_CMD} walks it on the host.` });
  if (c.state === "unreadable") {
    const why = c.why === "directory" ? "The audit directory could not be read, so no row is verified." : "The check did not run, so no row is verified here.";
    return ui.banner({ status: "attention", icon: "chain", title: "The chain could not be checked", body: html`${why} ${VERIFY_CMD} walks the same chain on the host.` });
  }
  if (c.state === "broken") {
    const label = damagedLabel(a);
    const verified = c.through === null ? "No row could be verified" : `Chain verified through row ${c.through}`;
    const at = placeOf(c.broken.pos);
    const href = at === null ? null : `/audit?${new URLSearchParams({ before: `${at[0]}:${Math.max(at[1], 1) + 1}` })}#line-${at[0]}-${at[1]}`;
    const before = c.suspect ? ` Neither can row ${c.suspect.seq}, the row before it: the link between the two does not hold, so the chain cannot tell whether row ${c.suspect.seq} changed.` : "";
    const body = html`${c.broken.reason ? html`The check says: ${c.broken.reason}. ` : null}${lead(label)} and every row after it cannot be trusted.${before} Keep the file as it is and compare it with your last backup; ${VERIFY_CMD} names the same line.`;
    const show = href === null ? null : ui.btn({ kind: ["sm", "primary"], label: "Show the damaged line", href });
    return ui.banner({ status: "failed", icon: "chain", title: `${verified}. ${lead(label)} is damaged.`, body, actions: show });
  }
  if (c.through === null) {
    if ((a.rows ?? []).length === 0) return ui.banner({ status: "ok", icon: "chain", title: "The audit log is empty", body: "The chain starts with the first row the console writes." });
    return ui.banner({ status: "idle", icon: "chain", title: "No row is verified yet", body: "Every row was written after the last check; the next one covers them." });
  }
  const span = c.startsAt !== null && c.from !== null ? `Chain verified from row ${c.from} through row ${c.through}` : `Chain verified through row ${c.through}`;
  const reaped = c.startsAt !== null ? " The log starts there: older rows were reaped by retention, or removed, and the two look alike." : "";
  const fresh = (a.rows ?? []).some((r) => r.state === "unchecked") ? " Rows written since the check say unchecked until the next one." : "";
  return ui.banner({ status: "ok", icon: "chain", title: span, body: `Every row's hash follows the row before it.${reaped}${fresh}` });
}

/**
 * The filters (the AuditScreen card): a search over targets and reasons and a closed list each for who, action and
 * outcome, as a plain GET form to the page itself, so a filtered view is a link like any other and needs no script.
 * Who lists the names the rows read so far hold (and the one chosen); action and outcome the worker's closed lists.
 */
export function auditFilter(view) {
  if (view.role !== "operator") return html``;
  const q = view.query ?? {};
  const names = Array.isArray(view.data?.audit?.who) ? view.data.audit.who : [];
  const pick = (id, name, label, values, value) => html`<label class="sr" for="${id}">${label}</label>${ui.select({ id, name, value: value ?? "", options: [{ value: "", label: `${label}: all` }, ...values.map((v) => ({ value: v, label: `${label}: ${v}` }))] })}`;
  const reset = auditFiltered(q) || (typeof q.before === "string" && q.before !== "") || Number.isSafeInteger(q.seq) ? ui.btn({ kind: "ghost", label: "Clear", href: "/audit" }) : null;
  return html`<form class="filterbar" method="get" action="/audit" role="search" aria-label="Filter the audit log"><label class="search">${ui.icon("search")}<input type="search" name="q" value="${q.q ?? ""}" maxlength="${AUDIT_Q_MAX}" placeholder="Search targets and reasons" aria-label="Search targets and reasons" autocomplete="off" spellcheck="false"></label>${pick("au-who", "who", "Who", names, q.who)}${pick("au-role", "role", "Role", AUDIT_ACTOR_ROLES, q.role)}${pick("au-action", "action", "Action", CONSOLE_AUDIT_ACTIONS, q.action)}${pick("au-outcome", "outcome", "Outcome", CONSOLE_AUDIT_OUTCOMES, q.outcome)}${ui.btn({ label: "Filter", type: "submit" })}${reset}</form>`;
}

/** What the log is (the AuditScreen card's side card): the verified range, the damage, the last check, who sees it. */
export function auditAbout(view) {
  if (view.role !== "operator") return html``;
  const a = view.data?.audit;
  const c = a?.chain ?? null;
  const ok = c !== null && c.state !== "unreadable";
  // A broken chain with nothing vouched for has no row to come "yet": the check stopped at the damage.
  const range = !ok ? "not checked" : c.through === null ? (c.state === "broken" ? "none" : "none yet") : c.from !== null && c.from !== c.through ? `rows ${c.from} to ${c.through}` : `row ${c.through}`;
  const label = damagedLabel(a);
  const after = a?.rows?.some((r) => r.state === "unverified") ? "every row after the damaged one" : "any row after the damaged one (none on this page)";
  const pairs = [
    ["Verified", range],
    ["Damaged", label === null ? (ok ? "none" : "not checked") : html`<b class="tinted tone-failed">${label}</b>`],
    ["Not verified", label === null ? (ok ? "none" : "every row") : c.suspect ? `row ${c.suspect.seq} (its link to the damaged row does not hold) and ${after}` : after],
    ...(Number.isFinite(c?.checkedAt) ? [["Checked at", timeHtml(c.checkedAt)]] : []),
    ["Each row keeps", "who, what, target, outcome, reason and a hash of the row before"],
    ["Who sees it", "operators only; viewers do not see this page"],
  ];
  return ui.card({ title: "About this log", body: ui.facts(pairs, { cols: 1 }) });
}
