/**
 * What a run loaded, in words (issue #800, INT-RUN-HISTORY-FILE-CONTRACT's `loaded`): the one place a surface gets them, so
 * a run page, the Runs list, the filter, `/api/run`, the `/dispatch` panel, a sandbox and a project cannot say different
 * things about one record. PURE: no I/O and no clock.
 *
 * IT READS THE RECORD, NEVER TODAY'S TRIGGERS FILE. What ran is the point: a host's overlay, its staged packages and the
 * repository each change on their own, and a line built from today's configuration would describe a run that never
 * happened. So "trigger 3" here is only the number the record kept, and what that trigger allows or names now is not said.
 *
 * THE STRINGS. `recordedLoaded` holds every name in the field to a closed list, a closed pattern or what the worker knew,
 * and any violation makes the field unreadable, so none of it can be raw. The record's OTHER strings this file prints
 * (`host`, `target`, `flow`, `provider`, `model`) are the worker's too but pass through no such rebuild here, so each is
 * held to its own shape first (`factsOf`) and falls back to fixed words. Everything leaves as text; the page's template
 * escapes it once more, and no HTML is written here. A line that needs a code span or a link says so as a part
 * (`code`, `strong`, `run`, `time`): a sentence holding markup would be a second escaping rule.
 *
 * WORDS THAT TELL THE TRUTH ABOUT WHAT THE RECORD CANNOT SAY:
 *   - A failed extension's total. pi 1.5.0 keeps an extension with a conflicting tool or flag name loaded and reports it in
 *     `errors` too (image/runner/src/loader.mjs `reportExtensionLoadErrors`, kind `conflict`), so it counts in both
 *     `extensions` and `failed`, while one that threw counts only in `failed`. The record keeps no kind, so a total is
 *     knowable only when nothing loaded at all. REJECTED: `extensions + failed` as the total, which counts a conflicted
 *     extension twice, and `extensions` alone, which says "1 of 1 failed" of a run that also lost a second one. For the same
 *     reason "went on without it" is said only when none of that tier's extensions loaded.
 *   - A dropped extension gets no sentence and no warning. This repository ships `dispatch.ts` in `.pi/extensions`, and the
 *     recursion guard drops it on every run on itself, so a warning would be noise on the one deployment that reads this
 *     most. It is a row in the fold.
 *   - `absent` is said without a cause: an older image on a clean exit never says, a runner that died did not get to, and a
 *     stop that took (exit 143) can read the same, and the record cannot tell them apart. REJECTED: "its stop did not take" on a
 *     cancel, which is false of that 143.
 *   - A flow pi did not find is said as that. At pi 1.5.0 (`dist/core/skills.js`) a SKILL.md with no description is not loaded and
 *     `frontmatter.name` renames one, so a repository can hold a `fix` folder that pi finds no skill named fix in, and the
 *     record knows only that pi found none. REJECTED: "has no fix skill", which claims what the repository holds.
 *   - Whether a run went on, which the stage does not show. The runner notes `ready`, then can refuse a command no extension
 *     registers or skip the prompt for a stop at load, and a repository's extension that breaks its report leaves an earlier stage on a
 *     run that carries on. So what happened is read from the outcome, the turns and the meter first (`wentOn`), and the stage only says
 *     how far a run that did not go on got. "Ran", "went on" and "everything" are said only of a run that went on. REJECTED: a list of
 *     reasons the runner refuses for, which the worker's vocabulary folds into `runner-policy` and a real record never holds.
 *   - A failed MCP server stops the run (`mcp.mjs` `start`: `mcp-unavailable`, exit 2, or `mcp-unreachable`, exit 1), so it is
 *     never a completed run's note and no line says the run went on.
 *   - `leftOut.overlayExtensions` is this job's switch, and not the host's: a host's PI_GLOBAL_ALLOW_EXTENSIONS=0 closes it
 *     and so does a model canary's replay (`record.canary`), which closes over it. So no line says it was the host that asked. And an overlay file
 *     can load beside it being off: a repository's `pi.extensions` manifest can name one. Both are true at once, so both are
 *     said and neither corrects the other.
 */
import { SCHEDULER_ID_MAX, cronRunOf } from "@edgehero/pi-dispatch/bullmq-internals";
import { QUEUED_STATES } from "@edgehero/pi-dispatch/chat-mode";
import { isForgeKind } from "@edgehero/pi-dispatch/forges";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { hostsAgree } from "@edgehero/pi-dispatch/host-loads";
import { recordedLoaded } from "@edgehero/pi-dispatch/loaded-record";
import { modelIdProblem, providerIdProblem } from "@edgehero/pi-dispatch/model-ref";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { refusedBeforeSpend, repoOfTarget } from "./costs.mjs";
import { fromNewerRelease } from "./newer-release.mjs";
import { outcomeKey } from "./words.mjs";

/** The panel's fixed sentences, exported so a card's ledger can cite each one. */
export const LOADED_WORDS = Object.freeze({
  title: "Loaded",
  sub: "what this run had",
  fold: "Each item, and where it came from",
  foot: "What pi loaded when this run started, from its record: names and versions from what the deployment staged and configured, and counts for what the repository holds.",
  notRecorded: "Not recorded: an older release wrote this run’s record.",
  notRecordedUnknown: "Not recorded: it ended before its container reported, or an older release wrote this run’s record.",
  refused: "Nothing loaded: it was refused before its container started.",
  cancelled: "Nothing loaded: it was cancelled before its container started.",
  absent: "Not recorded: this run’s runner did not say what it loaded.",
  invalid: "Could not be read: what this run’s runner said did not hold up, so this page keeps only what the worker knows.",
  noRoom: "Cut to fit: what this run loaded had no room, on its exit line or in its record.",
  cutCompact: "Cut to fit: this record keeps the counts and leaves out package, overlay and tool names.",
  cutMinimal: "Cut to fit: this record keeps what went wrong and leaves out the counts and names.",
  noAgent: "Nothing to load: this kind of run has no agent, extensions or skills.",
  stoppedStart: "It stopped before anything loaded.",
  stoppedLoader: "It stopped after its extensions and skills loaded, before its tools were ready.",
  stoppedServers: "It stopped while its MCP servers were connecting.",
  stoppedBeforeServers: "It stopped before its MCP servers started.",
  stoppedSession: "It stopped after its extensions and skills loaded, before the agent started.",
  stoppedAfterLoading: "It stopped after loading. The outcome above says what can stop a run this way.",
  notedEarly: "This record’s list was last noted before the run started, so it may be out of date.",
  notedEarlyRow: "this record’s list was last noted before that",
  running: "Shown when it ends, from its record.",
  ranWithoutFlow: "Ran without its flow.",
  flowNowhere: "Its flow was found nowhere.",
  mcpStopped: "The run stopped before the agent started.",
  mcpStoppedLoaded: "The run stopped before the agent started, after its extensions and skills had loaded.",
  notRetried: "Not retried: the next attempt would find it the same.",
  retried: "Retried, as any infrastructure failure.",
  retriedStopped: "Retried, as any infrastructure failure; the queue has stopped retrying this job.",
  queueStopped: "The queue has stopped retrying this job.",
  retriedRule: "The queue retries an infrastructure failure while it has attempts left.",
  readFirst: "Read what it did before you trust it.",
  imageId: "The image id on this host; two local builds of one tag differ, so it never counts as a host difference.",
  failedRow: "to load, in any tier; a path and its kind stay in the job’s log",
  droppedRow: "by the recursion guard, per tier; names stay in the job’s log",
  noRepositoryNames: "a record keeps no names from a repository.",
  sandboxFoot: "Nothing loads until you start pi in the shell.",
  freshFoot: "A fresh sandbox has no run to quote, so it says what a job would load there, from the host’s last doctor run, or unknown. The repository’s part is decided at its base commit.",
  projectTitle: "What its runs load",
  projectFoot: "From the records of its runs in the last 7 days. A host’s pi, packages and overlay are from its newest run able to show each, and are that host’s own, so runs of one project can load different things on different hosts.",
  projectCompared: "A host’s pi, packages and overlay are from its newest run able to show each, so an update every host took is no difference.",
  projectNone: "Nothing to read: no run of this project recorded what it loaded in the last 7 days.",
  projectNoneWhy: "Either none ran, or an older release wrote their records.",
});

/**
 * The states `loadedVerdict` returns, each drawn by a golden of its name (`LOADED_STATE_GOLDENS`, loaded-goldens.mjs, which a test
 * holds to this list). The LoadedStates card draws the ones a person acts on; `stopped`, `no-agent`, `absent`, `invalid` and `cut`
 * are one quiet line each and have a golden and no row there. There is no state for a server turned off: see `loadedOf`.
 */
export const LOADED_STATES = Object.freeze(["everything", "left-out", "host-differs", "no-flow", "extension-failed", "mcp-stopped", "mcp-failed", "stopped", "no-agent", "running", "not-recorded", "refused", "absent", "invalid", "cut"]);

// ---- the parts of a line ---------------------------------------------------------------------------------------------

const code = (text) => ({ code: text });
const strong = (text) => ({ b: text });
const run = (id) => ({ run: id });
const time = (ms) => ({ time: ms });
const repositoryLink = (text) => ({ repository: text });

/** A line's parts as plain text: what a test reads, and what a surface with no markup prints. A time is left to its surface. */
export function wordsText(parts) {
  return (Array.isArray(parts) ? parts : [parts]).map((part) => {
    if (part === null || part === undefined) return "";
    if (typeof part !== "object") return String(part);
    return part.code ?? part.b ?? part.run ?? part.repository ?? part.muted ?? "";
  }).join("");
}

// ---- small words -----------------------------------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b and c". */
function andList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
/** "a", "a, and b", "a, b, and c": the Tools row's own, whose parts are themselves lists. */
function commaAnd(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const matched = (value, re) => (typeof value === "string" && re.test(value) ? value : null);
/** A forge repository as the record's target spells it. Spaces for Azure's project names, never a control or a quote. */
const REPO_RE = /^[A-Za-z0-9._/-](?:[A-Za-z0-9._/ -]{0,198}[A-Za-z0-9._/-])?$/;
/** "sha256:7c1e0b4…": enough to tell two apart at a glance. The fold keeps it short too: it is an id, and a phone is narrow. */
const shortDigest = (digest) => `${digest.slice(0, "sha256:".length + 7)}…`;
/** A pattern in `run.excludeTools` as a person says it: `mcp__linear__*` is what removes one server's tools. */
function toolWord(name) {
  const server = /^mcp__([A-Za-z0-9_-]+)__\*$/.exec(name)?.[1];
  return server === undefined ? name : `${server}’s tools`;
}

/** The record's own strings this file prints, each held to its shape, so a record that was edited by hand prints fixed words. */
function factsOf(record) {
  const r = record !== null && typeof record === "object" ? record : {};
  const forge = isForgeKind(r.kind);
  const repo = forge ? matched(repoOfTarget(r.target), REPO_RE) : null;
  const index = Number.isSafeInteger(r.triggerIndex) && r.triggerIndex >= 0 ? r.triggerIndex : null;
  const provider = typeof r.provider === "string" && providerIdProblem(r.provider) === null ? r.provider : null;
  const model = typeof r.model === "string" && modelIdProblem(r.model) === null ? r.model : null;
  // A cron run keeps no index (`run-history.mjs`), and its job id names its trigger outright (`cronRunOf`).
  const cron = index === null ? cronRunOf(r.jobId, { idMax: SCHEDULER_ID_MAX })?.id ?? null : null;
  return { forge, repo, index, cron, host: matched(r.host, WORKER_NAME_RE), flow: matched(r.flow, SKILL_NAME_RE), provider, model, subject: index !== null ? `trigger ${index + 1}` : cron !== null ? `cron trigger ${cron}` : "this run", calls: isCount(r.tokens?.calls) ? r.tokens.calls : null };
}

// ---- where a problem is fixed ----------------------------------------------------------------------------------------

/**
 * Where each problem is fixed. `href` null is the repository, which the surface links by the forge's own rule
 * (`forgeBaseLinkOf`, which needs the deployment's forge variables). A record that names the base commit says so with its
 * short hash, and the link opens that commit: it is the code that ran, while the repository has moved on. A record that names
 * none (an older worker's, or a throw before its container) opens the repository and says that instead, rather than claim a
 * commit it cannot name. A line can offer several (`fixesOf`): a flow pi did not find is fixed on the trigger or in the code that
 * ran, and failures in two tiers are fixed in two places.
 */
/**
 * A trigger's page is opened by its row, and a cron run's record has no row, only its id. So a scheduled run, unattended and the one
 * whose way to its fix matters most, opens the list its trigger is on, under the name to look for. REJECTED: finding the row in
 * today's triggers file, which this file never reads (see its header).
 */
function triggerFix({ index = null, cron = null }) {
  if (index !== null) return { kind: "trigger", label: `Open trigger ${index + 1}`, icon: "config", href: `/config/trigger?index=${index}` };
  return cron === null ? null : { kind: "trigger", label: `Find ${cron} in Triggers`, icon: "config", href: "/triggers?kind=schedule" };
}
const repositoryFix = (facts, baseSha = null) => (facts.forge ? { kind: "repository", label: typeof baseSha === "string" ? `Open the base commit ${baseSha.slice(0, 7)}` : "Open the repository", icon: "git", href: null } : null);
const CONNECTIONS_FIX = Object.freeze({ kind: "connections", label: "Open Connections", icon: "plug", href: "/config/connections" });
const UPDATES_FIX = Object.freeze({ kind: "updates", label: "Open Updates", icon: "box", href: "/config/updates" });
const hostFix = (name) => (name === null ? null : { kind: "host", label: `Open ${name}`, icon: "fleet", href: `/fleet/host?${new URLSearchParams({ name })}` });
/** Each way a line offers, once: two packages' failures are one Updates. */
function fixesOf(...fixes) {
  const seen = new Set();
  return fixes.filter((fix) => {
    if (fix === null || fix === undefined || seen.has(fix.label)) return false;
    seen.add(fix.label);
    return true;
  });
}
const noFlowFixes = (loaded, facts) => fixesOf(triggerFix(facts), repositoryFix(facts, loaded.baseSha));

// ---- the record ------------------------------------------------------------------------------------------------------

const rebuilt = new WeakMap();
function deepFrozen(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFrozen(inner);
  }
  return value;
}

/**
 * The record's `loaded`, rebuilt: the field, null when there is none (an older record, or one a newer release wrote), or
 * the field saying `invalid` when it does not hold up, so a damaged field reads as could-not-be-read and never as absent.
 * Never throws, whatever it is handed.
 *
 * A server `disabled` does not hold up either. The worker refuses a job that names one (`mcp-preflight.mjs`,
 * `mcp-server-unknown`) and writes `/job/mcp.json` from that same read, so no worker's job can reach it: the runner's word is
 * for a hand-run container, and a line that says so was forged or written by something else. REJECTED: a state and a sentence
 * of its own ("the run went on without it", with a way to turn it on), which described a run this deployment cannot have.
 */
export function loadedOf(record) {
  try {
    if (record === null || typeof record !== "object" || fromNewerRelease(record)) return null;
    const raw = record.loaded;
    if (raw === undefined || raw === null) return null;
    // A project's page asks this of each record from a couple of dozen places, and the rebuild checks every string. Keyed on the
    // record and held to the field it read, so a record whose field was replaced is read again. Frozen, so sharing one answer is
    // honest: no caller writes to it, and one that tried would throw rather than change what the next one reads.
    const known = rebuilt.get(record);
    if (known !== undefined && known.raw === raw) return known.value;
    const kept = recordedLoaded(raw);
    const value = deepFrozen(kept === null || kept.mcp?.some((row) => row.state === "disabled") ? recordedLoaded({ v: 1, runner: "invalid" }) : kept);
    rebuilt.set(record, { raw, value });
    return value;
  } catch {
    return deepFrozen(recordedLoaded({ v: 1, runner: "invalid" }));
  }
}

const sourcesOf = (loaded, tier) => (loaded?.sources ?? []).filter((source) => source.tier === tier);
const sumOf = (rows, field) => rows.reduce((total, row) => total + (isCount(row[field]) ? row[field] : 0), 0);
const failedCountOf = (loaded) => (isCount(loaded?.problems?.failed) ? loaded.problems.failed : sumOf(loaded?.sources ?? [], "failed"));
const flowMissing = (loaded) => loaded?.flow?.tier === "none";
/** The line's own stages that say what loaded. `start` and `none` hold a version and no more. */
const saysWhatLoaded = (loaded) => ["loader", "session", "ready"].includes(loaded?.at);

/**
 * What is wrong with a run that completed: `flow-missing`, `extension-failed`. Only on a completed run, because that is the
 * one outcome that would otherwise read as fine, and the outcome itself stays `completed`, so every count is unchanged.
 */
export function loadedProblems(record) {
  if (record === null || typeof record !== "object" || outcomeKey(record.outcome, record.reason) !== "completed") return [];
  const loaded = loadedOf(record);
  if (loaded === null || loaded.runner !== "reported") return [];
  return [...(flowMissing(loaded) ? ["flow-missing"] : []), ...(failedCountOf(loaded) > 0 ? ["extension-failed"] : [])];
}

const CANCEL_REASONS = Object.freeze(["operator-cancel", "agent-cancel"]);
const isCancel = (record) => CANCEL_REASONS.includes(record?.reason);
const hasNoExit = (record) => record?.exitCode === null || record?.exitCode === undefined;

/**
 * Whether a record says its run ended before its container. Never of one that names its base commit: the worker notes that as the
 * last thing before the container (`processor.mjs`), so such a run got there. A refusal with no exit code never did, whether or
 * not it kept its count slot, as `over-budget` does. A cancel is said only of a run that spent nothing (`refusedBeforeSpend`):
 * one that holds its reservation may have been anywhere, and the banner beside it says "if it had started".
 */
function endedBeforeContainer(record, loaded) {
  if (record?.outcome !== "policy" || !hasNoExit(record) || typeof loaded?.baseSha === "string") return false;
  return !isCancel(record) || refusedBeforeSpend(record);
}

/** The sentences `outcomeNote` can say: fixed words and a count, no name. Exported so a model's read can hold them by value. */
export const OUTCOME_NOTE_RE = /^Completed, (?:without its flow(?: and with (?:a failed extension|[1-9]\d{0,5} failed extensions))?|with (?:a failed extension|[1-9]\d{0,5} failed extensions))$/;
export const isOutcomeNote = (value) => typeof value === "string" && OUTCOME_NOTE_RE.test(value);

/**
 * The word a person reads for a completed run that lacked something, or null: the run's outcome reads as it always did. An agent's
 * copy of a record has no `loaded` and carries this word as `note` (`modelRunRecord`, `agentReadProjection`), so a page or a
 * row drawn from that copy says the same.
 */
export function outcomeNote(record) {
  const problems = loadedProblems(record);
  if (problems.length === 0) return record !== null && typeof record === "object" && !Object.hasOwn(record, "loaded") && isOutcomeNote(record.note) && outcomeKey(record.outcome, record.reason) === "completed" ? record.note : null;
  const failed = failedCountOf(loadedOf(record));
  const extensions = failed === 1 ? "a failed extension" : `${failed} failed extensions`;
  if (problems.length === 2) return `Completed, without its flow and with ${extensions}`;
  return problems[0] === "flow-missing" ? "Completed, without its flow" : `Completed, with ${extensions}`;
}

// ---- the problems, in words ------------------------------------------------------------------------------------------

function noFlowSentence(loaded, facts) {
  const found = facts.flow === null ? "pi found no such skill" : `pi found no skill named ${facts.flow}`;
  const first = facts.forge ? `not in ${facts.repo ?? "this repository"} at its base commit` : "not in this folder";
  // A trigger that withholds the staged packages did not look in them, so "nor in a staged package" would be a guess.
  if (loaded.leftOut?.packages === true) return `${found}: ${first}, nor in a skills folder or the overlay. The trigger withholds the staged packages.`;
  return `${found}: ${first}, nor in a skills folder, the overlay or a staged package.`;
}

/** How a tier's failed extensions are named: whose they are, and which way fixes them. */
function failedTierOf(source, facts, baseSha = null) {
  if (source.tier === "repository") return { whose: `${facts.repo ?? "this repository"}’s`, from: facts.repo ?? "the repository", fix: repositoryFix(facts, baseSha) };
  if (source.tier === "overlay") return { whose: `${facts.host ?? "this host"}’s overlay`, from: `${facts.host ?? "this host"}’s overlay`, fix: hostFix(facts.host) };
  if (source.tier === "package") return { whose: source.name !== null ? `${source.name}’s` : "a staged package’s", from: source.name ?? "a staged package", fix: UPDATES_FIX };
  if (source.tier === "trigger") return { whose: "the skills folder’s", from: "the skills folder", fix: triggerFix(facts) };
  return { whose: "this run’s", from: "elsewhere", fix: null };
}

/**
 * An overlay that counts one failure, names none and has no extension loaded: `overlay_extensions_withheld` held the whole overlay
 * back (`createLoadTee` keeps it as one failure with no name), or the one entry it held failed with a name the line would not carry.
 * The record cannot tell those two apart, nothing loaded in either, and the log line of the first holds a reason and a root where the
 * second's holds a path and a kind. So what is said of it is true of both. Any other count, or an extension that did load, rules the
 * first one out.
 */
const heldBackOrFailed = (source) => source.tier === "overlay" && source.failed === 1 && source.extensions === 0 && !(source.failedNames?.length > 0);
const HELD_BACK_WORDS = "failed to load or held back, and the job’s log says which";

/** What the banner says of a tier's failed extensions: "without" only where none of them can have stayed loaded. */
function failedBannerWords(count, without) {
  const [noun, they, it] = count === 1 ? ["extension", "it", "it"] : ["extensions", "they", "them"];
  return `The ${noun} failed while ${they} loaded and the run went on${without ? ` without ${it}` : ""}. ${LOADED_WORDS.readFirst}`;
}

/**
 * The extension-failed line. Its total is said only where it is known: see this file's header. `ran` says whether the run went on
 * past it (see the header too). A name is never put first as it stands: it would need a capital ("Acme/web's") that is not its
 * spelling, so a sentence that leads with a tier leads with a word.
 */
function failedLine(loaded, facts, ran = true) {
  const failed = failedCountOf(loaded);
  const rows = (loaded.sources ?? []).filter((source) => source.failed > 0);
  const wentOn = ran ? "The run went on." : "";
  const joined = (...parts) => parts.filter(Boolean).join(" ");
  if (rows.length === 0) return { bold: `${plural(failed, "extension")} failed to load.`, rest: joined(wentOn, "This record was cut to fit, so it does not say which."), fixes: [], banner: failedBannerWords(failed, false) };
  if (rows.length > 1) {
    const named = rows.map((source) => `${source.failed} from ${failedTierOf(source, facts).from}${heldBackOrFailed(source) ? ` (${HELD_BACK_WORDS})` : ""}`);
    return { bold: `${failed} of this run’s extensions failed to load.`, rest: joined(`${andList(named)}.`, wentOn), fixes: fixesOf(...rows.map((source) => failedTierOf(source, facts, loaded.baseSha).fix)), banner: failedBannerWords(failed, false) };
  }
  const [source] = rows;
  const { whose, from, fix } = failedTierOf(source, facts, loaded.baseSha);
  if (heldBackOrFailed(source)) {
    return { bold: `The overlay on ${facts.host ?? "this host"} failed to load or was held back, and the job’s log says which.`, rest: ran ? "The run went on without its extensions." : "", fixes: fixesOf(fix), banner: `The run went on without its extensions. ${LOADED_WORDS.readFirst}` };
  }
  const names = source.tier === "overlay" && Array.isArray(source.failedNames) && source.failedNames.length > 0 ? `${andList(source.failedNames)}.` : "";
  const banner = failedBannerWords(source.failed, source.extensions === 0);
  const fixes = fixesOf(fix);
  if (source.extensions > 0) return { bold: `${source.failed} of ${whose} extensions failed to load.`, rest: joined(wentOn, names), fixes, banner };
  const bold = source.failed === 1 ? `The extension from ${from} failed to load.` : `All ${source.failed} extensions from ${from} failed to load.`;
  return { bold, rest: joined(ran ? `The run went on without ${source.failed === 1 ? "it" : "them"}.` : "", names), fixes, banner };
}

/** The servers in one state, by name, or a fixed word for a row the worker could not name. */
const serversIn = (loaded, states) => (loaded.mcp ?? []).filter((row) => states.includes(row.state)).map((row) => row.name ?? "a server");

/**
 * What is said of a retry, for a failure the queue retries: only what the record or the queue shows. The queue holding the job again
 * (`QUEUED_STATES`, or running it) shows a retry; `failed` shows the queue has stopped retrying it, and neither it nor the record gives
 * the total, so no attempt is called the last; a later attempt is itself a retry. With neither, a first attempt says what the queue
 * does and claims nothing of this run: the job may be gone from the queue either way.
 */
function retryWords(record, jobState) {
  const later = isCount(record?.attempt) && record.attempt > 1;
  if (jobState === "failed") return later ? LOADED_WORDS.retriedStopped : LOADED_WORDS.queueStopped;
  if (later || jobState === "active" || QUEUED_STATES.includes(jobState)) return LOADED_WORDS.retried;
  return LOADED_WORDS.retriedRule;
}

/** The MCP line of a run a server stopped, or null. By the record's rows, or its minimal form's count and the run's reason. */
function mcpStopLine(loaded, record, { jobState }) {
  const failed = serversIn(loaded, ["failed"]);
  const timedOut = serversIn(loaded, ["timeout"]);
  const uncounted = loaded.mcp === null && isCount(loaded.problems?.mcp) && loaded.problems.mcp > 0;
  if (failed.length === 0 && timedOut.length === 0 && !uncounted) return null;
  const retried = retryWords(record, jobState);
  // A record's minimal form keeps how many and not which way. The run's outcome says: only the wait running out is retried.
  if ((timedOut.length > 0 && failed.length === 0) || (uncounted && record?.outcome === "failed")) {
    const who = timedOut.length > 0 ? andList(timedOut) : plural(loaded.problems.mcp, "MCP server");
    return { state: "mcp-stopped", tone: "failed", icon: "failed", bold: `${who} did not answer in time.`, rest: LOADED_WORDS.mcpStopped, small: [retried], fixes: [CONNECTIONS_FIX] };
  }
  const who = failed.length > 0 ? andList(failed) : plural(loaded.problems.mcp, "MCP server");
  return { state: "mcp-failed", tone: "refused", icon: "refused", bold: `${who} could not be used.`, rest: saysWhatLoaded(loaded) ? LOADED_WORDS.mcpStoppedLoaded : LOADED_WORDS.mcpStopped, small: [LOADED_WORDS.notRetried], fixes: [CONNECTIONS_FIX] };
}

/** What `cut` says, under whichever line says whether the run was fine, because it says nothing about that itself. */
function cutWords(loaded) {
  const cut = loaded.cut;
  if (cut === null || cut === undefined) return [];
  if (cut.form === "compact") return [LOADED_WORDS.cutCompact];
  if (cut.form === "minimal") return [LOADED_WORDS.cutMinimal];
  const parts = [
    cut.packages > 0 ? plural(cut.packages, "package") : null,
    cut.servers > 0 ? plural(cut.servers, "server") : null,
    cut.names > 0 ? plural(cut.names, "name") : null,
    cut.counts > 0 ? `the exact value of ${plural(cut.counts, "count")}` : null,
  ].filter(Boolean);
  // Not "cut to fit": `cut.names` also counts a tool's name withheld because the job's redactor would have changed it, which no room would have kept.
  return parts.length > 0 ? [`This record leaves out ${andList(parts)}.`] : [];
}

/**
 * What the trigger and the host left out on purpose, each its own sentence. Green: what a trigger turns off is not a
 * problem, so it is said as chosen and never as missing.
 */
function leftOutLines(loaded) {
  const left = loaded.leftOut;
  if (left === null || left === undefined) return [];
  const lines = [];
  const asked = [...(left.tools.length > 0 ? [andList(left.tools.map(toolWord))] : []), ...(left.packages ? ["the staged packages"] : [])];
  if (asked.length > 0) lines.push({ bold: "Left out, as it asks:", rest: `${commaAnd(asked)}.` });
  // One line for the one thing: a restricted run's switch is closed too, and its own reason is the more exact.
  if (left.restricted) lines.push({ bold: "Left out, as this kind of run asks:", rest: "the overlay’s extensions." });
  else if (left.overlayExtensions) lines.push({ bold: "Left out for this job:", rest: "the overlay’s extensions." });
  return lines;
}

/**
 * Who says what about the names this run loaded from its host's overlay and staged packages: `{ names, lack, absent, old,
 * unread }`, or null when no other host's publication proves a difference. A publication proves that host and only one that
 * published: silence is said as silence, and nothing is claimed about a host that has no current record. A canary's
 * candidate differs on purpose, so a canary's packages are not compared.
 *
 * THE OTHER HOSTS ARE READ AS THEY ARE NOW, AND THE RUN MAY BE A WEEK OLD. So a name is a difference between hosts only while the
 * run's own host still lists it: a package every host has moved past, or an overlay file removed everywhere, is lacking on every
 * host and is no difference between any of them. A host that says nothing current of itself cannot be said to differ.
 */
function hostDifference(record, loaded, facts, hostLoads) {
  const rows = hostLoads?.hosts;
  if (!Array.isArray(rows) || facts.host === null) return null;
  const others = rows.filter((row) => row?.name !== facts.host && typeof row?.name === "string");
  const readable = (row) => row?.state === "current" && Array.isArray(row.extensions) && Array.isArray(row.packages);
  const own = rows.find((row) => row?.name === facts.host);
  if (!readable(own)) return null;
  const known = others.filter(readable);
  const hasOverlay = (row, name) => row.overlayExtensionsAllowed === true && row.extensions.some((entry) => entry.name === name);
  const hasPackage = (row, pkg) => row.packages.some((entry) => entry.name === pkg.name && entry.version === pkg.version);
  const overlay = (sourcesOf(loaded, "overlay")[0]?.names ?? []).filter((name) => hasOverlay(own, name));
  const packages = record?.packageCanary ? [] : sourcesOf(loaded, "package").filter((row) => row.name !== null && hasPackage(own, row));
  // A list past its cap, or a part the host could not read, cannot prove a lack.
  const canSayOverlay = (row) => !row.unread?.includes("extensions") && !row.more?.extensions;
  const canSayPackages = (row) => !row.unread?.includes("packages") && !row.more?.packages;
  const lackingOverlay = overlay.filter((name) => known.some((row) => canSayOverlay(row) && !hasOverlay(row, name)));
  const lackingPackages = packages.filter((pkg) => known.some((row) => canSayPackages(row) && !hasPackage(row, pkg)));
  if (lackingOverlay.length === 0 && lackingPackages.length === 0) return null;
  const lack = known.filter((row) => (canSayOverlay(row) && lackingOverlay.some((name) => !hasOverlay(row, name))) || (canSayPackages(row) && lackingPackages.some((pkg) => !hasPackage(row, pkg)))).map((row) => row.name);
  return {
    overlay: lackingOverlay,
    packages: lackingPackages.map((pkg) => `${pkg.name} ${pkg.version}`),
    lack,
    absent: others.filter((row) => row.state === "unknown" && row.why !== "unreadable").map((row) => row.name),
    unread: others.filter((row) => row.state === "unknown" && row.why === "unreadable").map((row) => row.name),
    old: others.filter((row) => row.state === "old").map((row) => row.name),
  };
}

/**
 * How many of the hosts that lack a name get a button beside the one that has it. The fix is on the host that is behind, so it gets one;
 * the sentence already names them all, and a fleet's worth of buttons is no line. The docs say this number, and a test holds them to it.
 */
export const HOSTS_OFFERED = 3;

/** "**Also loaded git-guard** from build3's overlay. mini1 does not have it; mini2 has published nothing." */
function hostDifferenceLine(difference, facts) {
  const overlay = difference.overlay.length > 0 ? andList(difference.overlay) : null;
  const packages = difference.packages.length > 0 ? andList(difference.packages) : null;
  const from = overlay !== null && packages !== null ? `from ${facts.host}’s overlay, and ${packages} from its staged packages` : `from ${facts.host}’s ${overlay !== null ? "overlay" : "staged packages"}`;
  const count = difference.overlay.length + difference.packages.length;
  const said = [
    difference.lack.length > 0 ? `${andList(difference.lack)} ${difference.lack.length === 1 ? "does" : "do"} not have ${count === 1 ? "it" : "all of them"}` : null,
    difference.absent.length > 0 ? `${andList(difference.absent)} ${difference.absent.length === 1 ? "has" : "have"} published nothing` : null,
    difference.old.length > 0 ? `${andList(difference.old)}’s publication is old` : null,
    difference.unread.length > 0 ? `${andList(difference.unread)}’s publication could not be read` : null,
  ].filter(Boolean);
  return { bold: `Also loaded ${overlay ?? packages}`, rest: `${from}. ${said.join("; ")}.` };
}

// ---- the verdict -----------------------------------------------------------------------------------------------------

const verdict = (fields, record = null) => ({ tone: "idle", icon: "minus", lead: null, bold: null, rest: null, then: [], small: [], outcome: outcomeNote(record), fixes: [], also: [], ...fields });

/**
 * Whether the record shows the agent went on past what loaded (see this file's header). Each way out of the runner leaves something
 * different on its line, and each thing it leaves is a claim only in some of them:
 *   - Completed went on, whatever else it holds: a `run.command` can complete with no turn at all.
 *   - A line with a count of turns is the decided path. `turns` rises as a turn STARTS, so a provider's 401 on the first prompt holds
 *     `turns: 1`. `calls` rises before the provider answers too, so it holds `calls: 1`, measured at the pi pin through the real budget
 *     and meter; only `total: 0` shows nothing came back. A provider that reports no usage reads the same way on a run that did not
 *     complete, and the card then says less of it, never anything false: it did stop after loading.
 *   - A line with no turns is the outer catch, whose only trace of a run that had gone on is its metered calls. A policy exit there
 *     is a refusal, nearly always before the prompt, and its calls can be an extension's while it loaded (`meteredExitFields`
 *     names that very case), so it is not read as having gone on. REJECTED: any call on any line, which would read a cost cap at load
 *     (`turns: 0`, and the call that crossed it) as having run.
 */
const wentOn = (record) => {
  if (record?.outcome === "completed") return true;
  if (isCount(record?.turns)) return record.turns > 0 && record.tokens?.total !== 0;
  return record?.outcome !== "policy" && isCount(record?.tokens?.calls) && record.tokens.calls > 0;
};

/**
 * The top line of a run's Loaded card. `{ state, tone, icon, lead, bold, rest, then, small, outcome, fixes, also }`:
 * the line reads `lead`, then `bold`, then `rest`, then each of `then`; `small` goes under it; `fixes` are the ways to where it is
 * fixed, in order; `also` holds any further problem, each with its own `fixes`; `outcome` is `outcomeNote`. `hostLoads` is what the hosts published
 * (`readHostLoadsView`), and a missing or failed read is no line at all, never "the same". `jobState` is the queue's word for the
 * job (`chatFactsOf`), or null where it has none, which the record alone cannot say: an infra failure writes a record per attempt.
 */
export function loadedVerdict(record, hostLoads = null, { jobState = null } = {}) {
  if (record === null || typeof record !== "object") return null;
  const facts = factsOf(record);
  const loaded = loadedOf(record);
  if (endedBeforeContainer(record, loaded) && (loaded === null || loaded.runner === "absent")) return verdict({ state: "refused", rest: isCancel(record) ? LOADED_WORDS.cancelled : LOADED_WORDS.refused }, record);
  if (loaded === null) {
    // A run that failed, or a cancel that holds its reservation, with no exit code may be this release's, whose worker stopped before any container: not an older release's for certain.
    const unknown = hasNoExit(record) && ["failed", "policy"].includes(record.outcome);
    return verdict({ state: "not-recorded", rest: unknown ? LOADED_WORDS.notRecordedUnknown : LOADED_WORDS.notRecorded }, record);
  }
  if (loaded.runner === "absent") return verdict({ state: "absent", rest: LOADED_WORDS.absent }, record);
  if (loaded.runner === "invalid") return verdict({ state: "invalid", tone: "attention", icon: "attention", rest: LOADED_WORDS.invalid }, record);
  if (loaded.runner === "cut") return verdict({ state: "cut", rest: LOADED_WORDS.noRoom }, record);
  if (loaded.at === "none") return verdict({ state: "no-agent", rest: LOADED_WORDS.noAgent }, record);
  // A list that never got past `start` on a run that went on says nothing of what it had, which is what `absent` says.
  if (loaded.at === "start") return wentOn(record) ? verdict({ state: "absent", rest: LOADED_WORDS.absent }, record) : verdict({ state: "stopped", rest: LOADED_WORDS.stoppedStart }, record);

  const small = cutWords(loaded);
  const problems = [];
  const stop = mcpStopLine(loaded, record, { jobState });
  if (stop !== null) problems.push(stop);
  const ran = stop === null && wentOn(record);
  // It went on, and a report that broke left an earlier stage. A failed server would have stopped it, so nothing it asks for is missing.
  if (ran && loaded.at !== "ready") small.push(LOADED_WORDS.notedEarly);
  if (flowMissing(loaded)) problems.push({ state: "no-flow", tone: "attention", icon: "attention", bold: ran ? LOADED_WORDS.ranWithoutFlow : LOADED_WORDS.flowNowhere, rest: noFlowSentence(loaded, facts), fixes: noFlowFixes(loaded, facts) });
  if (failedCountOf(loaded) > 0) {
    const line = failedLine(loaded, facts, ran);
    problems.push({ state: "extension-failed", tone: "failed", icon: "failed", bold: line.bold, rest: line.rest, fixes: line.fixes });
  }
  if (problems.length > 0) {
    const [first, ...others] = problems;
    return verdict({ ...first, small: [...(first.small ?? []), ...small], also: others.map(({ tone, icon, bold, rest, fixes }) => ({ tone, icon, bold, rest, fixes })) }, record);
  }
  if (!ran) {
    // A `-shadowed` refusal comes before the servers start (run-job.mjs), and their rows read `pending` all the same.
    const pending = serversIn(loaded, ["pending"]).length > 0;
    const rest = loaded.at === "loader" ? LOADED_WORDS.stoppedLoader : pending ? (/-shadowed$/.test(record.reason ?? "") ? LOADED_WORDS.stoppedBeforeServers : LOADED_WORDS.stoppedServers) : loaded.at === "session" ? LOADED_WORDS.stoppedSession : LOADED_WORDS.stoppedAfterLoading;
    return verdict({ state: "stopped", rest, small }, record);
  }
  const connected = (loaded.mcp ?? []).filter((row) => row.state === "connected");
  const servers = connected.length > 0 ? [`MCP: ${andList(connected.map((row) => `${row.name ?? "a server"} connected, with ${plural(row.tools, "tool")}`))}.`] : [];
  const left = leftOutLines(loaded);
  const difference = hostDifference(record, loaded, facts, hostLoads);
  if (difference !== null) {
    const line = hostDifferenceLine(difference, facts);
    return verdict({ state: "host-differs", tone: "attention", icon: "info", bold: line.bold, rest: line.rest, then: left, small: [...servers, ...small], fixes: fixesOf(hostFix(facts.host), ...difference.lack.slice(0, HOSTS_OFFERED).map(hostFix)) }, record);
  }
  const lead = `Everything ${facts.subject} asks for loaded.`;
  const [first, ...rest] = left;
  if (first !== undefined) return verdict({ state: "left-out", tone: "ok", icon: "done", lead, bold: first.bold, rest: first.rest, then: rest, small: [...servers, ...small] }, record);
  return verdict({ state: "everything", tone: "ok", icon: "done", rest: lead, small: [...servers, ...small] }, record);
}

/** The line of a run with no record yet: a record is written from the exit line, and a live one would need a second trusted line. */
export function runningVerdict(triggerIndex = null) {
  const index = Number.isSafeInteger(triggerIndex) && triggerIndex >= 0 ? triggerIndex : null;
  return verdict({ state: "running", rest: index !== null ? `${LOADED_WORDS.running} Trigger ${index + 1} says what it asks for.` : LOADED_WORDS.running, fixes: fixesOf(triggerFix({ index })) });
}

/** What the outcome banner adds for a completed run that lacked something: `{ sentences, fixes }`, or null. A completed run went on, whatever its line's stage. */
export function outcomeBanner(record) {
  const problems = loadedProblems(record);
  if (problems.length === 0) return null;
  const loaded = loadedOf(record);
  const facts = factsOf(record);
  const sentences = [];
  const fixes = [];
  if (problems.includes("flow-missing")) {
    sentences.push(`${noFlowSentence(loaded, facts)} ${LOADED_WORDS.readFirst}`);
    fixes.push(...noFlowFixes(loaded, facts));
  }
  if (problems.includes("extension-failed")) {
    const line = failedLine(loaded, facts);
    sentences.push(`${line.bold} ${line.banner}`);
    fixes.push(...line.fixes);
  }
  return { sentences, fixes: fixesOf(...fixes) };
}

// ---- the card's rows -------------------------------------------------------------------------------------------------

function piRow(loaded, facts) {
  const version = loaded.pi ?? loaded.imagePi;
  const value = version !== null && loaded.image !== null ? [`pi ${version} in `, code(loaded.image)] : version !== null ? `pi ${version}` : loaded.image !== null ? ["pi in ", code(loaded.image)] : "pi, its version not recorded";
  const more = loaded.imageDigest !== null ? ["image ", code(shortDigest(loaded.imageDigest)), facts.host !== null ? `, as ${facts.host} ran it` : ""] : null;
  return { icon: "box", label: "pi", value, more };
}

function modelRow(facts) {
  return { icon: "bolt", label: "Model", value: facts.model !== null ? `${facts.provider !== null ? `${facts.provider} / ` : ""}${facts.model}` : "not recorded", more: facts.calls !== null ? plural(facts.calls, "call") : null };
}

function extensionsRow(loaded, facts) {
  const named = sourcesOf(loaded, "package").filter((row) => row.name !== null);
  const unnamed = sourcesOf(loaded, "package").find((row) => row.name === null);
  const overlay = sourcesOf(loaded, "overlay")[0];
  const repository = sourcesOf(loaded, "repository")[0]?.extensions ?? 0;
  const others = sumOf([...sourcesOf(loaded, "trigger"), ...sourcesOf(loaded, "other")], "extensions");
  if (loaded.sources.length === 0) return { icon: "layers", label: "Extensions", value: "not kept", more: "this record was cut to fit" };
  const names = [...named.map((row) => `${row.name} ${row.version}`), ...(overlay?.names ?? [])];
  const counted = [
    unnamed && unnamed.extensions > 0 ? `${unnamed.extensions} from staged packages` : null,
    overlay && overlay.names === null && overlay.extensions > 0 ? `${overlay.extensions} from the overlay` : null,
    repository > 0 ? `${repository} from the repository` : null,
    others > 0 ? `${others} from elsewhere` : null,
  ].filter(Boolean);
  const said = [
    named.length > 0 ? `staged on ${facts.host ?? "this host"}` : null,
    (overlay?.names?.length ?? 0) > 0 ? `${andList(overlay.names)} from ${facts.host ?? "this host"}’s overlay` : null,
    ...(names.length > 0 ? counted : []),
    loaded.leftOut?.packages ? `${facts.subject} withholds the staged packages` : null,
    loaded.leftOut?.overlayExtensions ? "this job left out the overlay’s extensions" : null,
  ].filter(Boolean);
  const value = names.length > 0 ? names.join(", ") : counted.length > 0 ? counted.join(", ") : "none";
  return { icon: "layers", label: "Extensions", value, more: said.length > 0 ? commaAnd(said) : null };
}

/** Where a flow was found, in the words the card uses. */
function flowFrom(flow, facts) {
  if (flow.tier === "repository") return "the repository";
  if (flow.tier === "trigger") return `${facts.subject}’s skills folder`;
  if (flow.tier === "overlay") return "the overlay";
  if (flow.tier === "package") return flow.package ?? "a staged package";
  return "elsewhere";
}

/** Whether a source's skill count holds the flow, so the count beside the flow's own line can take it back out. */
const holdsFlow = (flow, row) => flow !== null && flow.tier === row.tier && (row.tier !== "package" || row.name === null || flow.package === null || row.name === flow.package);

function skillsRow(loaded, facts) {
  const flow = loaded.flow;
  const name = facts.flow ?? "its flow";
  if (loaded.sources.length === 0) {
    const value = flow === null ? "not kept" : flow.tier === "none" ? [strong(name), ", the flow, found nowhere"] : [strong(name), `, the flow, from ${flowFrom(flow, facts)}`];
    return { icon: "skill", label: "Skills", value, more: "this record was cut to fit" };
  }
  // The repository first, as the record is the repository's before it is a package's; the rest in the order pi resolves them.
  const ordered = ["repository", "trigger", "overlay", "package", "other"].flatMap((tier) => sourcesOf(loaded, tier));
  const counted = ordered.filter((row) => row.skills > 0).map((row) => {
    const own = holdsFlow(flow, row) ? 1 : 0;
    const label = row.tier === "repository" ? "the repository" : row.tier === "trigger" ? "the skills folder" : row.tier === "overlay" ? "the overlay" : row.tier === "package" ? row.name ?? "staged packages" : "elsewhere";
    return { label, count: Math.max(0, row.skills - own) };
  }).filter((row) => row.count > 0);
  const total = counted.reduce((sum, row) => sum + row.count, 0);
  const others = counted.map((row) => `${row.count} from ${row.label}`).join(", ");
  if (flow === null) return { icon: "skill", label: "Skills", value: total > 0 ? plural(total, "skill") : "none", more: total > 0 ? `${others}; the trigger names no flow` : "the trigger names no flow" };
  const value = flow.tier === "none" ? [strong(name), ", the flow, found nowhere"] : [strong(name), `, the flow, from ${flowFrom(flow, facts)}`];
  return { icon: "skill", label: "Skills", value, more: total > 0 ? `and ${total} more: ${others}` : "and no others" };
}

const SERVER_STATE_WORDS = Object.freeze({
  failed: "could not be used",
  timeout: "did not answer in time",
  pending: "had not connected",
});
/** A server's state. `pending` on a run that went on is an early note, since it would have stopped otherwise: it says that. */
const stateWords = (row, ran) => (row.state === "connected" ? `connected, with ${plural(row.tools, "tool")}` : row.state === "pending" && ran ? "was still connecting when this was noted" : SERVER_STATE_WORDS[row.state]);
const serverWords = (row, ran) => `${row.name ?? "a server"} ${stateWords(row, ran)}`;

function mcpRow(loaded, facts, ran) {
  const row = (value, more = null) => ({ icon: "plug", label: "MCP", value, more });
  if (loaded.mcp === null) {
    if (isCount(loaded.problems?.mcp) && loaded.problems.mcp > 0) return row(`${plural(loaded.problems.mcp, "server")} could not be used`, "this record was cut to fit");
    return row("not kept", loaded.at !== "loader" ? "this record was cut to fit" : ran ? LOADED_WORDS.notedEarlyRow : "the run stopped before its servers started");
  }
  const left = loaded.cut?.servers > 0 ? `and ${plural(loaded.cut.servers, "more server")} past this record’s bound` : null;
  if (loaded.mcp.length === 0) return row("none", left ?? `${facts.subject} names no server`);
  return row(loaded.mcp.map((server) => serverWords(server, ran)).join("; "), left);
}

function toolsRow(loaded, ran) {
  const row = (value, more = null) => ({ icon: "flows", label: "Tools", value, more });
  if (loaded.tools === null) return row("not kept", loaded.at !== "loader" ? "this record was cut to fit" : ran ? LOADED_WORDS.notedEarlyRow : "the run stopped before its tools were ready");
  const fromExtensions = sumOf(loaded.sources, "tools");
  const said = [
    Array.isArray(loaded.tools.own) && loaded.tools.own.length > 0 ? andList(loaded.tools.own) : null,
    fromExtensions > 0 ? `${fromExtensions} from the extensions` : null,
    Array.isArray(loaded.tools.job) && loaded.tools.job.length > 0 ? `${andList(loaded.tools.job)}, the job’s own` : null,
  ].filter(Boolean);
  const removed = loaded.leftOut?.tools?.length > 0 ? `${andList(loaded.leftOut.tools.map(toolWord))} removed` : "none removed";
  return row(`${loaded.tools.active} active`, said.length > 0 ? `${commaAnd(said)}; ${removed}` : removed);
}

/**
 * The card's one line per kind, or an empty list where the record says nothing about them. `{ icon, label, value, more }`,
 * each of `value` and `more` a line's parts.
 */
export function loadedRows(record) {
  const loaded = loadedOf(record);
  if (loaded === null) return [];
  const facts = factsOf(record);
  if (loaded.runner !== "reported" || !saysWhatLoaded(loaded)) return loaded.image !== null || loaded.pi !== null ? [piRow(loaded, facts)] : [];
  const ran = wentOn(record);
  return [piRow(loaded, facts), modelRow(facts), extensionsRow(loaded, facts), skillsRow(loaded, facts), mcpRow(loaded, facts, ran), toolsRow(loaded, ran)];
}

/** One tier's count as a row of the fold, by the words `from` gives it. */
const countRows = (loaded, slot, kind, facts) => {
  const rows = loaded.sources.filter((row) => row[slot] > 0);
  if (rows.length === 0) return [{ kind, name: "0", version: "", from: "in any tier" }];
  return rows.map((row) => ({ kind, name: String(row[slot]), version: "", from: row.tier === "package" ? row.name ?? "staged packages" : row.tier === "repository" ? "the repository at its base commit" : row.tier === "overlay" ? `${facts.host ?? "this host"}’s overlay` : row.tier === "trigger" ? "the skills folder" : "elsewhere" }));
};

/**
 * The fold's table, with what no top line mentions: the skills a package had replaced, the themes and the extensions the
 * guard dropped. `{ kind, name, version, from }`, `name` and `from` a line's parts, `version` a string or "". Empty when the
 * record holds no sources: then there is nothing to fold.
 */
export function loadedFold(record) {
  const loaded = loadedOf(record);
  if (loaded === null || loaded.runner !== "reported" || loaded.sources.length === 0) return [];
  const facts = factsOf(record);
  const host = facts.host ?? "this host";
  const rows = [];
  const add = (kind, name, version, from) => rows.push({ kind, name, version, from });
  if (loaded.imageDigest !== null) add("Image", code(shortDigest(loaded.imageDigest)), "", LOADED_WORDS.imageId);
  for (const row of sourcesOf(loaded, "package")) {
    if (row.name !== null) add("Extension", code(row.name), row.version, `staged on ${host}`);
    else add("Extension", String(row.extensions), "", "staged packages, by count: this record was cut to fit");
  }
  const failedRows = loaded.sources.filter((row) => row.failed > 0);
  if (failedRows.length === 0) add("Extension failed", "0", "", LOADED_WORDS.failedRow);
  for (const row of failedRows) add("Extension failed", String(row.failed), "", heldBackOrFailed(row) ? `${failedTierOf(row, facts).from}; ${HELD_BACK_WORDS}` : `${failedTierOf(row, facts).from}; a path and its kind stay in the job’s log`);
  const droppedRows = loaded.sources.filter((row) => row.dropped > 0);
  if (droppedRows.length === 0) add("Extension dropped", "0", "", LOADED_WORDS.droppedRow);
  for (const row of droppedRows) add("Extension dropped", String(row.dropped), "", `${failedTierOf(row, facts).from}, by the recursion guard; names stay in the job’s log`);
  add("Repository extensions", String(sourcesOf(loaded, "repository")[0]?.extensions ?? 0), "", "the repository’s .pi/extensions at its base commit");
  const overlay = sourcesOf(loaded, "overlay")[0];
  if (overlay?.names?.length > 0) for (const name of overlay.names) add("Overlay", code(name), "", `${host}’s overlay`);
  else if (overlay?.extensions > 0) add("Overlay", String(overlay.extensions), "", `${host}’s overlay, by count: this record was cut to fit`);
  else add("Overlay", "none", "", `no extension from ${host}’s overlay`);
  for (const name of overlay?.failedNames ?? []) add("Overlay failed", code(name), "", `${host}’s overlay`);
  const flow = loaded.flow;
  if (flow !== null) add("Skill", [code(facts.flow ?? "its flow"), { muted: " (the flow)" }], "", flow.tier === "none" ? "found in no tier" : flow.tier === "repository" ? "the repository’s .pi/skills at its base commit" : flowFrom(flow, facts));
  for (const row of loaded.sources.filter((source) => source.skills > 0)) {
    const own = holdsFlow(flow, row) ? 1 : 0;
    const count = row.skills - own;
    if (count <= 0) continue;
    if (row.tier === "repository") add("Skill", own === 1 ? `${count} more` : String(count), "", ["the repository at its base commit. ", repositoryLink("Read them there"), `; ${LOADED_WORDS.noRepositoryNames}`]);
    else add("Skill", String(count), "", row.tier === "package" ? row.name ?? "staged packages" : row.tier === "overlay" ? `${host}’s overlay` : row.tier === "trigger" ? "the skills folder" : "elsewhere");
  }
  // The runner counts these on the package that lost the name. Which higher tier won it is in the job's log and not here.
  for (const row of loaded.sources.filter((source) => source.shadowed > 0)) {
    add("Skill replaced", String(row.shadowed), "", `${row.shadowed === 1 ? "one" : row.shadowed} of ${row.tier === "package" ? `${row.name ?? "a staged package"}’s` : "this tier’s"}, by a skill of that name from the repository, the skills folder or the overlay; the name stays in the job’s log`);
  }
  for (const row of countRows(loaded, "prompts", "Prompt template", facts)) add(row.kind, row.name, row.version, row.from);
  for (const row of countRows(loaded, "themes", "Theme", facts)) add(row.kind, row.name, row.version, row.from);
  for (const server of loaded.mcp ?? []) add("MCP server", code(server.name ?? "a server"), "", stateWords(server, wentOn(record)));
  if (Array.isArray(loaded.tools?.own) && loaded.tools.own.length > 0) add("Tools", loaded.tools.own.join(", "), "", "pi");
  for (const row of sourcesOf(loaded, "package")) if (row.toolNames?.length > 0) add("Tools", row.toolNames.join(", "), "", row.name ?? "a staged package");
  for (const row of overlay?.namedTools ?? []) add("Tools", row.tools.join(", "), "", `${row.name}, ${host}’s overlay`);
  const repositoryTools = sourcesOf(loaded, "repository")[0]?.tools ?? 0;
  if (repositoryTools > 0) add("Tools", String(repositoryTools), "", `the repository’s extensions; ${LOADED_WORDS.noRepositoryNames}`);
  for (const name of loaded.tools?.job ?? []) add("Tools", code(name), "", name === "report_progress" ? `the job’s own, because ${facts.subject} sets run.progress` : "the job’s own");
  for (const name of loaded.leftOut?.tools ?? []) add("Left out", code(name), "", `${facts.subject}’s run.excludeTools`);
  if (loaded.leftOut?.packages) add("Left out", "the staged packages", "", `${facts.subject}’s run.packages false`);
  if (loaded.leftOut?.restricted) add("Left out", "the overlay’s extensions", "", "this kind of run");
  else if (loaded.leftOut?.overlayExtensions) add("Left out", "the overlay’s extensions", "", "this job’s overlay switch: off on its host (PI_GLOBAL_ALLOW_EXTENSIONS=0), or for a model canary’s replay");
  return rows;
}

// ---- a sandbox -------------------------------------------------------------------------------------------------------

/**
 * A shell has no overlay: worker/src/sandbox.mjs mounts no /opt/pi-global, so pi started there loads only the workspace's
 * own `.pi/`, whatever the run it came from loaded or a job on that host would load. This goes first, because "as gh-9575
 * loaded" would promise tools the shell does not have.
 */
const noOverlay = (pi) => `${typeof pi === "string" ? `pi ${pi} in the image.` : "pi in the image, at a version this page cannot name."} No overlay is mounted, so pi started here loads only the workspace’s own .pi/.`;

/**
 * pi's version for a shell on `image`, from what its host publishes: `piVersion` is of the image the host booted on
 * (`start.mjs`), so it says nothing of a kept `pi-job:4.0.0` or of a trigger's own `run.image`. Null unless the two are that one
 * image, and the line then says it cannot name the version. REJECTED: the host's version as a likely answer, which is how a
 * record from before an upgrade read "pi 1.5.0 in the image" over an image holding another.
 */
export function hostPiFor(row, image) {
  return typeof row?.piVersion === "string" && typeof image === "string" && row.image === image ? row.piVersion : null;
}

/** The names a line of a sandbox lists: packages with their versions, then overlay names, then how many past a list's cap. */
function namedOfRecord(loaded) {
  return [...sourcesOf(loaded, "package").filter((row) => row.name !== null).map((row) => `${row.name} ${row.version}`), ...(sourcesOf(loaded, "overlay")[0]?.names ?? [])];
}

/** What opens on a workspace prepared with no run: there is no run to quote, and a shell has no overlay either way. */
export const sandboxPreparedLine = (pi = null) => noOverlay(pi);

/**
 * What opens, from a run: a shell's own words first, then what the run itself had, linked to it. `pi` is `hostPiFor`'s, for a record
 * that does not say. `unread` is a read of the record that failed, which is unknown: the record may say.
 */
export function sandboxRunLine(record, id, { pi = null, unread = false } = {}) {
  const loaded = loadedOf(record);
  const version = loaded?.pi ?? loaded?.imagePi ?? pi;
  const first = noOverlay(version);
  if (unread) return [`${first} What `, run(id), " itself loaded could not be read."];
  if (loaded === null || loaded.runner !== "reported" || !saysWhatLoaded(loaded)) return [`${first} What `, run(id), " itself loaded is not recorded."];
  if (loaded.sources.length === 0) return [`${first} `, run(id), "’s record was cut to fit and keeps no names."];
  const names = namedOfRecord(loaded);
  if (names.length === 0 && sumOf(sourcesOf(loaded, "package").filter((row) => row.name === null), "extensions") > 0) return [`${first} `, run(id), "’s record was cut to fit and keeps no names."];
  if (names.length === 0) return [`${first} `, run(id), " itself loaded no staged package or overlay extension."];
  return [`${first} `, run(id), ` itself also loaded ${andList(names)}.`];
}

/** Each part a host's publication can say it could not read (`HOST_LOADS_PARTS`), in a sentence's words. */
const UNREAD_PART_WORDS = Object.freeze({ extensions: "its overlay’s extensions", skills: "its skills", mcp: "its MCP servers", packages: "its staged packages" });

/** One host's row of what the hosts published, or an unknown one: a read that failed or holds no such host cannot say. */
export function hostLoadsRow(hostLoads, name) {
  const row = Array.isArray(hostLoads?.hosts) ? hostLoads.hosts.find((entry) => entry?.name === name) : null;
  return row ?? { name, state: "unknown", why: hostLoads?.unreachable ? "unreachable" : "absent" };
}

/**
 * What opens, on a fresh sandbox: there is no run to quote, so what a job of that trigger would load on that host, from
 * its last doctor run and with the time, or that this is unknown. pi's version is `host:h:<name>`'s where `image`, the one the
 * trigger gives this sandbox, is the one that host booted on, so a host that has published no doctor run still has one.
 * Approximate in the safe direction, as the publication is: the repository's part is decided at its base commit, which the
 * foot says.
 */
export function sandboxFreshLine({ hostLoads, host, triggerIndex, withholdsPackages = false, image = null }) {
  const row = hostLoadsRow(hostLoads, host);
  const first = noOverlay(hostPiFor(row, image));
  const unknown = (why) => [`${first} What a job of trigger ${triggerIndex + 1} would load on this host is unknown: ${why}.`];
  if (row.state === "unknown") return unknown(row.why === "unreachable" ? "the hosts’ doctor runs could not be read" : row.why === "unreadable" ? "its last doctor run could not be read" : "it has published no doctor run");
  // Any part this job could load from that the host could not read makes the whole answer unknown: an empty list there is
  // not none. A part this job would not load from anyway (packages it withholds, an overlay that is off) changes nothing.
  const unread = (row.unread ?? []).filter((part) => (part !== "packages" || !withholdsPackages) && (part !== "extensions" || row.overlayExtensionsAllowed));
  if (unread.length > 0) return unknown(`its last doctor run could not read ${andList(unread.map((part) => UNREAD_PART_WORDS[part] ?? "part of what it publishes"))}`);
  const packages = withholdsPackages ? [] : (row.packages ?? []).map((entry) => `${entry.name} ${entry.version}`);
  const extensions = row.overlayExtensionsAllowed ? (row.extensions ?? []).map((entry) => entry.name) : [];
  const past = (withholdsPackages ? 0 : row.more?.packages ?? 0) + (row.overlayExtensionsAllowed ? row.more?.extensions ?? 0 : 0);
  const named = [...packages, ...extensions, ...(past > 0 ? [`${past} more`] : [])];
  const said = named.length > 0 ? andList(named) : "no staged package or overlay extension";
  return [`${first} A job of trigger ${triggerIndex + 1} on this host would load ${said}, from its last doctor run at `, time(row.at), row.state === "old" ? ", which is old." : "."];
}

// ---- a project -------------------------------------------------------------------------------------------------------

const NOT_READ = Object.freeze({
  older: Object.freeze({ one: (id) => ["an older release wrote ", run(id), "’s record"], many: (n) => `${n} from an older release` }),
  refused: Object.freeze({ one: (id) => [run(id), " was refused before its container started"], many: (n) => `${n} refused` }),
  cancelled: Object.freeze({ one: (id) => [run(id), " was cancelled before its container started"], many: (n) => `${n} cancelled before ${n === 1 ? "it" : "they"} started` }),
  unstarted: Object.freeze({ one: (id) => [run(id), " ended before its container reported"], many: (n) => `${n} that ended before ${n === 1 ? "its" : "their"} container reported` }),
  absent: Object.freeze({ one: (id) => [run(id), "’s runner did not say what it loaded"], many: (n) => `${n} whose runner did not say` }),
  invalid: Object.freeze({ one: (id) => [run(id), "’s record could not be read"], many: (n) => `${n} that could not be read` }),
  cut: Object.freeze({ one: (id) => [run(id), " had no room for what it loaded, on its exit line or in its record"], many: (n) => `${n} with no room for what ${n === 1 ? "it" : "they"} loaded` }),
});

/** Why a run has nothing to read: a key of `NOT_READ`, or null for a run whose record says what it loaded. */
function notReadWhy(record) {
  const loaded = loadedOf(record);
  if (loaded === null || loaded.runner === "absent") {
    if (endedBeforeContainer(record, loaded)) return isCancel(record) ? "cancelled" : "refused";
    if (loaded === null) return hasNoExit(record) ? "unstarted" : "older";
    return "absent";
  }
  if (loaded.runner === "invalid") return "invalid";
  if (loaded.runner === "cut") return "cut";
  // What the run's page says of it: a list stuck at `start` on a run that went on says nothing of what it had.
  if (loaded.at === "start" && wentOn(record)) return "absent";
  return null;
}

/** How many runs of a project it could not read, in the one sentence every state says it in. */
const notReadCount = (n) => `${n} did not load or ${n === 1 ? "was" : "were"} not recorded`;

/** How many flows the project's line names: a project's triggers are few, and the page keeps its one line. */
const FLOWS_SHOWN = 8;

/** A run's id as a run link can hold it, or nothing: a list drawn from records the worker wrote, held once more. */
const runIdOf = (record) => (typeof record?.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(record.jobId) ? record.jobId : "a run");

/** A run with no agent loads nothing, so a project's card leaves it out of everything but one line saying so. */
const hasNoAgent = (record) => {
  const loaded = loadedOf(record);
  return loaded?.runner === "reported" && loaded.at === "none";
};

/**
 * Whether a run's overlay was shut by its kind, whatever its host's overlay holds: a model canary always replays with it shut
 * (`canary-runtime.mjs`, `record.canary`), and a restricted run is forced shut. A package canary (`record.packageCanary`) is not here:
 * it is an ordinary job on its host's switch, so what it says of the overlay is its host's. Nor is a host's own
 * `PI_GLOBAL_ALLOW_EXTENSIONS=0`: that one is the host's, so it is a difference between hosts.
 */
const overlayShutByKind = (record, loaded) => Boolean(record?.canary) || loaded?.leftOut?.restricted === true;

/** Whether a run speaks for its host's staged packages: a withholding trigger and either canary each differ on purpose. */
const showsHostPackages = (record, loaded) => loaded?.leftOut?.packages !== true && !record?.packageCanary && !record?.canary;

/**
 * Whether a record's overlay list is short of what the run loaded. `cut.names` alone cannot say: it also counts tool names kept off
 * the record, which leave this list whole. So the row decides too, when it counts more extensions than it names. A folder holding two
 * entries under one name counts the same way, so beside a cut tool name that reads as cut, which is the side that claims nothing.
 */
const overlayNamesCut = (loaded, row) => (loaded.cut?.names ?? 0) > 0 && (row?.extensions ?? 0) > (row?.names?.length ?? 0);

/** When a record ended, for "the newest". A record with no readable time is never the newest of anything else. */
function endOf(record) {
  const at = Date.parse(record?.endedAt ?? record?.startedAt ?? "");
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * WHAT A HOST HAS IS WHAT THE NEWEST OF ITS RUNS ABLE TO SHOW IT HAD, fact by fact, in one pass over its runs: pi and its image from
 * its newest run on its own image; its staged packages from its newest run that did not withhold them, was no canary and kept their whole
 * list; its overlay from its newest run with the overlay open and its whole list kept. A host can have run 1.4.2 and then 1.4.3 inside the window, and a rare trigger may not
 * have run since, so REJECTED: the union of a host's runs, and its newest run per trigger, each of which calls a routine Adopt a difference
 * until the old run leaves the window. Packages and the overlay are the host's: a trigger chooses only all or nothing, which is
 * `leftOut`. A fact no run could show stays null, which is unknown, never empty: a record cut past its names is no evidence of none.
 * What a flow or a server did belongs to a trigger, and the card counts those by run, so it compares neither. A list past its cap is cut
 * short of what the run had, so it cannot show that kind either: its first 16 names beside another host's are neither the same nor different.
 */
function hostFacts(records) {
  const facts = { pi: null, image: null, packages: null, overlay: null, cut: false, shut: false, withheld: false, jobImage: false, stopped: 0 };
  const newest = { image: Number.NEGATIVE_INFINITY, packages: Number.NEGATIVE_INFINITY, overlay: Number.NEGATIVE_INFINITY };
  const take = (slot, at, value) => {
    if (facts[slot] !== null && at <= newest[slot]) return;
    facts[slot] = value;
    newest[slot] = at;
  };
  // A version per image, so a run that names none on a newer image leaves that image's pi unknown and not an older image's.
  const versions = new Map();
  for (const record of records) {
    const loaded = loadedOf(record);
    if (loaded === null) continue;
    const at = endOf(record);
    // A run on an image its job named cannot show the host's, whichever trigger ran last. The run's own page still names what it used.
    if (loaded.imageFromJob === true) facts.jobImage = true;
    else {
      if (loaded.image !== null) take("image", at, loaded.image);
      const version = loaded.pi ?? loaded.imagePi;
      const known = versions.get(loaded.image);
      if (version !== null && (known === undefined || at > known.at)) versions.set(loaded.image, { version, at });
    }
    if (loaded.runner !== "reported") continue;
    if (!saysWhatLoaded(loaded)) {
      // The run's own page reads one that went on as not recorded, and it did not stop before anything loaded.
      if (!wentOn(record)) facts.stopped += 1;
      continue;
    }
    const kept = loaded.sources.length > 0;
    const overlayRow = sourcesOf(loaded, "overlay")[0];
    if (overlayShutByKind(record, loaded)) facts.shut = true;
    else if (!kept || overlayRow?.names === null || overlayNamesCut(loaded, overlayRow)) facts.cut = true;
    else take("overlay", at, overlayRow?.names ?? []);
    const rows = sourcesOf(loaded, "package");
    if (!showsHostPackages(record, loaded)) facts.withheld = true;
    else if (!kept || rows.some((row) => row.name === null) || (loaded.cut?.packages ?? 0) > 0) facts.cut = true;
    else take("packages", at, rows.map((row) => `${row.name} ${row.version}`));
  }
  facts.pi = versions.get(facts.image)?.version ?? null;
  return facts;
}

/**
 * A host's fact as `hostsAgree` reads a published row. One rule decides "the same", so the unknown host that a run's page must never read as
 * the same is the same unknown host here: a fact no run could show is `unknown`, and the question has no answer. REJECTED: treating such
 * a host as agreeing because nothing differs, which is the guess a host on an older release would make true by saying nothing.
 */
const agreeRow = (list) => ({ state: list !== null ? "current" : "unknown", unread: [], more: {}, overlayExtensionsAllowed: true, extensions: [...(list ?? [])].sort().map((name) => ({ name })), skills: [], mcp: [], packages: [], flows: [] });

/** What one host has that some other host, able to say, does not, in a sentence's words. */
function hostExtras(name, facts, others) {
  const lacking = (part, value) => others.some((other) => other[part] !== null && !other[part].includes(value));
  // Unknown on either side is no difference: only two values that are both known can differ, and each sentence says only what is known.
  const differsOn = (part) => facts[part] !== null && others.some((other) => other[part] !== null && other[part] !== facts[part]);
  const runs = [facts.pi !== null ? `pi ${facts.pi}` : null, facts.image !== null ? `in ${facts.image}` : null].filter(Boolean).join(" ");
  const parts = [
    differsOn("pi") || differsOn("image") ? `runs ${runs}` : null,
    ...[["overlay", " from its overlay"], ["packages", ""]].map(([part, from]) => {
      const extra = (facts[part] ?? []).filter((value) => lacking(part, value));
      return extra.length > 0 ? `also loads ${andList(extra)}${from}` : null;
    }),
  ].filter(Boolean);
  return parts.length > 0 ? `${name} ${parts.join(" and ")}` : null;
}

/** The value and its "how many" for one thing runs share or split: `a in 15, b in 6`. */
function tally(records, read) {
  const counts = new Map();
  for (const record of records) {
    const key = read(record);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * What a project page says of its runs in the last 7 days, from their records and nothing else, grouped by host. `records` is
 * that window, rolling (`project-view.mjs`). REJECTED: this week, the window Members counts in under it, which empties this card
 * every Monday, when a person is most likely to ask what ran over the weekend. `{ state, tone, icon, total, read, top, small,
 * hosts, rows, links, foot }`, `state` being `differs`, `same`, `incomplete` or `none`.
 *
 * WHAT IT CLAIMS. A difference, when two hosts it can read differ by what `hostFacts` finds: that is read, whatever a third host says and
 * however few runs it read, and it says how few under the line. "The same", only when `hostsAgree` says so of every host that ran something,
 * on one host nothing has anything to differ from. Otherwise neither, and it says how little it read and why. Its other lines claim only
 * what the runs able to show a thing showed, which is why a run a trigger or a kind kept from showing it needs no excuse by name.
 */
export function projectLoadsOf(records, { historyIncomplete = false } = {}) {
  const all = Array.isArray(records) ? records.filter((record) => record !== null && typeof record === "object") : [];
  const runs = all.filter((record) => !hasNoAgent(record));
  const agentless = all.length - runs.length;
  const leftOutLine = agentless > 0 ? [`Leaves out ${plural(agentless, "run")} with no agent, which ${agentless === 1 ? "loads" : "load"} nothing.`] : [];
  const total = runs.length;
  const read = runs.filter((record) => notReadWhy(record) === null);
  const unread = runs.filter((record) => notReadWhy(record) !== null);
  const sub = `${plural(total, "run")} in the last 7 days`;
  const buckets = new Map();
  for (const record of unread) {
    const why = notReadWhy(record);
    buckets.set(why, [...(buckets.get(why) ?? []), record]);
  }
  const bucketWords = [...buckets].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([why, list]) => NOT_READ[why].many(list.length));
  const unreadSentence = bucketWords.length > 0 ? `${notReadCount(unread.length)}: ${bucketWords.join(", ")}.` : null;

  if (read.length === 0) {
    const onlyOlder = total === 0 ? agentless === 0 : buckets.size === 1 && buckets.has("older");
    return { state: "none", tone: "idle", icon: "minus", total, read: 0, sub, top: LOADED_WORDS.projectNone, small: [...(onlyOlder ? [LOADED_WORDS.projectNoneWhy] : unreadSentence !== null ? [unreadSentence] : []), ...leftOutLine], rows: [], hosts: [], links: [], foot: null };
  }

  const byHost = new Map();
  for (const record of runs) {
    const name = matched(record.host, WORKER_NAME_RE);
    if (name === null) continue;
    byHost.set(name, [...(byHost.get(name) ?? []), record]);
  }
  const hosts = [...byHost].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, list, facts: hostFacts(list), recorded: list.filter((record) => notReadWhy(record) === null).length }));
  const PARTS = [["pi", (value) => [value]], ["image", (value) => [value]], ["packages", (value) => value], ["overlay", (value) => value]];
  const hostless = runs.filter((record) => matched(record.host, WORKER_NAME_RE) === null).length;
  const asRow = (host, part, list) => agreeRow(host.facts[part] === null ? null : list(host.facts[part]));
  // Any host's reading is a part of "the same", so a bounded history cannot be read as every host's. One host has nothing to differ from.
  const same = !historyIncomplete && hostless === 0 && (hosts.length === 1 || PARTS.every(([part, list]) => hostsAgree(hosts.map((host) => asRow(host, part, list))) === true));
  const differs = PARTS.some(([part, list]) => hostsAgree(hosts.filter((host) => host.facts[part] !== null).map((host) => asRow(host, part, list))) === false);
  const state = differs ? "differs" : read.length * 2 < total ? "incomplete" : same ? "same" : "incomplete";

  const recordedWord = read.length === total ? "every recorded run" : read.length === 1 ? "the 1 recorded run" : `all ${read.length} recorded runs`;
  const imageTally = tally(read, (record) => {
    const loaded = loadedOf(record);
    const version = loaded.pi ?? loaded.imagePi;
    return version !== null || loaded.image !== null ? JSON.stringify([version, loaded.image]) : null;
  });
  const imageValue = (value) => {
    const [version, image] = JSON.parse(value);
    return image !== null ? [`${version !== null ? `pi ${version}` : "pi"} in `, code(image)] : [`pi ${version}`];
  };
  const piRowOf = () => {
    if (imageTally.length === 1) return { icon: "box", label: "pi", value: imageValue(imageTally[0][0]), more: state === "incomplete" ? `the ${read.length} recorded` : recordedWord };
    if (imageTally.length === 0) return { icon: "box", label: "pi", value: "not recorded", more: null };
    return { icon: "box", label: "pi", value: imageTally.flatMap(([value, n], at) => [...(at > 0 ? ["; "] : []), ...imageValue(value), ` in ${n}`]), more: null };
  };
  const models = tally(read, (record) => {
    const facts = factsOf(record);
    return facts.model !== null ? `${facts.provider !== null ? `${facts.provider} / ` : ""}${facts.model}` : null;
  });
  const modelsRow = { icon: "bolt", label: "Models", value: models.length === 0 ? "not recorded" : models.length === 1 ? models[0][0] : models.map(([value, n]) => `${value} in ${n}`).join(", "), more: models.length === 1 ? recordedWord : null };

  // What every host able to show it has, and what only some do, and nothing about runs: a host's facts are its newest runs', so a run from
  // before an update or one that withheld its packages neither holds nor lacks anything here, and none needs saying by name.
  const knownLists = (part) => hosts.map((host) => host.facts[part]).filter((list) => list !== null);
  const intersect = (lists) => (lists.length === 0 ? [] : lists.reduce((kept, list) => kept.filter((name) => list.includes(name))));
  const common = [...intersect(knownLists("packages")), ...intersect(knownLists("overlay"))];
  const anyKnown = knownLists("packages").length + knownLists("overlay").length > 0;
  const nothingAnywhere = [...knownLists("packages"), ...knownLists("overlay")].every((list) => list.length === 0);
  // A kind whose list was cut is no evidence of none: empty lists beside it do not make the row "none".
  const notKept = !anyKnown || (nothingAnywhere && hosts.some(({ facts }) => facts.cut && (facts.packages === null || facts.overlay === null)));
  const someOnly = hosts.flatMap((host) => [...(host.facts.packages ?? []), ...(host.facts.overlay ?? [])].filter((name) => !common.includes(name)).map((name) => `${name} on ${host.name}`));
  const extensionMore = notKept ? "no run here could show them" : [
    `from ${hosts.length === 1 ? "its" : "each host’s"} newest run able to show them`,
    ...(someOnly.length > 0 ? [`, and ${andList(someOnly)}`] : []),
    ...(unread.length > 0 ? [`; ${notReadCount(unread.length)}`] : []),
  ];
  const extensionsRowOf = { icon: "layers", label: "Extensions", value: common.length > 0 ? common.join(", ") : notKept ? "not kept" : nothingAnywhere ? "none" : "none on every host", more: extensionMore };

  const flows = tally(read, (record) => factsOf(record).flow !== null && loadedOf(record).flow !== null ? factsOf(record).flow : null);
  const flowFromOf = (flow) => {
    const record = read.find((candidate) => factsOf(candidate).flow === flow && loadedOf(candidate).flow !== null);
    const found = loadedOf(record).flow;
    if (found.tier === "repository") return `${flow} from ${factsOf(record).repo ?? "a repository"}’s .pi/skills`;
    if (found.tier === "none") return `${flow} found nowhere`;
    if (found.tier === "trigger") return `${flow} from a trigger’s skills folder`;
    if (found.tier === "overlay") return `${flow} from the overlay`;
    if (found.tier === "package") return `${flow} from ${found.package ?? "a staged package"}`;
    return `${flow} from elsewhere`;
  };
  const flowValue = flows.length === 0 ? "none named" : flows.slice(0, FLOWS_SHOWN).flatMap(([flow, n], at) => [...(at > 0 ? [", "] : []), code(flow), ` in ${n}`]);
  const flowsRow = { icon: "skill", label: "Flows", value: flowValue, more: flows.length === 0 ? null : flows.slice(0, FLOWS_SHOWN).map(([flow]) => flowFromOf(flow)).join("; ") };

  const serversOf = new Map();
  for (const record of read) for (const row of loadedOf(record).mcp ?? []) {
    const name = row.name ?? "a server";
    const had = serversOf.get(name) ?? new Map();
    had.set(row.state, (had.get(row.state) ?? 0) + 1);
    serversOf.set(name, had);
  }
  const serverWordsOf = ([name, states]) => `${name} ${[...states].map(([state, n]) => `${state === "connected" ? "connected" : SERVER_STATE_WORDS[state]} in ${n}`).join(", ")}`;
  const mcpRowOf = { icon: "plug", label: "MCP", value: serversOf.size === 0 ? "none" : [...serversOf].map(serverWordsOf).join("; "), more: serversOf.size === 0 ? "no recorded run names a server" : null };

  const noFlow = read.filter((record) => flowMissing(loadedOf(record)));
  const failedExtension = read.filter((record) => failedCountOf(loadedOf(record)) > 0);
  // A failed or timed-out server stops the run (see this file's header), and a page reading only flows and extensions would call that run fine.
  const stoppedByServer = read.filter((record) => {
    const loaded = loadedOf(record);
    return serversIn(loaded, ["failed", "timeout"]).length > 0 || (loaded.mcp === null && isCount(loaded.problems?.mcp) && loaded.problems.mcp > 0);
  });
  const missingParts = [
    noFlow.length > 0 ? `${plural(noFlow.length, "run")} without ${noFlow.length === 1 ? "its flow" : "their flow"}` : null,
    failedExtension.length > 0 ? `${plural(failedExtension.length, "run")} with a failed extension` : null,
    stoppedByServer.length > 0 ? `${plural(stoppedByServer.length, "run")} stopped by an MCP server` : null,
  ].filter(Boolean);
  const missingRuns = [...new Set([...noFlow, ...failedExtension, ...stoppedByServer])].slice(0, 3);
  const missingRow = missingParts.length === 0
    ? { icon: "refused", label: "Missing", value: state === "incomplete" ? `nothing in the ${read.length} recorded` : "nothing", more: state === "incomplete" ? "a run with no record cannot say" : "no record says a run lacked its flow or an extension, or was stopped by an MCP server" }
    : { icon: "refused", label: "Missing", value: andList(missingParts), more: missingRuns.flatMap((record, at) => [...(at > 0 ? [", "] : []), run(runIdOf(record))]) };

  const notReadParts = () => {
    if (unread.length > 3) return `${bucketWords.join(", ")}.`;
    return unread.flatMap((record, at) => [...(at > 0 ? ["; "] : []), ...NOT_READ[notReadWhy(record)].one(runIdOf(record))]);
  };
  const notReadRow = { icon: "minus", label: "Not read", value: `${unread.length} of ${plural(total, "run")}`, more: notReadParts() };

  const table = hosts.map((host) => {
    const newest = host.list[0];
    const overlayNames = host.facts.overlay ?? [];
    const packageNames = host.facts.packages ?? [];
    return {
      name: host.name,
      backend: typeof newest?.backend === "string" ? newest.backend : null,
      runs: host.list.length,
      recorded: host.recorded,
      extensions: host.facts.packages === null && host.facts.overlay === null ? [{ muted: "not recorded" }] : [
        ...(packageNames.length > 0 ? [packageNames.join(", ")] : []),
        ...overlayNames.flatMap((name, at) => [...(packageNames.length > 0 || at > 0 ? [", "] : []), name, { muted: " (overlay)" }]),
        ...(packageNames.length === 0 && overlayNames.length === 0 ? [{ muted: "none" }] : []),
        ...(host.facts.packages === null ? [{ muted: "; its packages not recorded" }] : []),
        ...(host.facts.overlay === null ? [{ muted: "; its overlay not recorded" }] : []),
      ],
      flows: tally(host.list, (record) => (notReadWhy(record) === null && loadedOf(record).flow !== null ? factsOf(record).flow : null)).map(([flow]) => flow),
    };
  });

  const readFrom = `Read from ${read.length} of its ${total} runs in the last 7 days`;
  if (state === "incomplete") {
    // Each way "the same" stays open, so a line that read every run it had still says why it will not say. A host names a cause only for
    // a fact it left unknown: a cut record or a canary beside a run able to show the fact leaves nothing open.
    const hostsWhere = (test) => hosts.filter(({ facts }) => test(facts)).map(({ name }) => name);
    const cutHosts = hostsWhere((facts) => facts.cut && (facts.packages === null || facts.overlay === null));
    const shutHosts = hostsWhere((facts) => facts.shut && facts.overlay === null);
    const withheldHosts = hostsWhere((facts) => facts.withheld && facts.packages === null);
    const jobImageHosts = hostsWhere((facts) => facts.jobImage && facts.image === null);
    const noVersionHosts = hostsWhere((facts) => facts.image !== null && facts.pi === null);
    const noImageHosts = hostsWhere((facts) => facts.pi !== null && facts.image === null);
    const stopped = hosts.filter(({ facts }) => facts.stopped > 0 && facts.packages === null && facts.overlay === null).map(({ name, facts }, at) => `${at === 0 ? plural(facts.stopped, "run") : facts.stopped} on ${name}`);
    const small = [
      unreadSentence,
      historyIncomplete ? "The run history could not be read completely." : null,
      hostless > 0 ? `${hostless === 1 ? "1 run names" : `${hostless} runs name`} no host, so ${hostless === 1 ? "it" : "they"} cannot be compared.` : null,
      cutHosts.length > 0 ? `The records of ${andList(cutHosts)} were cut to fit, so they keep no whole list to compare.` : null,
      stopped.length > 0 ? `${andList(stopped)} stopped before anything loaded.` : null,
      shutHosts.length > 0 ? `The runs on ${andList(shutHosts)} had the overlay shut, as a model canary and a restricted run do, so they say nothing of its extensions.` : null,
      withheldHosts.length > 0 ? `The runs on ${andList(withheldHosts)} withheld the staged packages or were canaries, so they say nothing of them.` : null,
      jobImageHosts.length > 0 ? `Every run on ${andList(jobImageHosts)} used an image its job named, so none says what pi or image the host runs otherwise.` : null,
      noVersionHosts.length > 0 ? `No run on ${andList(noVersionHosts)} says which pi it ran.` : null,
      noImageHosts.length > 0 ? `No run on ${andList(noImageHosts)} says which image it ran in.` : null,
      ...leftOutLine,
    ].filter(Boolean);
    return { state, tone: "attention", icon: "attention", total, read: read.length, sub, top: `${readFrom}, so runs may differ in ways this does not show.`, small, rows: [piRowOf(), extensionsRowOf, missingRow], hosts: [], links: [], foot: null };
  }
  if (state === "same") {
    const names = hosts.map(({ name }) => name);
    const top = names.length === 1 ? `All its recorded runs ran on one host: ${names[0]}.` : `Runs load the same on each host: ${andList(names)}.`;
    // Green is for nothing to do: hosts that agree on what stopped every run still have every run stopped.
    const missing = missingParts.length > 0;
    return { state, tone: missing ? "attention" : "ok", icon: missing ? "attention" : "done", total, read: read.length, sub, top, small: leftOutLine, rows: [piRowOf(), extensionsRowOf, ...(stoppedByServer.length > 0 ? [mcpRowOf] : []), ...(missing ? [missingRow] : []), ...(unread.length > 0 ? [notReadRow] : [])], hosts: [], links: [], foot: names.length > 1 ? LOADED_WORDS.projectCompared : null };
  }
  const extras = hosts.map(({ name, facts }) => ({ name, said: hostExtras(name, facts, hosts.filter((other) => other.name !== name).map((other) => other.facts)) })).filter(({ said }) => said !== null);
  const top = `Runs differ by host: ${extras.map(({ said }) => said).join("; ")}.`;
  return { state, tone: "attention", icon: "attention", total, read: read.length, sub, top, small: [...(read.length * 2 < total ? [`${readFrom}, so they may differ in other ways too.`] : []), ...leftOutLine], rows: [piRowOf(), modelsRow, extensionsRowOf, flowsRow, mcpRowOf, missingRow, ...(unread.length > 0 ? [notReadRow] : [])], hosts: table, links: extras.map(({ name }) => hostFix(name)), foot: LOADED_WORDS.projectFoot };
}
