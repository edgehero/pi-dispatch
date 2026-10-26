/**
 * The overview screen's panels (issue #737: the OverviewScreen, OverviewAllClear, OverviewPhone, SetupScreen,
 * TimelineAndWaitlists, Status and CardsAndBanners cards), re-exported by `../panels.mjs`. The rules every panel keeps
 * (one pure, deterministic renderer per region, every value through `html`, the role and run-text rule, the action
 * controls and the PATHS rule) are stated once, in `../panels.mjs`'s header. Drawn in the Pulse kit's markup: the screen
 * left the legacy layer with this module.
 *
 * THE PANELS, each `(view) -> SafeHtml`:
 *   - the headline (`overviewHeadline`), the shell's `#p-headline` under the title: what needs the person, or "All
 *     clear", or on a first run how many steps stand before the first job;
 *   - the first run's three (`overviewSetup`, `overviewSetupPi`, `overviewSetupEmpty`), drawn only while
 *     `firstRunState(...).applies`, and the overview's eight (`overviewNeeds`, `overviewWaiting`, `overviewActive`,
 *     `overviewSpend`, `overviewTimeline`, `overviewCaps`, `overviewWaitlists`, `overviewHosts`), drawn only while it does
 *     not. Every one of the eleven is on the page in both states, an empty panel hidden (`section[data-panel]:empty`), so
 *     the live stream moves a deployment from the checklist to the overview by swapping panels, with no reload.
 *
 * THE ROLE RULE. A viewer reads counts, ids, hosts and why each job waits, in the worker's closed vocabulary: a
 * reason this console has no words for is still a word of that vocabulary (a newer worker's: the worker writes no
 * reason outside its table, and the reader takes only `[a-z][a-z0-9-]`, 32 at most, no wider than an id a viewer reads
 * anyway), so every role reads it as recorded, the token in the code face, rather than the `none` bucket's "No reason
 * was recorded", which would be false. A wait check's profile names are the operator's own configuration, so a viewer
 * never reads them. Never a failure's text, a form, a command or a reader's own error message (every read that fails
 * is said in a fixed sentence). An operator on a console that takes changes also gets the writes (`canAct`): Retry,
 * Cancel, a host's pause, Pause fleet, a question's Answer (its run page's Chat panel takes the answer only there; a
 * question is Open otherwise), and the waitlists' links; on a read-only console an operator still reads the commands,
 * which run in a shell, not here.
 *
 * LINKS. A page this console has (`PAGES`) is linked by name (`kit.mjs` `pageHref`); a page a later change adds (a
 * host's, a trigger's, the trigger editor) is linked by its name too, falling back to the page that holds it today
 * (Fleet, Configuration), so the overview reaches the new page the day it exists. The table is `view.pages` when the
 * caller hands it (`pages.mjs`'s `PAGES`, which this module cannot import: `pages.mjs` reads these renderers as it
 * loads), else `OVERVIEW_LINKS`, a copy of the paths the overview links to today, pinned to `PAGES` by a test.
 *
 * TIMES are `<time>` elements (`timeHtml`), which the browser script shows in the reader's zone; the timeline's axis is
 * UTC text inside its SVG (`timeline.mjs`). An instant no date can show (past the year 9999, `DEFER_TIME_MAX_MS`) is
 * missing, never "unknown".
 *
 * WHERE THE OVERVIEW'S OLD PANELS WENT (issue #710's acceptance holds on the new ones): the fleet's paused state is the
 * hosts panel's head (paused, or how many of its queues are), and so is the Workers fact (how many beat, and registered
 * and connected where those differ), and each queue's counts are Waitlists' Queues row; the parked
 * runs, with the ones being answered, are Needs you's questions; the day's failed and refused runs (the floor rule, and
 * cancels not counted as refusals) are Needs you's foot line, linking the runs; "no worker online" and the stale-beats
 * note lead the hosts panel; the count and dollar windows are Caps, under the UTC sentence; the active jobs' table with
 * its progress stays on Fleet, and Running here counts them in each host's slots.
 */
import { DEFER_BUCKETS, DEFER_BUCKET_WORDS, DEFER_DUE_SENTENCE, DEFER_PROJECT_RE, DEFER_TIME_MAX_MS, DEFER_WHYS, DEFER_WHY_RE } from "@edgehero/pi-dispatch/defer-reasons";
import { HOST_SKEW_CLAIM_MS } from "@edgehero/pi-dispatch/host-registry";
import { FIRST_RUN_COMMANDS, FIRST_RUN_STATES, doctorHostsOf, doctorProblems, doctorStale, firstRunCommandHint, firstRunState } from "../../doctor-view.mjs";
import { usd2 } from "../../panel.mjs";
import { NO_EXPLANATION, docsHref } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { TIMELINE_ROWS, TIMELINE_WAIT_WORDS, TIMELINE_ZOOMS, timelineHtml, timelineLegend, timelineModel } from "../timeline.mjs";
import { BEAT_FRESH_MS, RUN_ID_RE, ageText, beatAgeOf, beatFresh, canAct, count, moneyHtml, shownPath, timeHtml, usdText, workersOnline } from "./common.mjs";

// ---- the sentences -----------------------------------------------------------------------------------------------------

/** The sentence the hosts panel leads with when no worker drains the queue (issue #710). */
export const NO_WORKER_TEXT = "No worker online: jobs queue but nothing runs them.";

/**
 * The softer note when BullMQ sees more workers than beat freshly (issue #710). It claims only what both sources say:
 * a clock out of step is the likely cause, and a wedged worker (which keeps its connection) the other one, so it never
 * says jobs are being run.
 */
export const STALE_BEATS_TEXT = "Host beats look stale (clock skew?), but the queue still sees its workers connected.";

/** The hosts panel's note when the registry could not be read this tick: the rows are the last ones read. */
export const REGISTRY_UNREAD_TEXT = "The host registry could not be read; this shows the fleet as it was last seen.";

/** The line under the caps: the budget's windows reset on UTC boundaries, not on the reader's local ones. */
export const COUNT_WINDOWS_UTC_TEXT = "Days, weeks (Monday to Sunday) and months here are UTC, as the budget counts them.";

/** What a panel says when the snapshot could not be read at all (the panels' shared sentence, `common.mjs`'s). */
export const OVERVIEW_UNREAD_TEXT = "The deployment's Valkey could not be read, so this panel has nothing to show. The next refresh tries again.";

/** Needs you's definition, under its numbers: drawn with them, so not under "0 nothing needs you" (the card's). */
export const NEEDS_DEFINITION = "A question is a parked run nobody has answered; to fix is a failed job the queue still keeps, or a registered host whose doctor fails.";

/** Needs you's foot line when the day's read is a floor that holds no failure or refusal: why it is not All clear. */
export const DAY_FLOOR_TEXT = "Last 24 hours: no failed or refused run among the runs read, but the run history read does not reach back a day.";

/**
 * A Needs you row with no project tag. Its project is a run record's (the parked list and the failed set name none), so
 * the job is in no project or no record read here names it; Waitlists' "not known until it starts" would be false of a
 * job that ran.
 */
export const NEEDS_UNKNOWN_PROJECT_TEXT = "A job with no project tag is in no project, or no run record read here names one.";

/**
 * A Waitlists row with no project tag: the row carries what the reader found (its defer record's project, a forge job's
 * repository's or a cron trigger's folder's through the projects file), so a job without one is in no project, or in
 * one that is known only once it starts.
 */
export const WAITING_UNKNOWN_PROJECT_TEXT = "A job with no project tag is in no project, or its project is not known until it starts.";

/**
 * Each panel's empty state: `title` the few words its number reads beside 0 (and the first run's preview of the panel
 * says), `body` its sentence. Shared with `p-setup-empty`, so the preview and the panel cannot drift.
 */
export const NEEDS_EMPTY = Object.freeze({ title: "nothing needs you", body: "No questions, failures or refusals in the last 24 hours." });
export const WAITING_EMPTY = Object.freeze({ title: "nothing is waiting", body: "No job is waiting to start." });
export const RUNNING_EMPTY = Object.freeze({ title: "nothing is running", body: "No job is running on any host." });
export const SPEND_EMPTY = Object.freeze({ title: "no runs in the spend window", body: "No run has settled any spend today." });
export const HOSTS_EMPTY = Object.freeze({ title: "no host is registered yet", body: "No host is registered. A worker registers when it starts." });

/** Waitlists' line when nothing waits on a slot, another run or a check (a retry or a pause may still wait). */
export const WAITLISTS_CALM = "No job waits for a slot, another run, or a time or check.";

/** The caps' word for the soft hold: what the worker does from it (budget.mjs), not what the design drew. */
export const SOFT_HOLD_TEXT = "From the soft hold new starts are refused; nothing is spent.";

/** Waitlists' line beside today's soft-hold refusals: none of them waits in line. */
export const SOFT_HOLD_REFUSED_TEXT = "The soft hold refuses rather than holds.";

/** A slot held by a job that is gone: the console cannot free it (no action reaches another host's runtime). */
export const FREE_SLOT_TEXT = "The slot frees when that job's container is gone; nothing in the console reaches another host's runtime.";

/**
 * A registry row with no expiry (`noExpiry`). Never a host's first beat: a beat sets the row, its expiry, then its
 * place in the live set, and readers walk the live set, so a row without an expiry was left so (by an earlier worker
 * of the same name that crashed, or written by hand).
 */
export const HOST_NO_EXPIRY_TEXT = "Its registry row has no expiry, so it will not leave the registry by itself, and the host may be gone. Doctor or a restart of its worker clears it.";

/** A host that has published no doctor result. */
export const NO_DOCTOR_TEXT = "No doctor result yet";

/**
 * What the spend dots are, under them, and where the number beside them comes from: the deployment's day window, its
 * counter's spent and held (`SPEND_HOURS_TEXT`), or, with no such window read, the dots' own sum (`SPEND_SUM_TEXT`).
 * The note names the number's source, so it never says the window's counter over a number that is not it.
 */
export const SPEND_HOURS_TEXT = "Dots: each UTC hour's settled spend, from the run records. The number is the day window's spent and held.";
export const SPEND_SUM_TEXT = "Dots: each UTC hour's settled spend, from the run records. The number is their sum.";

/**
 * The one sentence for a waiting read that was cut (`truncated`: it stopped at its bound on queues, or a queue held
 * more waiting jobs than one read takes), whichever the cut was: In line draws it under every cut read, and the
 * timeline's notes draw the same constant (`UNREAD.waitingCut`), so the two cannot say the cut in different words.
 */
export const WAITING_CUT_TEXT = "Not every waiting job was read, so jobs in line may be missing here.";

/** Caps' sentence when the settings overlay was read whole and sets no cap: it names its source, the overlay. */
export const CAPS_EMPTY_TEXT = "The settings overlay sets no cap.";

/**
 * The fixed sentences of reads that failed, or that were not made whole (a reader's own message can name a host, so
 * none is ever drawn). THE READ RULE, every panel's: a whole count, an empty sentence (`CAPS_EMPTY_TEXT`, "nothing is
 * waiting", "No run in this window, and nothing in line.", Spend today's, the waitlists' calm line) or All clear is
 * drawn only over the reads behind it, each made whole; a read that failed or was cut is said here instead, never drawn
 * as nothing.
 */
const UNREAD = Object.freeze({
  parked: "The parked runs could not be read, so the questions are not counted.",
  failed: "The failed jobs could not be read, so they are not counted.",
  doctor: "The doctor results could not be read, so failing doctors are not counted.",
  registry: "The host registry could not be read, so failing doctors are not counted.",
  registryNoWorker: "The host registry could not be read and the queue sees no worker connected, so failing doctors are not counted and whether a worker is online is not known.",
  day: "The run history could not be read, so the day's failures are not counted.",
  waiting: "The waiting jobs could not be read.",
  waitingCut: WAITING_CUT_TEXT,
  settings: "The settings overlay could not be read, so its caps are not drawn.",
  dollars: "The dollar counters could not be read.",
  counts: "The job or token counters could not be read, so their windows are not drawn.",
  spend: "The run records could not be read, so the spend per hour is not drawn.",
  spendShort: "Not every run record of today was read, so these hours may be missing spend.",
  runs: "The run history could not be read, so only what runs and waits is drawn.",
  runsPartial: "Some run records could not be read, so runs in this window may be missing.",
});

// ---- links ---------------------------------------------------------------------------------------------------------------

/** The pages the overview links to, as `pages.mjs` `PAGES` names them (pinned to it by a test; see the header). */
export const OVERVIEW_LINKS = Object.freeze({
  overview: Object.freeze({ path: "/" }),
  runs: Object.freeze({ path: "/runs" }),
  run: Object.freeze({ path: "/run" }),
  parked: Object.freeze({ path: "/parked" }),
  insights: Object.freeze({ path: "/insights" }),
  fleet: Object.freeze({ path: "/fleet" }),
  config: Object.freeze({ path: "/config" }),
});

/** A page's link: `name` in the caller's page table, else `fallback`'s (see the header); null for neither. */
function hrefTo(view, name, query = null, fallback = null) {
  const pages = view?.pages !== null && typeof view?.pages === "object" ? view.pages : OVERVIEW_LINKS;
  const own = ui.pageHref(pages, name, query);
  if (own !== null || fallback === null) return own;
  return ui.pageHref(pages, fallback) ?? ui.pageHref(OVERVIEW_LINKS, fallback);
}

/** A run's page, for an id `/run?id=` takes (`RUN_ID_RE`); null for any other. */
const runHref = (view, jobId) => (typeof jobId === "string" && RUN_ID_RE.test(jobId) ? hrefTo(view, "run", { id: jobId }) : null);

// ---- small words ----------------------------------------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** A duration to the second under an hour ("1m 48s"), else `ageText`'s ("2h 14m"). */
function durText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const s = Math.floor((ms % 60_000) / 1000);
    return s === 0 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 60_000)}m ${s}s`;
  }
  return ageText(ms);
}

/** An age in whole words, for a line that says how old something is ("2 minutes", "3 days"): its largest unit alone. */
function ageWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  const [n, unit] = ms < 60_000 ? [Math.floor(ms / 1000), "second"] : ms < 3_600_000 ? [Math.floor(ms / 60_000), "minute"] : ms < 86_400_000 ? [Math.floor(ms / 3_600_000), "hour"] : [Math.floor(ms / 86_400_000), "day"];
  return `${count(n)} ${n === 1 ? unit : `${unit}s`}`;
}

/**
 * An instant as a `<time>`, or null for one outside what the worker's leaf passes on: a whole number of ms from 0 to
 * `DEFER_TIME_MAX_MS`, the year 9999's last instant (see the header). Past it `utcText` writes a six-digit year cut at
 * sixteen characters, a date that is not the instant's; the cancel preview's line holds its instants to the same range.
 */
const timeOrNull = (ms) => (Number.isSafeInteger(ms) && ms >= 0 && ms <= DEFER_TIME_MAX_MS ? timeHtml(ms) : null);

/** A project id as the projects file spells one, or null. */
const projectId = (v) => (typeof v === "string" && DEFER_PROJECT_RE.test(v) ? v : null);

/** A queue's name as a row shows it: the shared `pi-jobs`, and a host's queue by its host (`@build3`). */
function queueLabel(name) {
  const at = typeof name === "string" ? name.indexOf("@") : -1;
  return at > 0 ? name.slice(at) : String(name ?? "-");
}

/** A host queue's name for host `name` (`pi-jobs@build3`), as the snapshot's `queueCounts` carries it. */
const hostQueueOf = (s, name) => (Array.isArray(s?.queueCounts) ? s.queueCounts.find((q) => typeof q?.queue === "string" && q.queue.endsWith(`@${name}`) && q.queue.indexOf("@") === q.queue.length - name.length - 1) ?? null : null);

/** Whether this view's overview is the first run's checklist (`firstRunState`). */
const setupOf = (view) => firstRunState(view?.data?.snapshot ?? null, { session: { role: view?.role ?? null }, deployment: view?.data?.deployment ?? null, freshMs: BEAT_FRESH_MS });

/**
 * One of the overview's eight: the fixed sentence in its card when there is no snapshot, nothing while the first run's
 * checklist stands in for the overview, else `render(snapshot, view)`.
 */
function overviewPanel(title, render) {
  return (view) => {
    const s = view?.data?.snapshot;
    if (!s) return ui.card({ title, body: html`<p class="muted">${OVERVIEW_UNREAD_TEXT}</p>` });
    if (setupOf(view).applies) return html``;
    return render(s, view);
  };
}

/** The registry rows the overview draws (named rows only). */
const hostsOf = (s) => (Array.isArray(s?.hostBudgets) ? s.hostBudgets.filter((h) => h && typeof h.name === "string") : []);

/** Each job id's project, from the day's records and the newest runs (a parked or failed job's own record). */
function projectsByJob(s) {
  const out = new Map();
  for (const r of [...(Array.isArray(s?.runsDay?.runs) ? s.runsDay.runs : []), ...(Array.isArray(s?.runs) ? s.runs : [])]) {
    if (typeof r?.jobId === "string" && !out.has(r.jobId) && projectId(r.project) !== null) out.set(r.jobId, r.project);
  }
  return out;
}

/**
 * A job id as a row shows it, in the code face: a scheduler's run by its trigger and its run time ("hourly-sync,
 * <time> run"), since `repeat:hourly-sync:1791471600000` says neither to a person, the raw id in `title`; any other id
 * as it is.
 */
function jobIdHtml(jobId) {
  const id = String(jobId);
  const run = ui.schedulerRunOf(id);
  if (run === null || run.at === null) return html`<span class="code">${id}</span>`;
  return html`<span class="code" title="${id}">${run.scheduler}, ${timeHtml(run.at)} run</span>`;
}

/** A row's project tag and id: the tag where the project is known, the id in the code face (`jobIdHtml`). */
const idItems = (project, jobId) => [...(project === null ? [] : [ui.ptag(project)]), jobIdHtml(jobId)];

// ---- the headline -----------------------------------------------------------------------------------------------------------

/**
 * The reads Needs you rests on, each `[key, noun]`: the noun is how the headline names it when it could not be read
 * (`UNREAD` holds the card's sentence for the same key). `registry` is the host registry's own read this tick (the
 * snapshot's `queue.fleetDegraded` unset, its rows a list): "to fix" counts the registry's hosts whose doctor fails, so
 * its 0 and All clear stand on that read as much as on the three lists, and nothing else stands in for it.
 */
const NEEDS_READS = Object.freeze([
  ["parked", "the parked runs"],
  ["failed", "the failed jobs"],
  ["doctor", "the doctor results"],
  ["registry", "the host registry"],
]);

/**
 * What needs the person, Needs you's and the headline's one rule, so the two cannot disagree:
 * `{ questions, answering, failedRows, failedJobs, failingHosts, fix, unread, questionsKnown, fixKnown, read, day,
 * noWorker, workerKnown, clear }`.
 *
 * Each list holds what was read. `unread` is the keys of `NEEDS_READS` whose read failed, or whose field the snapshot
 * lacks: an empty list where a read failed would say nothing needs the person, which nobody knows. A count is whole
 * only where every read behind it was made (`questionsKnown`: the parked runs; `fixKnown`: the failed jobs, the doctor
 * results and the host registry), else it is a floor, and neither surface ever writes 0 for what it could not read;
 * `read` is all four. `failingHosts` are the registry's hosts whose doctor fails, never a host gone from it, so none
 * while the registry was not read: its rows are then the last ones seen, and a host may have left since.
 * BULLMQ'S LIST ANSWERS ONE QUESTION ONLY, whether a worker is online (`workersOnline`: its `online` is null for a
 * registry that could not be read, and its `none` false, since it judges nothing then; `workerKnown` is false only
 * there with no worker the queue sees connected), never which hosts the registry holds: it once stood in for the
 * registry's read, and the card then drew a whole "0 to fix" and All clear over failing doctors nobody had counted.
 * `day` is the last 24 hours' failed and refused runs (`{ read, floor, failed, refused }`, read only as whole counts).
 * `noWorker` is the hosts panel's "no worker online" (`workersOnline`). `clear` is the one All clear rule (the card's,
 * `REQ-OPERATOR-CONSOLE-SCREENS` (a2)): every read made, a worker online to run what is in line, nothing to answer or
 * fix, and a day read whole with no failure and no refusal.
 */
function needsOf(s) {
  const parkedRead = Array.isArray(s?.parked) && !s.parkedUnreachable;
  const failedRead = s?.failed !== null && typeof s?.failed === "object" && !s.failed.unreachable && Array.isArray(s.failed.rows);
  const doctorRead = s?.doctor !== null && typeof s?.doctor === "object" && !s.doctor.unreachable;
  const registryRead = Array.isArray(s?.hostBudgets) && !s?.queue?.fleetDegraded;
  const workers = workersOnline(s);
  const parked = parkedRead ? s.parked.filter((p) => p && p.answered !== true) : [];
  const answering = parked.filter((p) => typeof p.answering === "string").length;
  const questions = parked.filter((p) => typeof p.answering !== "string");
  const failedRows = failedRead ? s.failed.rows : [];
  const failedJobs = failedRows.length + (failedRead && Number.isSafeInteger(s.failed.more) && s.failed.more > 0 ? s.failed.more : 0);
  // A host's failing doctor counts while the host is in the registry: a gone host's record outlives it by days.
  const live = new Set(hostsOf(s).map((h) => h.name));
  const failingHosts = doctorRead && registryRead ? doctorHostsOf(s).filter((r) => live.has(r.name) && !r.unreadable && Number.isSafeInteger(r.counts?.fail) && r.counts.fail > 0) : [];
  const unread = NEEDS_READS.map(([key]) => key).filter((key) => !{ parked: parkedRead, failed: failedRead, doctor: doctorRead, registry: registryRead }[key]);
  const fix = failedJobs + failingHosts.length;
  const dayRead = Number.isSafeInteger(s?.failures24h) && s.failures24h >= 0;
  const day = { read: dayRead, floor: dayRead && s.failures24hFloor === true, failed: dayRead ? s.failures24h : 0, refused: dayRead && Number.isSafeInteger(s.refusals24h?.count) && s.refusals24h.count > 0 ? s.refusals24h.count : 0 };
  const read = unread.length === 0;
  const noWorker = workers.none;
  const clear = read && !noWorker && questions.length === 0 && fix === 0 && day.read && !day.floor && day.failed === 0 && day.refused === 0;
  return { questions, answering, failedRows, failedJobs, failingHosts, fix, unread, questionsKnown: parkedRead, fixKnown: failedRead && doctorRead && registryRead, read, day, noWorker, workerKnown: workers.online !== null || workers.connected > 0, clear };
}

/** How many jobs run, as the headline says it. */
function runningText(s) {
  const n = Array.isArray(s?.active) ? s.active.length : 0;
  return n === 0 ? "nothing is running" : `${plural(n, "job")} running`;
}

const capFirst = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A list in words: "a", "a and b", "a, b and c". */
const andList = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * The headline (`#p-headline`): on a first run the checklist's lead; else, by `needsOf`'s one rule, "All clear. 4 jobs
 * running, nothing needs you." only where Needs you says All clear; what needs the person as it was read ("Needs you:
 * 1 question and 3 to fix. 4 jobs running."); where a read failed, which, in fixed words, and that more may need the
 * person, or that what does is not known ("The failed jobs could not be read, so what needs you is not known."), all
 * led by `NO_WORKER_TEXT` when no worker is online; else "Nothing needs you." (the day had a failure or a refusal, or
 * was not read whole, which Needs you's foot line says).
 */
export function overviewHeadline(view) {
  const s = view?.data?.snapshot;
  if (!s) return html`Valkey could not be read; the next refresh tries again.`;
  const setup = setupOf(view);
  if (setup.applies) return html`${setup.lead}`;
  const need = needsOf(s);
  const running = runningText(s);
  if (need.clear) return html`All clear. ${capFirst(running)}, nothing needs you.`;
  // What was read, counted; a read that failed adds nothing here (its list is empty) and is said after.
  const parts = [...(need.questions.length > 0 ? [plural(need.questions.length, "question")] : []), ...(need.fix > 0 ? [`${count(need.fix)} to fix`] : [])];
  // With no worker online the line leads with it: nothing in line runs until one starts, which needs the person first.
  const lead = `${need.noWorker ? `${NO_WORKER_TEXT} ` : ""}${parts.length > 0 ? `Needs you: ${parts.join(" and ")}. ` : ""}`;
  if (!need.read) {
    const nouns = NEEDS_READS.filter(([key]) => need.unread.includes(key)).map(([, noun]) => noun);
    return html`${lead}${capFirst(andList(nouns))} could not be read, so ${parts.length > 0 ? "more may need you" : "what needs you is not known"}. ${capFirst(running)}.`;
  }
  return lead !== "" ? html`${lead}${capFirst(running)}.` : html`Nothing needs you. ${capFirst(running)}.`;
}

// ---- Needs you -------------------------------------------------------------------------------------------------------------

/** The most rows Needs you lists before it counts the rest (the card's four). */
export const NEEDS_ROWS_MAX = 4;

/**
 * The day's failures and refusals, Needs you's foot line (`refusalsIn`'s rule: cancels are not refusals), from
 * `needsOf`'s `day`: a day that could not be read is said; a floor with nothing in it is said, since it is why the card
 * is not All clear; a day with neither is no line.
 */
function dayLine(day, view) {
  if (!day.read) return html`<p class="card__sub">${UNREAD.day}</p>`;
  if (day.failed === 0 && day.refused === 0) return day.floor ? html`<p class="card__sub">${DAY_FLOOR_TEXT}</p>` : null;
  const floor = day.floor ? "at least " : "";
  const parts = [];
  if (day.failed > 0) parts.push(html`<a href="${hrefTo(view, "runs", { outcome: "failed" })}">${floor}${count(day.failed)} failed</a>`);
  if (day.refused > 0) parts.push(html`<a href="${hrefTo(view, "runs", { outcome: "policy" })}">${floor}${count(day.refused)} refused</a>`);
  return html`<p class="card__sub">Last 24 hours: ${parts.length === 2 ? html`${parts[0]} and ${parts[1]}` : parts[0]}${day.refused > 0 ? ", not counting runs an operator cancelled" : ""}.</p>`;
}

/**
 * One of Needs you's two numbers (`ui.big`): its count where every read behind it was made; where one was not, what
 * was read as a floor in the label ("1 or more to fix", the number alone in the big face), or a dash with "not known"
 * when it read nothing: never a 0 for what could not be read.
 */
function needsBig(known, n, { one, many, status, href }) {
  if (known) return ui.big({ n: count(n), label: n === 1 ? one : many, status: n > 0 ? status : null, href });
  if (n > 0) return ui.big({ n: count(n), label: `or more ${many}`, status, href });
  return ui.big({ n: "-", label: `${many}: not known`, href });
}

export const overviewNeeds = overviewPanel("Needs you", (s, view) => {
  const need = needsOf(s);
  const act = canAct(view);
  const projects = projectsByJob(s);
  // Each row `{ pill, tagless }`: a job's row carries its project where a run record read here names one, and a job's
  // row without one is `tagless`, which the card then says once (a host's row names a host, not a project).
  const rows = [];
  for (const p of need.questions) {
    const href = runHref(view, p.jobId);
    const project = projectId(p.project) ?? projects.get(p.jobId) ?? null;
    // Answer where this page can take the answer (an operator on a console that takes changes); else the run's page.
    rows.push({ pill: ui.rowPill({ icon: "parked", status: "parked", items: idItems(project, String(p.jobId ?? "-")), action: href === null ? null : { label: act ? "Answer" : "Open", href } }), tagless: project === null });
  }
  for (const j of need.failedRows) {
    const id = typeof j?.jobId === "string" ? j.jobId : null;
    if (id === null) continue;
    const retry = act && RUN_ID_RE.test(id) && typeof j.queue === "string";
    const href = runHref(view, id);
    const action = retry ? ui.actForm({ action: "retry-failed", hidden: [["jobId", id], ["queue", j.queue]], label: "Retry", kind: ["sm", "paid"] }) : href === null ? null : { label: "Open", href };
    const project = projects.get(id) ?? null;
    rows.push({ pill: ui.rowPill({ icon: "failed", status: "failed", items: idItems(project, id), action }), tagless: project === null });
  }
  for (const h of need.failingHosts) {
    // The name in `title` too: a long one gives way to its row's words, and is still read whole there.
    rows.push({ pill: ui.rowPill({ icon: "doctor", status: "failed", items: [html`<b title="${h.name}">${h.name}</b>`, "doctor fails"], action: { label: "Open", href: hrefTo(view, "host", { name: h.name }, "fleet") } }), tagless: false });
  }
  const shown = rows.slice(0, NEEDS_ROWS_MAX);
  const hidden = rows.length - shown.length + (need.failedJobs - need.failedRows.length);
  const answering = need.answering > 0 ? html`<p class="card__sub">${plural(need.answering, "more question is", "more questions are")} being answered now.</p>` : null;
  const more = hidden > 0 ? html`<p class="card__sub">And ${count(hidden)} more: see <a href="${hrefTo(view, "parked")}">Parked</a> and <a href="${hrefTo(view, "fleet")}">Fleet</a>.</p>` : null;
  // The 0 and its "nothing needs you" only where all four reads were made and found nothing, and a worker is online to
  // run what is in line; else the two numbers, each a count, a floor or "not known".
  const zero = need.read && !need.noWorker && need.questions.length === 0 && need.fix === 0;
  const head = zero
    ? ui.kpi(count(0), NEEDS_EMPTY.title)
    : html`<div class="bigpair">${needsBig(need.questionsKnown, need.questions.length, { one: "question", many: "questions", status: "parked", href: hrefTo(view, "parked") })}${needsBig(need.fixKnown, need.fix, { one: "to fix", many: "to fix", status: "failed", href: hrefTo(view, "fleet") })}</div>`;
  // An unread registry says, beside the doctors it leaves uncounted, that whether a worker is online is not known either
  // where the queue sees none connected (BullMQ's list answers that alone).
  const unreadText = (key) => (key === "registry" && !need.workerKnown ? UNREAD.registryNoWorker : UNREAD[key]);
  const notes = [...(need.noWorker ? [NO_WORKER_TEXT] : []), ...need.unread.map(unreadText), ...(shown.some((r) => r.tagless) ? [NEEDS_UNKNOWN_PROJECT_TEXT] : [])];
  const body = html`${head}${shown.length > 0 ? html`<ul class="rows">${shown.map((r) => r.pill)}</ul>` : null}${more}${answering}${need.clear ? ui.empty({ status: "ok", icon: "done", title: "All clear", body: NEEDS_EMPTY.body }) : null}${notes.map((n) => html`<p class="card__sub">${n}</p>`)}${dayLine(need.day, view)}${zero ? null : html`<p class="card__sub">${NEEDS_DEFINITION}</p>`}`;
  return ui.card({ title: "Needs you", body });
});

// ---- In line ---------------------------------------------------------------------------------------------------------------

/** The buckets In line always lists, at 0 too, so the card does not change shape (the card's four). */
export const WAITING_MAIN_BUCKETS = Object.freeze(["slot", "run", "check", "retry"]);

/** A bucket's icon: the timeline's glyph for it (`timeline.mjs` `TIMELINE_WAIT_WORDS`), so the two draw a reason alike. */
const bucketIcon = (bucket) => TIMELINE_WAIT_WORDS[Object.hasOwn(TIMELINE_WAIT_WORDS, bucket) ? bucket : "none"].glyph;

/** The waiting read, `{ rows, byBucket, ... }`, or null when it was not made or failed. */
function waitingOf(s) {
  const w = s?.waiting;
  return w && typeof w === "object" && !w.unreachable && Array.isArray(w.rows) ? w : null;
}

/** Each bucket's count of the jobs in line. */
function bucketCounts(w) {
  const by = Object.fromEntries(DEFER_BUCKETS.map((b) => [b, 0]));
  for (const r of w.rows) by[Object.hasOwn(by, r?.bucket) ? r.bucket : "none"] += 1;
  return by;
}

/**
 * How many jobs are in line, `{ n, label, cut }` for the big number and its label: a count where the read was whole; a
 * floor in the label where it was cut and found jobs ("5 or more jobs waiting to start"); and where it was cut before
 * it found any, a dash with "not known", as Needs you writes a number nothing was read for (`cut`), since "0 or more"
 * says nothing and "nothing is waiting" would be false. The setup's preview says the same.
 */
function inLineOf(w) {
  const n = w.rows.length;
  if (w.truncated === true) return n > 0 ? { n: count(n), label: "or more jobs waiting to start", cut: false } : { n: "-", label: "jobs waiting: not known", cut: true };
  return { n: count(n), label: n === 0 ? WAITING_EMPTY.title : n === 1 ? "job waiting to start" : "jobs waiting to start", cut: false };
}

/**
 * A reason row's count under a cut read: a floor, "2 or more", or a dash where the read found none of that reason,
 * never a whole number (a whole 0 would say no job waits for it, which a cut read cannot know).
 */
const floorEnd = (n) => (n > 0 ? html`<b>${count(n)}</b> or more` : html`<b>-</b>`);

/**
 * In line: the big number (`inLineOf`), the age of the longest wait, and each reason's count, the four main ones always.
 * ONE RULE UNDER A CUT READ (`truncated`): every number the card draws is a floor, "N or more", or a dash for none
 * found: the big number in its label, each reason row's count (`floorEnd`), and the longest wait, since the job that has
 * waited longest may be one the read did not reach; and `WAITING_CUT_TEXT` says why, whichever the cut was.
 */
export const overviewWaiting = overviewPanel("In line", (s, view) => {
  const w = waitingOf(s);
  if (w === null) return ui.card({ title: "In line", body: html`<p class="muted">${UNREAD.waiting}</p>` });
  const cut = w.truncated === true;
  const oldest = w.rows.reduce((a, r) => (Number.isSafeInteger(r?.queuedAt) && (a === null || r.queuedAt < a) ? r.queuedAt : a), null);
  const longest = oldest !== null && Number.isFinite(view.now) && view.now >= oldest ? ui.chip(`longest ${ageText(view.now - oldest)}${cut ? " or more" : ""}`) : null;
  const by = bucketCounts(w);
  const buckets = DEFER_BUCKETS.filter((b) => WAITING_MAIN_BUCKETS.includes(b) || by[b] > 0);
  const rows = buckets.map((b) => ui.rowPill({ icon: bucketIcon(b), items: [DEFER_BUCKET_WORDS[b].short], end: cut ? floorEnd(by[b]) : by[b] }));
  // The big number is a count alone, or a dash; a floor is said in its label (`inLineOf`).
  const line = inLineOf(w);
  return ui.card({ title: "In line", end: longest, body: html`${ui.kpi(line.n, line.label)}<ul class="rows">${rows}</ul>${cut ? html`<p class="card__sub">${WAITING_CUT_TEXT}</p>` : null}` });
});

// ---- Running ---------------------------------------------------------------------------------------------------------------

/** A host whose list of running jobs could not be read (the reader's `jobsUnreadable`), as its row says it. */
export const JOBS_UNREAD_WORDS = "running jobs unreadable";

/** The Hosts card's note for such a host. */
export const JOBS_UNREAD_TEXT = "Its list of running jobs could not be read, so how many it runs, and how many of its slots are free, is not known.";

/** A host that has not beaten within `BEAT_FRESH_MS`, as its Running row and its slots say it. */
export const NOT_BEATING_WORDS = "not beating";

/** A host row of a registry that could not be read this tick (the rows last seen), as its Running row and slots say it. */
export const LAST_SEEN_WORDS = "as last seen";

/** Why a host's slots are not known, in a row's words (`slotsOf`'s `unknown`). */
const UNKNOWN_SLOT_WORDS = Object.freeze({ unread: JOBS_UNREAD_WORDS, stale: NOT_BEATING_WORDS, lastSeen: LAST_SEEN_WORDS });

/** Whether a registry row's host beats: a last beat within `BEAT_FRESH_MS`, the rule `workersOnline` counts online by. */
const beats = (h) => beatFresh(h);

/**
 * A host row's slots: `{ unknown, run, hold, free, total }`, `total` null when the host publishes no slot count, and
 * `unknown` why nothing about its slots is drawn as a count, and none of them as free, or null: `lastSeen` for every row
 * of a registry that could not be read this tick (`lastSeen`, the snapshot's `queue.fleetDegraded`: the rows are the
 * last ones read, their beat ages as old as that read, so a slot drawn free from them is one nobody knows is free),
 * `stale` for a host that has not beaten within `BEAT_FRESH_MS` (its list is as its last beat left it, and a host that
 * does not beat takes no job, so a slot drawn free there would sit beside "No worker online" as one that is), `unread`
 * for one whose list of running jobs could not be read. Any of them leaves the slots used a floor with no total
 * (`runningLabel`).
 */
function slotsOf(h, lastSeen = false) {
  const raw = typeof h?.concurrency === "number" ? h.concurrency : typeof h?.concurrency === "string" && /^\d{1,4}$/.test(h.concurrency) ? Number(h.concurrency) : null;
  const total = Number.isSafeInteger(raw) ? raw : null;
  if (lastSeen) return { unknown: "lastSeen", run: 0, hold: 0, free: 0, total };
  if (!beats(h)) return { unknown: "stale", run: 0, hold: 0, free: 0, total };
  if (h?.jobsUnreadable === true) return { unknown: "unread", run: 0, hold: 0, free: 0, total };
  const jobs = Array.isArray(h?.jobs) ? h.jobs : [];
  const hold = jobs.filter((j) => j?.o === true).length;
  const run = jobs.length - hold + (Number.isSafeInteger(h?.jobsMore) && h.jobsMore > 0 ? h.jobsMore : 0);
  return { unknown: null, run, hold, free: total === null ? 0 : Math.max(0, total - run - hold), total };
}

/** A host's slot dots, named for a screen reader; none for a host whose slots are not known (`slotsOf`). */
const slotDots = (name, sl) =>
  sl.unknown !== null
    ? ui.slots({ label: `${name}: ${UNKNOWN_SLOT_WORDS[sl.unknown]}` })
    : ui.slots({ run: sl.run, hold: sl.hold, free: sl.free, label: `${name}: ${count(sl.run)} running, ${count(sl.hold)} held, ${sl.total === null ? "slots not published" : `${count(sl.free)} free`}` });

/** A Running row's end: what its slots hold, in words. */
function slotsEnd(sl) {
  if (sl.unknown !== null) return { text: UNKNOWN_SLOT_WORDS[sl.unknown], status: "attention" };
  if (sl.hold > 0) return { text: `${count(sl.hold)} held`, status: "attention" };
  return { text: sl.total === null ? "slots not published" : sl.free > 0 ? `${count(sl.free)} free` : "full", faint: true };
}

/**
 * Running's label beside its count of active jobs: the slots used of all the hosts' where the registry has rows; with
 * none, "nothing is running" only for no job, and for jobs that run (a worker from before the registry, or a registry
 * that could not be read) that they run and no host publishes its slots; a host whose slots are not known (`slotsOf`:
 * its registry was not read this tick, it does not beat, or its running jobs could not be read) makes the slots used a
 * floor with no total, and a floor of none says nothing, so then the label is the count's own ("nothing is running", or
 * that jobs run in slots not known). The label follows the count, never the rows.
 */
function runningLabel(n, slots) {
  if (slots.length === 0) return n === 0 ? RUNNING_EMPTY.title : `${n === 1 ? "job" : "jobs"} running, slots not published`;
  const used = slots.reduce((a, { sl }) => a + sl.run + sl.hold, 0);
  // A host whose slots are not known uses slots nobody can count: the slots used are a floor, with no total.
  if (slots.some(({ sl }) => sl.unknown !== null)) {
    if (used > 0) return `in ${count(used)} or more slots`;
    return n === 0 ? RUNNING_EMPTY.title : `${n === 1 ? "job" : "jobs"} running, slots not known`;
  }
  const total = slots.every(({ sl }) => sl.total !== null) ? slots.reduce((a, { sl }) => a + sl.total, 0) : null;
  return total === null ? `in ${plural(used, "slot")}` : `in ${count(used)} of ${plural(total, "slot")}`;
}

export const overviewActive = overviewPanel("Running", (s) => {
  const n = Array.isArray(s.active) ? s.active.length : 0;
  const lastSeen = Boolean(s.queue?.fleetDegraded);
  const slots = hostsOf(s).map((h) => ({ h, sl: slotsOf(h, lastSeen) }));
  const rows = slots.map(({ h, sl }) =>
    ui.rowPill({ items: [html`<b title="${h.name}">${h.name}</b>`, slotDots(h.name, sl)], end: slotsEnd(sl) }),
  );
  const live = n > 0 ? ui.chip("live", { status: "running", icon: "running" }) : null;
  // A registry that could not be read says so, under the rows last seen or in their place, never that no host is
  // registered.
  const note = lastSeen ? REGISTRY_UNREAD_TEXT : rows.length === 0 ? HOSTS_EMPTY.body : null;
  return ui.card({ title: "Running", end: live, body: html`${ui.kpi(count(n), runningLabel(n, slots))}${rows.length > 0 ? html`<ul class="rows">${rows}</ul>` : null}${note === null ? null : html`<p class="card__sub">${note}</p>`}` });
});

// ---- Spend today -----------------------------------------------------------------------------------------------------------

/**
 * Micro-dollars as a KPI's big number: `moneyHtml`'s fixed form with the exact amount on hover, in a `<data>` element,
 * since the bundle draws every `span` inside a `.kpi` in its small label face (`.kpi span`).
 */
function kpiMoney(micros, { spent = false } = {}) {
  return usdText(micros) === "-" ? "-" : html`<data value="${String(micros)}" title="${usdText(micros)}">${usd2(micros, { spent })}</data>`;
}

/**
 * `used` as a percentage of `cap`, or null: rounded DOWN below the cap (`moneyHtml`'s spent rule), so a window one unit
 * short of its cap never reads as full; at or past it, as it is.
 */
const pctOf = (used, cap) => (Number.isFinite(used) && Number.isFinite(cap) && cap > 0 ? (used >= cap ? (used / cap) * 100 : Math.floor((used / cap) * 100)) : null);

/**
 * Spend today: the deployment's day window, spent and held, against its cap, where that window's counter was read;
 * else the run records' settled spend today, the dots' sum; else (neither read) a dash, "not known". The note under
 * the dots names which the number is (`SPEND_HOURS_TEXT`, `SPEND_SUM_TEXT`), a counter that could not be read is said
 * (the reader's `unreachable`, or a day window whose counter came back null), and so is a day of records not read
 * whole (only the newest read, or a side of them unread), whose hours may be short.
 */
export const overviewSpend = overviewPanel("Spend today", (s) => {
  const d = s.dollars;
  const day = Array.isArray(d?.rows) ? d.rows.find((r) => r?.ledger === "deployment" && r.window === "day") ?? null : null;
  const windowRead = day !== null && Number.isSafeInteger(day.counterMicros);
  const countersUnread = Boolean(d?.unreachable) || (day !== null && !windowRead);
  const hours = Array.isArray(s.spendByHour?.hours) ? s.spendByHour.hours : null;
  const cut = hours === null ? -1 : hours.indexOf(null);
  const past = hours === null ? null : hours.slice(0, cut === -1 ? hours.length : Math.max(1, cut));
  const settled = past === null ? null : past.reduce((a, v) => a + (Number.isSafeInteger(v) && v > 0 ? v : 0), 0);
  let kpi;
  let chip = null;
  if (windowRead) {
    const pct = pctOf(day.counterMicros, day.capMicros);
    kpi = ui.kpi(kpiMoney(day.counterMicros, { spent: true }), html`of ${moneyHtml(day.capMicros)}`);
    if (pct !== null) chip = ui.chip(`${count(Math.floor(pct))}% of cap`, { status: day.full ? "failed" : "ok" });
  } else if (settled !== null) kpi = ui.kpi(kpiMoney(settled), "settled today");
  else kpi = ui.kpi("-", "not known");
  const dots = past === null ? html`<p class="card__sub">${UNREAD.spend}</p>` : ui.spendDots({ hours: past, label: "Settled spend by UTC hour today", startHour: 0 });
  const unpriced = Number.isSafeInteger(s.spendByHour?.unpriced) && s.spendByHour.unpriced > 0 ? ` ${plural(s.spendByHour.unpriced, "run")} today ${s.spendByHour.unpriced === 1 ? "carries" : "carry"} no settled amount.` : "";
  // The read rule: "No run has settled any spend today." only over the day's records read whole; over a day read in part
  // the note names its number's source as it does for any sum, and `spendShort` says the hours may be missing spend.
  const short = past !== null && (s.spendByHour.floor === true || s.spendByHour.partial === true);
  const note = past === null ? null : html`<p class="card__sub">${settled === 0 && !short ? SPEND_EMPTY.body : windowRead ? SPEND_HOURS_TEXT : SPEND_SUM_TEXT}${unpriced}</p>`;
  return ui.card({ title: "Spend today", end: chip, body: html`${kpi}${dots}${note}${short ? html`<p class="card__sub">${UNREAD.spendShort}</p>` : null}${countersUnread ? html`<p class="card__sub">${UNREAD.dollars}</p>` : null}` });
});

// ---- the timeline ----------------------------------------------------------------------------------------------------------

/** The timeline's query as the overview's links write it: a default is left out, so a link is the canonical one. */
function timelineQuery(view) {
  const q = view?.query ?? {};
  return {
    rows: TIMELINE_ROWS.includes(q.rows) ? q.rows : null,
    zoom: typeof q.zoom === "string" && Object.hasOwn(TIMELINE_ZOOMS, q.zoom) ? q.zoom : null,
    project: projectId(q.project),
  };
}

/** The overview's own link with the timeline's query changed by `over`. */
function overviewHref(view, q, over) {
  const next = { ...q, ...over };
  return hrefTo(view, "overview", { rows: next.rows === TIMELINE_ROWS[0] ? null : next.rows, zoom: next.zoom === "3h" ? null : next.zoom, project: next.project });
}

/**
 * The project chips (the card's title-bar filter, here in the card): All, then each project of the window, as links.
 * All counts every project, the chips the timeline did not draw (`chipsMore`) too, and those are said in one "+N more".
 */
function chipsHtml(view, q, model) {
  if (!Array.isArray(model.chips) || model.chips.length === 0) return null;
  const more = model.chipsMore ?? null;
  const moreCount = Number.isSafeInteger(more?.count) ? more.count : 0;
  const all = model.chips.reduce((a, c) => a + (Number.isSafeInteger(c.count) ? c.count : 0), 0) + moreCount;
  const link = (href, on, inner) => html`<a href="${href}"${on ? html` aria-current="page"` : null}>${inner}</a>`;
  const rest = Number.isSafeInteger(more?.projects) && more.projects > 0 ? html`<span class="muted">+${count(more.projects)} more</span>` : null;
  return html`<div class="projseg" role="group" aria-label="Project"><span class="projseg__l">Project</span>${link(overviewHref(view, q, { project: null }), model.project === null, html`All<b>${count(all)}</b>`)}${model.chips.map((c) => link(overviewHref(view, q, { project: c.project }), c.on === true, html`${ui.ptag(c.project)}<b>${count(c.count)}</b>`))}${rest}</div>`;
}

export const overviewTimeline = overviewPanel("Runs by project", (s, view) => {
  if (!Number.isFinite(view.now)) return ui.card({ title: "Runs by project", body: html`<p class="muted">${OVERVIEW_UNREAD_TEXT}</p>` });
  const q = timelineQuery(view);
  // A parked run's project is its record's (the parked list carries none), as Needs you reads it.
  const projects = projectsByJob(s);
  const parked = (Array.isArray(s.parked) ? s.parked : []).map((p) => ({ ...p, project: projectId(p?.project) ?? projects.get(p?.jobId) ?? null }));
  // The waiting read whole, for every role: the timeline reads no hold's label or answers (the wait check's profiles,
  // an operator's), so there is nothing in it a viewer may not read.
  const model = timelineModel({ now: view.now, zoom: q.zoom, rows: q.rows, project: q.project, runs: s.runsDay ?? [], active: Array.isArray(s.active) ? s.active : [], hostJobs: hostsOf(s), waiting: s.waiting ?? null, parked });
  const byHost = model.by === "host";
  const title = byHost ? "Runs by host" : "Runs by project";
  const rowsSeg = ui.seg(TIMELINE_ROWS.map((r) => ({ label: r === "host" ? "Host" : "Project", href: overviewHref(view, q, { rows: r }), on: model.by === r })), { label: "Rows" });
  const zoomSeg = ui.seg(Object.keys(TIMELINE_ZOOMS).map((z) => ({ label: z, href: overviewHref(view, q, { zoom: z }), on: model.zoom === z })), { label: "Zoom" });
  // The read rule (`UNREAD`): the empty sentence only over a run history and a waiting read both made whole; each read
  // that was not says so instead, whether or not the timeline is empty.
  const runsRead = s.runsDay !== null && typeof s.runsDay === "object" && Array.isArray(s.runsDay.runs);
  const runsWhole = runsRead && s.runsDay.partial !== true;
  const w = waitingOf(s);
  const notes = [
    runsRead ? null : UNREAD.runs,
    w === null ? UNREAD.waiting : w.truncated === true ? UNREAD.waitingCut : null,
    runsRead && s.runsDay.partial === true ? UNREAD.runsPartial : null,
    runsRead && s.runsDay.floor ? "Only the newest runs are read, so older runs in this window may be missing." : null,
    model.empty && runsWhole && w !== null && w.truncated !== true ? "No run in this window, and nothing in line." : null,
  ].filter(Boolean);
  const body = html`${chipsHtml(view, q, model)}${timelineHtml(model, { label: title })}${notes.map((n) => html`<p class="card__sub">${n}</p>`)}${timelineLegend()}`;
  return ui.card({ title, sub: "left of now: what ran; right of now: what is in line", end: html`${rowsSeg}${zoomSeg}`, body });
});

// ---- Caps ------------------------------------------------------------------------------------------------------------------

/** The job and token windows: `[name, window, counter key, overlay cap key, takes the soft hold]`. */
const COUNT_CAPS = Object.freeze([
  ["Jobs", "today", "day", "dailyCap", true],
  ["Jobs", "week", "week", "weeklyCap", true],
  ["Jobs", "month", "month", "monthlyCap", true],
  ["Tokens", "today", "tokensToday", "dailyTokenCap", false],
]);

const WINDOW_WORD = Object.freeze({ day: "today", week: "week", month: "month" });

/**
 * A dollar window's capsule name (its capsule adds the unit, "$") and, for a project or a model, what the key line says
 * it is. A scope's name is the operator's own `scoped-limits.json` row, and a folder scope is a host path, which a page
 * shows by its last folder for every role (the PATHS rule, `panels.mjs`'s header): every scope is named through
 * `shownPath` (a repo as it is), and the key line names no scope at all, since what it would add is that raw name.
 * A project's capsule is its id, which the key says is a project; a model's is the model alone (its provider,
 * `anthropic/`, would crowd a capsule's label), the key saying which model: a model row's name is `<provider>/<model>`
 * (`splitModelEntry`, a provider before the first `/`), never a host path.
 */
function dollarName(row) {
  if (row.ledger === "deployment") return { name: "Deploy", key: null };
  const raw = typeof row.name === "string" ? row.name : "";
  if (row.ledger === "model") {
    const short = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) || raw : raw;
    return { name: short, key: `${short} $ is model ${raw}` };
  }
  if (raw.startsWith("project:")) {
    const project = raw.slice("project:".length);
    return { name: project, key: `${project} $ is project ${project}` };
  }
  return { name: shownPath(raw), key: null };
}

/**
 * A count window's status by the budget's own band (budget.mjs `windowState`): failed once the next start would pass the
 * cap, attention once it would pass the soft hold, else ok.
 */
function countStatus(used, cap, hold) {
  if (used >= cap) return "failed";
  return Number.isInteger(hold) && used >= Math.floor((cap * hold) / 100) ? "attention" : "ok";
}

/**
 * Caps: a capsule for every window with a cap whose counter was read. The job and token caps and the soft hold are the
 * settings overlay's, so they are drawn only from a settings read made whole (the reader's `{ path, overlay }`, an
 * object; never its `{ path, invalid }`, on which the worker refuses every job): any other read is said in a line of its
 * own (`UNREAD.settings`) and draws none of them. A window with a cap whose counter was not read (a job or token counter
 * that is not a number, the dollar counters' read failed, or a dollar window's counter null) is said in a line too. The
 * empty sentence, `CAPS_EMPTY_TEXT`, is drawn only where no window has a cap and nothing went unread, and it names its
 * source: the worker's own caps from its environment (`PI_DAILY_CAP` and the rest) are in no read this console makes, so
 * "No cap is set." would be false of a worker that caps at its default.
 */
export const overviewCaps = overviewPanel("Caps", (s, view) => {
  const read = s.settings;
  const settingsRead = read !== null && typeof read === "object" && !read.invalid && read.overlay !== null && typeof read.overlay === "object" && !Array.isArray(read.overlay);
  const overlay = settingsRead ? read.overlay : {};
  const b = s.budget !== null && typeof s.budget === "object" ? s.budget : null;
  const hold = Number.isInteger(overlay.softHoldPct) && overlay.softHoldPct >= 1 && overlay.softHoldPct <= 99 ? overlay.softHoldPct : null;
  const caps = [];
  let countsUnread = false;
  for (const [name, window, key, capKey, holds] of COUNT_CAPS) {
    const cap = overlay[capKey];
    if (!Number.isSafeInteger(cap) || cap <= 0) continue;
    const used = b === null ? NaN : Number(b[key] ?? 0);
    if (!Number.isFinite(used)) {
      countsUnread = true;
      continue;
    }
    caps.push(ui.capsule({ name, window, pct: pctOf(used, cap), hold: holds ? hold : null, status: holds ? countStatus(used, cap, hold) : used >= cap ? "failed" : "ok" }));
  }
  const keys = [];
  let dollarsUnread = Boolean(s.dollars?.unreachable);
  for (const r of Array.isArray(s.dollars?.rows) ? s.dollars.rows : []) {
    if (!Number.isSafeInteger(r?.capMicros) || r.capMicros <= 0) continue;
    if (!Number.isSafeInteger(r.counterMicros)) {
      dollarsUnread = true;
      continue;
    }
    const { name, key } = dollarName(r);
    if (key !== null && !keys.includes(key)) keys.push(key);
    caps.push(ui.capsule({ name, unit: "$", window: WINDOW_WORD[r.window] ?? String(r.window), pct: pctOf(r.counterMicros, r.capMicros), status: r.full ? "failed" : "ok" }));
  }
  const unread = [settingsRead ? null : UNREAD.settings, countsUnread ? UNREAD.counts : null, dollarsUnread ? UNREAD.dollars : null].filter(Boolean).map((t) => html`<p class="card__sub">${t}</p>`);
  const spend = ui.btn({ kind: "sm", label: "Spend", href: hrefTo(view, "insights") });
  if (caps.length === 0) return ui.card({ title: "Caps", sub: "percent used", end: spend, body: html`${unread.length > 0 ? unread : html`<p class="muted">${CAPS_EMPTY_TEXT}</p>`}<p class="card__sub">${COUNT_WINDOWS_UTC_TEXT}</p>` });
  const legend = html`<p class="keyrow"><span><i class="k tone-ok"></i>Open</span>${hold !== null ? html`<span><i class="k tone-attention"></i>Soft hold</span>` : null}<span><i class="k tone-failed"></i>Full</span>${hold !== null ? html`<span><i class="k k--hold"></i>Soft hold line (${count(hold)}%)</span>` : null}${keys.length > 0 ? html`<span>${keys.join("; ")}</span>` : null}</p>`;
  return ui.card({ title: "Caps", sub: "percent used", end: spend, body: html`<div class="capbars">${caps}</div>${legend}${unread}<p class="card__sub">${hold !== null ? `${SOFT_HOLD_TEXT} ` : ""}${COUNT_WINDOWS_UTC_TEXT}</p>` });
});

// ---- Waitlists -------------------------------------------------------------------------------------------------------------

/** The most rows one reason's list shows before it counts the rest. */
export const WAITLIST_ROWS_MAX = 5;

/** A wait check's last answer, in words (the worker's `WAIT_ANSWERS`). */
const ANSWER_WORDS = Object.freeze({ go: "met", hold: "not yet", fault: "fault", refuse: "refused", unclear: "unclear" });

/**
 * A placeholder of a `DEFER_WHYS` sentence or of `DEFER_DUE_SENTENCE` from a waiting row, or null when the row does not
 * hold it by its rule: `until` the record's own instant, else the delayed set's due (the worker writes the one it moves
 * the job to), `due` the delayed set's alone, each an instant `timeOrNull` draws.
 */
function placeholder(row, key) {
  if (key === "until") return timeOrNull(row.untilAt) ?? timeOrNull(row.dueAt);
  if (key === "due") return timeOrNull(row.dueAt);
  if (key === "attempt" || key === "attempts") return Number.isSafeInteger(row[key]) && row[key] > 0 ? String(row[key]) : null;
  if (key === "host" || key === "holder" || key === "endpoint") return typeof row[key] === "string" && row[key] !== "" ? row[key] : null;
  return null;
}

/** `sentence` with each `{placeholder}` filled from `row` (`placeholder`), or null when one is missing. */
function filledSentence(sentence, row) {
  const values = sentence.split(/\{([a-z]+)\}/).map((p, i) => (i % 2 === 1 ? placeholder(row, p) : p));
  return values.every((v) => v !== null) ? html`${values}` : null;
}

/**
 * Why a waiting job waits, as a row says it, the cancel preview's line (`actions.mjs` `waitingLine`) for every row: a job
 * the reader found past its due (`due`) says so (`DEFER_DUE_SENTENCE`), whatever it recorded; else the worker's own
 * sentence for the reason it recorded (`DEFER_WHYS`), each `{placeholder}` filled from the row, a time as a `<time>`; a
 * sentence whose placeholder the row lacks says the bucket's title instead ("Waiting for a free slot"), never a sentence
 * with a hole. A reason this console has no words for was recorded all the same: for every role its token in the code
 * face with `NO_EXPLANATION` (see the header's role rule), never the `none` bucket's title, which says no reason was
 * recorded. Null for no row.
 */
export function waitingSentence(row) {
  if (row === null || typeof row !== "object") return null;
  const why = typeof row.why === "string" && DEFER_WHY_RE.test(row.why) ? row.why : null;
  if (row.bucket === "due") {
    const line = filledSentence(DEFER_DUE_SENTENCE, row);
    if (line !== null) return line;
  } else if (why !== null && row.known === true && Object.hasOwn(DEFER_WHYS, why)) {
    const line = filledSentence(DEFER_WHYS[why].sentence, row);
    if (line !== null) return line;
  } else if (why !== null && row.known === false) {
    return html`Recorded reason: <span class="code">${why}</span>, ${NO_EXPLANATION}`;
  }
  return html`${DEFER_BUCKET_WORDS[Object.hasOwn(DEFER_BUCKET_WORDS, row.bucket) ? row.bucket : "none"].title}`;
}

/** The registry's orphan entries (a job gone, its slot still held) per host name. */
function orphansByHost(s) {
  const out = new Map();
  for (const h of hostsOf(s)) {
    const held = (Array.isArray(h.jobs) ? h.jobs : []).filter((j) => j?.o === true && typeof j.id === "string").map((j) => j.id);
    if (held.length > 0) out.set(h.name, held);
  }
  return out;
}

/** Whether a row waits for its host's slot while a job that is gone holds one there (the timeline's arrow, too). */
const heldSlot = (row, orphans) => row.bucket === "slot" && (row.why === "host-slot" || row.why === "host-budget") && typeof row.host === "string" && orphans.has(row.host);

/**
 * Whether `cancel-queued` would plan this row: it never started, never stalled, recovers no run, is no scheduler's next.
 * A count Valkey holds malformed reads null, and is not 0.
 */
const cancellable = (row) => row.attemptsMade === 0 && row.stalled === 0 && row.recovery !== true && row.schedulerNext !== true && RUN_ID_RE.test(String(row.jobId)) && typeof row.queue === "string";

/** A trigger's Edit link: the trigger's page by its name once that page exists, Configuration until then. */
const editTrigger = (view, index) => ui.btn({ kind: ["sm", "ghost"], label: "Edit", href: hrefTo(view, "trigger", { index }, "config") });

/** The triggers file's index of the cron trigger whose scheduler minted `jobId` (the snapshot's `triggers`), or null. */
function schedulerTriggerOf(s, jobId) {
  const run = ui.schedulerRunOf(jobId);
  const t = run !== null && Array.isArray(s?.triggers?.triggers) ? s.triggers.triggers.find((x) => x?.type === "cron" && x.id === run.scheduler) : null;
  return Number.isSafeInteger(t?.index) ? t.index : null;
}

/**
 * A waiting row's one action, an operator's (see the panel's docblock), or null. A scheduler's next run (in line once it
 * is overdue) is one the queue refuses to remove, so it gets no Cancel but its cron trigger's Edit, as a held check's
 * row gets its trigger's. A slot a gone job holds gets a link, never a button: nothing in the console frees it
 * (`FREE_SLOT_TEXT`), so the row leads to the host, by its page's name once that page exists, Fleet until then, and
 * says which.
 */
function waitAction(row, view, orphans, s) {
  if (row.schedulerNext === true) {
    const index = schedulerTriggerOf(s, row.jobId);
    return index === null ? null : editTrigger(view, index);
  }
  if (heldSlot(row, orphans)) {
    const host = hrefTo(view, "host", { name: row.host });
    return ui.btn({ kind: ["sm", "ghost"], label: host === null ? "Open Fleet" : `Open ${row.host}`, href: host ?? hrefTo(view, "fleet") });
  }
  if (row.bucket === "run" && runHref(view, row.holder) !== null) return ui.btn({ kind: ["sm", "ghost"], label: "Chain", href: runHref(view, row.holder) });
  if (row.bucket === "check" && Number.isSafeInteger(row.trigger)) return editTrigger(view, row.trigger);
  if (cancellable(row)) return ui.actForm({ action: "cancel-queued", hidden: [["jobId", String(row.jobId)], ["queue", row.queue]], label: "Cancel", kind: ["sm", "danger"] });
  return null;
}

/**
 * A waiting row's sentence with what the row adds to it: the job holding its host's slot, the queue of a host the
 * registry no longer names, and how long it was held.
 */
function waitText(row, view, orphans, operator, s) {
  const said = waitingSentence(row);
  const held = heldSlot(row, orphans) ? html`. <span class="code">${orphans.get(row.host)[0]}</span> still holds one of its slots` : null;
  // In a host's own queue whose host left the registry: only that host's worker takes a job from it, so the row says
  // where the job is, beside why it last waited.
  const stray = strayQueue(s, row.queue) ? html`. It is in <span class="code">${row.queue}</span>, whose host is not in the registry` : null;
  const since = row.held !== null && typeof row.held === "object" && Number.isSafeInteger(row.held.since) && Number.isFinite(view.now) && view.now >= row.held.since ? html`. Held ${ageText(view.now - row.held.since)}` : null;
  const answers = operator && Array.isArray(row.held?.answers) && row.held.answers.length > 0 ? html`; last answers: ${row.held.answers.map((a, i) => html`${i === 0 ? null : ", "}<span class="code">${a.profile}</span> ${ANSWER_WORDS[a.answer] ?? a.answer}`)}` : null;
  return html`${said}${held}${stray}${since}${answers}`;
}

/**
 * Whether `queue` is a host's own queue (`pi-jobs@<name>`) that no registry row names, in a registry that was read (one
 * that was not is drawn as last seen, and judges nothing).
 */
function strayQueue(s, queue) {
  if (typeof queue !== "string" || s?.queue?.fleetDegraded) return false;
  const at = queue.indexOf("@");
  return at > 0 && !hostsOf(s).some((h) => h.name === queue.slice(at + 1));
}

/**
 * Each queue's counts, the Waitlists' Queues row: the shared queue, then each host's (the snapshot's `queueCounts`, the
 * registry's hosts), then each queue the waiting read found jobs in that those leave out (`w.byQueue`: a host gone from
 * the registry whose queue still holds jobs), by how many wait in it. A queue the waiting read read with nothing in
 * line is not listed: a host gone for good leaves its queue's keys behind.
 */
function queueRow(s, w) {
  const list = Array.isArray(s?.queueCounts) ? s.queueCounts.filter((q) => typeof q?.queue === "string") : [];
  const counted = new Set(list.map((q) => q.queue));
  const extra = (Array.isArray(w?.byQueue) ? w.byQueue : []).filter((q) => typeof q?.queue === "string" && !counted.has(q.queue) && Number.isSafeInteger(q.inLine) && q.inLine > 0);
  if (list.length === 0 && extra.length === 0) return null;
  const words = (q) => {
    const c = q.counts ?? {};
    const n = (k) => (Number.isSafeInteger(c[k]) && c[k] > 0 ? c[k] : 0);
    const parts = [...(q.paused ? ["paused"] : []), ...(n("waiting") + n("prioritized") > 0 ? [`${count(n("waiting") + n("prioritized"))} waiting`] : []), ...(n("delayed") > 0 ? [`${count(n("delayed"))} delayed`] : []), ...(n("paused") > 0 ? [`${count(n("paused"))} held by the pause`] : [])];
    return parts.length === 0 ? "0" : parts.join(", ");
  };
  const strayWords = (q) => `${count(q.inLine)} in line${strayQueue(s, q.queue) ? ", its host not in the registry" : ""}`;
  return html`<div class="qrow"><span class="card__sub">Queues</span>${list.map((q) => html`<span class="qp"><b class="code">${queueLabel(q.queue)}</b>${words(q)}</span>`)}${extra.map((q) => html`<span class="qp"><b class="code">${queueLabel(q.queue)}</b>${strayWords(q)}</span>`)}</div>`;
}

/**
 * What is scheduled next: the cron triggers' next fires (the schedulers' `next`), soonest first, at most three, each by
 * its `key`, the trigger's id (BullMQ's `name` is the job's, "local" for every cron trigger, so a scheduler whose key the
 * reader refused is left out rather than drawn as "local").
 */
function scheduledLine(s, view) {
  const list = (Array.isArray(s?.schedulers) ? s.schedulers : []).filter((x) => timeOrNull(x?.next) !== null && typeof x.key === "string" && (!Number.isFinite(view.now) || x.next >= view.now)).sort((a, b) => a.next - b.next);
  if (list.length === 0) return null;
  const shown = list.slice(0, 3).map((x, i) => html`${i === 0 ? null : ", "}<span class="code">${x.key}</span> ${timeHtml(x.next)}`);
  return html`<p class="card__sub">${ui.icon("clock", { size: "sm" })} Scheduled: ${shown}${list.length > 3 ? `, and ${count(list.length - 3)} more` : ""}</p>`;
}

/** Today's soft-hold refusals, linked to those runs: none of them waits in line. */
function softHoldLine(s, view) {
  const t = s?.softHoldToday;
  const hold = Number.isInteger(s?.settings?.overlay?.softHoldPct);
  if (!t || !Number.isSafeInteger(t.count) || (t.count === 0 && !hold)) return null;
  const n = html`${t.floor ? "at least " : ""}${count(t.count)} today`;
  return html`<p class="card__sub">${SOFT_HOLD_REFUSED_TEXT} ${t.count > 0 ? html`<a href="${hrefTo(view, "runs", { outcome: "policy", reason: "soft-hold" })}">${n}</a>` : n}.</p>`;
}

/**
 * Why the waiting counts are a floor, in one line for every role, or null when they are not: the read stopped at its
 * bound on queues (it read the first `byQueue.length` and counts the rest, `queuesCut`), or a queue holds more waiting
 * jobs than one read takes (a `byQueue` entry `truncated`), or both. In line's label says "or more" for the same `truncated`.
 */
function floorText(w) {
  const cut = Number.isSafeInteger(w.queuesCut) && w.queuesCut > 0 ? w.queuesCut : 0;
  const read = Array.isArray(w.byQueue) ? w.byQueue.length : 0;
  const part = Array.isArray(w.byQueue) && w.byQueue.some((q) => q?.truncated === true);
  if (cut > 0) return `Only the first ${count(read)} queues were read; ${count(cut)} more ${cut === 1 ? "was" : "were"} not${part ? ", and a queue holds more waiting jobs than are read" : ""}, so the counts are a floor.`;
  return w.truncated ? "A queue holds more waiting jobs than are read, so the counts are a floor." : null;
}

/**
 * Waitlists (the TimelineAndWaitlists card): the waiting jobs as one bar by reason, then each reason's jobs with their
 * project, id, why and one action (an operator's: Open Fleet, a link to the host whose slot a gone job holds, with
 * `FREE_SLOT_TEXT`; Chain, the run it waits for; Edit, the trigger whose wait check holds it, where the job's defer
 * record names one, or the cron trigger of a scheduler's next run, which the queue will not remove; else Cancel, for a
 * job `cancel-queued` would remove), a line when the read was cut (`floorText`), every queue's counts, what is
 * scheduled next, and today's soft-hold refusals.
 */
export const overviewWaitlists = overviewPanel("Waitlists", (s, view) => {
  const w = waitingOf(s);
  const operator = view.role === "operator";
  const act = canAct(view);
  const orphans = orphansByHost(s);
  const foot = html`${queueRow(s, w)}${scheduledLine(s, view)}${softHoldLine(s, view)}`;
  if (w === null) return ui.card({ title: "Waitlists", body: html`<div class="wl"><p class="muted">${UNREAD.waiting}</p>${foot}</div>` });
  const by = bucketCounts(w);
  const bar = ui.waitBar(DEFER_BUCKETS.map((b) => ({ icon: bucketIcon(b), count: by[b] })), { label: "In line by reason" });
  let freeSlot = false;
  let unknownProject = false;
  const groups = DEFER_BUCKETS.filter((b) => by[b] > 0).map((b) => {
    const rows = w.rows.filter((r) => (Object.hasOwn(by, r?.bucket) ? r.bucket : "none") === b);
    const items = rows.slice(0, WAITLIST_ROWS_MAX).map((r) => {
      const project = projectId(r.project);
      if (project === null) unknownProject = true;
      const action = act ? waitAction(r, view, orphans, s) : null;
      if (operator && heldSlot(r, orphans)) freeSlot = true;
      return html`<li>${project === null ? null : ui.ptag(project)}${jobIdHtml(r.jobId)}<span class="wl__t">${waitText(r, view, orphans, operator, s)}</span>${action}</li>`;
    });
    const more = rows.length > WAITLIST_ROWS_MAX ? html`<p class="card__sub">And ${count(rows.length - WAITLIST_ROWS_MAX)} more waiting for this, not listed: the overview lists the first ${count(WAITLIST_ROWS_MAX)} of each reason.</p>` : null;
    const slotNote = b === "slot" && freeSlot ? html`<p class="card__sub">${FREE_SLOT_TEXT}</p>` : null;
    return html`<div class="wl__g"><p class="wl__h">${ui.tile("idle", { icon: bucketIcon(b), sm: true, iconSm: true })}<b>${DEFER_BUCKET_WORDS[b].title}</b>${ui.count(by[b])}</p><ul class="wl__l">${items}</ul>${more}${slotNote}</div>`;
  });
  // Calm only over a read made whole: a cut one says its counts are a floor (`floorText`), and may have missed the job.
  const calm = w.truncated !== true && by.slot === 0 && by.run === 0 && by.check === 0 ? ui.collapsed({ icon: "done", title: WAITLISTS_CALM }) : null;
  const notes = [unknownProject ? WAITING_UNKNOWN_PROJECT_TEXT : null, floorText(w)].filter(Boolean);
  return ui.card({ title: "Waitlists", body: html`<div class="wl">${bar}${groups}${calm}${notes.map((n) => html`<p class="card__sub">${n}</p>`)}${foot}</div>` });
});

// ---- Hosts -----------------------------------------------------------------------------------------------------------------

/**
 * A host's clock against this console's, in words, when the registry says it is out by more than `HOST_SKEW_CLAIM_MS`
 * (`skewMs`: this console's clock minus the host's, beyond how long ago Valkey last refreshed the row): "build3's
 * clock is about 1m 48s behind this console's: its beat says 2m ago, and Valkey last refreshed its row 12s ago." Null
 * for a host within the bound, or a row that cannot say.
 */
export function hostSkewText(row) {
  const skew = row?.skewMs;
  const age = row?.ttlAgeMs;
  if (!Number.isSafeInteger(skew) || !Number.isSafeInteger(age) || age < 0 || Math.abs(skew) <= HOST_SKEW_CLAIM_MS || typeof row.name !== "string") return null;
  if (skew > 0) return `${row.name}'s clock is about ${durText(skew)} behind this console's: its beat says ${Number.isSafeInteger(row.staleMs) ? `${ageText(row.staleMs)} ago` : "nothing readable"}, and Valkey last refreshed its row ${ageText(age)} ago.`;
  return `${row.name}'s clock is about ${durText(-skew)} ahead of this console's: Valkey last refreshed its row ${ageText(age)} ago, and its beat is stamped later than that.`;
}

/** A host's doctor in one line (the card's): the first failing check with its age, the warnings, or the passes. */
function doctorLine(s, name) {
  if (!s?.doctor || s.doctor.unreachable) return null;
  const row = doctorHostsOf(s).find((r) => r.name === name) ?? null;
  if (row === null) return html`<span class="faint">${NO_DOCTOR_TEXT}</span>`;
  if (row.unreadable) return html`<span class="tinted tone-attention">${ui.icon("attention", { size: "sm" })}Its doctor result cannot be read</span>`;
  const stale = doctorStale(row) ? ", stale" : "";
  const old = Number.isSafeInteger(row.ageMs) ? `, ${ageWords(row.ageMs)} old` : "";
  const problems = doctorProblems(row);
  const fail = problems.find((c) => c.level === "fail") ?? null;
  const c = row.counts ?? {};
  if (fail !== null || (Number.isSafeInteger(c.fail) && c.fail > 0)) {
    const others = (Number.isSafeInteger(c.fail) ? c.fail : 1) - 1;
    return html`<span class="tinted tone-failed">${ui.icon("failed", { size: "sm" })}Doctor: ${fail?.label ?? "a check fails"}${others > 0 ? ` and ${plural(others, "more failing")}` : ""}${old}${stale}</span>`;
  }
  if (Number.isSafeInteger(c.warn) && c.warn > 0) return html`<span class="tinted tone-attention">${ui.icon("attention", { size: "sm" })}${plural(c.warn, "doctor warning")}${stale}</span>`;
  return html`<span class="tinted tone-ok">${ui.icon("done", { size: "sm" })}Doctor: ${count(Number.isSafeInteger(c.ok) ? c.ok : 0)} passing${stale}</span>`;
}

/** A host queue's counts, the host row's: not started and running. */
function hostQueueLine(q) {
  if (q === null) return null;
  const c = q.counts ?? {};
  const n = (k) => (Number.isSafeInteger(c[k]) && c[k] > 0 ? c[k] : 0);
  return html`<span><span class="code">${queueLabel(q.queue)}</span> ${q.paused ? "paused, " : ""}${count(n("waiting") + n("prioritized") + n("delayed") + n("paused"))} waiting, ${count(n("active"))} running</span>`;
}

/** A host's pause: its own queue's pause or resume, round, drawn only for a queue the snapshot counts. */
function hostPause(q, name) {
  if (q === null) return null;
  return q.paused
    ? ui.actForm({ action: "queue-resume", hidden: [["queue", q.queue]], label: `Resume ${name}`, kind: ["sm", "round", "paid"], icon: "play" })
    : ui.actForm({ action: "queue-pause", hidden: [["queue", q.queue]], label: `Pause ${name}`, kind: ["sm", "round", "danger"], icon: "pause" });
}

/** A host's venues as the registry publishes them (`backends.blessed`), the default first. */
function venuesText(h) {
  const blessed = Array.isArray(h?.backends?.blessed) ? h.backends.blessed.filter((v) => typeof v === "string") : null;
  if (blessed === null) return "venues not published";
  return blessed.length === 0 ? "no venue" : blessed.join(", ");
}

/**
 * What a partial pause holds, for the Hosts head's chip: how many queues, never their names ("the shared queue and 2
 * host queues"). A host's queue is named by its host, up to 64 characters, and the head has no room for a list of them;
 * the Waitlists' Queues line and each host's own row name every paused queue.
 */
function pausedText(s) {
  const paused = (Array.isArray(s?.queueCounts) ? s.queueCounts : []).filter((x) => x?.paused === true && typeof x.queue === "string");
  const hosts = paused.filter((x) => x.queue.indexOf("@") > 0).length;
  const parts = [...(paused.length > hosts ? ["the shared queue"] : []), ...(hosts > 0 ? [plural(hosts, "host queue")] : [])];
  return parts.length > 0 ? parts.join(" and ") : "some queues";
}

/**
 * The Hosts head's count, saying what it counts (`workersOnline`, the old overview's Workers fact): "as last seen" for
 * a registry that could not be read; with no registry row, the workers BullMQ sees connected (its own list, no beat in
 * it), or none registered where it cannot say; else the hosts that beat, and where that is not every registered host
 * or BullMQ sees more connected, all three: "3 registered, 1 beating, 3 connected".
 */
function workersText(s, w) {
  if (w.online === null) return "as last seen";
  // The registry's rows as `workersOnline` and `resolveWorkerCount` count them (`count` is their number when there are any).
  const rows = Array.isArray(s.hostBudgets) ? s.hostBudgets.length : 0;
  if (rows === 0) return Number.isSafeInteger(s.queue?.workers) && s.queue.workers >= 0 ? `${count(s.queue.workers)} connected` : "none registered";
  if (w.online === rows && !w.staleBeats) return `${count(w.online)} beating`;
  return `${count(rows)} registered, ${count(w.online)} beating${w.staleBeats ? `, ${count(w.connected)} connected` : ""}`;
}

/**
 * Hosts (the OverviewScreen card): per host its beat, its venues, its slots, its doctor, its own queue's counts and
 * pause, and what the registry says of its clock and its row; in the head what beats (`workersText`), whether the fleet
 * is paused (or how many of its queues are, `pausedText`), and Pause fleet and Resume fleet as Fleet offers them. When no worker drains
 * the queue the panel says so first (`NO_WORKER_TEXT`), and the softer note when only the beats look stale.
 */
export const overviewHosts = overviewPanel("Hosts", (s, view) => {
  const act = canAct(view);
  const q = s.queue ?? {};
  const w = workersOnline(s);
  const hosts = hostsOf(s);
  const state = q.pausedState ? ui.chip("Paused", { status: "attention", icon: "pause" }) : q.pausedPartial ? ui.chip(`Partly paused: ${pausedText(s)}`, { status: "attention", icon: "pause" }) : null;
  // Fleet's rule (`panels/fleet.mjs`): Pause fleet unless the whole fleet is paused, Resume fleet once any of it is.
  const fleetAct = !act ? null : html`${q.pausedState ? null : ui.actForm({ action: "fleet-pause", label: "Pause fleet", kind: ["sm", "danger"], icon: "pause" })}${q.pausedState || q.pausedPartial ? ui.actForm({ action: "fleet-resume", label: "Resume fleet", kind: ["sm", "paid"], icon: "play" }) : null}`;
  const sub = workersText(s, w);
  const banner = w.none
    ? ui.banner({ status: "failed", icon: "fleet", sm: true, title: NO_WORKER_TEXT, actions: ui.btn({ kind: "sm", label: "Open Fleet", href: hrefTo(view, "fleet") }) })
    : w.staleBeats
      ? ui.banner({ status: "attention", icon: "beat", sm: true, title: STALE_BEATS_TEXT })
      : null;
  const degraded = q.fleetDegraded ? ui.banner({ status: "attention", icon: "fleet", sm: true, title: REGISTRY_UNREAD_TEXT }) : null;
  const rows = hosts.map((h) => {
    const stale = !beatFresh(h);
    const age = beatAgeOf(h);
    // Running's rule for the slots, so the two cards never disagree: none drawn free from a registry not read this tick.
    const sl = slotsOf(h, Boolean(q.fleetDegraded));
    const hq = hostQueueOf(s, h.name);
    const skew = hostSkewText(h);
    // A note in a tone carries its glyph, as the doctor's line does, so the tone is never the only cue.
    const note = (text) => html`<span class="tinted tone-attention">${ui.icon("attention", { size: "sm" })}${text}</span>`;
    const x = [doctorLine(s, h.name), hostQueueLine(hq), h.jobsUnreadable === true ? note(JOBS_UNREAD_TEXT) : null, skew === null ? null : note(skew), h.noExpiry === true ? note(HOST_NO_EXPIRY_TEXT) : null].filter(Boolean);
    return html`<li class="hostrow">${ui.dot(stale ? "attention" : "ok", { label: stale ? "beat late" : "beating" })}<span class="hostrow__n"><b>${h.name}</b><span>${venuesText(h)}</span></span>${slotDots(h.name, sl)}<span class="${stale ? "hostrow__beat tone-attention" : "hostrow__beat"}">${ui.icon("beat", { size: "sm" })}${age !== null ? ageText(age) : "unknown"}</span><span class="hostrow__p">${act ? hostPause(hq, h.name) : null}</span><span class="hostrow__x">${x}</span></li>`;
  });
  const list = rows.length > 0 ? html`<ul class="hosts">${rows}</ul>` : q.fleetDegraded ? null : html`<p class="muted">${HOSTS_EMPTY.body}</p>`;
  return ui.card({ title: "Hosts", sub, end: state === null && fleetAct === null ? null : html`${state}${fleetAct}`, body: html`${banner}${degraded}${list}` });
});

// ---- the first run -------------------------------------------------------------------------------------------------------

/** A step's sentence parts (`firstRunState`'s) as markup: text, a name in the code face, bold, an age. */
const partsHtml = (parts) => html`${(Array.isArray(parts) ? parts : []).map((p) => (typeof p === "string" ? p : typeof p?.code === "string" ? html`<span class="code">${p.code}</span>` : typeof p?.b === "string" ? html`<b>${p.b}</b>` : Number.isFinite(p?.age) ? ageText(p.age) : null))}`;

/** The icon a step's tile carries while it is to do or optional (a state's own icon otherwise). */
const STEP_ICONS = Object.freeze({ deployment: "folder", queue: "queue", token: "key", worker: "fleet", egress: "globe", provider: "key", trigger: "plus", forge: "git" });

/** A step's tile icon: the state's (done, failed, attention), or the step's own while it is to do or optional. */
const stepIcon = (st) => (st.state === "ready" ? "done" : st.state === "not-yet" ? "failed" : st.state === "check" ? "attention" : STEP_ICONS[st.id] ?? "clock");

/** The segmented bar under the count: a segment per step in its state's tone, a step to do on the inset's grey. */
function progressBar(steps) {
  const gap = 0.8;
  const w = (100 - gap * (steps.length - 1)) / steps.length;
  const n = (state) => steps.filter((x) => x.state === state).length;
  const label = `${count(n("ready"))} of ${count(steps.length)} ready: ${count(n("not-yet"))} not yet, ${count(n("check"))} to check, ${count(n("to-do") + n("optional"))} to do`;
  return html`<svg class="su-bar" height="10" role="img" aria-label="${label}">${steps.map((x, i) => {
    const st = FIRST_RUN_STATES[x.state];
    const todo = x.state === "to-do" || x.state === "optional";
    return html`<rect class="${todo ? `su-seg tone-${st.status} su-seg--todo` : `su-seg tone-${st.status}`}" x="${ui.svgNum(i * (w + gap), 0, 100, 2)}%" y="0" width="${ui.svgNum(w, 0, 100, 2)}%" height="10" rx="5"/>`;
  })}</svg>`;
}

/** One step of the checklist, the card's: its tile, number, title, word, sentence, and an operator's commands or action. */
function stepHtml(st, i, view) {
  const word = FIRST_RUN_STATES[st.state];
  const operator = view.role === "operator";
  // A command with a placeholder in it carries the sentence that says what to put there (`firstRunCommandHint`).
  const hintOf = (argv) => {
    const hint = firstRunCommandHint(argv);
    return hint === null ? null : html`<p class="su-alt">${partsHtml(hint)}</p>`;
  };
  const cmds = operator ? st.commands.map((argv, k) => html`${k === 1 && st.id === "worker" ? html`<p class="su-alt">Or run it yourself in a terminal:</p>` : null}${ui.cmd([...argv])}${hintOf(argv)}`) : null;
  const href = docsHref("docs/triggers.md");
  const add = st.id === "trigger" && st.state !== "ready" && canAct(view) ? html`<div class="su-act">${ui.btn({ kind: "primary", label: "Add a trigger", icon: "plus", href: hrefTo(view, "trigger-add", null, "config") })}${href === null ? null : ui.outLink({ href, label: "What triggers can do", btn: "ghost" })}</div>` : null;
  return html`<li class="${st.state === "ready" ? "su-step su-step--done" : "su-step"}">${ui.tile(word.status, { icon: stepIcon(st) })}<div class="su-step__b"><p class="su-step__t"><span class="su-n">${count(i + 1)}</span>${st.title}${ui.chip(word.word, { status: word.status })}</p><p class="su-step__s">${partsHtml(st.sentence)}</p>${cmds}${add}</div></li>`;
}

/**
 * The first run's checklist (the SetupScreen card's "Getting ready"): how many of the eight steps are ready with a bar
 * of them, what jobs wait for, then each step. Nothing unless the first run applies (`firstRunState`).
 */
export function overviewSetup(view) {
  const st = setupOf(view);
  if (!st.applies) return html``;
  const from = st.doctor === null ? null : `from doctor on ${st.doctor.host}${Number.isSafeInteger(st.doctor.ageMs) ? `, ${ageWords(st.doctor.ageMs)} ago` : ""}`;
  const prog = html`<div class="su-prog"><p><b class="su-big">${count(st.ready)}</b> of ${count(st.total)} ready</p>${progressBar(st.steps)}<p class="muted">${st.sub}</p></div>`;
  return ui.card({ title: "Getting ready", sub: from, body: html`${prog}<ol class="su-steps">${st.steps.map((x, i) => stepHtml(x, i, view))}</ol>` });
}

/** "Do it from pi": the guided setup, `/dispatch setup`, its command an operator's. */
export function overviewSetupPi(view) {
  if (!setupOf(view).applies) return html``;
  return ui.card({ title: "Do it from pi", body: html`<p class="muted su-p">The guided setup in pi walks through every step and asks before each one. It never asks for the provider key.</p>${view.role === "operator" ? ui.cmd([...FIRST_RUN_COMMANDS.pi]) : null}` });
}

/**
 * The overview's panels as they will read once it runs: each one's empty words (the panels' own constants), or for In
 * line, Running and Hosts what they already have to show.
 */
export function overviewSetupEmpty(view) {
  if (!setupOf(view).applies) return html``;
  const s = view.data.snapshot;
  const line = (icon, title, body) => ui.collapsed({ icon, title, body });
  // A panel that already has something to show says what, from the rows the checklist reads (the first run's own
  // registry rows, its waiting and active jobs), so the preview never says "no host is registered yet" beside step 4's
  // host that beats.
  const hosts = hostsOf(s).length;
  const active = Array.isArray(s.active) ? s.active.length : 0;
  const w = waitingOf(s);
  const inLine = w === null ? null : inLineOf(w);
  const waiting = inLine === null ? "could not be read" : inLine.cut ? WAITING_CUT_TEXT : w.rows.length === 0 ? WAITING_EMPTY.title : `${inLine.n} ${inLine.label}`;
  return ui.card({
    title: "The Overview, once it runs",
    sub: "each panel says what it is waiting for",
    body: html`<div class="stack su-empties">${line("parked", "Needs you", NEEDS_EMPTY.title)}${line("queue", "In line", waiting)}${line("running", "Running", active === 0 ? RUNNING_EMPTY.title : `${plural(active, "job")} running`)}${line("spend", "Spend today", SPEND_EMPTY.title)}${line("fleet", "Hosts", hosts === 0 ? HOSTS_EMPTY.title : `${plural(hosts, "host")} registered`)}</div>`,
  });
}
