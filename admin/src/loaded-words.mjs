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
 *   - Whether a run went on. A flow found nowhere or an extension that failed still runs, but only if the run got that far:
 *     a run stopped before the agent started did not go on without anything. So "ran" and "went on" are said only at `ready`
 *     with no server having stopped it, and otherwise it says what was found and failed, and nothing of what happened next.
 *   - A failed MCP server stops the run (`mcp.mjs` `start`: `mcp-unavailable`, exit 2, or `mcp-unreachable`, exit 1), so it is
 *     never a completed run's note and no line says the run went on.
 *   - `leftOut.overlayExtensions` is this job's switch, and not the host's: a host's PI_GLOBAL_ALLOW_EXTENSIONS=0 closes it
 *     and so does a canary's replay, which closes over it. So no line says it was the host that asked. And an overlay file
 *     can load beside it being off: a repository's `pi.extensions` manifest can name one. Both are true at once, so both are
 *     said and neither corrects the other.
 */
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
  running: "Shown when it ends, from its record.",
  ranWithoutFlow: "Ran without its flow.",
  flowNowhere: "Its flow was found nowhere.",
  mcpStopped: "The run stopped before the agent started.",
  mcpStoppedLoaded: "The run stopped before the agent started, after its extensions and skills had loaded.",
  notRetried: "Not retried: the next attempt would find it the same.",
  retried: "Retried, as any infrastructure failure.",
  retriedLast: "Retried, as any infrastructure failure; this was its last attempt.",
  readFirst: "Read what it did before you trust it.",
  imageId: "The image id on this host; two local builds of one tag differ, so it never counts as a host difference.",
  failedRow: "to load, in any tier; a path and its kind stay in the job’s log",
  droppedRow: "by the recursion guard, per tier; names stay in the job’s log",
  noRepositoryNames: "a record keeps no names from a repository.",
  sandboxFoot: "Nothing loads until you start pi in the shell.",
  freshFoot: "A fresh sandbox has no run to quote, so it says what a job would load there, from the host’s last doctor run, or unknown. The repository’s part is decided at its base commit.",
  projectTitle: "What its runs load",
  projectFoot: "From the records of its runs in the last 7 days. The overlay and staged packages are each host’s own, so runs of one project can load different things on different hosts.",
  projectNone: "Nothing to read: no run of this project has a record in the last 7 days.",
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
  return { forge, repo, index, host: matched(r.host, WORKER_NAME_RE), flow: matched(r.flow, SKILL_NAME_RE), provider, model, subject: index !== null ? `trigger ${index + 1}` : "this run", calls: isCount(r.tokens?.calls) ? r.tokens.calls : null };
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
const triggerFix = (index) => (index === null ? null : { kind: "trigger", label: `Open trigger ${index + 1}`, icon: "config", href: `/config/trigger?index=${index}` });
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
const noFlowFixes = (loaded, facts) => fixesOf(triggerFix(facts.index), repositoryFix(facts, loaded.baseSha));

// ---- the record ------------------------------------------------------------------------------------------------------

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
    const kept = recordedLoaded(raw);
    return kept === null || kept.mcp?.some((row) => row.state === "disabled") ? recordedLoaded({ v: 1, runner: "invalid" }) : kept;
  } catch {
    return recordedLoaded({ v: 1, runner: "invalid" });
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
  if (source.tier === "trigger") return { whose: "the skills folder’s", from: "the skills folder", fix: triggerFix(facts.index) };
  return { whose: "this run’s", from: "elsewhere", fix: null };
}

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
    const named = rows.map((source) => `${source.failed} from ${failedTierOf(source, facts).from}`);
    return { bold: `${failed} of this run’s extensions failed to load.`, rest: joined(`${andList(named)}.`, wentOn), fixes: fixesOf(...rows.map((source) => failedTierOf(source, facts, loaded.baseSha).fix)), banner: failedBannerWords(failed, false) };
  }
  const [source] = rows;
  const { whose, from, fix } = failedTierOf(source, facts, loaded.baseSha);
  const names = source.tier === "overlay" && Array.isArray(source.failedNames) && source.failedNames.length > 0 ? `${andList(source.failedNames)}.` : "";
  const banner = failedBannerWords(source.failed, source.extensions === 0);
  const fixes = fixesOf(fix);
  if (source.extensions > 0) return { bold: `${source.failed} of ${whose} extensions failed to load.`, rest: joined(wentOn, names), fixes, banner };
  const bold = source.failed === 1 ? `The extension from ${from} failed to load.` : `All ${source.failed} extensions from ${from} failed to load.`;
  return { bold, rest: joined(ran ? `The run went on without ${source.failed === 1 ? "it" : "them"}.` : "", names), fixes, banner };
}

/** The servers in one state, by name, or a fixed word for a row the worker could not name. */
const serversIn = (loaded, states) => (loaded.mcp ?? []).filter((row) => states.includes(row.state)).map((row) => row.name ?? "a server");

/** The MCP line of a run a server stopped, or null. By the record's rows, or its minimal form's count and the run's reason. */
function mcpStopLine(loaded, record, { jobEnded }) {
  const failed = serversIn(loaded, ["failed"]);
  const timedOut = serversIn(loaded, ["timeout"]);
  const uncounted = loaded.mcp === null && isCount(loaded.problems?.mcp) && loaded.problems.mcp > 0;
  if (failed.length === 0 && timedOut.length === 0 && !uncounted) return null;
  const retried = jobEnded ? LOADED_WORDS.retriedLast : LOADED_WORDS.retried;
  // A record's minimal form keeps how many and not which way. The run's outcome says: only the wait running out is retried.
  if ((timedOut.length > 0 && failed.length === 0) || (uncounted && record?.outcome === "failed")) {
    const who = timedOut.length > 0 ? andList(timedOut) : plural(loaded.problems.mcp, "MCP server");
    return { state: "mcp-stopped", tone: "failed", icon: "failed", bold: `${who} did not answer in time.`, rest: LOADED_WORDS.mcpStopped, small: [retried], short: "An MCP server did not answer", fixes: [CONNECTIONS_FIX] };
  }
  const who = failed.length > 0 ? andList(failed) : plural(loaded.problems.mcp, "MCP server");
  return { state: "mcp-failed", tone: "refused", icon: "refused", bold: `${who} could not be used.`, rest: saysWhatLoaded(loaded) ? LOADED_WORDS.mcpStoppedLoaded : LOADED_WORDS.mcpStopped, small: [LOADED_WORDS.notRetried], short: "An MCP server could not be used", fixes: [CONNECTIONS_FIX] };
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
  return parts.length > 0 ? [`Cut to fit: this record leaves out ${andList(parts)}.`] : [];
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

const verdict = (fields, record = null) => ({ tone: "idle", icon: "minus", lead: null, bold: null, rest: null, then: [], small: [], short: null, outcome: outcomeNote(record), fixes: [], also: [], ...fields });

/**
 * The top line of a run's Loaded card. `{ state, tone, icon, lead, bold, rest, then, small, short, outcome, fixes, also }`:
 * the line reads `lead`, then `bold`, then `rest`, then each of `then`; `small` goes under it; `fixes` are the ways to where it is
 * fixed, in order; `also` holds any further problem, each with its own `fixes`; `outcome` is `outcomeNote`. `hostLoads` is what the hosts published
 * (`readHostLoadsView`), and a missing or failed read is no line at all, never "the same". `jobEnded` is whether the queue
 * says the job is over, which the record alone cannot: an infra failure writes a record per attempt.
 */
export function loadedVerdict(record, hostLoads = null, { jobEnded = false } = {}) {
  if (record === null || typeof record !== "object") return null;
  const facts = factsOf(record);
  const loaded = loadedOf(record);
  if (endedBeforeContainer(record, loaded) && (loaded === null || loaded.runner === "absent")) return verdict({ state: "refused", rest: isCancel(record) ? LOADED_WORDS.cancelled : LOADED_WORDS.refused, short: "Nothing loaded" }, record);
  if (loaded === null) {
    // A run that failed, or a cancel that holds its reservation, with no exit code may be this release's, whose worker stopped before any container: not an older release's for certain.
    const unknown = hasNoExit(record) && ["failed", "policy"].includes(record.outcome);
    return verdict({ state: "not-recorded", rest: unknown ? LOADED_WORDS.notRecordedUnknown : LOADED_WORDS.notRecorded, short: "Not recorded" }, record);
  }
  if (loaded.runner === "absent") return verdict({ state: "absent", rest: LOADED_WORDS.absent, short: "Not recorded" }, record);
  if (loaded.runner === "invalid") return verdict({ state: "invalid", tone: "attention", icon: "attention", rest: LOADED_WORDS.invalid, short: "Could not be read" }, record);
  if (loaded.runner === "cut") return verdict({ state: "cut", rest: LOADED_WORDS.noRoom, short: "Cut to fit" }, record);
  if (loaded.at === "none") return verdict({ state: "no-agent", rest: LOADED_WORDS.noAgent, short: "Nothing to load" }, record);
  if (loaded.at === "start") return verdict({ state: "stopped", rest: LOADED_WORDS.stoppedStart, short: "Stopped before loading" }, record);

  const small = cutWords(loaded);
  const problems = [];
  const stop = mcpStopLine(loaded, record, { jobEnded });
  if (stop !== null) problems.push(stop);
  const ran = loaded.at === "ready" && stop === null;
  if (flowMissing(loaded)) problems.push({ state: "no-flow", tone: "attention", icon: "attention", bold: ran ? LOADED_WORDS.ranWithoutFlow : LOADED_WORDS.flowNowhere, rest: noFlowSentence(loaded, facts), short: ran ? "Ran without its flow" : "Its flow found nowhere", fixes: noFlowFixes(loaded, facts) });
  if (failedCountOf(loaded) > 0) {
    const line = failedLine(loaded, facts, ran);
    problems.push({ state: "extension-failed", tone: "failed", icon: "failed", bold: line.bold, rest: line.rest, short: `${plural(failedCountOf(loaded), "extension")} failed`, fixes: line.fixes });
  }
  if (problems.length > 0) {
    const [first, ...others] = problems;
    return verdict({ ...first, small: [...(first.small ?? []), ...small], also: others.map(({ tone, icon, bold, rest, fixes }) => ({ tone, icon, bold, rest, fixes })) }, record);
  }
  if (loaded.at === "loader") return verdict({ state: "stopped", rest: LOADED_WORDS.stoppedLoader, small, short: "Stopped while loading" }, record);
  // A `-shadowed` refusal comes before the servers start (run-job.mjs), and their rows read `pending` all the same.
  if (serversIn(loaded, ["pending"]).length > 0) return verdict({ state: "stopped", rest: /-shadowed$/.test(record.reason ?? "") ? LOADED_WORDS.stoppedBeforeServers : LOADED_WORDS.stoppedServers, small, short: "Stopped while connecting" }, record);

  const connected = (loaded.mcp ?? []).filter((row) => row.state === "connected");
  const servers = connected.length > 0 ? [`MCP: ${andList(connected.map((row) => `${row.name ?? "a server"} connected, with ${plural(row.tools, "tool")}`))}.`] : [];
  const left = leftOutLines(loaded);
  const difference = hostDifference(record, loaded, facts, hostLoads);
  if (difference !== null) {
    const line = hostDifferenceLine(difference, facts);
    return verdict({ state: "host-differs", tone: "attention", icon: "info", bold: line.bold, rest: line.rest, then: left, small: [...servers, ...small], short: "Differs from another host", fixes: fixesOf(hostFix(facts.host)) }, record);
  }
  const lead = `Everything ${facts.subject} asks for loaded.`;
  const [first, ...rest] = left;
  if (first !== undefined) return verdict({ state: "left-out", tone: "ok", icon: "done", lead, bold: first.bold, rest: first.rest, then: rest, small: [...servers, ...small], short: "Everything loaded, some left out" }, record);
  return verdict({ state: "everything", tone: "ok", icon: "done", rest: lead, small: [...servers, ...small], short: "Everything loaded" }, record);
}

/** The line of a run with no record yet: a record is written from the exit line, and a live one would need a second trusted line. */
export function runningVerdict(triggerIndex = null) {
  const index = Number.isSafeInteger(triggerIndex) && triggerIndex >= 0 ? triggerIndex : null;
  return verdict({ state: "running", rest: index !== null ? `${LOADED_WORDS.running} Trigger ${index + 1} says what it asks for.` : LOADED_WORDS.running, short: "Shown when it ends", fixes: fixesOf(triggerFix(index)) });
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
const serverWords = (row) => `${row.name ?? "a server"} ${row.state === "connected" ? `connected, with ${plural(row.tools, "tool")}` : SERVER_STATE_WORDS[row.state]}`;

function mcpRow(loaded, facts) {
  const row = (value, more = null) => ({ icon: "plug", label: "MCP", value, more });
  if (loaded.mcp === null) {
    if (isCount(loaded.problems?.mcp) && loaded.problems.mcp > 0) return row(`${plural(loaded.problems.mcp, "server")} could not be used`, "this record was cut to fit");
    return row("not kept", loaded.at === "loader" ? "the run stopped before its servers started" : "this record was cut to fit");
  }
  const left = loaded.cut?.servers > 0 ? `and ${plural(loaded.cut.servers, "more server")} past this record’s bound` : null;
  if (loaded.mcp.length === 0) return row("none", left ?? `${facts.subject} names no server`);
  return row(loaded.mcp.map(serverWords).join("; "), left);
}

function toolsRow(loaded) {
  const row = (value, more = null) => ({ icon: "flows", label: "Tools", value, more });
  if (loaded.tools === null) return row("not kept", loaded.at === "loader" ? "the run stopped before its tools were ready" : "this record was cut to fit");
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
  return [piRow(loaded, facts), modelRow(facts), extensionsRow(loaded, facts), skillsRow(loaded, facts), mcpRow(loaded, facts), toolsRow(loaded)];
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
  for (const row of failedRows) add("Extension failed", String(row.failed), "", `${failedTierOf(row, facts).from}; a path and its kind stay in the job’s log`);
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
  for (const server of loaded.mcp ?? []) add("MCP server", code(server.name ?? "a server"), "", server.state === "connected" ? `connected, with ${plural(server.tools, "tool")}` : SERVER_STATE_WORDS[server.state]);
  if (Array.isArray(loaded.tools?.own) && loaded.tools.own.length > 0) add("Tools", loaded.tools.own.join(", "), "", "pi");
  for (const row of sourcesOf(loaded, "package")) if (row.toolNames?.length > 0) add("Tools", row.toolNames.join(", "), "", row.name ?? "a staged package");
  for (const row of overlay?.namedTools ?? []) add("Tools", row.tools.join(", "), "", `${row.name}, ${host}’s overlay`);
  const repositoryTools = sourcesOf(loaded, "repository")[0]?.tools ?? 0;
  if (repositoryTools > 0) add("Tools", String(repositoryTools), "", `the repository’s extensions; ${LOADED_WORDS.noRepositoryNames}`);
  for (const name of loaded.tools?.job ?? []) add("Tools", code(name), "", name === "report_progress" ? `the job’s own, because ${facts.subject} sets run.progress` : "the job’s own");
  for (const name of loaded.leftOut?.tools ?? []) add("Left out", code(name), "", `${facts.subject}’s run.excludeTools`);
  if (loaded.leftOut?.packages) add("Left out", "the staged packages", "", `${facts.subject}’s run.packages false`);
  if (loaded.leftOut?.restricted) add("Left out", "the overlay’s extensions", "", "this kind of run");
  else if (loaded.leftOut?.overlayExtensions) add("Left out", "the overlay’s extensions", "", "this job’s overlay switch: off on its host (PI_GLOBAL_ALLOW_EXTENSIONS=0), or for a canary’s replay");
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
  return null;
}

/** How many runs of a project it could not read, in the one sentence every state says it in. */
const notReadCount = (n) => `${n} did not load or ${n === 1 ? "was" : "were"} not recorded`;

/** How many flows the project's line names: a project's triggers are few, and the page keeps its one line. */
const FLOWS_SHOWN = 8;

/** A run's id as a run link can hold it, or nothing: a list drawn from records the worker wrote, held once more. */
const runIdOf = (record) => (typeof record?.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(record.jobId) ? record.jobId : "a run");

/**
 * Whether a run's overlay was this job's to shut, whatever its host's overlay holds: a canary always replays with it shut
 * (`canary-runtime.mjs`), and a restricted run is forced shut. A host's own `PI_GLOBAL_ALLOW_EXTENSIONS=0` is not here: that one is
 * the host's, so it is a difference between hosts.
 */
const overlayShutByKind = (record, loaded) => Boolean(record?.packageCanary) || loaded?.leftOut?.restricted === true;

/** What one host's runs let a project page compare: names, each spelt once, with where they came from. */
function hostFacts(records) {
  const facts = { images: new Set(), packages: new Set(), overlay: new Set(), packagesSeen: false, overlaySeen: false, nameless: false, comparable: 0 };
  for (const record of records) {
    const loaded = loadedOf(record);
    if (loaded === null || loaded.runner !== "reported" || !saysWhatLoaded(loaded)) continue;
    if (loaded.sources.length === 0) { facts.nameless = true; continue; }
    facts.comparable += 1;
    const version = loaded.pi ?? loaded.imagePi;
    if (version !== null || loaded.image !== null) facts.images.add(JSON.stringify([version, loaded.image]));
    if (!overlayShutByKind(record, loaded)) {
      facts.overlaySeen = true;
      for (const name of sourcesOf(loaded, "overlay")[0]?.names ?? []) facts.overlay.add(name);
      if (sourcesOf(loaded, "overlay")[0]?.names === null) facts.nameless = true;
    }
    // A trigger that withholds them, and a canary trying a candidate, each differ on purpose, so neither speaks for the host.
    if (loaded.leftOut?.packages === true || record?.packageCanary) continue;
    facts.packagesSeen = true;
    const rows = sourcesOf(loaded, "package");
    if (rows.some((row) => row.name === null)) facts.nameless = true;
    for (const row of rows) if (row.name !== null) facts.packages.add(`${row.name} ${row.version}`);
  }
  return facts;
}

/**
 * A host's facts as `hostsAgree` reads a published row. One rule decides "the same", so the unknown host that a run's page
 * must never read as the same is the same unknown host here: a host with no record that says what it loaded, or one whose
 * records were cut past their names, is `unknown` and the question has no answer. REJECTED: treating such a host as agreeing
 * because nothing differs, which is the guess a host on an older release would make true by saying nothing. `flows` stay
 * out: a flow is the repository's and the trigger's, so two hosts serving different repositories differ there for no
 * reason a host could fix. The image id stays out too: two local builds of one tag differ. `speaks` is whether this host's
 * runs say anything of the part compared, so a host whose only runs had the overlay shut leaves the overlay's answer open.
 */
function agreeRow(facts, list, speaks = true) {
  const known = speaks && facts.comparable > 0 && !facts.nameless;
  return { state: known ? "current" : "unknown", unread: [], more: {}, overlayExtensionsAllowed: true, extensions: [...list].sort().map((name) => ({ name })), skills: [], mcp: [], packages: [], flows: [] };
}

/** What one host has that some other known host does not, in a sentence's words. */
function hostExtras(name, facts, others) {
  const overlay = [...facts.overlay].filter((value) => others.some((other) => other.overlaySeen && !other.overlay.has(value)));
  const packages = facts.packagesSeen ? [...facts.packages].filter((value) => others.some((other) => other.packagesSeen && !other.packages.has(value))) : [];
  const images = [...facts.images].filter((value) => others.some((other) => !other.images.has(value))).map((value) => {
    const [version, image] = JSON.parse(value);
    return `runs ${version !== null ? `pi ${version}` : "pi"}${image !== null ? ` in ${image}` : ""}`;
  });
  const parts = [
    ...images,
    overlay.length > 0 ? `also loads ${andList(overlay)} from its overlay` : null,
    packages.length > 0 ? `also loads ${andList(packages)}` : null,
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
 * WHAT IT CLAIMS. A difference, when two hosts it can read differ: that is read, whatever a third host says and however few runs
 * it read, and it says how few under the line. "The same", only when `hostsAgree` says so of every host that ran something.
 * Otherwise neither, and it says how little it read and why.
 */
export function projectLoadsOf(records, { historyIncomplete = false } = {}) {
  const runs = Array.isArray(records) ? records.filter((record) => record !== null && typeof record === "object") : [];
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
    const onlyOlder = total === 0 || (buckets.size === 1 && buckets.has("older"));
    return { state: "none", tone: "idle", icon: "minus", total, read: 0, sub, top: LOADED_WORDS.projectNone, small: onlyOlder ? [LOADED_WORDS.projectNoneWhy] : [unreadSentence], rows: [], hosts: [], links: [], foot: null };
  }

  const byHost = new Map();
  for (const record of runs) {
    const name = matched(record.host, WORKER_NAME_RE);
    if (name === null) continue;
    byHost.set(name, [...(byHost.get(name) ?? []), record]);
  }
  const hosts = [...byHost].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, list, facts: hostFacts(list), recorded: list.filter((record) => notReadWhy(record) === null).length }));
  const imageList = (facts) => [...facts.images].map((value) => `image:${value}`);
  const overlayList = (facts) => [...facts.overlay].map((name) => `overlay:${name}`);
  const packageList = (facts) => [...facts.packages].map((name) => `package:${name}`);
  const known = hosts.filter(({ facts }) => facts.comparable > 0 && !facts.nameless);
  const withPackages = hosts.filter(({ facts }) => facts.packagesSeen || facts.comparable === 0 || facts.nameless);
  const agree = (list, of, speaks) => (list.length === 0 ? null : hostsAgree(list.map(({ facts }) => agreeRow(facts, of(facts), speaks?.(facts)))));
  const baseAll = agree(hosts, imageList);
  // One host has nothing to differ from, so what its runs left unsaid is no open question.
  const overlayAll = hosts.length === 1 ? baseAll : agree(hosts, overlayList, (facts) => facts.overlaySeen);
  const packagesAll = withPackages.length === 0 ? true : agree(withPackages, packageList);
  const baseKnown = agree(known, imageList);
  const overlayKnown = agree(known.filter(({ facts }) => facts.overlaySeen), overlayList);
  const packagesKnown = agree(known.filter(({ facts }) => facts.packagesSeen), packageList);
  const hostless = runs.filter((record) => matched(record.host, WORKER_NAME_RE) === null).length;
  // Any host's reading is a part of "the same", so a bounded history cannot be read as every host's.
  const same = !historyIncomplete && baseAll === true && overlayAll === true && packagesAll === true && hostless === 0;
  const differs = baseKnown === false || overlayKnown === false || packagesKnown === false;
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

  // What every comparable run loaded, and what only some did. A trigger's withheld packages and a canary's candidate are
  // said as such, by name, so a chosen difference never reads as a host's.
  const comparable = read.filter((record) => {
    const loaded = loadedOf(record);
    return saysWhatLoaded(loaded) && loaded.sources.length > 0;
  });
  const showsPackages = comparable.filter((record) => loadedOf(record).leftOut?.packages !== true && !record.packageCanary);
  const showsOverlay = comparable.filter((record) => !overlayShutByKind(record, loadedOf(record)));
  const namesOf = (record) => sourcesOf(loadedOf(record), "package").filter((row) => row.name !== null).map((row) => `${row.name} ${row.version}`);
  const overlayOf = (record) => sourcesOf(loadedOf(record), "overlay")[0]?.names ?? [];
  const intersect = (lists) => (lists.length === 0 ? [] : lists.reduce((kept, list) => kept.filter((name) => list.includes(name))));
  const commonPackages = intersect(showsPackages.map(namesOf));
  const commonOverlay = intersect(showsOverlay.map(overlayOf));
  const common = [...commonPackages, ...commonOverlay];
  const someOnly = [];
  for (const host of hosts) {
    const here = comparable.filter((record) => record.host === host.name);
    const extra = [...host.facts.packages, ...host.facts.overlay].filter((name) => !common.includes(name));
    for (const name of extra) {
      const count = here.filter((record) => namesOf(record).includes(name) || overlayOf(record).includes(name)).length;
      if (count > 0) someOnly.push(`${name} in the ${count} recorded on ${host.name}`);
    }
  }
  const withheld = [...new Set(comparable.filter((record) => loadedOf(record).leftOut?.packages === true).map((record) => factsOf(record).index).filter((index) => index !== null))].sort((a, b) => a - b);
  const canaries = comparable.filter((record) => record.packageCanary && typeof record.packageCanary.name === "string" && typeof record.packageCanary.version === "string");
  const restricted = commonOverlay.length > 0 ? comparable.filter((record) => !record.packageCanary && loadedOf(record).leftOut?.restricted === true).length : 0;
  const excuses = [
    withheld.length > 0 ? `${andList(withheld.map((index) => `trigger ${index + 1}’s`))}, which withhold them` : null,
    ...canaries.slice(0, 3).map((record) => ["the canary ", run(runIdOf(record)), `, which tried ${record.packageCanary.name} ${record.packageCanary.version}`]),
    restricted > 0 ? `${plural(restricted, "run")} of a kind that leaves out the overlay’s extensions` : null,
  ].filter(Boolean);
  const extensionMore = () => {
    const parts = [];
    if (state === "incomplete") parts.push(total > read.length ? `the ${read.length} recorded; unknown for the other ${total - read.length}` : `the ${read.length} recorded`);
    else {
      parts.push(recordedWord);
      if (someOnly.length > 0) parts.push(`, and ${andList(someOnly)}`);
      if (excuses.length > 0) {
        parts.push(", but for ");
        excuses.forEach((excuse, at) => {
          if (at > 0) parts.push(", and ");
          parts.push(...(Array.isArray(excuse) ? excuse : [excuse]));
        });
      }
      if (unread.length > 0) parts.push(`; ${notReadCount(unread.length)}`);
    }
    return parts;
  };
  const extensionsRowOf = { icon: "layers", label: "Extensions", value: common.length > 0 ? common.join(", ") : comparable.length > 0 ? "none in every run" : "not kept", more: extensionMore() };

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
    ? { icon: "refused", label: "Missing", value: state === "incomplete" ? `nothing in the ${read.length} recorded` : "nothing", more: state === "incomplete" ? "a run with no record cannot say" : "every recorded run found its flow and loaded every extension, and no MCP server stopped one" }
    : { icon: "refused", label: "Missing", value: andList(missingParts), more: missingRuns.flatMap((record, at) => [...(at > 0 ? [", "] : []), run(runIdOf(record))]) };

  const notReadParts = () => {
    if (unread.length > 3) return `${bucketWords.join(", ")}.`;
    return unread.flatMap((record, at) => [...(at > 0 ? ["; "] : []), ...NOT_READ[notReadWhy(record)].one(runIdOf(record))]);
  };
  const notReadRow = { icon: "minus", label: "Not read", value: `${unread.length} of ${plural(total, "run")}`, more: notReadParts() };

  const table = hosts.map((host) => {
    const newest = host.list[0];
    const here = comparable.filter((record) => record.host === host.name);
    const overlayNames = [...host.facts.overlay];
    const packageNames = [...host.facts.packages];
    return {
      name: host.name,
      backend: typeof newest?.backend === "string" ? newest.backend : null,
      runs: host.list.length,
      recorded: host.recorded,
      extensions: here.length === 0 ? [{ muted: "not recorded" }] : [
        ...(packageNames.length > 0 ? [packageNames.join(", ")] : []),
        ...overlayNames.flatMap((name, at) => [...(packageNames.length > 0 || at > 0 ? [", "] : []), name, { muted: " (overlay)" }]),
        ...(packageNames.length === 0 && overlayNames.length === 0 ? [{ muted: "none" }] : []),
      ],
      flows: tally(host.list, (record) => (notReadWhy(record) === null && loadedOf(record).flow !== null ? factsOf(record).flow : null)).map(([flow]) => flow),
    };
  });

  const readFrom = `Read from ${read.length} of its ${total} runs in the last 7 days`;
  if (state === "incomplete") {
    // Each way "the same" stays open, so a line that read every run it had still says why it will not say.
    const cutHosts = hosts.filter(({ facts }) => facts.nameless).map(({ name }) => name);
    const silentHosts = hosts.filter(({ facts, recorded }) => recorded > 0 && facts.comparable === 0 && !facts.nameless).map(({ name }) => name);
    const shutHosts = hosts.length > 1 ? hosts.filter(({ facts }) => facts.comparable > 0 && !facts.nameless && !facts.overlaySeen).map(({ name }) => name) : [];
    const small = [
      unreadSentence,
      historyIncomplete ? "The run history could not be read completely." : null,
      hostless > 0 ? `${hostless === 1 ? "1 run names" : `${hostless} runs name`} no host, so ${hostless === 1 ? "it" : "they"} cannot be compared.` : null,
      cutHosts.length > 0 ? `The records of ${andList(cutHosts)} were cut to fit and keep no names to compare.` : null,
      silentHosts.length > 0 ? `The runs on ${andList(silentHosts)} stopped before anything loaded.` : null,
      shutHosts.length > 0 ? `The runs on ${andList(shutHosts)} had the overlay shut, as canaries and restricted runs do, so they say nothing of its extensions.` : null,
    ].filter(Boolean);
    return { state, tone: "attention", icon: "attention", total, read: read.length, sub, top: `${readFrom}, so runs may differ in ways this does not show.`, small, rows: [piRowOf(), extensionsRowOf, missingRow], hosts: [], links: [], foot: null };
  }
  if (state === "same") {
    const names = hosts.map(({ name }) => name);
    const top = names.length === 1 ? `All its recorded runs ran on one host: ${names[0]}.` : `Runs load the same on each host: ${andList(names)}.`;
    // Green is for nothing to do: hosts that agree on what stopped every run still have every run stopped.
    const missing = missingParts.length > 0;
    return { state, tone: missing ? "attention" : "ok", icon: missing ? "attention" : "done", total, read: read.length, sub, top, small: [], rows: [piRowOf(), extensionsRowOf, ...(stoppedByServer.length > 0 ? [mcpRowOf] : []), ...(missing ? [missingRow] : []), ...(unread.length > 0 ? [notReadRow] : [])], hosts: [], links: [], foot: null };
  }
  const extras = known.map(({ name, facts }) => ({ name, said: hostExtras(name, facts, known.filter((other) => other.name !== name).map((other) => other.facts)) })).filter(({ said }) => said !== null);
  const top = `Runs differ by host: ${extras.map(({ said }) => said).join("; ")}.`;
  return { state, tone: "attention", icon: "attention", total, read: read.length, sub, top, small: read.length * 2 < total ? [`${readFrom}, so they may differ in other ways too.`] : [], rows: [piRowOf(), modelsRow, extensionsRowOf, flowsRow, mcpRowOf, missingRow, ...(unread.length > 0 ? [notReadRow] : [])], hosts: table, links: extras.map(({ name }) => hostFix(name)), foot: LOADED_WORDS.projectFoot };
}
