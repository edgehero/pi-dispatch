import { answererRun, standingAnswerEditor, offeredAnswerDraft } from "./answerer.mjs";
import { sandboxLinks, sandboxBrowserLink, sandboxCopy, sandboxNativeLink, sandboxDriverLine } from "../sandbox-links.mjs";
import { modelRolesTelemetryOf } from "@edgehero/pi-dispatch/run-history";
import { modelChoiceSentence, providerFailureSentence } from "../../model-words.mjs";
import { LOADED_WORDS, loadedFold, loadedOf, loadedRows, loadedVerdict, outcomeBanner, outcomeNote, runningVerdict } from "../../loaded-words.mjs";
import { fixButton, loadedFoot, loadedList, stateLine, wordsHtml } from "./loaded-parts.mjs";
/**
 * The run page's panels (the outcome banner, progress, inbox, chat and the record's panels), split out of
 * `../panels.mjs` (issue #737), which re-exports what this module exports. The rules every panel keeps (one pure,
 * deterministic renderer per region, every value through `html`, the role and run-text rule, the action controls and
 * the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { providerFailureOf } from "@edgehero/pi-dispatch/model-failover-protocol";
import { notionalFloorPart, recordNotionalMicros, recordNotionalProviders, refusedBeforeSpend } from "../../costs.mjs";
import { FORK_THINKING_LEVELS } from "../../run-fork.mjs";
import { forkArchiveFact } from "@edgehero/pi-dispatch/fork-job";
import { modelIdProblem } from "@edgehero/pi-dispatch/model-ref";
import { recordedMainCredential, recordedProgress } from "@edgehero/pi-dispatch/run-history";
import { UNATTRIBUTED_BACKEND, servesOf, SERVES, declarationOf, BACKENDS } from "@edgehero/pi-dispatch/backends";
import { BUNDLE_SKIPPED_TEXT, LIVE_SKIPPED_TEXT, STEER_SKIPPED_TEXT, VENUE_MAY_NOT_STREAM, liveAbsentCause, progressAbsentText, recordSkips, sandboxShellRefusal, bundleCountsText, bundleReceivedText, checkpointsText, isProgressSnapshot, progressStaleFor, recordBundle, recordRecovery, recoveredText, openshellCountsText, openshellHostsText, recordOpenshell, recordPrivateEndpoints, privateEndpointsText, recordSecretsProfile, RUN_RECORD_UNREAD, runPlaces, runPlacesText, SERVES_TEXT, CUSTODY_TEXT, venueCustody, transcriptAbsentText, forgeBaseLinkOf, forgeLinkOf } from "../../read-model.mjs";
import { CHAIN_MAX_PER_JOB_DEFAULT } from "@edgehero/pi-dispatch/config";
import { RECOVERY_CAP, RECOVERY_TTL_MS, RECOVERY_MAX_WAIT_MS } from "@edgehero/pi-dispatch/recovery-queue";
import { recordedEarlier } from "@edgehero/pi-dispatch/run-history";
import { beatAgeOf, doctorHostsOf, doctorProblems, doctorCountsText } from "../../doctor-view.mjs";
import { PROPERTY_LABEL, DECLARATION_TEXT } from "../../read-model.mjs";
import { PARKED_ELSEWHERE_TITLE } from "./parked.mjs";
import { sessionSavedOf } from "../run-api.mjs";
import { coresText } from "@edgehero/pi-dispatch/size-suggest";
import { NO_EXPLANATION, VENUE_LABEL, capitalised, docsHref, outcomeWord, recordReason } from "../../words.mjs";
import { explainReason } from "@edgehero/pi-dispatch/reason-catalog";
import { QUEUED_STATES } from "@edgehero/pi-dispatch/chat-mode";
import { rerunRefusalOf } from "../../job-actions.mjs";
import { fromNewerRelease, NEWER_RECORD_SENTENCE } from "../../newer-release.mjs";
import { sessionKeyOfRecord } from "@edgehero/pi-dispatch/session-key";
import { isForgeKind } from "@edgehero/pi-dispatch/forges";
import { isSchedulerJobId } from "@edgehero/pi-dispatch/bullmq-internals";
import { ARTIFACT_DROP_REASONS, ARTIFACT_DROP_TEXT, artifactSizeText } from "@edgehero/pi-dispatch/artifacts-record";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { STEER_MAX_MESSAGES, STEER_TOTAL_MAX_BYTES } from "@edgehero/pi-dispatch/steer-inbox";
import { changesOffered, plural, SEC, MIN, cell, ageText, timeHtml, msOf, usdText, count, RUN_ID_RE, runLink, targetLink, canAct, actForm, area, table, runCost, costText, capMicrosOf, staleText, outcomeText, bannerCut, parkedAnswerForm, HOSTS_UNREAD, hostsUnread, registryReadInPart, hostPartCase, rowLastSeen, SHELLS_SHOWN, shellsShort } from "./common.mjs";
import { windowFloor } from "./runs.mjs";

const titled = (title, body) => ui.card({ title, body });
const facts = (pairs) => ui.facts(pairs.filter(([, value]) => value !== null && value !== undefined));
/** Facts whose values are sentences, which three narrow columns would split mid-word. */
const factsOne = (pairs) => ui.facts(pairs.filter(([, value]) => value !== null && value !== undefined), { cols: 1 });
const recordOf = (view) => view.data?.run?.record ?? null;
/**
 * The run card's label for the record's `kind`: "Forge" where it names a forge (its value then says which), "Kind" for
 * anything else (`local`, or a kind a newer release added), so a local run is never labelled with a forge.
 */
const kindLabel = (kind) => (isForgeKind(kind) ? "Forge" : "Kind");
const hiddenRecord = (view) => !recordOf(view) || refusedBeforeStart(recordOf(view));
const command = (jobId, host = null) => ui.cmd(["pi-dispatch", "chat", jobId], { host: host ? `Run it on ${host}, or a host that holds the session store (PI_SESSIONS_DIR).` : "Run it on a host that holds the session store (PI_SESSIONS_DIR)." });

// ---- run detail ------------------------------------------------------------------------------------------------------

/**
 * Whether the page's run is RUNNING with no record yet (a record is written at its end): its live transcript exists, a
 * live progress snapshot has not ended, or the queue says the job is active.
 */
function runningWithoutRecord(view) {
  if (view.data?.run?.record) return false;
  return (view.data?.transcript?.exists === true && view.data.transcript.ended !== true) || (isProgressSnapshot(view.data?.progress) && !view.data.progress.ended) || view.data?.chat?.jobState === "active";
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
    if (refusedBeforeStart(got.record)) return html``;
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
/**
 * A live transcript whose read failed (`data.transcript.unreachable`), said the same at every place the page mentions
 * the transcript (issue #962): never "no longer kept" or a reason the run has none, which only a read can say.
 */
export const TRANSCRIPT_UNREAD_TEXT = "The live transcript could not be read; the next update tries again.";
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

/** The banner for a run whose record could not be read (`readRunById`'s `unreadable`, what could not be read). */
export function runUnreadText(why) {
  return `${capitalised(String(why))}, so this page cannot say what the run did. Reload to try again.`;
}

/**
 * The banner for a run whose record both sides said they do not hold while no other place shows a run and some could
 * not be read (`runPlaces`' `unread`, in `RUN_PLACES`' words): the page names what it could not read rather than say
 * there is no run.
 */
export function runUntoldText(unread) {
  return `No record of this run is in this host's history or the fleet's run mirror, but this page could not read ${runPlacesText(unread)}, so it cannot say whether the run exists. Reload to try again.`;
}

/**
 * Why the page has no record, said ONCE (issue #710): not a run id, a running job (a record is written at its end), a
 * queued job, a record that could not be read (`runUnreadText`), a job the queue holds as ended whose record this host
 * cannot read, a run no place shows while some could not be read (`runUntoldText`, issue #737: the places, the queues
 * and the live transcript included, for both roles), or no such run. `{ cls, text }`.
 *
 * THE TONE IS THE JOB'S, DELIBERATELY, and none of these prints an outcome word (there is no outcome yet, or none this
 * page can read). A job that exists and has not ended (queued, running) is a grey `note`: nothing is wrong, the record
 * comes at its end. What the page cannot show is an amber `warn`: an id that is not one, a run no history or mirror
 * holds, a record or a place that could not be read, and an ended job whose record is not readable here. Never `bad`:
 * no run failed that this page knows of.
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
  if (typeof state === "string" && QUEUED_STATES.includes(state)) return { cls: "note", text: "This job is queued and has not started yet: a run's record is written when it ends, and its live transcript attaches on this page once it runs." };
  // A record neither side said it does not hold (`missing`) is one this page could not read, whatever it was handed.
  if (got?.missing !== true) return { cls: "warn", text: runUnreadText(typeof got?.unreadable === "string" ? got.unreadable : RUN_RECORD_UNREAD) };
  if (state === "completed" || state === "failed") return { cls: "warn", text: "This job has ended, but its record is not in this host's history or the fleet's run mirror (another host's run, with the mirror off?)." };
  // The load's own answer where it told one (`data.runPlaces`): an agent's copy of the data holds no transcript and no
  // progress, and neither is a place that could not be read.
  const told = view.data?.runPlaces;
  const places = told !== null && typeof told === "object" && typeof told.shown === "boolean" && Array.isArray(told.unread) ? told : runPlaces({ run: got, lookup: view.data?.chat, transcript: view.data?.transcript, progress: view.data?.progress });
  if (!places.shown && places.unread.length > 0) return { cls: "warn", text: runUntoldText(places.unread) };
  if (typeof state === "string") return { cls: "warn", text: `The queue holds this job in a state this console does not name yet (${state}); its run record is not readable here.` };
  return { cls: "warn", text: "No run with that id is in this host's history or the fleet's run mirror." };
}

/**
 * The console page that fixes what a refusal names (issue #849), beside the catalog's own "What to do", which stays word for word (`INT-REASON-CATALOG`).
 * Only pages with a form that fixes it, and only for a run refused on this console's own host (`data.selfHost`), since the secret profiles a page writes
 * are this host's. REJECTED: links to pages that only show the problem (subscription authentication, egress, MCP servers); a provider key, which the page
 * writes only under the host-setup grant; and an invalid settings overlay, which the settings form refuses to change until the file is fixed by hand: a
 * button there would send a person somewhere that cannot do it. A test holds each
 * key to a catalog token and each link to a page's own panel.
 */
export const REASON_FIXES = Object.freeze({
  "secret-profile-unknown": Object.freeze({ label: "Declare it on Secrets", href: "/config/secrets#p-secret-add", icon: "key" }),
  "secret-bundle-profile-unknown": Object.freeze({ label: "Declare it on Secrets", href: "/config/secrets#p-secret-add", icon: "key" }),
  "secret-bundle-profile-ambiguous": Object.freeze({ label: "Open Secrets", href: "/config/secrets#p-secret-bundles", icon: "key" }),
});

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
  const r = recordOf(view);
  if (!r) {
    const { text } = absentOutcome(view);
    return ui.banner({ status: "idle", title: text });
  }
  if (fromNewerRelease(r)) return newerOutcome(r);
  const token = recordReason(r);
  const w = outcomeWord(r.outcome, token);
  const recovering = token === "recovery-enqueued" && [view.data?.chat?.activeJobId, view.data?.chat?.queuedJobId].some((id) => typeof id === "string" && id !== r.jobId);
  // Issue #800: a clean exit is not proof. The record's outcome stays completed, so every count does; only the word changes.
  const note = outcomeNote(r);
  const lacked = outcomeBanner(r);
  const word = recovering ? "Failed, continuing" : refusedBeforeStart(r) ? w.word === "cancelled" ? "Cancelled before it started" : "Refused before it started" : note ?? capitalised(w.known ? w.word : bannerCut(r.outcome));
  const started = msOf(r.startedAt), ended = msOf(r.endedAt);
  const where = r.host ? ` on ${r.host}${String(r.backend).startsWith("openshell") ? ", in an OpenShell sandbox" : ""}` : "";
  const duration = Number.isFinite(started) && Number.isFinite(ended) ? `: finished in ${ageText(ended - started)}${where}` : where;
  const said = token ? explainReason(token, { why: r.why }) : null;
  const reason = said?.known ? ui.withCode(said.sentence) : token ? html`${bannerCut(token)}, ${NO_EXPLANATION}.` : html`${NO_REASON_TEXT[w.word] ?? NO_REASON_TEXT.failed}${w.word === "failed" ? view.role === "operator" ? " The Fleet page's failed list may say more." : " Failure reasons are shown to operators only." : ""}`;
  const next = said?.known ? html`<p><strong>What to do:</strong> ${ui.withCode(token === "awaiting-input" && answerRefusedHere(view) ? AWAITING_INPUT_ELSEWHERE : said.next)}</p>${docsHref(said.anchor) ? ui.outLink({ href: docsHref(said.anchor), label: "Read more in the reasons docs" }) : null}` : null;
  const href = forgeLinkOf(r, view.env);
  const recoveryId = view.data?.chat?.activeJobId ?? view.data?.chat?.queuedJobId;
  const recoveryActions = recovering ? html`${typeof recoveryId === "string" && RUN_ID_RE.test(recoveryId) ? ui.btn({ href: `/run?id=${encodeURIComponent(recoveryId)}`, label: "Open recovery run", kind: "primary", icon: "running" }) : null}${view.data?.siblings?.map((s) => ui.btn({ href: `/run?id=${encodeURIComponent(s.jobId)}`, label: "Open sibling replica", kind: "sm", icon: "runs" }))}` : null;
  const fixLink = r.outcome === "policy" && !["awaiting-input", "awaiting-approval"].includes(token) && /^[a-f0-9]{64}$/.test(r.touchScopeId ?? "") ? ui.btn({ href: `/config?becauseRun=${encodeURIComponent(r.jobId)}`, label: "Fix configuration", kind: "sm", icon: "config" }) : null;
  const here = typeof view.data?.selfHost === "string" && view.data.selfHost !== "" && r.host === view.data.selfHost;
  const reasonFix = token && here && canAct(view) && Object.hasOwn(REASON_FIXES, token) ? REASON_FIXES[token] : null;
  const actions = view.role !== "operator" ? null : recovering ? recoveryActions : html`${lacked ? lacked.fixes.map((fix) => fixButton(fix, { repositoryHref: forgeBaseLinkOf(r, view.env) })) : null}${reasonFix ? ui.btn({ href: reasonFix.href, label: reasonFix.label, kind: "sm", icon: reasonFix.icon }) : null}${refusedBeforeStart(r) ? ui.btn({ href: "/fleet", label: "Open Fleet", kind: "primary", icon: "fleet" }) : href ? ui.outLink({ href, label: "Open target on the forge", btn: "primary" }) : null}${r.outcome === "completed" && !["awaiting-input", "awaiting-approval"].includes(token) ? ui.btn({ href: "#p-workspace", label: "Try it in its workspace", kind: "sm", icon: "terminal" }) : null}${rerunLine(r, view)}${fixLink}`;
  return ui.banner({ block: true, status: recovering ? "running" : note !== null ? "attention" : w.status, title: `${word}${refusedBeforeStart(r) ? "" : duration}`, body: html`${lacked === null || token ? html`<p>${reason}</p>` : null}${lacked === null ? null : lacked.sentences.map((sentence) => html`<p>${sentence}</p>`)}${next}${(view.data?.children?.length ?? 0) > 0 || r.chainRefused > 0 ? html`<p>${queuedText(view.data)}${r.chainRefused > 0 ? `, and ${r.chainRefused} more requests were refused: a job may queue at most ${view.data?.chainMaxPerJob ?? CHAIN_MAX_PER_JOB_DEFAULT}` : ""}. ${view.data?.children?.map((child) => runLink(child.jobId))}</p>` : null}${refusedBeforeStart(r) ? html`<p>Nothing was spent.</p>` : href ? html`<p>Merges are never automatic: a person merges the pull request on the forge.</p>` : null}`, actions });
}

/**
 * How many runs the banner says a run queued from /outbox: the children the search found, "at least" that many where
 * the search was incomplete (`childrenIncomplete`, issue #962), and with none found then, that the number is not known,
 * never "0 runs" over pages nobody read.
 */
export function queuedText(data) {
  const n = Array.isArray(data?.children) ? data.children.length : 0;
  if (!data?.childrenIncomplete) return `It queued ${plural(n, "run")} from /outbox`;
  return n > 0 ? `It queued at least ${plural(n, "run")} from /outbox (the search for them was incomplete)` : "How many runs it queued from /outbox is not known (the search for them was incomplete)";
}

/**
 * The banner for a record a NEWER pi-dispatch wrote (issue #761): its outcome and times, which keep their meaning in
 * every release, and the one sentence that says why the page shows nothing else. No reason, no next step and no action:
 * each reads a field past the stable core, which this record reaches the page without.
 */
function newerOutcome(r) {
  const w = outcomeWord(r.outcome, null);
  const started = msOf(r.startedAt), ended = msOf(r.endedAt);
  const where = r.host ? ` on ${r.host}` : "";
  const duration = Number.isFinite(started) && Number.isFinite(ended) ? `: finished in ${ageText(ended - started)}${where}` : where;
  return ui.banner({ block: true, status: w.status, title: `${capitalised(w.known ? w.word : bannerCut(r.outcome))}${duration}`, body: html`<p>${NEWER_RECORD_SENTENCE}.</p>` });
}

/** The "Run" card for a record a newer pi-dispatch wrote (issue #761): its stable core alone, each field by name. */
function newerSummary(r, source) {
  const started = msOf(r.startedAt), ended = msOf(r.endedAt);
  return titled("Run", facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Outcome", outcomeText(r)],
    ["Attempt", cell(r.attempt)],
    [kindLabel(r.kind), cell(r.kind)],
    ["Project", cell(r.project)],
    ["Host", cell(r.host)],
    ["Started", timeHtml(started)],
    ["Ended", timeHtml(ended)],
    ["Took", Number.isFinite(started) && Number.isFinite(ended) ? ageText(ended - started) : "-"],
    ["Read from", source === "host" ? "the worker holding this run" : source === "mirror" ? "the fleet's run mirror" : "this host's run history"],
  ]));
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
  const f = g.phase;
  if (!f && g.phases.length === 0) return ui.noProgress("The worker reports no phase progress.");
  const total = f ? Math.max(g.phases.length, f.index + 1) : g.phases.length;
  return html`${f ? html`<p class="run-phase">Phase ${f.index + 1} of ${count(total)}${f.done !== null ? `: ${count(f.done)}${f.total !== null ? ` of ${count(f.total)}` : ""} done` : ""}</p>` : null}${ui.phases({ names: Array.from({ length: total }, (_, i) => operator ? g.phases[i] ?? `Phase ${i + 1}` : `Phase ${i + 1}`), index: f?.index ?? 0, done: f?.done, total: f?.total })}${operator ? g.note !== null ? html`<p class="run-note">${ui.icon("runs", { size: "sm" })}<span>Note from the run: ${g.note}</span></p>` : null : html`<p class="card__sub">Phase names and the run's note are shown to operators only.</p>`}`;
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
  const running = g.running.length === 0 ? html`<p class="note">${g.ended ? `The run has ended (${typeof g.outcome === "string" ? (outcomeWord(recordOf(view)?.outcome ?? g.outcome, recordReason(recordOf(view))).word ?? recordOf(view)?.outcome ?? g.outcome) : "unknown"}).` : "No step is running."}</p>` : html`<ul class="plain">${g.running.map((r) => html`<li><span class="mono">${r.tool}</span> ${open(r)}</li>`)}</ul>`;
  const recent = [...g.recent].reverse().slice(0, 3);
  const max = view.data?.activeRun?.maxTurns;
  const stepRow = (r) => ui.rowPill({
    icon: r.status === "ok" ? "done" : "failed",
    status: r.status === "ok" ? "ok" : "failed",
    items: [html`<span class="code">${r.tool}</span>`, html`<span class="run-st tinted">${r.status}</span>`],
    end: html`<span>${stepDuration(r.durationMs)}</span><span class="run-at">${timeHtml(r.at)}</span>`,
  });
  // The rare rows stay facts: on most runs none of them draws, and the run's own numbers lead (the RunLive card).
  const rare = [
    ["Interrupted steps", g.interrupted > 0 ? count(g.interrupted) : null],
    ["Replayed calls", Number.isSafeInteger(g.replayed) ? count(g.replayed) : null],
    // The resume prior: what the session's earlier runs did before this run resumed it, not this job's retries.
    ["Earlier runs of this session", g.prior ? `${count(g.prior.turns)} turns, ${count(g.prior.steps)} steps before this run resumed the session` : null],
  ].filter(([, value]) => value !== null);
  return html`${stale !== null ? html`<p class="warn">Stale: ${staleText(stale)}${view.data?.activeRun?.host ? ` on ${view.data.activeRun.host}` : ""}. <a href="/fleet">Open Fleet</a>.</p>` : null}<div class="run-prog"><div class="run-big"><p class="kpi"><b class="run-tc">${Number.isFinite(now) && now >= g.startedAt ? timecode(now - g.startedAt) : "-"}</b><span>elapsed since ${timeHtml(g.startedAt)}</span></p></div><dl class="run-stats"><div><dt>Turn</dt><dd><span><b>${count(g.turn)}</b>${Number.isSafeInteger(max) ? ` of ${max}` : ""}</span></dd></div><div><dt>Steps</dt><dd><span><b>${count(g.steps)}</b>${g.failed > 0 ? `, ${count(g.failed)} failed` : ""}</span></dd></div><div class="tone-running"><dt>Running now</dt><dd>${running}</dd></div></dl></div>${rare.length ? facts(rare) : null}${phaseBody(g, operator)}<h3 class="run-sub">Recent steps</h3>${recent.length ? html`<ul class="rows">${recent.map(stepRow)}</ul>` : html`<p class="note">No step has finished yet.</p>`}<p class="run-at">Updated ${timeHtml(g.updatedAt)}</p>`;
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
    const nextProgress = view.data?.recoveryProgress?.progress;
    return titled(title, html`${line}${recordProgressBody(record) ?? html`<p class="note">This attempt's record holds no progress.</p>`}${isProgressSnapshot(nextProgress) ? html`<h3>Recovery progress</h3>${liveProgressBody(nextProgress, { ...view, data: { ...view.data, run: null, activeRun: view.data.recoveryLive } })}` : null}`);
  }
  const live = isProgressSnapshot(g) ? g : null;
  const recordEnd = typeof record?.endedAt === "string" ? Date.parse(record.endedAt) : Number.NaN;
  if (record && live && Number.isFinite(recordEnd) && live.startedAt > recordEnd) {
    const outcome = typeof record.outcome === "string" && /^[a-z-]{1,40}$/.test(record.outcome) ? record.outcome : "unknown";
    return titled(title, html`<p class="note">An earlier attempt of this run ended (${outcome}); this is the attempt after it.</p>${liveProgressBody(live, { ...view, data: { ...view.data, run: null } })}`);
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
  if (live) return ui.card({ title, end: !live.ended && progressStaleFor(live, view.now) === null ? ui.chip("live", { status: "running", icon: "running" }) : null, body: liveProgressBody(live, view) });
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
    if ((e.state !== "queued" && e.state !== "written") || typeof e.id !== "string" || !MESSAGE_ID_RE.test(e.id)) return null;
    return actForm("steer-withdraw", { hidden: [["jobId", jobId], ["id", e.id]], label: "Withdraw" });
  };
  const entries = Array.isArray(box.entries) ? box.entries : null;
  const list =
    entries === null
      ? html`<p class="warn">The messages could not be read this time; the next refresh tries again.</p>`
      : entries.length === 0
        ? html`<p class="note">No message has been sent to this run.</p>`
        : html`<ul class="rows">${entries.map((e) => ui.rowPill({
            icon: e.state === "delivered" ? "done" : "clock",
            items: [html`<span class="run-inbox"><strong>${cell(MODE_WORD[e.mode])}</strong> <span class="muted">${cell(e.source)}, ${e.bytes === 1 ? "1 byte" : `${count(e.bytes)} bytes`}</span><br><span class="run-at">${Number.isSafeInteger(e.at) ? timeHtml(e.at) : "-"}</span> <span class="code">${cell(e.id)}</span></span>`],
            end: ui.chip(e.state, { icon: e.state === "delivered" ? "done" : e.state === "withdrawn" ? "cancel" : "clock" }),
            action: withdraw(e),
          }))}</ul>`;
  // Issue #647: when the Chat panel draws the message forms (a live run an operator can steer), they are drawn THERE and
  // not here, so the page holds one steer form per mode, never two copies of the same action.
  const forms = act && takes && !chatDrawsSteer(view) ? steerForms(jobId) : null;
  const cont = next !== null ? html`<p class="note">This job is ${cell(box.state)}; its run continues as ${runLink(next)}, and a message sent here goes to that job.</p>` : null;
  return titled(title, html`${cont}<p class="note">${status}</p>${entries ? ui.meter({ value: entries.length, max: STEER_MAX_MESSAGES, label: "Messages" }) : null}${entries ? ui.meter({ value: entries.reduce((n, e) => n + (e.bytes ?? 0), 0), max: STEER_TOTAL_MAX_BYTES, label: "Bytes" }) : null}${entries?.some((e) => e.state === "late") ? html`<p>Late: the run ended before the message arrived, so the agent never saw it.</p>` : null}${list}${forms}<p class="note">A message's text is never listed: the run reads it, and the audit log keeps its sha256.</p>`);
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

  const title = "Chat";
  if (record?.purpose === "answer-draft") return titled(title, html`<p>This draft helper takes no replies. Review and send the answer from the parked source run ${runLink(record.answerDraft?.sourceRunId)}.</p>`);
  if (chat.unreachable) return titled(title, html`<p class="warn">The queue could not be read (is Valkey reachable?), so whether this run can chat is unknown. The next refresh tries again.</p>`);
  const jobId = typeof view.query?.id === "string" && RUN_ID_RE.test(view.query.id) ? view.query.id : null;
  const answering = chat.state === "answered" && typeof chat.answeringJobId === "string";
  const status = html`<p>This run is ${answering ? "being answered" : Object.hasOwn(CHAT_STATE_WORD, chat.state) ? CHAT_STATE_WORD[chat.state] : "unknown"}.</p>`;
  if (!record && view.data?.run?.missing !== true && chat.state === "unknown") return titled(title, html`<p>The run's chat state is unknown while its record could not be read.</p>`);
  if (view.role !== "operator") return titled(title, html`${status}<p class="note">Chat is for operators; a viewer sees the run's status only.</p>`);
  if (chat.mode !== "live" && chat.mode !== "reply" && chat.mode !== "fork") return titled(title, html`${status}<p class="note">${typeof chat.says === "string" ? chat.says : "This run has no chat."}</p>${chatHeldBy(chat)}`);
  if (jobId === null) return titled(title, html`${status}<p class="note">Chat is for operators; a viewer sees the run's status only.</p>`);
  const terminal = (id) => command(id, record?.host);
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
    return titled(title, html`${status}${via}${send}${readOnly}`);
  }
  if (chat.mode === "reply") {
    const offered = view.query?.id === view.data?.answerer?.privateDraft?.meta?.runId ? offeredAnswerDraft(view) : null;
    const link = view.data?.run?.record ? targetLink(view.data.run.record, view.env) : "-";
    // Issue #647: the form only where the planner would plan the answer (`parkedAnswerCheck`, its own predicate): a pull
    // request's park, a forge without a reply route or expired job data shows the planner's sentence instead. A check that
    // could not be read keeps the form and says so (the planner checks again before anything is queued).
    const check = view.data?.chatAnswer ?? null;
    const refusal = typeof check?.refusal === "string" ? check.refusal : null;
    const why = check?.unreachable ? html`<p class="warn">Whether it can be answered from here could not be read; the preview checks again.</p>` : null;
    const keptTranscript = view.data?.transcript?.exists === true;
    // A transcript that could not be read is not one that expired (issue #962): the forge thread still holds the question.
    const question = keptTranscript ? html`<div data-run-question></div><p class="card__sub">The question is the last assistant entry of the transcript <a href="#transcript">below</a>.</p>` : html`<p>Read the question on the forge thread: ${link}. ${view.data?.transcript?.unreachable ? TRANSCRIPT_UNREAD_TEXT : "The live transcript is no longer kept."}</p>`;
    const answer = refusal !== null ? ui.banner({ status: "attention", sm: true, title: PARKED_ELSEWHERE_TITLE, body: refusal, actions: forgeLinkOf(record, view.env) ? ui.outLink({ href: forgeLinkOf(record, view.env), label: "Answer on the forge", btn: "primary" }) : null }) : canAct(view) ? record?.reason === "awaiting-approval" ? ui.approvalForms({ jobId, id: "run-approval" }) : ui.answerForm({ jobId, id: "run-answer", hint: "Preview the answer before posting it and resuming the run.", guarded: Boolean(view.data?.answerer?.rules?.length), value: offered?.draft ?? "", draft: offered ? { draftRunId: offered.meta.draftRunId, digest: offered.digest } : null, keepStanding: Boolean(view.data?.answerer?.rules?.length && record?.project) }) : readOnly;
    const gate = record?.reason === "awaiting-approval" ? html`<p>Awaiting approval for <span class="code">${record.approval?.action ?? "unknown action"}</span>.</p><p>${record.approval?.action === "budget-raise" ? "Worker-enforced: the declared cap remains subject to deployment and scoped budgets." : "Advisory: the worker does not enforce this external action."}</p>` : null;
    return ui.questionCard({ jobId, waited: Number.isFinite(msOf(record?.endedAt)) ? ageText(view.now - msOf(record.endedAt)) : null, project: record?.project, target: link, body: html`${gate}${question}${why}`, answer: html`${answer}${view.data?.answerer?.rules?.length && record?.project && changesOffered(view) && record?.reason !== "awaiting-approval" ? standingAnswerEditor({ id: "standing-from-answer", projects: [record.project], runId: jobId, repo: `${record.kind}:${String(record.target ?? "").split("#")[0]}` }) : null}` });
  }
  // fork: whether the record names a session the host-local fork can find, said before the command is offered.
  const kept = sessionSavedOf(record);
  const why = !kept ? record?.session?.reason ? `${nestedText("session.reason", record.session.reason)} There is no saved transcript to fork.` : "This run's trigger keeps no session (no run.resume), so there is no transcript to fork." : sessionKeyOfRecord(record) === null ? "This run's session cannot be found from its record (a pull or merge request's session is keyed by its head branch, which the record does not carry), so a fork would refuse." : null;
  if (why !== null) return titled(title, html`${status}<p class="note">${why}</p>`);
  return titled(title, html`${status}<p class="note">Continue it in your own pi, as a fork of its session: run this on a host that holds the session store (PI_SESSIONS_DIR). The session's transcript is not redacted and goes to your pi's provider; the run's own transcript is never written.</p>${chat.newer?.jobId ? html`<p class="warn">The session holds a later run's turns too: ${runLink(chat.newer.jobId)} continued it on ${record.target} after this run.</p>` : null}${terminal(jobId)}`);
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
 * What the run page says of a sandbox whose manifest this host read and refused (`sandboxRetentionOf`'s `why`), when
 * the pane's own words (`reason`) would not read as a sentence after "Its workspace is".
 */
const SANDBOX_KEPT_TEXT = Object.freeze({
  "retention-off": "Its workspace was not kept: sandbox retention is off on this host (PI_SANDBOX_RETENTION_HOURS=0).",
  swept: "Its workspace is no longer kept on this host: it was swept after its retention window, or never kept.",
  // Issue #761: the manifest's version is above what this release reads, so no shell of it opens the workspace; the
  // retention sweep still honours its deadline, which keeps its meaning in every version.
  "manifest-newer": "Its workspace was kept by a newer pi-dispatch, whose manifest this release cannot read: open it with the pi-dispatch of that release on its host.",
});

/**
 * The verdicts (`sandboxRetentionOf`'s `why`) that hide the sandbox command: the ones true whatever the shell that runs
 * it blesses. A venue-policy verdict (`unblessed`, `policy-unreadable`, and any word added later) never hides it
 * (review round 1): the console never sees the PI_BACKENDS that shell opens under (`OQ-038`), so it would hide the
 * command of every podman run, and the opener's own venue check (`sandboxVenueRefusal`) is the one that can tell. The
 * fleet reader asks with the policy unknown, so those words should not reach here; this list is the backstop.
 */
const SANDBOX_CERTAIN = new Set(["retention-off", "swept", "id-mismatch", "manifest-newer", "no-image", "workspace-gone", "venue", "no-venue", "no-launcher"]);

/** Codes the fork reader returns, in words a person can act on. Anything else it says is already a sentence. */
const FORK_REFUSAL_WORDS = Object.freeze({
  "fork-source-store-unset": "this host keeps no saved sessions (PI_SESSIONS_DIR is not set)",
  "fork-source-unavailable": "no saved session is available for this run",
});
const forkRefusalWords = (refusal) => FORK_REFUSAL_WORDS[refusal] ?? refusal;

/** One decision for the row and its action. Tracking loss is unknown, never evidence that a shell or workspace ended. */
/**
 * Under the Workspace row, why an absent watcher is not inferred (issue #988, `shellsShort`): the shells or the
 * browser sessions were not read, or the list is cut at its cap, or a registration in it does not parse. One sentence,
 * "could not be read", said all three, so a deployment with more open shells than the list holds said it for good.
 */
const SHELLS_NOTE = Object.freeze({
  unread: "Some shell or browser status could not be read; an absent watcher is not inferred.",
  cut: `More shells are open than the first ${SHELLS_SHOWN} this list holds; an absent watcher is not inferred.`,
  rows: "A registration in the open shells' list does not parse and is left out; an absent watcher is not inferred.",
});
const shellsNote = (data) => {
  const why = shellsShort(data);
  return why === null ? null : html`<p class="note" role="status">${SHELLS_NOTE[why]}</p>`;
};

export function runWorkspaceState(view) {
  const r = recordOf(view), data = view.data ?? {};
  const id = r?.jobId ?? view.query?.id;
  const active = data.chat?.jobState === "active" || data.chat?.state === "active" || runningWithoutRecord(view) || r?.reason === "recovery-enqueued" && Boolean(data.chat?.activeJobId || data.chat?.queuedJobId);
  if (active) return { kind: "running", id, title: "Opens when it ends.", text: "To change it now, steer it. The running job's container is never a browser terminal." };
  if (!r) return { kind: "unknown", id, title: "Workspace unknown.", text: "This run's record is unavailable; no workspace or shell is inferred." };
  if (refusedBeforeStart(r) || r.reason === "container-never-started") return { kind: "nothing", id, title: "Nothing to open.", text: r.reason === "container-never-started" ? "Its container never started." : "The run was refused before it started." };
  const published = data.workspace ?? {};
  const check = data.sandboxCheck;
  const shell = published.shell ?? data.browserGateways?.sessions?.find((s) => s.host === r.host && s.id === r.jobId) ?? null;
  const certain = check?.retained === true || check?.retained === false && SANDBOX_CERTAIN.has(check.why) || check?.why === "past-window" ? check : null;
  const evidence = certain ?? published;
  const until = Number.isSafeInteger(evidence.until) ? evidence.until : msOf(evidence.until);
  const venue = r.backend ?? UNATTRIBUTED_BACKEND;
  const noVenue = sandboxShellRefusal(venue);
  if (!shell && (noVenue || evidence.retained === false || Number.isFinite(until) && until <= view.now)) return { kind: "prepare", id, host: r.host, title: noVenue ? "Cannot reopen." : evidence.why === "retention-off" ? "Not kept." : "Workspace gone.", text: noVenue ? `Its ${venue} venue cannot reopen a sandbox.` : evidence.why === "retention-off" ? "Workspace retention is off on its host." : "It was swept or never kept, or it is past its opening window.", until };
  const purpose = ["awaiting-input", "awaiting-approval"].includes(recordReason(r)) ? { title: "Look before you answer.", text: "Your answer starts a new job, so put what you find in it; shell edits do not reach it." } : outcomeWord(r.outcome, recordReason(r)).word === "failed" ? { title: "Reproduce it.", text: "The kept sandbox uses the run's recorded limits." } : { title: "Try it before you merge.", text: "The native terminal checks the workspace again before opening." };
  return { kind: shell ? "open" : evidence.retained === true ? "kept" : "unknown", id, host: r.host, shell, until, ...purpose, ...(shell || evidence.retained === true ? {} : { text: "The workspace's current retention could not be verified. The native command checks again; missing tracking does not prove it was swept." }) };
}

export function runWorkspace(view) {
  if (view.role !== "operator") return html``;
  const state = runWorkspaceState(view), r = recordOf(view);
  let actions = null, more = null;
  if (state.kind === "running") actions = !view.readOnly ? ui.btn({ href: "#p-chat", label: "Steer this run", kind: "sm", icon: "steer" }) : null;
  else if (state.kind === "prepare") actions = !view.readOnly ? ui.btn({ href: `/runs/sandboxes?${new URLSearchParams({ fromRun: state.id })}`, label: "Prepare from this run", kind: "sm", icon: "plus" }) : null;
  else if (r && ["open", "kept", "unknown"].includes(state.kind) && RUN_ID_RE.test(state.id ?? "")) {
    const verb = state.shell ? "attach" : "open";
    if (!view.readOnly) actions = html`${state.shell ? sandboxBrowserLink(view, state.shell) : null}${typeof state.host === "string" ? sandboxNativeLink({ id: state.id, host: state.host, verb }) : null}`;
    const copy = typeof state.host === "string" ? sandboxCopy({ id: state.id, host: state.host, verb, config: view.data?.sandboxHosts }) : html`<aside data-sandbox-command>${ui.cmd(["pi-dispatch", "sandbox", state.id], { host: "Run on the host that kept this workspace; its historical host was not recorded." })}</aside>`;
    more = html`<details class="ws-more"><summary>${view.readOnly || !state.shell ? "Copy the command" : "Copy the command, or end the shell"}</summary><div class="ws-more__b">${copy}${!view.readOnly && state.shell ? ui.actForm({ action: "sandbox-end", hidden: [["host", state.shell.host], ["id", state.shell.id], ["nonce", state.shell.nonce], ["containerId", state.shell.containerId]], label: "Preview End", kind: ["sm", "danger"], icon: "cancel" }) : null}</div></details>`;
  }
  // Who is in it comes first, and what opening it would do depends on who is reading: a watcher never joins, they only see.
  const driver = state.shell ? view.data?.browserGateways?.drivers?.find((s) => s.host === state.shell.host && s.id === state.shell.id && s.containerId === state.shell.containerId && s.nonce === state.shell.nonce) : null;
  const since = Number.isFinite(state.shell?.since) ? html`, since ${timeHtml(state.shell.since)}` : null;
  const opener = html`<b>${state.shell?.by ?? "The native terminal operator"}</b> opened the shell${since}.`;
  const shared = driver?.watching && driver.by !== view.name;
  const line = !state.shell ? html`<b>${state.title}</b> ${state.text}`
    : shared ? html`<b>${driver.by} is driving</b>, and lets operators watch. You see new output and cannot type.`
    : html`${opener}${view.readOnly ? null : " Opening it joins that shell."}`;
  // Watching and joining are different promises: Open in Terminal still shares the driver's prompt, so say so here.
  const below = !state.shell ? null
    : shared ? html`<p class="sx-open__s">${opener}${view.readOnly ? null : " A native terminal joins that shell and its prompt."}${driver.watchers?.length ? ` Watching now: ${driver.watchers.map((w) => w.name).join(", ")}.` : null}</p>`
    : sandboxDriverLine(view, state.shell);
  const points = view.data?.forkPoints;
  const canFork = points?.ok && points.entries?.some((entry) => entry.positions?.length);
  const found = r && !view.readOnly && !["nothing", "running"].includes(state.kind) ? html`<p class="ws-found"><b>Found something?</b><a class="link" href="/triggers">Add it to a trigger’s instructions</a>${canFork ? html`<a class="link" href="#run-fork">Fork it with a message</a>` : html`<span>Fork unavailable: ${(r.forkSource?.saved === false ? forkRefusalWords(forkArchiveFact(r.forkSource).reason) : forkRefusalWords(points?.refusal)) ?? "no exact retained point is available"}.</span>`}</p>` : null;
  // A gone workspace has no "kept until", and "not verified" would contradict the row beneath it.
  const sub = !state.host ? null : state.kind === "prepare" ? html`on ${state.host}` : state.until && Number.isFinite(state.until) ? html`kept on ${state.host} until ${timeHtml(state.until)}` : html`on ${state.host}, retention not verified`;
  return ui.card({ title: "Workspace", sub, body: html`<div class="ws-row"><p class="ws-row__t"><span class="dot ${state.kind === "open" ? "tone-running" : "tone-idle"}"></span><span>${line}</span></p><div class="ws-row__a">${actions}</div></div>${below}${shellsNote(view.data)}${more}${found}` });
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
  if (refusal !== null) return html`${ui.btn({ label: "Preview a re-run", kind: ["sm", "paid"], disabled: true })}<p class="card__sub">Not offered for a re-run: ${refusal}.</p>`;
  return ui.actForm({ action: "rerun", hidden: [["jobId", r.jobId]], label: "Preview a re-run", kind: ["sm", "paid"], icon: "rerun" });
}

/**
 * The run summary's skip rows (issue #712): "Steering" (why a steer-armed run took no message, the record's
 * `steerSkipped`) and "Live transcript" (why it had none, `liveSkipped`), each the closed enum and its sentence; no row
 * for a record that carries neither, so every other run renders byte-identical. A transcript whose read failed is "could
 * not be read" (issue #962), never one of the reasons a run has none.
 */
function skipRows(r, view) {
  const { liveSkipped, steerSkipped } = recordSkips(r);
  return [
    ["Steering", steerSkipped !== null ? `skipped: ${STEER_SKIPPED_TEXT[steerSkipped]}` : r.steered ? `armed: ${r.steered.delivered} delivered, ${r.steered.late} late, ${r.steered.withdrawn} withdrawn` : "not armed: its trigger sets no run.steer"],
    ["Live transcript", liveSkipped !== null ? `none: ${LIVE_SKIPPED_TEXT[liveSkipped]}` : view?.data?.transcript?.exists ? "streamed, kept 24 hours after the end" : view?.data?.transcript?.unreachable ? TRANSCRIPT_UNREAD_TEXT : transcriptAbsentText(r)],
  ];
}

/** What today's triggers file says the trigger matches, or nothing: an agent's copy keeps none of it, and an empty clause would still name the file. */
function triggerMatchWords(view) {
  const trigger = view.data?.trigger;
  const said = trigger ? [trigger.phrase, trigger.label, trigger.pattern].filter(Boolean).join(", ") : "";
  return said === "" ? "" : `: ${said} (as the triggers file says now)`;
}

/**
 * The Run card's MCP row: what today's triggers file names, and only where nothing better is on the page. A record whose `loaded.mcp`
 * says what connected is the Loaded card's, and today's file beside it could disagree. Every other record says nothing of it (older,
 * `absent`, `invalid`, `cut`, stopped at the loader), so the row stands. An agent's page has no row: its copy has no `loaded`, so "the record
 * does not say" would be false of it, and the projection keeps no server's name, so it would read "none" of a trigger that names one.
 */
function triggerServersRow(view, r) {
  const trigger = view.data?.trigger;
  if (!trigger || view.role === "agent") return null;
  const servers = trigger.mcp?.length ? trigger.mcp.join(", ") : "none";
  return Array.isArray(loadedOf(r)?.mcp) ? null : `${servers} (as the triggers file says now; the record does not say which connected)`;
}

/**
 * The run summary's OpenShell rows (issue #712): "Sandbox policy" (the mode, the credential providers and placeholders
 * the sandbox was given) and "Rule hosts" (the hosts its policy admitted, with the count of any the record does not
 * list), the worker's rebuild (`recordOpenshell`: hosts held to the host-name charset), escaped by the renderer; and
 * "Secrets profile", the profile NAME run.secrets resolved through. No row for a record without the keys, so every
 * other run renders byte-identical. MCP connection state is no part of these fields: the record's `loaded.mcp` holds it (#800).
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
  const said = b ? [bundleReceivedText({ ...b, variables: b.variables.filter((name) => !b.shadowed.includes(name)) }), b.shadowed.length > 0 ? `shadowed by the trigger's own run.secrets: ${b.shadowed.join(", ")}` : null, bundleCountsText(b) || null].filter(Boolean) : [];
  return [
    ["Secret bundle", said.length > 0 ? said.join("; ") : null],
    ["Bundle skipped", got.bundleSkipped !== null ? `${got.bundleSkipped}: ${BUNDLE_SKIPPED_TEXT[got.bundleSkipped]}` : null],
  ];
}

/** Lineage is identifiers only. A damaged record never supplies link targets or arbitrary text. */
function forkRows(record) {
  const f = record.fork;
  if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.fromJob !== "string" || typeof f.fromEntry !== "string" || !/^[0-9a-f]{32}$/.test(f.id ?? "") || !RUN_ID_RE.test(f.fromJob ?? "") || !/^[0-9a-f]{8}$/.test(f.fromEntry ?? "") || !["before", "at"].includes(f.position)) return [];
  return [["Forked from", runLink(f.fromJob)], ["Fork point", `${f.position} ${f.fromEntry}`], ["Fork model", typeof f.model === "string" && modelIdProblem(f.model) === null ? f.model : null]];
}

const recordSummary = withRun("Run", (r, view, source) => {
  const started = msOf(r.startedAt);
  const ended = msOf(r.endedAt);
  return html`${facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Target", targetLink(r, view.env)],
    [kindLabel(r.kind), cell(r.kind)],
    ["Flow", cell(r.flow)],
    ["Outcome", outcomeText(r)],
    ["Reason", recordReason(r)],

    ["Exit code", cell(r.exitCode)],
    ["Attempt", cell(r.attempt)],
    ...recoveryRows(r),
    ...forkRows(r),
    ["Host", cell(r.host)],
    [VENUE_LABEL, cell(r.backend)],
    ...skipRows(r, view),

    ["Project", cell(r.project)],

    ["Provider and model", [r.provider, r.model].filter(Boolean).join(" / ") || "-"],
    ["Model role", typeof r.modelRole === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(r.modelRole) ? r.modelRole : null],
    ["Agent refusals", modelRolesTelemetryOf(r.modelRoles)?.refusals.length || null],
    ["Model choice", modelChoiceSentence(r)],
    ["Provider failure", providerFailureSentence(r.providerFailure)],
    ["Provider reset", providerFailureOf(r.providerFailure)?.resetAt !== undefined ? timeHtml(r.providerFailure.resetAt) : null],
    ["Turns", `${cell(r.turns)}${Number.isSafeInteger(r.maxTurns) ? ` of ${r.maxTurns}` : ""}`],
    ["Turn warning", limitWarningText(r.tokens?.turnsWarned, "turn limit")],
    ["Trigger", r.triggerIndex !== null && r.triggerIndex !== undefined ? html`<a href="/config">row ${r.triggerIndex + 1}</a> (${cell(r.triggerType)})${triggerMatchWords(view)}` : "-"],
    ["MCP", triggerServersRow(view, r)],
    ["Replica", Number.isInteger(r.replica) ? html`${r.replica} of ${cell(r.replicas)}${view.data?.siblings?.length ? html` · ${view.data.siblings.map((s) => html`${runLink(s.jobId)} ${ui.outcomeBadge(s.outcome, recordReason(s))} `)}` : null}` : null],
    ["Queued", Number.isFinite(msOf(r.queuedAt)) ? timeHtml(msOf(r.queuedAt)) : null],
    ["Wait for a slot", Number.isFinite(msOf(r.queuedAt)) && Number.isFinite(started) ? ageText(started - msOf(r.queuedAt)) : null],
    ["Stalled re-pick", r.stalledRepick ? "This job was re-picked after its worker stopped reporting." : null],
    ["Started", timeHtml(started)],
    ["Ended", timeHtml(ended)],
    ["Took", Number.isFinite(started) && Number.isFinite(ended) ? ageText(ended - started) : "-"],
    ["Read from", source === "host" ? "the worker holding this run" : source === "mirror" ? "the fleet's run mirror" : "this host's run history"],
  ])}`;
});

/** A whole count of micro-dollars, or null: the shape of every issue #985 amount the record carries. */
const microsOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * The cap's own facts on the run page (issue #985), from a capped run's `tokens` and its `costRefusal`: what the cap
 * charged (the run and its subprocesses, which can be far above `Cost`), the part of it above pi's price, the calls that
 * waited for room, whether the warning at 70% was queued, and the numbers the first refusal judged. Each row only when its
 * key is there and well formed, so a run with no cap, or from before these keys, renders as it did. Numbers and fixed
 * words only. Not floor counters: no settlement reads them (costs.mjs).
 */
function capChargeRows(r) {
  const t = r.tokens ?? null;
  const charged = microsOf(t?.costChargedMicros);
  const lifted = microsOf(t?.costLiftedMicros);
  const waited = microsOf(t?.costWaited);
  const n = r.costRefusal ?? null;
  const parts = n && typeof n === "object" ? [n.spentMicros, n.inflightMicros, n.externalMicros, n.boundMicros].map(microsOf) : [];
  const refusal = parts.length === 4 && parts.every((part) => part !== null) ? parts : null;
  const sum = refusal ? refusal.reduce((a, b) => a + b, 0) : null;
  return [
    ["Charged against the cap", charged !== null ? `${usdText(charged)}, this run and its subprocesses` : null],
    ["Above pi's price", lifted !== null ? (lifted > 0 ? `${usdText(lifted)}: calls charged their most (failed or cut after they started, with broken usage, without a price, or a provider's forward) or the long-context rate` : usdText(0)) : null],
    ["Calls that waited", waited !== null ? `${count(waited)} waited for room under the cap` : null],
    ["Cost warning", t?.costWarned === 1 ? "queued for the agent at 70% of the cap" : t?.costWarned === 0 ? "not queued" : null],
    ["Refused at", refusal && Number.isSafeInteger(sum) ? `${usdText(refusal[0])} spent + ${usdText(refusal[1])} held by calls in flight + ${usdText(refusal[2])} elsewhere in the job + ${usdText(refusal[3])} for the refused call = ${usdText(sum)}, against the ${usdText(capMicrosOf(r))} cap` : null],
  ];
}

/** US dollars as whole micro-dollars, rounded to the nearest, or null for a value that is not an amount. */
const dollarsToMicros = (usd) => (typeof usd === "number" && Number.isFinite(usd) && usd >= 0 && Number.isSafeInteger(Math.round(usd * 1e6)) ? Math.round(usd * 1e6) : null);

/**
 * What the job cap's meter plots (issue #1008's console part): what the cap CHARGED, `costChargedMicros` (the run and its
 * subprocesses, issue #985), where the record carries it, else the recorded `tokens.cost`, which is what an image from
 * before those keys counted against the cap. Never the run's billed or list price: a run stopped at $141.70 charged once
 * read 25% of its $150 cap here, because the meter plotted the recorded cost. Null when neither is an amount.
 */
export function capChargeMicros(r) {
  const t = r?.tokens ?? null;
  return microsOf(t?.costChargedMicros) ?? dollarsToMicros(t?.cost);
}

/**
 * Billed and notional apart (issue #1008), from a record that names its notional providers AND carries
 * `tokens.costNotional` (`recordNotionalProviders`), split the worker's way (`recordNotionalMicros`, the same split the
 * Cost row's typed cost makes, ledger or none): what was billed (`cost` less `costNotional`, what the worker settled the
 * dollar windows to), and the list price of the subscription calls nobody was billed for, with the providers. And the
 * trigger's list-price allowance (`allowanceMicros`) against that list price, rounded up as the allowance guard reads it,
 * whenever the record carries one. No row for any other record, so a run without a subscription renders as it did.
 * Numbers, fixed words and closed-enum providers only.
 */
export function notionalRows(r) {
  const t = r?.tokens ?? null;
  const providers = recordNotionalProviders(r);
  const split = providers ? recordNotionalMicros(r) : null;
  const allowance = microsOf(t?.allowanceMicros);
  const used = typeof t?.costNotional === "number" && Number.isFinite(t.costNotional) && t.costNotional >= 0 && Number.isSafeInteger(Math.ceil(t.costNotional * 1e6)) ? Math.ceil(t.costNotional * 1e6) : null;
  return [
    ["Billed", split ? `${usdText(split.billedMicros)}: the calls the job cap and the dollar windows count` : null],
    ["Notional", split ? `${usdText(split.notionalMicros)} at list price on ${[...providers].join(" and ")}'s subscription: not billed, so no cap or dollar window counts it` : null],
    ["Subscription allowance", allowance !== null ? (used !== null ? `${usdText(used)} of ${usdText(allowance)} at list price${allowance > 0 ? ` (${Math.floor((100 * used) / allowance)}%)` : ""}` : `${usdText(allowance)} at list price; what was used is not recorded`) : null],
  ];
}

/**
 * A floor counter's cell, the cost card's "Cost unreported" and the Model usage card's "Unpriced calls" (issue #1058):
 * the count, and when the record says some of those calls were on a subscription with no paid extra usage
 * (`notionalFloorPart`, the cost fold's reading), how many were billed and how many were not. Only the billed ones keep
 * the dollar windows at the whole hold. The count as it is otherwise, so a record without the part renders as it did.
 * Numbers and fixed words only.
 */
export function floorCountText(t, key) {
  const value = t?.[key];
  const notional = notionalFloorPart(t, key);
  if (notional === null || notional === 0) return value;
  return `${count(value - notional)} billed, ${count(notional)} on a subscription (not billed)`;
}

/** Dollar windows have no soft hold; these are settlement facts, never a promise to spend again. */
export function settlementText(basis) {
  return ({ metered: "settled from the reported model cost", floor: "the window keeps the whole hold because the full cost was not known", refunded: "the hold was released before the run spent", unreserved: "no dollar hold was reserved" })[basis] ?? "no settlement explanation was recorded";
}

export const runCostPanel = withRun("Tokens and dollars", (r, view) => {
  const t = r.tokens ?? null;
  const d = r.dollars ?? null;
  const cost = runCost(r, Array.isArray(view.data.subscriptions) ? view.data.subscriptions : []);
  const attempts = view.data?.recoveryRuns ?? [];
  const holds = Array.isArray(view.data?.runHolds) ? view.data.runHolds : [];
  return html`${attempts.length > 1 || holds.length ? html`<h3>Each attempt</h3>${attempts.map((a) => html`<p>${runLink(a.jobId)}: ${costText(runCost(a, view.data.subscriptions ?? []))}${a.dollars ? `; ${usdText(a.dollars.settledMicros)} settled` : ""}.</p>`)}${holds.map((h) => html`<p>Container attempt ${h.seq}: ${usdText(h.amountMicros)} ${h.state === "held" ? "held while it runs" : h.state === "settled-crashed" ? "settled at the whole hold after it was lost" : h.state}.</p>`)}<p>A durable run can hold up to ${(2 + RECOVERY_CAP)} per-job caps: two queue attempts and ${RECOVERY_CAP} recoveries. Each settles on its own.</p>` : null}${capMicrosOf(r) > 0 && cost && capChargeMicros(r) !== null ? ui.meter({ value: capChargeMicros(r), max: capMicrosOf(r), label: "Job cap (dollars)" }) : null}${facts([
    ["Cost", costText(cost)],
    ["Cost class", cost ? `${cost.class}${cost.floor ? " (a floor: the meter could not see all of it)" : ""}` : "not metered"],
    ["Input tokens", t ? count(t.input) : "-"],
    ["Output tokens", t ? count(t.output) : "-"],
    ["Total tokens", t ? count(t.total) : "-"],
    ["Model calls", t ? cell(t.calls) : "-"],
    ...notionalRows(r),
    ["Job cap", usdText(capMicrosOf(r))],
    ...capChargeRows(r),
    ["Reserved", d ? usdText(d.reservedMicros) : "no dollar window applied"],
    ["Settled", d && d.settledMicros !== null && d.settledMicros !== undefined ? `${usdText(d.settledMicros)}: ${settlementText(d.basis)}` : null],
    ["Released at the end", d && Number.isFinite(d.reservedMicros) && Number.isFinite(d.settledMicros) ? usdText(Math.max(0, d.reservedMicros - d.settledMicros)) : null],
    ["Token split", t && (t.rootTotal != null || t.otherTotal != null || t.childTotal != null) ? `${count(t.rootTotal ?? 0)} this run, ${count(t.otherTotal ?? 0)} other sessions, ${count(t.childTotal ?? 0)} subprocesses` : null],
    ["Unmetered children", t?.unmeteredChildren],
    ["Cost unreported", floorCountText(t, "costUnreported")],
    ["Model window", d?.modelBasis ? settlementText(d.modelBasis) : null],
  ])}`;
});

/** Bytes as MiB. */
const mib = (bytes) => (Number.isFinite(bytes) ? `${count(bytes / (1024 * 1024))} MiB` : "-");

/**
 * Whether the warning at 70% of a limit was queued (issue #1055, the record's `tokens.turnsWarned` and
 * `tokens.timeWarned`), in fixed words, or null for a record without the key: a run that did not watch that limit, or
 * one from before it, renders as it did.
 */
function limitWarningText(value, limit) {
  return value === 1 ? `queued for the agent at 70% of the ${limit}` : value === 0 ? "not queued" : null;
}

/** Why a run kept the 30-minute limit (issue #888, the record's `limits.why` and `limits.unavailable`), in words. */
const LIMITS_WHY_WORDS = Object.freeze({ image: "its job image does not declare idleWatch", subscription: "it signed in to its model with a subscription", "forge-token": "its GitHub token comes from an App and lives an hour" });
const LIMITS_UNAVAILABLE_WORDS = Object.freeze({ "venue-copies": "its venue has no channel for the activity counters", "no-capability": "its image cannot sign the counters on this venue", "no-exit-key": "it had no exit key to sign the counters with", "no-transcript": "it had no transcript folder for the counters" });

/** The record's `limits` in one line (issue #888), or null for a record without it. */
function limitsText(l) {
  if (!l || typeof l !== "object") return null;
  const minutes = (n) => (Number.isSafeInteger(n) ? `${n} min` : "?");
  const parts = [`idle ${minutes(l.idleMinutes)}`, `stall ${l.stallMinutes === 0 ? "off" : minutes(l.stallMinutes)}`, l.maxMinutes ? `ceiling ${minutes(l.maxMinutes)}` : "no ceiling"];
  const reason = LIMITS_WHY_WORDS[l.why] ?? LIMITS_UNAVAILABLE_WORDS[l.unavailable] ?? null;
  const basis = l.basis === "activity" ? "stopped only when idle, stalled or at the ceiling" : `kept the 30-minute limit${reason ? ` because ${reason}` : ""}`;
  return `${parts.join(", ")}; ${basis}`;
}

export const runResources = withRun("Resources", (r) => {
  const x = r.resources ?? null;
  const size = r.size ?? null;
  return html`${x && size?.memMiB > 0 ? ui.meter({ value: x.memPeak, max: size.memMiB * 1024 * 1024, label: "Peak memory against size given" }) : null}${facts([
    ["Size given", size ? `${count(size.memMiB)} MiB, ${Number.isSafeInteger(size.cpuCenti) && size.cpuCenti >= 0 ? coresText(size.cpuCenti) : "- cores"} (${cell(size.source)})` : "-"],
    ["Peak memory", x ? mib(x.memPeak) : "not reported"],
    ["Out-of-memory kills", x ? cell(x.oomKills) : null],
    ["CPU time", x && Number.isFinite(x.cpuUsec) ? `${(x.cpuUsec / 1e6).toFixed(1)} s` : null],
    ["Throttled", x && Number.isFinite(x.throttledUsec) ? `${(x.throttledUsec / 1e6).toFixed(1)} s` : null],
    ["Peak processes", x ? cell(x.pidsPeak) : null],
    ["Peak swap", x?.swapPeak != null ? mib(x.swapPeak) : null],
    ["Memory pressure", x ? `${(x.memSomeUsec ?? 0) / 1e6} s some, ${(x.memFullUsec ?? 0) / 1e6} s full` : null],
    ["Throttled periods", x?.throttledPeriods],
    ["Limits", limitsText(r.limits)],
    ["Time warning", limitWarningText(r.tokens?.timeWarned, "time limit")],
    ["Last step seen", r.limits?.lastStepAt ? timeHtml(msOf(r.limits.lastStepAt)) : null],
    ["Last activity seen", r.limits?.lastActivityAt ? timeHtml(msOf(r.limits.lastActivityAt)) : null],
    ["Host offered at admission", r.capacity ? `${r.capacity.slots ?? "?"} slots, ${r.capacity.memMiB ?? "?"} MiB, ${r.capacity.cpuCenti === "off" ? "CPU budget off" : r.capacity.cpuCenti != null ? coresText(r.capacity.cpuCenti) : "CPU budget unknown"}; ${r.capacity.cpus ?? "?"} physical CPUs` : null],
  ])}`;
});

export const runSession = withRun("Session and plan", (r) => {
  const s = r.session ?? null;
  const p = r.plan ?? null;
  return facts([
    ["Session", s ? (s.resumed ? "resumed" : `fresh${typeof s.reason === "string" ? `: ${nestedText("session.reason", s.reason)}` : ""}`) : "this trigger keeps no session"],
    ["Kept", sessionSavedOf(r) ? `for the next run on ${r.target ?? "this target"}` : null],
    ["Transcript", s && Number.isFinite(s.bytes) ? `${count(s.bytes / 1024)} KB in the session store` : null],
    ["Plan", p ? `${cell(p.outcome)}${p.clamped ? ", clamped" : ""}${typeof p.reason === "string" && p.reason !== "" ? `: ${nestedText("plan.reason", p.reason)}` : ""}` : "none"],
    ["Plan id", p?.planId ? html`<span class="mono">${p.planId}</span>` : null],
  ]);
});

/**
 * What the search for a run's children found when it lists none: "No child run among the N newest runs." for a search
 * that read every page it asked for, and for one that did not (`childrenIncomplete`, issue #962: a page that could not
 * be read, or one read without the other hosts' runs) that it was incomplete, never a count of the runs it did not read.
 */
export function childSearchText(data, { found = 0 } = {}) {
  const searched = count(data?.childrenSearched ?? 0);
  if (data?.childrenIncomplete) return found > 0 ? `The search for child runs was incomplete: part of the run history could not be read, so there may be more than these. ${searched} ${data.childrenSearched === 1 ? "run was" : "runs were"} searched.` : `The search for child runs was incomplete: part of the run history could not be read, so whether this run has child runs is not known. ${searched} ${data.childrenSearched === 1 ? "run was" : "runs were"} searched.`;
  return found > 0 ? null : `No child run among the ${searched} newest runs.`;
}

export const runChain = withRun("Chain", (r, view) => {
  const kids = Array.isArray(view.data?.children) ? view.data.children : [];
  const searchText = childSearchText(view.data, { found: kids.length });
  if (!r.parentJobId && kids.length === 0 && !(r.chainRefused > 0)) return ui.collapsed({ icon: "chain", title: view.data?.childrenIncomplete ? "No parent run; child runs not known" : "No parent or child runs", body: searchText });
  return html`${facts([
    ["Parent", r.parentJobId ? runLink(r.parentJobId) : "none"],
    ["Depth", cell(r.chainDepth)],
    ["Refused chain requests", `${cell(r.chainRefused)}; a job may queue at most ${view.data?.chainMaxPerJob ?? CHAIN_MAX_PER_JOB_DEFAULT} (PI_CHAIN_MAX_PER_JOB)`],
  ])}<h3>Children</h3>${kids.length === 0 ? null : html`<ul class="plain">${kids.map((k) => html`<li>${runLink(k.jobId)} ${outcomeText(k)}</li>`)}</ul>`}${searchText === null ? null : html`<p class="note">${searchText}</p>`}`;
});

/** The elapsed run time, with fixed-width components so updates do not move the card. */
export function timecode(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The title's changing line also carries its status and the active run's destructive preview. */
export function runHeadline(view) {
  const r = recordOf(view), a = view.data?.activeRun;
  const chat = view.data?.chat;
  const recovering = r?.reason === "recovery-enqueued" && (chat?.activeJobId || chat?.queuedJobId);
  const active = chat?.jobState === "active" || runningWithoutRecord(view);
  const badge = recovering ? ui.badge("running", "Recovering") : r ? outcomeNote(r) !== null ? ui.badge("attention", outcomeNote(r)) : ui.outcomeBadge(r.outcome, recordReason(r)) : ui.badge(active ? "running" : "idle", active ? "Running" : QUEUED_STATES.includes(chat?.jobState) ? "Queued" : "Unknown");
  const facts = r ?? a ?? {};
  const cancel = canAct(view) && chat?.jobState === "active" && RUN_ID_RE.test(view.query?.id ?? "") ? ui.actForm({ action: "cancel-active", hidden: [["jobId", view.query.id]], label: "Cancel run", kind: ["sm", "danger"], icon: "cancel" }) : null;
  return html`${badge} ${facts.project ? ui.ptag(facts.project) : null} ${facts.target ? targetLink(facts, view.env) : null} ${facts.flow ?? ""} ${facts.host ? `on ${facts.host}` : ""} ${facts.endedAt ? timeHtml(msOf(facts.endedAt)) : facts.startedAt ? timeHtml(msOf(facts.startedAt)) : null}${cancel}`;
}

export function runSummary(view) {
  if (recordOf(view)) {
    if (fromNewerRelease(recordOf(view))) return newerSummary(recordOf(view), view.data?.run?.source);
    if (refusedBeforeStart(recordOf(view))) return titled("Run", facts([["Job", recordOf(view).jobId], ["Target", targetLink(recordOf(view), view.env)], ["Project", recordOf(view).project], ["Host", recordOf(view).host], [VENUE_LABEL, recordOf(view).backend]]));
    return recordSummary(view);
  }
  const a = view.data?.activeRun;
  if (!a) return html``;
  return titled("Run", facts([["Target", targetLink(a, view.env)], ["Project", a.project], ["Flow", a.flow], ["Host", a.host], [VENUE_LABEL, a.backend], ["Provider and model", [a.provider, a.model].filter(Boolean).join(" / ")], ["Queue", a.queue], ["Queued", timeHtml(msOf(a.queuedAt))], ["Started", timeHtml(msOf(a.startedAt))]]));
}

/**
 * The Loaded card (issue #800, the RunLoaded and LoadedStates cards): what the job had when it started, from its record, one
 * line per kind with the details folded. Its top line says whether everything the trigger asks for loaded, or names what
 * did not, with a way to where each thing is fixed. Both roles read the same words, names, versions, counts and states and
 * never content; a viewer has no button. A running job's line says when the card arrives: the record is written from the
 * exit line, and a live card would need the worker to trust a second line during the run. An agent's page draws no card: its copy
 * of the record has no `loaded`, by rule (`agentReadProjection`), and a card over that copy would say "an older release wrote this".
 */
export function runLoaded(view) {
  if (view.role === "agent") return html``;
  const r = recordOf(view);
  if (!r && !runningWithoutRecord(view)) return html``;
  const v = r ? loadedVerdict(r, view.data?.hostLoads ?? null, { jobState: view.data?.chat?.jobState ?? null }) : runningVerdict(view.data?.activeRun?.triggerIndex);
  const operator = view.role === "operator";
  const repositoryHref = r ? forgeBaseLinkOf(r, view.env) : null;
  const fix = (entry) => (operator ? entry.fixes.map((one) => fixButton(one, { repositoryHref })) : null);
  // A problem and a chosen line draw their icon and tone; the quiet ones (no record, nothing loaded) are one muted line, as on the card.
  const line = (entry, lead = null) => html`${lead === null ? null : html`${lead} `}${entry.bold ? html`<b>${entry.bold}</b> ` : null}${entry.rest}${(entry.then ?? []).map((part) => html` <b>${part.bold}</b> ${part.rest}`)}`;
  const top = v.tone === "idle" ? html`<span class="muted">${line(v)}</span>` : stateLine(v.tone, v.icon, line(v, v.lead));
  const small = v.small.map((text) => html`<small>${text}</small>`);
  const also = v.also.map((entry) => html`<p class="ld-top">${stateLine(entry.tone, entry.icon, line(entry))} ${fix(entry)}</p>`);
  const rows = r ? loadedRows(r) : [];
  const fold = r ? loadedFold(r) : [];
  const folded = fold.length === 0 ? null : html`<details class="ld-more"><summary>${LOADED_WORDS.fold}</summary><div class="tbl-wrap"><table class="tbl tbl--stack ld-fold"><caption class="sr">What ${r.jobId} loaded</caption><thead><tr><th scope="col">Kind</th><th scope="col">Name or count</th><th scope="col">Version</th><th scope="col">From</th></tr></thead><tbody>${fold.map((row) => html`<tr><td>${row.kind}</td><td class="ld-fold__n">${wordsHtml(row.name)}</td><td${row.version ? html` data-l="Version"` : null}>${row.version}</td><td class="wide">${wordsHtml(row.from, { repositoryHref })}</td></tr>`)}</tbody></table></div></details>`;
  return ui.card({ title: LOADED_WORDS.title, sub: LOADED_WORDS.sub, body: html`<p class="ld-top">${top} ${fix(v)}${small}</p>${also}${rows.length > 0 ? loadedList(rows) : null}${folded}${fold.length > 0 ? loadedFoot(LOADED_WORDS.foot) : null}` });
}

export function runRecord(view) {
  return recordOf(view) || !runningWithoutRecord(view) ? html`` : ui.collapsed({ icon: "runs", title: "Run record, tokens, resources, session and chain are written when the run ends." });
}

export function runRest(view) {
  return refusedBeforeStart(recordOf(view)) ? ui.collapsed({ icon: "runs", title: "Nothing ran, so there is no progress, transcript or spend.", body: "Session fresh, no parent or child runs. No workspace to reopen: none was made." }) : html``;
}

export function runTranscriptState(view) {
  if (refusedBeforeStart(recordOf(view))) return html``;
  const meta = view.data?.transcript;
  const r = recordOf(view);
  const state = meta?.exists ? meta.ended ? `Ended (${outcomeWord(r?.outcome ?? meta.outcome, recordReason(r)).word ?? r?.outcome ?? meta.outcome ?? "unknown"}); kept 24 hours after the end.` : `Streamed from ${r?.host ?? view.data?.activeRun?.host ?? "the worker"} as it happens.` : meta?.unreachable ? TRANSCRIPT_UNREAD_TEXT : r ? transcriptAbsentText(r) : "Waiting for the run's live transcript. It attaches here when it starts.";
  return titled("Live transcript", html`<p data-transcript-status role="status" aria-live="polite">${state}</p>`);
}

export function runTerminal(view) {
  const chat = view.data?.chat;
  if (view.role !== "operator" || refusedBeforeStart(recordOf(view)) || !["live", "reply"].includes(chat?.mode)) return html``;
  return titled("Terminal chat", command(view.query.id, recordOf(view)?.host ?? view.data?.activeRun?.host));
}

export function runActionsPanel(view) {
  const r = recordOf(view);
  if (!r || view.role !== "operator" || !RUN_ID_RE.test(r.jobId ?? "")) return html``;
  const continuing = r.reason === "recovery-enqueued" && [view.data?.chat?.activeJobId, view.data?.chat?.queuedJobId].some((id) => typeof id === "string" && id !== r.jobId);
  if (continuing) return html``;
  return titled("Actions", html`${rerunLine(r, view)}${forkLine(r, view)}${isSchedulerJobId(r.jobId) ? html`<p>A cron run is fired again by hand from its trigger as the triggers file says now.</p>` : null}`);
}

export function runSandbox(view) {
  const record = recordOf(view);
  const r = record ?? view.data?.activeRun;
  if (!r || (!record && !runningWithoutRecord(view))) return html``;
  // Only a historical record can predate venue attribution. Missing live facts are unknown, never legacy local.
  // A job at work that has published no venue yet: absent, which is not a read that failed (issue #988).
  if (!record && !r.backend) return titled("Sandbox", html`<p>This running job has not published its venue yet. Its host's default is not known here.</p>`);
  const venue = r.backend ?? UNATTRIBUTED_BACKEND;
  const serves = servesOf(venue), custody = venueCustody(venue);
  const check = view.data?.sandboxCheck;
  const o = recordOpenshell(r);
  const workspace = refusedBeforeStart(r) ? "No workspace was made: the run was refused before it started." : sandboxShellRefusal(venue) ? `Its workspace is ${sandboxShellRefusal(venue)}.` : check?.retained === true && Number.isFinite(check.until) ? html`Kept on ${r.host} until ${timeHtml(check.until)}. PI_SANDBOX_RETENTION_HOURS controls this window (24 hours by default; 0 keeps none).` : check?.retained === false ? check.why === "past-window" ? "Past its retention window: the sandbox command needs --pin." : SANDBOX_KEPT_TEXT[check.why] ?? check.reason ?? "Its workspace cannot be reopened." : "Its host keeps a run's workspace for PI_SANDBOX_RETENTION_HOURS after the run (24 hours by default), unless retention is off there or the run's trigger keeps no sandbox. This console cannot read another host's workspaces; the CLI on that host decides.";
  const siblings = Array.isArray(view.data?.siblings) ? view.data.siblings : [];
  return titled(`Sandbox: ${venue}${r.host ? ` on ${r.host}` : ""}`, html`${r.backend ? null : html`<p>A local run from before venues were recorded.</p>`}${factsOne([...(serves ? SERVES.map((key) => [key === "liveTranscript" ? "Live transcript" : key === "sandboxShell" ? "Sandbox shell" : capitalised(key), SERVES_TEXT[key]?.[serves[key]]]) : [[VENUE_LABEL, "This console does not know this venue yet."]]), [VENUE_LABEL, BACKENDS[venue]?.describe ?? "This console does not know this venue yet."], ["Who holds the credentials", custody ? CUSTODY_TEXT[custody] : "unknown"], ["Sandbox policy", o ? openshellCountsText(o) : null], ["Rule hosts", o ? o.ruleHostCount === 0 ? openshellHostsText(o) : html`${o.ruleHostCount} rule hosts: ${o.ruleHosts.map((name) => ui.chip(name))}${o.ruleHostCount > o.ruleHosts.length ? ` and ${o.ruleHostCount - o.ruleHosts.length} more` : ""}` : null], ["Private endpoints", (() => { const p = recordPrivateEndpoints(r); return p ? privateEndpointsText(p) : null; })()], ["Workspace", workspace], ["Replica", Number.isInteger(r.replica) ? `replica ${r.replica} of ${r.replicas}: each replica is its own sandbox, racing the others on the same event` : null]])}${siblings.length ? html`<p>Sibling replicas: ${siblings.map((s) => html`${runLink(s.jobId)} ${ui.outcomeBadge(s.outcome, recordReason(s))} `)}</p>` : null}`);
}

export function runSecrets(view) {
  const r = recordOf(view);
  if (!r || (!recordBundle(r) && !recordSecretsProfile(r))) return html``;
  const got = recordBundle(r), b = got?.bundle;
  const names = (b?.variables ?? []).filter((name) => !b.shadowed.includes(name));
  return titled("Secrets", html`${facts([["Secrets profile", recordSecretsProfile(r)], ...bundleRows(r)])}${Array.isArray(names) && names.length ? html`<p>${names.map((name) => ui.chip(`${name}${Array.isArray(b.placeholderNames) ? b.placeholderNames.includes(name) ? " (placeholder)" : " (value)" : ""}`))}</p>` : null}${b?.shadowed?.length ? html`<p>The trigger's value won; the bundle's was not passed: ${b.shadowed.join(", ")}.</p>` : null}<p class="card__sub">Names only: no secret value reaches a log, a record or this page.</p>`);
}

/**
 * Where the run's main model got its credential (issue #998), from the record's `mainCredential` (the worker's closed word
 * and, for a declared key, its variable's name, never a value), or null for a record without one: a run refused before
 * its container, or one an earlier release wrote. A declared key is named by what declared it, the record's purpose
 * telling an answer draft and a question grouping from a trigger's job.
 */
export function mainCredentialText(record) {
  const c = recordedMainCredential(record?.mainCredential);
  if (c === null) return null;
  if (c.source === "run-secret") {
    const owner = record.purpose === "answer-draft" ? "the answer rule's" : record.purpose === "zero-touch-grouping" ? "the zeroTouch block's" : "the trigger's";
    return `${owner} declared key${c.variable ? ` ${c.variable}` : ""}`;
  }
  return { "host-env": "the host's key", "pi-login": "the host's pi login", subscription: "a subscription connection", keyless: "no key (keyless)" }[c.source];
}

export function runModels(view) {
  const r = recordOf(view), u = r?.usage;
  // Issue #998: a run with no usage still says where its credential came from, when its record knows.
  const credential = r ? mainCredentialText(r) : null;
  if (hiddenRecord(view) || (!u && credential === null)) return html``;
  if (!u) return titled("Model usage", facts([["Credential", credential]]));
  // A damaged ledger row (not an object) is skipped, as the cost fold skips it (costs.mjs `hasLedger`).
  const models = Array.isArray(u.models) ? u.models.filter((m) => m !== null && typeof m === "object" && !Array.isArray(m)) : [];
  // Issue #1008: a row of a provider the record names notional is its list price, not billed, and says so.
  const notional = recordNotionalProviders(r);
  return titled("Model usage", html`${table("Model usage", ["Provider", "Model", "Calls", "Input", "Output", "Cost"], models.map((m) => html`<tr><td>${m.provider}</td><td>${m.model}</td><td>${count(m.calls)}</td><td>${count(m.input)}</td><td>${count(m.output)}</td><td>${usdText(Number.isFinite(m.cost) ? Math.round(m.cost * 1e6) : null)}${notional?.has(m.provider) ? " notional" : ""}</td></tr>`), "No per-model usage was recorded.")}${facts([["Credential", credential], ["Cache reads", models.reduce((n, m) => n + (m.cacheRead ?? 0), 0)], ["Cache writes", models.reduce((n, m) => n + (m.cacheWrite ?? 0) + (m.cacheWrite1h ?? 0), 0)], ["Unpriced calls", floorCountText(r.tokens, "unpriced")], ["No model resolved", r.tokens?.unresolved]])}<p>Priced by pi-ai ${u.piAi ?? "unknown"} at stream time.</p>`);
}

export function runTail(view) {
  return view.role === "operator" && view.data?.chat?.mode === "reply" && view.data?.transcript?.exists ? titled("Last transcript entries", html`<div data-run-tail></div><a href="#transcript">Read the whole transcript</a>`) : html``;
}

/** Counts are positioned evenly: a record has no checkpoint timestamps, so the track invents none. */
function recoveryTrack(record, next, view) {
  const c = recordRecovery(record)?.checkpoints;
  const total = (c?.written ?? 0) + (c?.failed ?? 0) + (c?.skipped ?? 0);
  const visible = Math.min(total, 24);
  const marks = Array.from({ length: visible }, (_, i) => {
    const kind = i < (c?.written ?? 0) ? "written" : i < (c?.written ?? 0) + (c?.failed ?? 0) ? "failed" : "skipped";
    return html`<g class="run-cp run-cp--${kind}"><title>${kind} checkpoint ${i + 1}; its time was not recorded</title><circle cx="${40 + (visible <= 1 ? 0 : i * 270 / (visible - 1))}" cy="20" r="4"></circle></g>`;
  });
  return html`<div class="run-track"><svg viewBox="0 0 640 110" role="img" aria-label="Attempt and recovery; checkpoint positions are evenly spaced, not timestamps"><line class="run-track__line" x1="20" y1="70" x2="620" y2="70"></line><rect class="run-track__attempt" x="20" y="42" width="300" height="28" rx="14"></rect><text x="34" y="61">Attempt ${record.attempt ?? 1}: ${outcomeWord(record.outcome, recordReason(record)).word ?? record.outcome}</text>${marks}${next ? html`<line class="run-track__wait" x1="325" y1="56" x2="390" y2="56"></line><rect class="run-track__next" x="395" y="42" width="225" height="28" rx="14"></rect><text x="408" y="61">${view.data?.chat?.activeJobId === next ? "Recovery running" : "Recovery queued"}</text>` : null}</svg></div><p class="card__sub">Checkpoint positions are evenly spaced; their times and kinds were not recorded.${total > visible ? ` ${total - visible} more checkpoints are counted below.` : ""}</p>`;
}

export function runRecovery(view) {
  const r = recordOf(view), rec = r ? recordRecovery(r) : null;
  if ((!rec && !view.data?.trigger?.recover && !String(r?.reason ?? "").startsWith("recovery-")) || refusedBeforeStart(r)) return html``;
  const next = view.data?.chat?.activeJobId ?? view.data?.chat?.queuedJobId;
  const continuation = typeof next === "string" && next !== r.jobId ? next : null;
  const recovered = rec?.recovered ?? [...(view.data?.recoveryRuns ?? [])].reverse().map((record) => recordRecovery(record)?.recovered).find(Boolean);
  const earlier = recordedEarlier(r.earlier) ?? [];
  const queuedAt = msOf(view.data?.recoveryLive?.queuedAt), startedAt = msOf(view.data?.recoveryLive?.startedAt);
  return titled(`Recovery${Number.isInteger(r.triggerIndex) ? `: run.recover is armed on trigger row ${r.triggerIndex + 1}` : ""}`, html`${continuation || rec?.checkpoints ? recoveryTrack(r, continuation, view) : null}${facts(recoveryRows(r))}${!rec && !continuation ? html`<p>None needed: this run finished on its first attempt.</p>` : null}${continuation ? html`<p>${ui.badge(view.data.chat.activeJobId === continuation ? "running" : "idle", view.data.chat.activeJobId === continuation ? "Recovery running" : "Recovery queued")} ${runLink(continuation)}.</p>` : null}${recovered ? facts([["Restored from", `${recovered.from} checkpoint ${recovered.checkpointSeq ?? "(sequence not recorded)"}`], ["Recovery", `${recovered.n} of at most ${RECOVERY_CAP}`], ["Calls replayed", recovered.replayed], ["Calls interrupted (may or may not have happened)", recovered.interrupted], ["Calls not started", recovered.notStarted]]) : null}${recovered?.checkpointSeq ? html`<p>The agent was told it restarts from checkpoint ${recovered.checkpointSeq}. Its workspace was restored, with .pi/, .agents/ and the root context files reset to the base commit. It checks before repeating anything with outside effects.</p>` : null}${Number.isFinite(queuedAt) ? html`<p>Wait for a slot: ${ageText((Number.isFinite(startedAt) ? startedAt : view.now) - queuedAt)} on ${view.data.recoveryLive.host ?? r.host}.</p>` : null}${earlier.map((a) => html`<p>Retried: an earlier attempt ran on ${a.host}, ${timeHtml(msOf(a.startedAt))} to ${timeHtml(msOf(a.endedAt))}.</p>`)}${r.stalledRepick ? html`<p>Re-picked: its worker stopped answering and this pickup ran it again.</p>` : null}${view.role === "operator" ? html`<div data-recovery-tools></div>` : null}<p class="card__sub">Recovery queued waits for the checkpoint's host: ${RECOVERY_TTL_MS / 3_600_000} hours, longer while that host is alive, at most ${RECOVERY_MAX_WAIT_MS / 86_400_000} days.</p>`);
}

/**
 * What the refused run's two cards say of a fact its host did not give (issue #988), told apart by what the snapshot
 * says of the read. "could not be read" is said of a read that failed and of nothing else: there is no snapshot, or the
 * part of it the fact comes from was not read. Where the hosts were not read the cards say that (`HOSTS_UNREAD`, or
 * the registry's own "read in part"). And where everything was read and the host has no row, no doctor result or no
 * queue, they say that it has none: a host that left, or one that never published, is not a read that failed.
 */
const REFUSED_WORDS = Object.freeze({
  unread: "could not be read",
  inPart: "not read this time: the host registry was read in part",
  // The registry answered before and not this time: the rows are as they were last seen, so a host with no row may have
  // registered since, and a row's beat is not this read's.
  lastSeen: "not read this time: the host registry could not be read",
  noRow: (host) => `no live registry row for ${cell(host)}`,
  noDoctor: "no doctor result published",
  doctorRefused: "its newest result does not load",
  noQueue: "no queue of this host is listed",
  partWindow: ": part of the run history could not be read",
});

/**
 * The run's host row and its newest doctor result, from the snapshot the refused run's page reads, and for each what
 * is known where there is none: `hostGap` (the words for a missing row's beat), `floorGap` (the same for its floor,
 * which says "not known" with the reason), `doctorGap` and `queueGap` (for a queue of the host's that is not in the
 * snapshot's list), each null where the fact is there.
 */
function hostFacts(view, name) {
  const s = view.data?.snapshot;
  const read = s !== null && typeof s === "object";
  const host = (Array.isArray(s?.hostBudgets) ? s.hostBudgets : []).find((h) => h.name === name) ?? null;
  const doctor = doctorHostsOf(s).filter((d) => d.name === name).sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity))[0] ?? null;
  // "No live registry row" is said only over a registry read THIS time (`rowLastSeen`): after one good read a registry
  // that fails shows its rows as last seen, and the cards said "none" of a host that had registered since.
  // A host with no row over a registry read in part (issue #1073): "part" only where that read may have missed its row
  // (`hostPartCase`: it names this host, or does not name every host it missed); a read that names every host it missed
  // and not this one found no row, so the host has none, as over a registry read whole. It said "part" of any such host.
  const kind = !read ? "unread" : registryReadInPart(s) && (host?.notRead === true || (!host && hostPartCase(s, name) !== null)) ? "part" : hostsUnread(s) ? "hosts" : rowLastSeen(s, host) ? "last" : host ? null : "none";
  const hostGap = { unread: REFUSED_WORDS.unread, part: REFUSED_WORDS.inPart, hosts: HOSTS_UNREAD, last: REFUSED_WORDS.lastSeen, none: REFUSED_WORDS.noRow(name) }[kind] ?? null;
  const floorGap = { unread: HOSTS_UNREAD, part: REFUSED_WORDS.inPart, hosts: HOSTS_UNREAD, last: REFUSED_WORDS.lastSeen, none: `not known: ${REFUSED_WORDS.noRow(name)}` }[kind] ?? null;
  // A row that is as last seen has a beat, and its age is not this read's to tell.
  const beatUnread = host !== null && (kind === "last" || kind === "part");
  const doctorRead = read && s.doctor !== null && typeof s.doctor === "object" && !s.doctor.unreachable;
  const doctorGap = !doctorRead ? REFUSED_WORDS.unread : doctor === null ? REFUSED_WORDS.noDoctor : doctor.unreadable ? REFUSED_WORDS.doctorRefused : null;
  // The host's own queue is found through the hosts: where they were not read, a queue that is not listed is theirs to
  // explain, and "no queue is listed" is said only over a list that was read whole.
  const queuesRead = read && Array.isArray(s.queueCounts);
  const queueGap = !queuesRead ? REFUSED_WORDS.unread : kind === "hosts" || kind === "part" || kind === "last" ? hostGap : REFUSED_WORDS.noQueue;
  return { host, doctor, hostGap, floorGap, doctorGap, queueGap, beatUnread };
}

export function runWhy(view) {
  const r = recordOf(view);
  if (!refusedBeforeStart(r)) return html``;
  const token = recordReason(r), window = view.data?.runsWindow;
  // The day's window, read: a reason it does not count had no run in it, which is 0 and not a read that failed.
  const windowRead = window !== null && typeof window === "object";
  const n = windowRead && token ? window.byReason?.[token] ?? 0 : null;
  // A count over a window that ended inside the day, or that was folded without a side of the history, is a floor.
  const least = windowRead && windowFloor(window) ? "at least " : null;
  const { host, doctor, floorGap, doctorGap } = hostFacts(view, r.host);
  const floor = host?.backends?.floor;
  const properties = floor && typeof floor === "object" ? Object.entries(floor) : [];
  const said = token ? explainReason(token, { why: r.why }) : null;
  return titled("Why it was refused", html`${facts([["Rule", said?.known ? ui.withCode(said.sentence) : "No explanation is recorded for this rule yet."], ["Venue floor (PI_BACKEND_FLOOR)", properties.length ? properties.map(([name, want]) => html`<span>${PROPERTY_LABEL[name] ?? name}: ${want}; ${r.backend ?? UNATTRIBUTED_BACKEND} declares ${DECLARATION_TEXT[declarationOf(r.backend ?? UNATTRIBUTED_BACKEND, name)?.word] ?? "unknown"}. </span>`) : floorGap ?? "This host has not published a floor."], ["Same reason in the last 24 hours", Number.isFinite(n) ? html`${least}${n > 0 ? html`<a href="/runs?reason=${encodeURIComponent(token)}">${count(n)}</a>` : count(n)}${window.partial === true ? REFUSED_WORDS.partWindow : null}` : REFUSED_WORDS.unread], ["Newest doctor result", doctorGap === null ? `${doctorCountsText(doctor)}, ${ageText(doctor.ageMs)} ago` : doctorGap]])}${said?.known && docsHref(said.anchor) ? ui.outLink({ href: docsHref(said.anchor), label: "Read the rule in the reasons docs" }) : null}${view.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: `Run it on ${r.host ?? "the worker host"}; the console runs nothing on a host.` }) : html`<p>Ask an operator to run the host's doctor checks.</p>`}`);
}

export function runHost(view) {
  const r = recordOf(view);
  if (!refusedBeforeStart(r)) return html``;
  const { host, doctor, hostGap, doctorGap, queueGap, beatUnread } = hostFacts(view, r.host);
  const age = beatUnread ? null : beatAgeOf(host), fail = doctorGap === null ? doctorProblems(doctor).find((p) => p.level === "fail") : null;
  const queues = Array.isArray(view.data?.snapshot?.queueCounts) ? view.data.snapshot.queueCounts : [];
  const queue = queues.find((q) => q.queue === host?.queue || q.queue === `pi-jobs@${r.host}`);
  return titled("The host", html`${facts([["Host", r.host], [VENUE_LABEL, r.backend ?? UNATTRIBUTED_BACKEND], ["Heartbeat", Number.isFinite(age) ? `${ageText(age)} ago` : hostGap ?? "not published"], ["Newest failing doctor check", fail ? fail.label : doctorGap ?? "none in its newest result"], ["Queue waiting", queue ? count(queue.counts?.waiting) : queueGap], ["Queue running", queue ? count(queue.counts?.active) : queueGap]])}<a href="/fleet">Open Fleet for this host's queues and doctor checks</a>`);
}

export function runViewer(view) {
  return view.role !== "operator" ? ui.banner({ status: "idle", sm: true, icon: "shield", title: "Signed in as a viewer", body: "Transcripts, chat, phase names, the run's note, failure reasons and every action are shown to operators only. The files a run kept are shown to you too." }) : html``;
}

// ---- artifacts (issue #920) ------------------------------------------------------------------------------------------

/** The states the Artifacts panel draws, in docs/console.md's order (console-doc-tables.test.mjs holds the table). */
export const ARTIFACT_STATES = Object.freeze(["kept", "dropped", "expired", "elsewhere", "unreadable"]);

/**
 * A file's own address on this console: the route looks the name up in the run's manifest and serves only that. `host`
 * only for a file another host keeps (issue #942), which the route then asks that host for.
 */
export function artifactHref(jobId, name, host = null) {
  return `/api/artifact?id=${encodeURIComponent(jobId)}&name=${encodeURIComponent(name)}${typeof host === "string" ? `&host=${encodeURIComponent(host)}` : ""}`;
}

/** One line per drop reason that happened, in the closed list's order. */
function droppedLines(dropped) {
  const rows = ARTIFACT_DROP_REASONS.filter((reason) => Number.isSafeInteger(dropped?.[reason]) && dropped[reason] > 0);
  if (rows.length === 0) return null;
  return html`<ul class="plain">${rows.map((reason) => html`<li>${count(dropped[reason])} not kept: ${ARTIFACT_DROP_TEXT[reason]}</li>`)}</ul>`;
}

/**
 * What a forge job left in /artifacts (issue #920, `REQ-FORGE-JOB-ARTIFACTS`): the files this host keeps, or since issue
 * #942 the host that ran the job keeps, each served by `/api/artifact` (an image drawn small and opened whole, text
 * opened as text, anything else downloaded), what was not kept and why, or why the files cannot be shown here. Shown to
 * viewers too (`RUN_VIEWER_PANELS`): the evidence is for a pull request's reviewer, who is often one. Nothing at all for
 * a run that kept and dropped nothing.
 */
export function runArtifacts(view) {
  // Not `withRun`: that draws the card whatever its body says, and a run with nothing kept must draw no card at all.
  const r = view.data?.run?.record;
  const a = view.data?.artifacts;
  if (!r || refusedBeforeStart(r) || !a || !ARTIFACT_STATES.includes(a.state)) return html``;
  return titled("Artifacts", artifactsBody(r, a));
}

/**
 * Why another host's files cannot be shown now (issue #942), by the reader's `why`: each says what is known and what
 * brings them back. A `why` this console does not know says only that they were not fetched.
 */
function elsewhereWhy(host, why) {
  if (why === "not-running") return html`${host} is not running now; its files show here once it runs again, until its retention removes them.`;
  if (why === "no-answer") return html`${host} did not answer in time, or runs an earlier version that cannot send files; reload to ask again.`;
  if (why === "busy") return html`${host} is busy sending other files; reload to ask again.`;
  return html`They could not be fetched from ${host}; reload to ask again.`;
}

function artifactsBody(r, a) {
  const kept = a.counts?.kept ?? 0;
  // The host that keeps the files, where it is not this console's (issue #942): the reader names it then alone.
  const host = typeof a.host === "string" && a.host !== "" ? a.host : null;
  if (a.state === "dropped") return html`<p>This run kept no file.</p>${droppedLines(a.counts?.dropped)}`;
  if (a.state === "expired") return html`<p>The ${count(kept)} ${kept === 1 ? "file" : "files"} this run kept (${artifactSizeText(a.counts?.bytes)}) were removed after ${host === null ? "this host" : host}'s retention (PI_ARTIFACTS_RETENTION_DAYS).</p>${droppedLines(a.counts?.dropped)}`;
  if (a.state === "elsewhere") return html`<p>Kept on ${a.host}: ${count(kept)} ${kept === 1 ? "file" : "files"}, ${artifactSizeText(a.counts?.bytes)}. ${elsewhereWhy(a.host, a.why)}</p>${droppedLines(a.counts?.dropped)}`;
  if (a.state === "unreadable") return html`<p>The ${count(kept)} ${kept === 1 ? "file" : "files"} this run kept could not be read ${host === null ? "here" : html`on ${host}`}.</p>`;
  const files = Array.isArray(a.files) ? a.files : [];
  const rows = files.map((f) => {
    const href = artifactHref(r.jobId, f.name, host);
    const image = f.type.startsWith("image/");
    const text = f.type === "text/plain";
    // A download for anything that is neither an image nor text: the route sends it as an attachment too.
    const link = image || text ? html`<a class="mono" href="${href}" target="_blank" rel="noopener noreferrer">${f.name}</a>` : html`<a class="mono" href="${href}" download="${f.name}">${f.name}</a>`;
    return [
      image ? html`${link}<br><a href="${href}" target="_blank" rel="noopener noreferrer"><img src="${href}" alt="${f.name}" width="240" loading="lazy"></a>` : link,
      artifactSizeText(f.size),
      image ? "image" : text ? (f.scrubbed ? "text, cleaned of the job's secrets" : "text") : "download",
    ];
  });
  const where = host === null ? "" : html` on ${host}`;
  return html`${ui.tbl({ label: "Files this run kept", heads: ["File", "Size", "Kind"], rows, stack: true })}${droppedLines(a.dropped)}${a.keepUntil ? html`<p class="note">Kept${where} until ${timeHtml(msOf(a.keepUntil))}.</p>` : html`<p class="note">Kept${where} until ${host === null ? "this host" : host}'s retention removes them.</p>`}`;
}

/** Only exact retained points are selectable; ids carry no transcript text into the page. */
function forkLine(r, view) {
  if (!canAct(view)) return null;
  const points = view.data?.forkPoints;
  if (!points?.ok) return html`<p>Fork unavailable: ${(r.forkSource?.saved === false ? forkRefusalWords(forkArchiveFact(r.forkSource).reason) : forkRefusalWords(points?.refusal)) ?? forkRefusalWords("fork-source-unavailable")}.</p>`;
  const entries = points.entries.filter((e) => e.positions?.length);
  if (!entries.length) return html`<p>Fork unavailable: no exact workspace point is retained.</p>`;
  return html`<form class="act" id="run-fork" data-action="run-fork" autocomplete="off"><input type="hidden" name="jobId" value="${r.jobId}">
    <p><b>Fork this run.</b> Continue from a retained point on a separate branch and pull request.</p>
    ${ui.field({ label: "Fork point", id: "fork-point", control: ui.select({ id: "fork-point", name: "point", options: entries.flatMap((e) => e.positions.map((position) => ({ value: `${e.id}:${position}`, label: `${position} ${e.id} (${e.role ?? e.type})` }))) }) })}
    ${ui.field({ label: "Provider (optional)", id: "fork-provider", control: ui.input({ id: "fork-provider", name: "provider" }) })}
    ${ui.field({ label: "Model (optional)", id: "fork-model", control: ui.input({ id: "fork-model", name: "model" }) })}
    ${ui.field({ label: "Thinking level (optional)", id: "fork-thinking", control: ui.select({ id: "fork-thinking", name: "thinking", options: ["", ...FORK_THINKING_LEVELS] }) })}
    ${ui.field({ label: "Message (optional)", id: "fork-message", control: ui.input({ id: "fork-message", name: "message" }) })}
    ${ui.btn({ type: "submit", label: "Preview a fork", kind: ["sm", "paid"], icon: "rerun" })}</form>`;
}

/** Private answer-rule text is mounted only on operator run pages. */
export const runAnswerDraft = answererRun;
