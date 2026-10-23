/**
 * The run page's panels (the outcome banner, progress, inbox, chat and the record's panels), split out of
 * `../panels.mjs` (issue #737), which re-exports what this module exports. The rules every panel keeps (one pure,
 * deterministic renderer per region, every value through `html`, the role and run-text rule, the action controls and
 * the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { refusedBeforeSpend } from "../../costs.mjs";
import { recordedProgress } from "@edgehero/pi-dispatch/run-history";
import { UNATTRIBUTED_BACKEND } from "@edgehero/pi-dispatch/backends";
import { BUNDLE_SKIPPED_TEXT, LIVE_SKIPPED_TEXT, STEER_SKIPPED_TEXT, VENUE_MAY_NOT_STREAM, liveAbsentCause, progressAbsentText, recordSkips, sandboxShellRefusal, bundleCountsText, bundleReceivedText, checkpointsText, isProgressSnapshot, progressStaleFor, recordBundle, recordRecovery, recoveredText, openshellCountsText, openshellHostsText, recordOpenshell, recordSecretsProfile } from "../../read-model.mjs";
import { coresText } from "@edgehero/pi-dispatch/size-suggest";
import { NO_EXPLANATION, TONE_CLASS, VENUE_LABEL, docsHref, outcomeWord } from "../../words.mjs";
import { explainReason } from "@edgehero/pi-dispatch/reason-catalog";
import { QUEUED_STATES } from "@edgehero/pi-dispatch/chat-mode";
import { rerunRefusalOf } from "../../job-actions.mjs";
import { sessionKeyOfRecord } from "@edgehero/pi-dispatch/session-key";
import { html } from "../html.mjs";
import { SEC, MIN, cell, ageText, timeHtml, msOf, usdText, count, RUN_ID_RE, runLink, targetLink, titled, canAct, actForm, area, table, facts, runCost, costText, capMicrosOf, staleText, outcomeText, bannerCut, parkedAnswerForm } from "./common.mjs";

// ---- run detail ------------------------------------------------------------------------------------------------------

/**
 * Whether the page's run is RUNNING with no record yet (a record is written at its end): its live transcript exists, a
 * live progress snapshot has not ended, or the queue says the job is active.
 */
function runningWithoutRecord(view) {
  if (view.data?.run?.record) return false;
  return view.data?.transcript?.exists === true || (isProgressSnapshot(view.data?.progress) && !view.data.progress.ended) || view.data?.chat?.jobState === "active";
}

/**
 * Whether the record is a run REFUSED BEFORE IT STARTED (issue #710): a policy outcome (never retried,
 * CONST-RETRY-INFRA-ONLY, so no later attempt of the same id can start) whose record says no spend at all, the cost
 * fold's own `refusedBeforeSpend` (no tokens, no exit code, `budgetReserved: false`). Such a run made no container and
 * no workspace, so its page draws no Progress, no Chat, no transcript section and no sandbox command. A refusal the fold
 * cannot tell from a spend (one that kept its count slot, `over-budget`) keeps those panels, and says what they say.
 */
export function refusedBeforeStart(record) {
  return record !== null && typeof record === "object" && record.outcome === "policy" && refusedBeforeSpend(record);
}

/**
 * The record panels of the run page. With no record they draw NOTHING (issue #710): the empty section is hidden by the
 * stylesheet's `section[data-panel]:empty`, and the outcome banner (`runOutcome`) says once why there is no record,
 * where every panel used to say it again.
 */
function withRun(title, render) {
  return (view) => {
    const got = view.data?.run;
    if (!got?.record) return html``;
    return titled(title, render(got.record, view, got.source));
  };
}

// ---- the outcome banner (issue #710) ---------------------------------------------------------------------------------

/**
 * A nested reason's sentence (issue #710): the catalog's table for the record field (`session.reason`,
 * `recoverSkipped`, `plan.reason`), its fixed text with the Markdown backticks dropped (a facts value is plain text), or
 * "no explanation yet" for a token the catalog does not know. The token itself is printed beside it by the caller.
 */
function nestedText(field, token) {
  const said = explainReason(token, { field });
  return said.known ? said.sentence.replace(/`/g, "") : NO_EXPLANATION;
}

/** A catalog string with its Markdown code spans (`run.mcp`) as `<code>`, every part escaped by the template. */
function catalogText(text) {
  return String(text)
    .split("`")
    .map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : part));
}

/** What the banner says of a record that names no reason, by its outcome word. */
const NO_REASON_TEXT = Object.freeze({
  completed: "The run finished, and its record names no reason to say more.",
  refused: "The run was refused, and its record names no reason.",
  failed: "The run failed, and its record names no reason. Its exit code and the worker log say more.",
});

/**
 * The `awaiting-input` next step where THIS page cannot take the answer (review of issue #710): the catalog's line
 * without its console path. The catalog's own next step ends "or answer from the console's run page", which the Chat
 * panel beside it contradicts when the planner refuses the answer here (the queue no longer holds the job's data, a pull
 * request's park, a forge with no reply route) or when the run is no longer waiting for one. Fixed text, as the
 * catalog's is, and the same for both roles (an operator's Chat panel says why; a viewer's shows no chat).
 */
const AWAITING_INPUT_ELSEWHERE = "If no reply was taken yet, answer the question: reply on the issue or pull request (on a pull request, start the reply with this repository's pi-dispatch comment phrase). This console cannot take the answer for this run.";

/**
 * Whether the page's own Chat panel offers no answer for a parked record: the planner's check refused it
 * (`data.chatAnswer`, the very value that panel reads), or the chat facts say the run takes no reply now. Unknown
 * facts (no reader, an unreadable check) are not a contradiction: the catalog's line stays.
 */
function answerRefusedHere(view) {
  const chat = view.data?.chat ?? null;
  if (typeof view.data?.chatAnswer?.refusal === "string") return true;
  return chat !== null && typeof chat === "object" && !chat.unreachable && typeof chat.mode === "string" && chat.mode !== "reply";
}

/**
 * Why the page has no record, said ONCE (issue #710): not a run id, a running job (a record is written at its end), a
 * queued job, a job the queue holds as ended whose record this host cannot read, or no such run. `{ cls, text }`.
 *
 * THE TONE IS THE JOB'S, DELIBERATELY, and none of these prints an outcome word (there is no outcome yet, or none this
 * page can read). A job that exists and has not ended (queued, running) is a grey `note`: nothing is wrong, the record
 * comes at its end. What the page cannot show is an amber `warn`: an id that is not one, a run no history or mirror
 * holds, and an ended job whose record is not readable here. Never `bad`: no run failed that this page knows of.
 */
function absentOutcome(view) {
  const got = view.data?.run;
  if (got?.invalid) return { cls: "warn", text: "That is not a run id." };
  if (runningWithoutRecord(view)) {
    // A snapshot the worker stopped rewriting (its heartbeat is 30 s) may be a run that will never write a record.
    const stale = isProgressSnapshot(view.data?.progress) ? progressStaleFor(view.data.progress, view.now) : null;
    return { cls: "note", text: `This run has no record yet: a run's record is written when it ends.${stale !== null ? ` Its progress has had ${staleText(stale)}.` : ""}` };
  }
  const state = view.data?.chat?.jobState ?? null;
  if (typeof state === "string" && QUEUED_STATES.includes(state)) return { cls: "note", text: "This job is queued and has not started yet: a run's record is written when it ends, and its live transcript is on this page once it runs (reload then)." };
  if (state === "completed" || state === "failed") return { cls: "warn", text: "This job has ended, but its record is not in this host's history or the fleet's run mirror (another host's run, with the mirror off?)." };
  return { cls: "warn", text: "No run with that id is in this host's history or the fleet's run mirror." };
}

/**
 * The run page's first panel (issue #710, REQ-OPERATOR-CONSOLE-SCREENS (c)): what happened, why and what now. The
 * outcome in the console's words (words.mjs, the panel's too) in its tone, the reason's catalog sentence (the record's
 * `why` picks its variant where the catalog has one), its next step and a link to its heading in `docs/reasons.md`.
 *
 * THE SAME FOR BOTH ROLES, AND NO FREE TEXT (REQ-CONSOLE-SECURITY (l)): the outcome and reason are the record's closed
 * enums, which the run summary already shows a viewer; every sentence is the catalog's fixed text, escaped like any
 * value; a job's free-text `failedReason` never comes here. A token the catalog does not know (a newer worker's) is
 * printed once, cut to `BANNER_TOKEN_MAX`, with "no explanation yet"; an outcome word it does not know is cut the same.
 */
export function runOutcome(view) {
  const title = "Outcome";
  const r = view.data?.run?.record ?? null;
  if (!r) {
    const { cls, text } = absentOutcome(view);
    return titled(title, html`<p class="${cls}">${text}</p>`);
  }
  const w = outcomeWord(r.outcome, r.reason);
  const tone = w.tone === "success" ? "good" : (TONE_CLASS[w.tone] ?? null);
  // An outcome word this console does not know is cut like an unknown reason (review round 1): a record is the worker's,
  // but the banner's big line is no place for an unbounded string.
  const word = w.known ? w.word : typeof r.outcome === "string" && r.outcome !== "" ? bannerCut(r.outcome) : cell(r.outcome);
  const token = typeof r.reason === "string" && r.reason !== "" ? r.reason : null;
  const head = html`<p class="big${tone !== null ? ` ${tone}` : ""}">${word}</p>`;
  if (token === null) return titled(title, html`${head}<p>${Object.hasOwn(NO_REASON_TEXT, String(w.word)) ? NO_REASON_TEXT[w.word] : NO_REASON_TEXT.failed}</p>`);
  const said = explainReason(token, { why: typeof r.why === "string" ? r.why : null });
  if (!said.known) {
    return titled(title, html`${head}<p><span class="mono">${bannerCut(token)}</span>, ${NO_EXPLANATION}.</p>`);
  }
  const href = docsHref(said.anchor);
  const more = href !== null ? html`: <a href="${href}" rel="noreferrer noopener" target="_blank">read more in the reasons docs</a>` : null;
  const next = token === "awaiting-input" && answerRefusedHere(view) ? AWAITING_INPUT_ELSEWHERE : said.next;
  return titled(title, html`${head}<p>${catalogText(said.sentence)}</p><p><strong>What to do:</strong> ${catalogText(next)}</p><p class="note">Reason <span class="mono">${token}</span>${more}.</p>`);
}

// ---- run progress (issue #644) ---------------------------------------------------------------------------------------

/** A step's duration: `1.2 s`, `40s`-style past a minute, or `-` when pi recorded none (the tool never ran). */
function stepDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return "-";
  return ms < MIN ? `${(ms / SEC).toFixed(1)} s` : ageText(ms);
}

/** The run record's `progress`, rebuilt by the worker's own rule (`recordedProgress`): integers and closed keys only. */
function recordProgressBody(r) {
  const p = recordedProgress(r?.progress);
  if (p === undefined) return null;
  const z = (v) => (Number.isSafeInteger(v) ? count(v) : "0");
  const tools = p.tools ? Object.entries(p.tools) : [];
  return html`${facts([
    ["Turns", z(p.turns)],
    ["Steps", z(p.steps)],
    ["Failed steps", z(p.failed)],
    ["Interrupted steps", z(p.interrupted)],
    // A sum, not wall time: steps the model ran in parallel overlap, so this can exceed the run's own duration.
    ["Sum of step durations", Number.isSafeInteger(p.toolMs) ? stepDuration(p.toolMs) : "-"],
    ["Longest step", Number.isSafeInteger(p.longestStepMs) ? stepDuration(p.longestStepMs) : "-"],
    ["Longest interrupted step", Number.isSafeInteger(p.longestInterruptedMs) ? stepDuration(p.longestInterruptedMs) : null],
    ["Phases declared", z(p.phasesDeclared)],
    ["Last phase", Number.isSafeInteger(p.lastPhaseIndex) ? `${p.lastPhaseIndex + 1} of ${count(p.phasesDeclared)}` : null],
  ])}${tools.length > 0 ? table("Steps by tool", ["Tool", { num: "Steps" }], tools.map(([name, n]) => html`<tr><td class="mono">${name}</td><td class="num">${count(n)}</td></tr>`), "") : null}`;
}

/**
 * The live snapshot's phase section. The integers (which phase of how many, done of total) are a list's own facts and
 * every role gets them; the NAMES, the bar and the note are the model's words and go to an operator alone, escaped by
 * the template (the worker already escaped the control class; this is the second belt). A `phase.index` past the list
 * (the worker's size cut) shows no name rather than a neighbour's.
 */
function phaseBody(g, operator) {
  if (!g.phase && g.phases.length === 0) return html`<p class="note">This run declared no phase.</p>`;
  const f = g.phase;
  const total = f ? Math.max(g.phases.length, f.index + 1) : g.phases.length;
  const where = f ? html`<p>Phase ${f.index + 1} of ${count(total)}${f.done !== null ? `: ${count(f.done)}${f.total !== null ? ` of ${count(f.total)}` : ""} done` : ""}</p>` : null;
  if (!operator) return html`${where}<p class="note">Phase names and the run's note are shown to operators only.</p>`;
  const name = f && f.index < g.phases.length ? g.phases[f.index] : null;
  const bar = f && f.done !== null && f.total !== null ? html`<progress value="${String(f.done)}" max="${String(f.total)}">${`${f.done} of ${f.total}`}</progress>` : null;
  const list = g.phases.length > 0 ? html`<ol class="phases">${g.phases.map((p, i) => html`<li${f && i === f.index ? html` aria-current="step"` : null}>${p}</li>`)}</ol>` : null;
  return html`${where}${name !== null ? html`<p>Current phase: <strong>${name}</strong> ${bar}</p>` : bar}${list}${g.note !== null ? html`<h3>Note</h3><p class="run-note">${g.note}</p>` : null}`;
}

/**
 * The live snapshot's counters and steps, for every role: integers, UTC times and charset-checked tool names. A STALE
 * snapshot (`progressStaleFor`: no write past the worker's heartbeat) leads with a warning, and its open steps read as
 * open at the last update, never as running now with an age the console's clock keeps growing.
 */
function liveProgressBody(g, view) {
  const now = view.now;
  const operator = view.role === "operator";
  const stale = progressStaleFor(g, now);
  const open = (r) => (stale === null ? `running ${Number.isFinite(now) && now >= r.since ? ageText(now - r.since) : "-"}` : `open ${g.updatedAt >= r.since ? ageText(g.updatedAt - r.since) : "-"} at the last update`);
  const running = g.running.length === 0 ? html`<p class="note">${g.ended ? `The run has ended (${typeof g.outcome === "string" ? (outcomeWord(g.outcome).word ?? g.outcome) : "unknown"}).` : "No step is running."}</p>` : html`<ul class="plain">${g.running.map((r) => html`<li><span class="mono">${r.tool}</span> ${open(r)}</li>`)}</ul>`;
  const recent = [...g.recent].reverse();
  return html`${stale !== null ? html`<p class="warn">Stale: ${staleText(stale)}.</p>` : null}${facts([
    ["Turn", count(g.turn)],
    ["Steps", `${count(g.steps)}${g.failed > 0 ? ` (${count(g.failed)} failed)` : ""}`],
    ["Interrupted steps", g.interrupted > 0 ? count(g.interrupted) : null],
    // The resume prior: what the session's earlier runs did before this run resumed it, not this job's retries.
    ["Earlier runs of this session", g.prior ? `${count(g.prior.turns)} turns, ${count(g.prior.steps)} steps before this run resumed the session` : null],
    ["Started", timeHtml(g.startedAt)],
    ["Updated", timeHtml(g.updatedAt)],
  ])}<h3>Running now</h3>${running}<h3>Phase</h3>${phaseBody(g, operator)}<h3>Recent steps</h3>${table("Recent steps", ["Tool", "Status", { num: "Took" }, "At"], recent.map((r) => html`<tr${r.status === "ok" ? null : html` class="warn"`}><td class="mono">${r.tool}</td><td>${r.status}</td><td class="num">${stepDuration(r.durationMs)}</td><td>${timeHtml(r.at)}</td></tr>`), "No step has finished yet.")}`;
}

/**
 * Why a run on a venue that streams has no progress snapshot: the key cannot tell these apart, so the panel names all
 * three. Issue #712: the panel says `progressAbsentText(record)`, `TRANSCRIPT_ABSENT`'s rule (progress is read off the
 * live transcript), so a run on a venue that does not stream it is not blamed on the switch alone.
 */
export const PROGRESS_ABSENT = progressAbsentText({ backend: "local" });

/**
 * The run page's "Progress" panel (issue #644). A run with a record shows the record's `progress` (and, while the key
 * is still kept, an operator also gets the phase names it declared); a running job shows the live snapshot, counters
 * and recent steps for everyone, phase names, the done/total bar and the note for an operator alone. The page is live
 * (the hub re-renders this panel by digest), so a running job's counters move without a reload.
 *
 * An infra retry keeps the job id: attempt 1 writes its record and attempt 2 then rewrites the key. So the key is set
 * beside the record only when the two are the SAME attempt, judged by time: a key that started after the record ended
 * is a later attempt's, and the panel shows that live body (saying an earlier attempt ended, with the record's
 * outcome); the key's phase names join the record only when the key has ended and started inside the record's
 * attempt (no earlier than the record started, no later than it ended). A record whose start or end cannot be read
 * pairs with no key.
 *
 * Issue #662: the key is read by the job's RUN id (pages.mjs, `readRunProgress`), so a recovery's page pairs with its
 * own live key, and an attempt whose record says its run continues as a recovery (`data.progressContinues`) pairs with
 * nothing: it shows its own record's progress and links the recovery job.
 */
export function runProgress(view) {
  const title = "Progress";
  const record = view.data?.run?.record ?? null;
  const g = view.data?.progress ?? null;
  // Issue #710: a run refused before it started made no container, so it has no progress to show and the panel draws
  // nothing (its empty section is hidden); and with no record and no live snapshot, the outcome banner says why once.
  if (refusedBeforeStart(record)) return html``;
  // Issue #662: an attempt whose run went on as a #645 recovery (its record says `recovery-enqueued`). The key is the
  // RUN's, so it now holds the recovery's progress: pairing it here would show another job's live steps as this
  // attempt's. The attempt shows its own record's progress, and names the job that continues it (its own page reads the
  // key live). A BullMQ retry keeps the job id and keeps the pairing below.
  const cont = view.data?.progressContinues ?? null;
  if (record && cont) {
    const next = typeof cont.as === "string" && RUN_ID_RE.test(cont.as) ? cont.as : null;
    const line = html`<p class="note">This run continues as ${next !== null ? runLink(next) : "a recovery job"}.</p>`;
    return titled(title, html`${line}${recordProgressBody(record) ?? html`<p class="note">This attempt's record holds no progress.</p>`}`);
  }
  const live = isProgressSnapshot(g) ? g : null;
  const recordEnd = typeof record?.endedAt === "string" ? Date.parse(record.endedAt) : Number.NaN;
  if (record && live && Number.isFinite(recordEnd) && live.startedAt > recordEnd) {
    const outcome = typeof record.outcome === "string" && /^[a-z-]{1,40}$/.test(record.outcome) ? record.outcome : "unknown";
    return titled(title, html`<p class="note">An earlier attempt of this run ended (${outcome}); this is the attempt after it.</p>${liveProgressBody(live, view)}`);
  }
  if (record) {
    const body = recordProgressBody(record);
    // Both bounds: a key that started before this record's attempt did is an EARLIER attempt's (attempt 2 refused before
    // its container leaves attempt 1's ended key in place), and its phase names are not this record's. An unreadable
    // start pairs with nothing, as an unreadable end does.
    const recordStart = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
    const same = live && live.ended && Number.isFinite(recordEnd) && Number.isFinite(recordStart) && live.startedAt >= recordStart && live.startedAt <= recordEnd;
    const names = same && view.role === "operator" && live.phases.length > 0 ? html`<h3>Phases</h3>${phaseBody(live, true)}` : null;
    // Issue #712: a record that names its live skip says it; one on a venue that does not always stream adds that cause.
    if (body === null && names === null) {
      const cause = liveAbsentCause(record);
      const why = cause?.skipped ? `it had no live transcript to read it from: ${cause.skipped}` : cause?.venue ? `an older worker, PI_RUN_PROGRESS=0, ${VENUE_MAY_NOT_STREAM}` : "an older worker, or PI_RUN_PROGRESS=0";
      return titled(title, html`<p class="note">This run's record holds no progress (${why}).</p>`);
    }
    return titled(title, html`${body ?? html`<p class="note">This run's record holds no progress.</p>`}${names}`);
  }
  if (live) return titled(title, liveProgressBody(live, view));
  if (g?.unreachable) return titled(title, html`<p class="warn">The run's progress could not be read (is Valkey reachable?).</p>`);
  if (g?.invalid) return titled(title, html`<p class="warn">The run's progress key is not one this console reads (a newer or older worker?).</p>`);
  // No record and no snapshot: a queued job, or no run at all, which the banner names. A running job keeps the sentence.
  if (!runningWithoutRecord(view)) return html``;
  return titled(title, html`<p class="note">${progressAbsentText(record)}</p>`);
}

// ---- run inbox (issue #646) ------------------------------------------------------------------------------------------

/** Why an active, steer-armed job's run takes no message: the open key cannot tell these apart, so all are named. */
export const INBOX_NOT_OPEN = "The run is not accepting messages: it has not started its loop yet, it has finished, or its venue cannot deliver (bind mounts, an exit key and an image with the steer capability).";

const MODE_WORD = Object.freeze({ steer: "steer", followUp: "follow-up" });
/** A message id as the inbox mints it (INT-STEER-INBOX-CONTRACT): only such an id gets a withdraw button. */
const MESSAGE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The run page's "Inbox" panel (issue #646, REQ-STEER-RUNNING-JOB): the messages sent into a steer-armed job, as
 * `readJobInbox` reads them, WITHOUT TEXT for every role (id, mode, source, state, time, size): the text is the
 * sender's words for one run, and a list is no place for them (the audit row keeps only their sha256 too). A job that
 * is not steer-armed, or not found, draws nothing at all (its empty section is hidden by the stylesheet's
 * `section[data-panel]:empty`), so every other run page reads as it did.
 *
 * The controls (`canAct`: an operator on a console that is not read-only): one form to steer and one to send a
 * follow-up, drawn only while the job is ACTIVE and its run takes messages (`open`), and a Withdraw button on each
 * message still `queued` (withdrawn for certain) or `written` (best effort; the preview says which). A viewer sees the
 * list and the run's status, never a control, which is the parked answer form's and the cancel button's rule. The page
 * is live, so a message's state moves from queued to written to delivered without a reload; a form being typed into is
 * not swapped (the script's `inUse`).
 */
export function runInbox(view) {
  const box = view.data?.inbox ?? null;
  if (box === null || typeof box !== "object" || box.invalid || box.found === false || (box.found === true && box.steer !== true)) return html``;
  const title = "Inbox";
  if (box.unreachable) return titled(title, html`<p class="warn">The run's inbox could not be read (is Valkey reachable?).</p>`);
  const jobId = view.query?.id;
  // Review F4: a job that is not active whose run goes on as a recovery job (`continuesAs`, same run, same inbox): the
  // forms stay, since the planner sends through the active job, and the panel names that job with a link.
  const next = typeof box.continuesAs === "string" && RUN_ID_RE.test(box.continuesAs) ? box.continuesAs : null;
  const running = box.state === "active" || next !== null;
  const takes = running && box.open === true;
  const status = takes
    ? "The run takes messages. A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop. Either one spends from the run's existing reservation."
    : running
      ? box.open === null
        ? "Whether the run takes messages could not be read."
        : INBOX_NOT_OPEN
      : `The job is ${cell(box.state)}, not running, so it takes no message; its inbox is kept for an hour after its run.`;
  const act = canAct(view) && typeof jobId === "string" && RUN_ID_RE.test(jobId);
  const withdraw = (e) => {
    if (!act) return null;
    if ((e.state !== "queued" && e.state !== "written") || typeof e.id !== "string" || !MESSAGE_ID_RE.test(e.id)) return html`<td>-</td>`;
    return html`<td>${actForm("steer-withdraw", { hidden: [["jobId", jobId], ["id", e.id]], label: "Withdraw" })}</td>`;
  };
  const entries = Array.isArray(box.entries) ? box.entries : null;
  const list =
    entries === null
      ? html`<p class="warn">The messages could not be read this time; the next refresh tries again.</p>`
      : table(
          "Inbox",
          ["Message", "Mode", "Source", "State", "Sent", { num: "Bytes" }, ...(act ? ["Action"] : [])],
          entries.map((e) => html`<tr><td class="mono">${cell(e.id)}</td><td>${cell(MODE_WORD[e.mode])}</td><td>${cell(e.source)}</td><td>${cell(e.state)}</td><td>${Number.isSafeInteger(e.at) ? timeHtml(e.at) : "-"}</td><td class="num">${count(e.bytes)}</td>${withdraw(e)}</tr>`),
          "No message has been sent to this run.",
        );
  // Issue #647: when the Chat panel draws the message forms (a live run an operator can steer), they are drawn THERE and
  // not here, so the page holds one steer form per mode, never two copies of the same action.
  const forms = act && takes && !chatDrawsSteer(view) ? steerForms(jobId) : null;
  const cont = next !== null ? html`<p class="note">This job is ${cell(box.state)}; its run continues as ${runLink(next)}, and a message sent here goes to that job.</p>` : null;
  return titled(title, html`${cont}<p class="note">${status}</p>${list}${forms}<p class="note">A message's text is never listed: the run reads it, and the audit log keeps its sha256.</p>`);
}

// ---- run chat (issue #647) -------------------------------------------------------------------------------------------

/** What each run state is called in the Chat panel's status line (`RUN_STATES`, chat-mode.mjs). */
const CHAT_STATE_WORD = Object.freeze({ active: "running", queued: "queued", parked: "parked, waiting for an answer", answered: "answered by a later run", finished: "finished", unknown: "unknown" });

/** The Chat panel's line for a run that cannot chat because another job holds it: a link to that job, or null. */
function chatHeldBy(chat) {
  if (typeof chat.answeringJobId === "string" && RUN_ID_RE.test(chat.answeringJobId)) return html`<p class="note">The run taking the answer is ${runLink(chat.answeringJobId)}.</p>`;
  if (typeof chat.queuedJobId === "string" && RUN_ID_RE.test(chat.queuedJobId)) return html`<p class="note">The queued recovery job is ${runLink(chat.queuedJobId)}.</p>`;
  return null;
}

/**
 * The run page's "Chat" panel (issue #647, REQ-TERMINAL-CHAT): the chat this run can have now (`data.chat`, from
 * `chatModeOf` through `run-api.mjs`'s `chatFactsOf`, the rule `/api/run` and `pi-dispatch chat` share), composed of what
 * the console already has, never a second copy of an action:
 *
 *   - live: the live transcript section below (issue #643, an operator's) and the steer and follow-up forms, which move
 *     here from the Inbox panel while this panel shows them (`chatDrawsSteer`);
 *   - reply: the parked answer form, the very one the parked inbox draws (`parkedAnswerForm`);
 *   - fork: the exact `pi-dispatch chat <id>` command to fork the run's session on a host that holds the session store
 *     (shown to copy, never run, like the sandbox command), or why its session cannot be found from the record.
 *
 * A VIEWER SEES STATUS ONLY (REQ-CONSOLE-SECURITY clause l): the state, the mode and a refusal's sentence, never a form
 * or a command; a read-only console draws no form for anyone. Nothing here is free text: the state words are this
 * module's, `says` is one of `chatModeOf`'s fixed sentences, and the id is charset-checked. A page whose fleet has no
 * job-state reader draws nothing (the empty section is hidden), so an older reader's page reads as it did.
 */
export function runChat(view) {
  const chat = view.data?.chat ?? null;
  if (chat === null || typeof chat !== "object") return html``;
  // Issue #710: nothing to chat with in a run refused before it started; and a job with no record that is itself queued,
  // or that nothing knows, is the outcome banner's to say, once. Every other state keeps its sentence.
  const record = view.data?.run?.record ?? null;
  if (refusedBeforeStart(record)) return html``;
  if (record === null && !chat.unreachable && (chat.state === "unknown" || (chat.state === "queued" && typeof chat.queuedJobId !== "string"))) return html``;
  const title = "Chat";
  if (chat.unreachable) return titled(title, html`<p class="warn">The queue could not be read (is Valkey reachable?), so whether this run can chat is unknown. The next refresh tries again.</p>`);
  const jobId = typeof view.query?.id === "string" && RUN_ID_RE.test(view.query.id) ? view.query.id : null;
  const answering = chat.state === "answered" && typeof chat.answeringJobId === "string";
  const status = html`<p>This run is ${answering ? "being answered" : Object.hasOwn(CHAT_STATE_WORD, chat.state) ? CHAT_STATE_WORD[chat.state] : "unknown"}.</p>`;
  if (chat.mode !== "live" && chat.mode !== "reply" && chat.mode !== "fork") return titled(title, html`${status}<p class="note">${typeof chat.says === "string" ? chat.says : "This run has no chat."}</p>${chatHeldBy(chat)}`);
  if (view.role !== "operator" || jobId === null) return titled(title, html`${status}<p class="note">Chat is for operators; a viewer sees the run's status only.</p>`);
  const terminal = (id) => html`<p>From a terminal: <code class="mono">${`pi-dispatch chat ${id}`}</code></p>`;
  const readOnly = view.readOnly ? html`<p class="note">This console is read-only, so it sends nothing.</p>` : null;
  if (chat.mode === "live") {
    const active = typeof chat.activeJobId === "string" && RUN_ID_RE.test(chat.activeJobId) ? chat.activeJobId : jobId;
    const via = active !== jobId ? html`<p class="note">The run goes on as ${runLink(active)}; its transcript is on that job's page, and a message sent here reaches it.</p>` : html`<p class="note">Its live transcript is <a href="#transcript">below</a>.</p>`;
    const box = view.data?.inbox ?? null;
    // An inbox that could not be read says so: "not steer-armed" about a run whose inbox was never read would be a guess.
    const boxRead = box !== null && typeof box === "object" && !box.unreachable && !box.invalid;
    const armed = boxRead && box.found === true && box.steer === true;
    const send = chatDrawsSteer(view)
      ? steerForms(jobId)
      : canAct(view)
        ? !boxRead
          ? html`<p class="warn">The run's inbox could not be read (is Valkey reachable?), so whether it takes a message is unknown. The next refresh tries again.</p>`
          : html`<p class="note">${!armed ? "This run is not steer-armed (its trigger sets no run.steer), so it takes no message; watch it instead." : "The run takes no message right now; the Inbox panel says why."}</p>`
        : null;
    return titled(title, html`${status}${via}${send}${readOnly}${terminal(jobId)}`);
  }
  if (chat.mode === "reply") {
    const link = view.data?.run?.record ? targetLink(view.data.run.record, view.env) : "-";
    // Issue #647: the form only where the planner would plan the answer (`parkedAnswerCheck`, its own predicate): a pull
    // request's park, a forge without a reply route or expired job data shows the planner's sentence instead. A check that
    // could not be read keeps the form and says so (the planner checks again before anything is queued).
    const check = view.data?.chatAnswer ?? null;
    const refusal = typeof check?.refusal === "string" ? check.refusal : null;
    const form = refusal === null && canAct(view) ? parkedAnswerForm(jobId) : null;
    const why = refusal !== null ? html`<p class="note">It cannot be answered from here: ${refusal}.</p>` : check?.unreachable ? html`<p class="warn">Whether it can be answered from here could not be read; the preview checks again.</p>` : null;
    return titled(title, html`${status}<p class="note">Its question is the last assistant entry of its transcript <a href="#transcript">below</a> (kept 24 hours), and on ${link}. An answer resumes it, as a reply there would.</p>${why}${form}${readOnly}${refusal === null ? terminal(jobId) : null}`);
  }
  // fork: whether the record names a session the host-local fork can find, said before the command is offered.
  const kept = record?.session !== null && typeof record?.session === "object";
  const why = !kept ? "This run's trigger keeps no session (no run.resume), so there is no transcript to fork." : sessionKeyOfRecord(record) === null ? "This run's session cannot be found from its record (a pull or merge request's session is keyed by its head branch, which the record does not carry), so a fork would refuse." : null;
  if (why !== null) return titled(title, html`${status}<p class="note">${why}</p>`);
  return titled(title, html`${status}<p class="note">Continue it in your own pi, as a fork of its session: run this on a host that holds the session store (PI_SESSIONS_DIR). The session's transcript is not redacted and goes to your pi's provider; the run's own transcript is never written.</p>${terminal(jobId)}`);
}

/**
 * The two message forms of a steer-armed run that takes messages (issue #646): a steer and a follow-up, both the `steer`
 * action with a `mode`. Drawn by the Inbox panel, or by the Chat panel when it shows a live run (issue #647), never by
 * both (`chatDrawsSteer`).
 */
function steerForms(jobId) {
  const text = (label) => area("text", label, { rows: 3, required: true, max: 8192 });
  return html`<h3>Send a message</h3>${actForm("steer", { hidden: [["jobId", jobId], ["mode", "steer"]], fields: text("Steer: read after the agent's current tool calls"), label: "Preview the steer" })}${actForm("steer", { hidden: [["jobId", jobId], ["mode", "followUp"]], fields: text("Follow-up: read once the agent would otherwise stop"), label: "Preview the follow-up" })}`;
}

/**
 * Whether the run's inbox takes a message now and this view may send one: the Inbox panel's own rule (an operator on a
 * writable console, a steer-armed job that is active or continues as an active recovery, and an open inbox).
 */
function inboxTakes(view) {
  const box = view.data?.inbox ?? null;
  if (box === null || typeof box !== "object" || box.found !== true || box.steer !== true || box.unreachable) return false;
  const next = typeof box.continuesAs === "string" && RUN_ID_RE.test(box.continuesAs) ? box.continuesAs : null;
  return (box.state === "active" || next !== null) && box.open === true;
}

/** Whether the Chat panel draws the message forms (so the Inbox panel does not): a live run an operator can steer now. */
function chatDrawsSteer(view) {
  const jobId = view.query?.id;
  return view.data?.chat?.mode === "live" && canAct(view) && typeof jobId === "string" && RUN_ID_RE.test(jobId) && inboxTakes(view);
}

/**
 * The run detail's operator actions (issue #642): the command that reopens the run's retained workspace on the host
 * (`pi-dispatch sandbox <jobId>`, shown to copy and never run: a browser terminal was rejected, DES-OPERATOR-CONSOLE),
 * and the re-run form, whose preview shows the reserve the worker will hold. A job id outside the run-id charset gets
 * neither: it could not be typed back as one argument.
 *
 * ONLY WHAT CAN WORK (issue #710, REQ-OPERATOR-CONSOLE-ACTIONS): each is replaced by one line saying why it cannot,
 * where that is known for certain before the click. The sandbox (`sandboxLine`) and the re-run (`rerunLine`) each say
 * how they know.
 */
function runActions(r, view) {
  if (view.role !== "operator" || typeof r.jobId !== "string" || !RUN_ID_RE.test(r.jobId)) return null;
  return html`<h3>Actions</h3>${sandboxLine(r, view)}${rerunLine(r, view)}`;
}

/**
 * What the run page says of a sandbox whose manifest this host read and refused (`sandboxRetentionOf`'s `why`), when
 * the pane's own words (`reason`) would not read as a sentence after "Its workspace is".
 */
const SANDBOX_KEPT_TEXT = Object.freeze({
  "retention-off": "Its workspace was not kept: sandbox retention is off on this host (PI_SANDBOX_RETENTION_HOURS=0).",
  swept: "Its workspace is no longer kept on this host: it was swept after its retention window, or never kept.",
});

/**
 * The verdicts (`sandboxRetentionOf`'s `why`) that hide the sandbox command: the ones true whatever the shell that runs
 * it blesses. A venue-policy verdict (`unblessed`, `policy-unreadable`, and any word added later) never hides it
 * (review round 1): the console never sees the PI_BACKENDS that shell opens under (`OQ-038`), so it would hide the
 * command of every podman run, and the opener's own venue check (`sandboxVenueRefusal`) is the one that can tell. The
 * fleet reader asks with the policy unknown, so those words should not reach here; this list is the backstop.
 */
const SANDBOX_CERTAIN = new Set(["retention-off", "swept", "id-mismatch", "no-image", "workspace-gone", "venue", "no-venue", "no-launcher"]);

/**
 * The sandbox line. Hidden, with the reason, for a venue that has no sandbox shell (`sandboxShellRefusal`, held to the
 * worker's SANDBOX_LAUNCHERS; a record with no `backend` is a `local` run from before attribution), for a run refused
 * before it started (no workspace was ever made), and for a workspace this host's manifest says cannot be reopened (the
 * panel's verdict, `sandboxRetentionOf`, read through the fleet reader for a run of THIS host and cached 15 s:
 * `data.sandboxCheck`) and only where that verdict is certain (`SANDBOX_CERTAIN`). Past its window, the command carries
 * `--pin`, which the CLI needs then. A venue-policy verdict, a check that could not be read, a run of another host, or a
 * page with no check keeps the command, as before: the CLI checks again.
 */
function sandboxLine(r, view) {
  const venue = typeof r.backend === "string" && r.backend !== "" ? r.backend : UNATTRIBUTED_BACKEND;
  const refused = sandboxShellRefusal(venue);
  if (refused !== null) return html`<p class="note">Its workspace is ${refused}.</p>`;
  if (refusedBeforeStart(r)) return html`<p class="note">No workspace to reopen: the run was refused before it started, so none was made.</p>`;
  const check = view.data?.sandboxCheck ?? null;
  if (check?.retained === false && typeof check.why === "string") {
    if (check.why === "past-window") return html`<p>Its workspace is past its retention window; the command pins it first: <code class="mono">${`pi-dispatch sandbox ${r.jobId} --pin`}</code></p>`;
    if (SANDBOX_CERTAIN.has(check.why)) {
      if (Object.hasOwn(SANDBOX_KEPT_TEXT, check.why)) return html`<p class="note">${SANDBOX_KEPT_TEXT[check.why]}</p>`;
      if (typeof check.reason === "string") return html`<p class="note">Its workspace is ${check.reason}.</p>`;
    }
  }
  return html`<p>Open its retained workspace on the host: <code class="mono">${`pi-dispatch sandbox ${r.jobId}`}</code></p>`;
}

/**
 * The re-run line: the form, or, where the planner would refuse on the record and the job's retained data alone, its
 * sentence instead. The refusal is `rerunRefusalOf`'s, the function `planRerun` asks first, so the page cannot offer
 * what the planner refuses on those, nor hide what it would plan: from the fleet's check (`data.rerunCheck`, which read
 * the retained data, cached 15 s), else from the record alone. The click still runs the whole planner (the triggers
 * file, git, a replica). Drawn only where actions can be taken (`canAct`).
 */
function rerunLine(r, view) {
  if (!canAct(view)) return null;
  const check = view.data?.rerunCheck ?? null;
  const refusal = typeof check?.refusal === "string" ? check.refusal : check?.ok === true ? null : rerunRefusalOf(r, view.now);
  if (refusal !== null) return html`<p class="note">Not offered for a re-run: ${refusal}.</p>`;
  return actForm("rerun", { hidden: [["jobId", r.jobId]], label: "Preview a re-run" });
}

/**
 * The run summary's skip rows (issue #712): "Steering" (why a steer-armed run took no message, the record's
 * `steerSkipped`) and "Live transcript" (why it had none, `liveSkipped`), each the closed enum and its sentence; no row
 * for a record that carries neither, so every other run renders byte-identical.
 */
function skipRows(r) {
  const { liveSkipped, steerSkipped } = recordSkips(r);
  return [
    ["Steering", steerSkipped !== null ? `skipped (${steerSkipped}): ${STEER_SKIPPED_TEXT[steerSkipped]}` : null],
    ["Live transcript", liveSkipped !== null ? `none (${liveSkipped}): ${LIVE_SKIPPED_TEXT[liveSkipped]}` : null],
  ];
}

/**
 * The run summary's OpenShell rows (issue #712): "Sandbox policy" (the mode, the credential providers and placeholders
 * the sandbox was given) and "Rule hosts" (the hosts its policy admitted, with the count of any the record does not
 * list), the worker's rebuild (`recordOpenshell`: hosts held to the host-name charset), escaped by the renderer; and
 * "Secrets profile", the profile NAME run.secrets resolved through. No row for a record without the keys, so every
 * other run renders byte-identical. MCP connection state is not recorded on any venue, so no row claims it.
 */
function openshellRows(r) {
  const o = recordOpenshell(r);
  return [
    ["Sandbox policy", o !== null ? openshellCountsText(o) : null],
    ["Rule hosts", o !== null ? openshellHostsText(o) : null],
    ["Secrets profile", recordSecretsProfile(r)],
  ];
}

/**
 * The run summary's durable-run rows (issue #645): "Recovery of" (the base run, linked), "Recovery" (where it came from
 * and the runner's counts, or why an armed job ran without recovery) and "Checkpoints". Every value is `recordRecovery`'s
 * rebuild (integers, closed enums and a charset-checked id), so both roles see them; each row is null, and so not drawn,
 * when the record holds nothing for it, which keeps every record of a job that never armed `run.recover` byte-identical.
 */
function recoveryRows(r) {
  const rec = recordRecovery(r);
  if (rec === null) return [];
  const said = [rec.recovered ? recoveredText(rec.recovered) : null, rec.recoverSkipped ? `recovery skipped (${rec.recoverSkipped}): ${nestedText("recoverSkipped", rec.recoverSkipped)}` : null].filter(Boolean);
  return [
    ["Recovery of", rec.recoveryOf !== null ? runLink(rec.recoveryOf) : null],
    ["Recovery", said.length > 0 ? said.join("; ") : null],
    ["Checkpoints", rec.checkpoints ? checkpointsText(rec.checkpoints) : null],
  ];
}

/**
 * The run summary's secret-bundle rows (issue #704): "Secret bundle" (the variable NAMES the run received and the bundle
 * they came from, the names a trigger's own run.secrets shadowed, and on an openshell venue how many were placeholders),
 * or why the run went without its project's bundle. `recordBundle`'s rebuild (names held to the environment-name
 * charset, a closed enum), escaped by the renderer like every record string; no row for a record that carries neither
 * key, so every run outside a bundled project renders byte-identical.
 */
function bundleRows(r) {
  const got = recordBundle(r);
  if (got === null) return [];
  const b = got.bundle;
  const said = b ? [bundleReceivedText(b), b.shadowed.length > 0 ? `shadowed by the trigger's own run.secrets: ${b.shadowed.join(", ")}` : null, bundleCountsText(b) || null].filter(Boolean) : [];
  return [
    ["Secret bundle", said.length > 0 ? said.join("; ") : null],
    ["Bundle skipped", got.bundleSkipped !== null ? `${got.bundleSkipped}: ${BUNDLE_SKIPPED_TEXT[got.bundleSkipped]}` : null],
  ];
}

export const runSummary = withRun("Run", (r, view, source) => {
  const started = msOf(r.startedAt);
  const ended = msOf(r.endedAt);
  return html`${facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Target", targetLink(r, view.env)],
    ["Forge", cell(r.kind)],
    ["Flow", cell(r.flow)],
    ["Outcome", outcomeText(r)],
    ["Reason", cell(r.reason)],
    ["Detail", r.why ?? null],
    ["Exit code", cell(r.exitCode)],
    ["Attempt", cell(r.attempt)],
    ...recoveryRows(r),
    ["Host", cell(r.host)],
    [VENUE_LABEL, cell(r.backend)],
    ...skipRows(r),
    ...openshellRows(r),
    ["Project", cell(r.project)],
    ...bundleRows(r),
    ["Provider and model", [r.provider, r.model].filter(Boolean).join(" / ") || "-"],
    ["Turns", cell(r.turns)],
    ["Trigger", r.triggerIndex !== null && r.triggerIndex !== undefined ? `#${r.triggerIndex} (${cell(r.triggerType)})` : "-"],
    ["Replica", Number.isInteger(r.replica) ? `${r.replica} of ${cell(r.replicas)}` : null],
    ["Started", timeHtml(started)],
    ["Ended", timeHtml(ended)],
    ["Took", Number.isFinite(started) && Number.isFinite(ended) ? ageText(ended - started) : "-"],
    ["Read from", source === "mirror" ? "the fleet's run mirror" : "this host's run history"],
  ])}${runActions(r, view)}`;
});

export const runCostPanel = withRun("Tokens and dollars", (r, view) => {
  const t = r.tokens ?? null;
  const d = r.dollars ?? null;
  const cost = runCost(r, Array.isArray(view.data.subscriptions) ? view.data.subscriptions : []);
  return facts([
    ["Cost", costText(cost)],
    ["Cost class", cost ? `${cost.class}${cost.floor ? " (a floor: the meter could not see all of it)" : ""}` : "not metered"],
    ["Input tokens", t ? count(t.input) : "-"],
    ["Output tokens", t ? count(t.output) : "-"],
    ["Total tokens", t ? count(t.total) : "-"],
    ["Model calls", t ? cell(t.calls) : "-"],
    ["Job cap", usdText(capMicrosOf(r))],
    ["Reserved", d ? usdText(d.reservedMicros) : "no dollar window applied"],
    ["Settled", d ? `${usdText(d.settledMicros)} (${cell(d.basis)})` : null],
    ["Model window", d?.modelBasis ?? null],
  ]);
});

/** Bytes as MiB. */
const mib = (bytes) => (Number.isFinite(bytes) ? `${count(bytes / (1024 * 1024))} MiB` : "-");

export const runResources = withRun("Resources", (r) => {
  const x = r.resources ?? null;
  const size = r.size ?? null;
  return facts([
    ["Size given", size ? `${count(size.memMiB)} MiB, ${Number.isSafeInteger(size.cpuCenti) && size.cpuCenti >= 0 ? coresText(size.cpuCenti) : "- cores"} (${cell(size.source)})` : "-"],
    ["Peak memory", x ? mib(x.memPeak) : "not reported"],
    ["Out-of-memory kills", x ? cell(x.oomKills) : null],
    ["CPU time", x && Number.isFinite(x.cpuUsec) ? `${(x.cpuUsec / 1e6).toFixed(1)} s` : null],
    ["Throttled", x && Number.isFinite(x.throttledUsec) ? `${(x.throttledUsec / 1e6).toFixed(1)} s` : null],
    ["Peak processes", x ? cell(x.pidsPeak) : null],
  ]);
});

export const runSession = withRun("Session and plan", (r) => {
  const s = r.session ?? null;
  const p = r.plan ?? null;
  return facts([
    ["Session", s ? (s.resumed ? "resumed" : `fresh (${cell(s.reason)})${typeof s.reason === "string" ? `: ${nestedText("session.reason", s.reason)}` : ""}`) : "this trigger keeps no session"],
    ["Transcript", s && Number.isFinite(s.bytes) ? `${count(s.bytes)} bytes` : null],
    ["Plan", p ? `${cell(p.outcome)}${p.reason ? ` (${p.reason})` : ""}${p.clamped ? ", clamped" : ""}${typeof p.reason === "string" && p.reason !== "" ? `: ${nestedText("plan.reason", p.reason)}` : ""}` : "none"],
    ["Plan id", p?.planId ? html`<span class="mono">${p.planId}</span>` : null],
  ]);
});

export const runChain = withRun("Chain", (r, view) => {
  const kids = Array.isArray(view.data?.children) ? view.data.children : [];
  return html`${facts([
    ["Parent", r.parentJobId ? runLink(r.parentJobId) : "none"],
    ["Depth", cell(r.chainDepth)],
    ["Refused chain requests", cell(r.chainRefused)],
  ])}<h3>Children</h3>${kids.length === 0 ? html`<p class="note">No child run among the ${count(view.data?.childrenSearched ?? 0)} newest runs.</p>` : html`<ul class="plain">${kids.map((k) => html`<li>${runLink(k.jobId)} ${outcomeText(k)}</li>`)}</ul>`}`;
});
