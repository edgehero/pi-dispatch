/**
 * `GET /api/run` (issue #647, INT-CONSOLE-STATE-API): one run, looked up by its id or by its issue, pull request or merge
 * request URL, with the chat it can have now (`chatModeOf`, the one rule `pi-dispatch chat`, this route and the run
 * page's Chat panel share). The terminal chat asks it which mode to open, and polls it every few seconds for the live
 * view's status line.
 *
 * NO TEXT, SO EVERY ROLE (REQ-CONSOLE-SECURITY clause l). The answer is built field by field from closed vocabularies,
 * charset-checked ids, integers and booleans: never a record's free text (`why`, a failure reason), never a Job's
 * `.data`, never a transcript entry, never a session key (the key names a directory of UNREDACTED transcript, and a
 * host-local fork re-derives it on its own host, `sessionKeyOfRecord`). A viewer gets the same shape as an operator,
 * which is why the route is a viewer's: there is nothing in it to withhold. `says` is one of `chatModeOf`'s fixed
 * sentences.
 *
 * `?url=` RESOLVES THROUGH `forgeTargetOf`, the inverse of the link the console draws (`forgeLinkOf`), then through the
 * run history: the newest run on that target is the run. An Azure work item's URL names no repository, so its target is
 * whichever runs' records say; several repositories is a 409 with the candidates, never a guess. "The same target" is
 * `targetKeyOf`'s: a repository path compared case-insensitively and a number without leading zeros, as the forges
 * look them up. A running job has no
 * record until it ends, so a URL whose only run is still running is a 404 that says to give the run's id.
 *
 * EVERY READ IS THE FLEET READER'S, injected (`pageDeps.fleet`), and none of them throws; a queue that cannot be read is
 * a 503 with a fixed sentence (the mode would otherwise be judged on half the facts, and a wrong mode is worse than
 * none).
 */
import { LIVE_OUTCOMES } from "@edgehero/pi-dispatch/live-transcript";
import { RUN_KINDS } from "@edgehero/pi-dispatch/forges";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { recordedProgress } from "@edgehero/pi-dispatch/run-history";
import { chatModeOf, pendingFactsOf, runStateOf } from "@edgehero/pi-dispatch/chat-mode";
import { repoOfTarget } from "../costs.mjs";
import { activeProgressOf, FORGE_URL_MAX, forgeLinkOf, forgeTargetOf, isProgressSnapshot, recordRecovery, RUNS_PAGE_EXAMINE_MAX, targetKeyOf } from "../read-model.mjs";
import { RUN_MODEL_RE, RUN_PROVIDER_RE } from "../run-filter.mjs";
import { RUN_ID_RE } from "./panels.mjs";

/** The document's version: a client checks it before it reads a field, and a breaking change bumps it. */
export const RUN_API_VERSION = 1;

/**
 * How many runs on one target the URL lookup and the newer-run search take: one runs page, newest first, counted AFTER
 * the exact-target match (`targetKeyOf`), over at most `RUNS_PAGE_EXAMINE_MAX` records of the kind.
 */
export const TARGET_RUNS_MAX = 100;

/** How long the run page's live loop reuses a parked record's newer-run search (a runs-page read), per run id. */
export const NEWER_CACHE_MS = 30_000;

/**
 * How long the run page's live loop reuses a park's pending-answer scan (`fleet.pendingAnswer`, a queue listing) and its
 * planner check (`fleet.parkedAnswerCheck`, a job read and the triggers file), per run id (review round 2: both ran on
 * every 2 s tick). The parked inbox's own refresh of the same scan (the snapshot's DOLLAR_RECORDS_TTL_MS), so the two
 * screens see a newly queued answer within one window; the planner reads both afresh before anything is queued.
 */
export const PARK_CHECK_CACHE_MS = 15_000;

/** The most candidates a 409 lists. */
export const CANDIDATES_MAX = 10;

/** What a fleet that cannot be read answers, 503: a fixed sentence, never the error's text. */
export const RUN_UNREADABLE = "the queue could not be read (is Valkey reachable?), so this run's chat cannot be judged; try again";

const NOT_FOUND = "no run with that id is in this host's history, the fleet's run mirror or the queue";

// Each record field's shape: the worker's own where it exports one, the runs filter's otherwise (run-filter.mjs).
const OUTCOME_RE = /^[a-z][a-z-]{0,31}$/;
const REASON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRIGGER_TYPE_RE = /^[a-z][a-z_]{0,39}$/;
const BACKEND_RE = /^[a-z][a-z-]{0,31}$/;
// A run target as the worker writes one: a repository path (GitLab subgroups, an Azure project with inner spaces) and
// `#`/`!` with a number, or `local:<basename>` for a local run.
const TARGET_RE = /^[A-Za-z0-9._:/#! -]{1,300}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const str = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
/** A record instant, re-serialized from the parsed millis so no byte of the source string rides along. */
const iso = (v) => {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const runAt = (r) => {
  const t = Date.parse(r?.endedAt ?? r?.startedAt ?? "");
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/**
 * The record's fields `/api/run` may carry, each rebuilt by name against its shape (null when it fails): ids, closed
 * words, instants and integers. Never `why`, never a token count's neighbour that is text, never anything a forge payload
 * could fill with words.
 */
export function safeRunOf(id, record) {
  const r = record ?? {};
  const target = str(r.target, TARGET_RE);
  const repo = target !== null ? repoOfTarget(target) : null;
  const rec = record ? recordRecovery(record) : null;
  return {
    id,
    jobId: str(r.jobId, RUN_ID_RE),
    kind: RUN_KINDS.includes(r.kind) ? r.kind : null,
    repo: typeof repo === "string" && TARGET_RE.test(repo) ? repo : null,
    target,
    triggerType: str(r.triggerType, TRIGGER_TYPE_RE),
    triggerIndex: count(r.triggerIndex),
    flow: str(r.flow, SKILL_NAME_RE),
    outcome: str(r.outcome, OUTCOME_RE),
    reason: str(r.reason, REASON_RE),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.endedAt),
    provider: str(r.provider, RUN_PROVIDER_RE),
    model: str(r.model, RUN_MODEL_RE),
    host: str(r.host, WORKER_NAME_RE),
    backend: str(r.backend, BACKEND_RE),
    project: str(r.project, PROJECT_ID_RE),
    attempt: count(r.attempt),
    exitCode: int(r.exitCode),
    turns: count(r.turns),
    parentJobId: str(r.parentJobId, RUN_ID_RE),
    recoveryOf: rec?.recoveryOf ?? null,
    // Whether the run kept a session (its trigger armed run.resume), and whether this run resumed one: two booleans, so
    // a terminal can say "this run keeps no session" before it looks for a directory. Never the key.
    session: { kept: r.session !== null && typeof r.session === "object", resumed: r.session?.resumed === true },
  };
}

/**
 * A run's progress as integers (and two booleans): the live snapshot's (`activeProgressOf`, no phase name, no note, no
 * tool name) while the key is the run's own, else the record's (`recordedProgress`). Null when there is neither.
 */
export function progressFactsOf(progress, record, { continues = false } = {}) {
  if (!continues && isProgressSnapshot(progress)) {
    const p = activeProgressOf(progress);
    return {
      live: true,
      turns: count(p.turn),
      steps: count(p.steps),
      failed: count(p.failed),
      interrupted: count(progress.interrupted),
      phase: p.phase ? { index: count(p.phase.index), count: count(p.phase.count), done: count(p.phase.done), total: count(p.phase.total) } : null,
      ended: p.ended === true,
      updatedAt: count(p.updatedAt),
    };
  }
  const r = recordedProgress(record?.progress);
  if (r === undefined) return null;
  const z = (v) => (Number.isSafeInteger(v) ? v : 0);
  return {
    live: false,
    turns: z(r.turns),
    steps: z(r.steps),
    failed: z(r.failed),
    interrupted: z(r.interrupted),
    phase: Number.isSafeInteger(r.lastPhaseIndex) ? { index: r.lastPhaseIndex, count: z(r.phasesDeclared), done: null, total: null } : null,
    ended: true,
    updatedAt: null,
  };
}

/**
 * The runs on `kind` whose target passes `match`, newest first: one runs page filtered by kind, with `match` handed to
 * the reader (`readRunsPage`'s predicate), so its `limit` counts runs on THAT target over a bounded scan of the kind's
 * newest records. Never the filter's `q`: a substring, which let `#120`, `#121`... fill the page and crowd out `#12`,
 * and which, for a target outside its charset, fell back to the kind's newest 100 alone. The match is applied again
 * here, so a reader that ignores the predicate still answers exactly. `{ runs, truncated, floor }` (`floor` the instant
 * at and below which a truncated scan did not look, else null), or `{ unreadable: true }`, also for a page whose own
 * history or run mirror could not be read (a partial history is not a known absence).
 */
async function runsOnTarget(fleet, kind, match) {
  if (typeof fleet?.runsPage !== "function") return { unreadable: true };
  const pred = (r) => Boolean(r) && r.kind === kind && typeof r.target === "string" && match(r.target);
  let page;
  try {
    page = await fleet.runsPage({ before: null, limit: TARGET_RUNS_MAX, filter: { kind }, match: pred });
  } catch {
    return { unreadable: true };
  }
  if (!Array.isArray(page?.runs) || page.unreachable || (typeof page.mirror === "string" && page.mirror.startsWith("unreachable"))) return { unreadable: true };
  const truncated = page.truncated === true;
  return { runs: page.runs.filter(pred), truncated, floor: truncated ? (Number.isSafeInteger(page.next) ? page.next - 1 : Number.POSITIVE_INFINITY) : null };
}

/** An exact-target matcher for `runsOnTarget`: `targetKeyOf`'s comparison (repository case, a number's zeros). */
const sameTarget = (kind, target) => {
  const key = targetKeyOf(kind, target);
  return (t) => key !== null && targetKeyOf(kind, t) === key;
};

/**
 * An Azure work item's matcher: `<project>/<repo>#<n>` with the project compared case-insensitively, any one repository
 * (no further `/`), and the number without its zeros.
 */
const workItemOf = (project, number) => {
  const p = project.toLowerCase();
  const n = String(number).replace(/^0+(?=\d)/, "");
  return (t) => {
    const m = /^([^/]+)\/([^/]+)#(\d{1,30})$/.exec(t);
    return m !== null && m[1].toLowerCase() === p && m[3].replace(/^0+(?=\d)/, "") === n;
  };
};

/**
 * The newest run on the record's target that is LATER than the record (`readParkedRuns`'s "answered" rule): `{ known:
 * true, jobId }` (null when there is none) or `{ known: false }` when the record names no target or the history could
 * not be searched.
 */
async function newerRunOf(fleet, record) {
  if (!record || !RUN_KINDS.includes(record.kind) || typeof record.target !== "string" || !TARGET_RE.test(record.target)) return { known: false, jobId: null };
  const got = await runsOnTarget(fleet, record.kind, sameTarget(record.kind, record.target));
  if (got.unreadable) return { known: false, jobId: null };
  const at = runAt(record);
  const newer = got.runs.filter((r) => runAt(r) > at && r.jobId !== record.jobId).sort((a, b) => runAt(b) - runAt(a))[0] ?? null;
  // A truncated scan that never reached the record's own instant has not seen every run after it.
  if (!newer && got.truncated && !(at > got.floor)) return { known: false, jobId: null };
  return { known: true, jobId: newer ? str(newer.jobId, RUN_ID_RE) : null };
}

// The run page loop's newer-run answers (issue #647), per fleet reader, then per run id: `{ at, recordKey, newer }`.
const newerCache = new WeakMap();

/** The identity a per-run cache entry is kept for: the record's id, end and target, so a new record reads afresh. */
const recordKeyOf = (record) => `${record?.jobId}\u0000${record?.endedAt}\u0000${record?.target}`;

/** `newerRunOf`, reused for `NEWER_CACHE_MS` while the record is the same one (its id, end and target). */
async function newerRunCached(fleet, id, record, now) {
  const at = typeof now === "function" ? now() : Date.now();
  const recordKey = recordKeyOf(record);
  let byId = newerCache.get(fleet);
  if (!byId) newerCache.set(fleet, (byId = new Map()));
  const hit = byId.get(id);
  if (hit && hit.recordKey === recordKey && at >= hit.at && at - hit.at < NEWER_CACHE_MS) return hit.newer;
  const newer = await newerRunOf(fleet, record);
  // An unknown answer is not kept: the next refresh tries the search again.
  if (newer.known) {
    if (byId.size >= 256) byId.delete(byId.keys().next().value);
    byId.set(id, { at, recordKey, newer });
  } else byId.delete(id);
  return newer;
}

// The run page loop's pending-answer scans and planner checks (review round 2), per fleet reader, then per run id:
// `{ at, recordKey, got, reuse, sawJobId }`. `sawJobId` outlives an entry that is not reused, so an answer seen running
// and then gone is noticed even across an unreadable tick.
const pendingCache = new WeakMap();
const answerCheckCache = new WeakMap();

/**
 * `read()`, reused for `PARK_CHECK_CACHE_MS` while the record is the same one, kept only when `keep(got)`: `{ got,
 * answerLeft }`, `answerLeft` true when an earlier read of this run saw a job id (`got.jobId`) and this fresh one reads
 * none (`jobId: null`), which is the moment the answer run has ended.
 */
async function parkCheckCached(cache, fleet, id, record, now, read, keep) {
  const at = typeof now === "function" ? now() : Date.now();
  const recordKey = recordKeyOf(record);
  let byId = cache.get(fleet);
  if (!byId) cache.set(fleet, (byId = new Map()));
  const hit = byId.get(id);
  if (hit && hit.reuse && hit.recordKey === recordKey && at >= hit.at && at - hit.at < PARK_CHECK_CACHE_MS) return { got: hit.got, answerLeft: false };
  const got = await read();
  const seen = str(got?.jobId, RUN_ID_RE);
  const answerLeft = typeof hit?.sawJobId === "string" && got !== null && typeof got === "object" && Object.hasOwn(got, "jobId") && got.jobId === null;
  if (!hit && byId.size >= 256) byId.delete(byId.keys().next().value);
  byId.set(id, { at, recordKey, got, reuse: keep(got), sawJobId: seen ?? (answerLeft ? null : (hit?.sawJobId ?? null)) });
  return { got, answerLeft };
}

/** A park's pending-answer scan through `fleet.pendingAnswer`, never throwing (an error reads as unreachable). */
async function pendingRead(fleet, id, record) {
  try {
    return await fleet.pendingAnswer({ kind: record.kind, target: record.target, runId: id });
  } catch {
    return { unreachable: true };
  }
}

/**
 * The planner's own check on whether parked run `id` can take a console answer (`fleet.parkedAnswerCheck`: `{ refusal }`,
 * `{ ok: true }` or `{ unreachable: true }`), reused by the run page loop for `PARK_CHECK_CACHE_MS` per run id while
 * `record` is the same one (`now` the clock); an unreadable check is read again on the next tick. Null without the reader.
 */
export async function parkedAnswerCheckOf(fleet, id, record, { now = Date.now } = {}) {
  if (typeof fleet?.parkedAnswerCheck !== "function") return null;
  const read = async () => {
    try {
      return await fleet.parkedAnswerCheck(id);
    } catch {
      return { unreachable: true };
    }
  };
  return (await parkCheckCached(answerCheckCache, fleet, id, record, now, read, (got) => got !== null && typeof got === "object" && !got.unreachable)).got;
}

// The run page's action checks (issue #710), per fleet reader, then per run id, `parkCheckCached`'s entries.
const rerunCheckCache = new WeakMap();
const sandboxCheckCache = new WeakMap();

/** A fleet check of run `id`, never throwing (an error reads as unreachable), reused as the parked answer's is. */
async function actionCheckOf(cache, fleet, method, id, record, now) {
  if (typeof fleet?.[method] !== "function") return null;
  const read = async () => {
    try {
      return await fleet[method](id, record);
    } catch {
      return { unreachable: true };
    }
  };
  return (await parkCheckCached(cache, fleet, id, record, now, read, (got) => got !== null && typeof got === "object" && !got.unreachable)).got;
}

/**
 * Whether run `id` (with `record`) can be offered a re-run (issue #710): `fleet.rerunCheck`, the planner's own cheap
 * refusals over the record and the job's retained data (`rerunRefusalOf`), reused by the run page's live loop for
 * `PARK_CHECK_CACHE_MS` per run id while `record` is the same one, as `parkedAnswerCheckOf` is; an unreadable check is
 * read again on the next tick. `{ refusal }`, `{ ok: true }`, `{ unreachable: true }`, or null without the reader.
 */
export async function rerunCheckOf(fleet, id, record, { now = Date.now } = {}) {
  return actionCheckOf(rerunCheckCache, fleet, "rerunCheck", id, record, now);
}

/**
 * Whether run `id`'s workspace is still re-openable on this host (issue #710): `fleet.sandboxCheck`, the panel's
 * manifest verdict (`sandboxRetentionOf`), reused like `rerunCheckOf`. `{ retained, why }`, `{ elsewhere: true }`,
 * `{ unreachable: true }`, or null without the reader.
 */
export async function sandboxCheckOf(fleet, id, record, { now = Date.now } = {}) {
  return actionCheckOf(sandboxCheckCache, fleet, "sandboxCheck", id, record, now);
}

/**
 * The chat facts of run `id` with `record` (its run record or null), read through `fleet`: `{ unreachable: true }` when
 * the queue cannot be read, else `{ found, jobState, activeJobId, queuedJobId, newer, answeringJobId, state, mode, says }`.
 * The newer-run search is a runs-page read, so the run page's live loop asks for it only when the mode depends on it
 * (`searchNewer: "parked"`, a parked record) and reuses its answer for `NEWER_CACHE_MS` per run id (`now` the clock);
 * `/api/run` always searches afresh. A parked record that no later record answered is then looked for in the queue
 * (`fleet.pendingAnswer`, read through chat-mode's `pendingFactsOf`): a job queued or running on its target takes the
 * answer (`answeringJobId`), and a scan that could not tell makes the park unknown, never a reply. The live loop reuses
 * that scan for `PARK_CHECK_CACHE_MS` per run id; when a scan finds the answer it saw before gone (the answer run ended,
 * and its record is now the newer run), the cached newer-run search is dropped and made again, so the page does not offer
 * a reply to an answered park for the rest of `NEWER_CACHE_MS` (review round 2). Without a `jobStatus` reader (an older
 * fleet double) this answers null; without a `pendingAnswer` reader the queue is not looked in.
 */
export async function chatFactsOf(fleet, id, record, { searchNewer = "always", now = Date.now } = {}) {
  if (typeof fleet?.jobStatus !== "function") return null;
  let status;
  try {
    status = await fleet.jobStatus(id);
  } catch {
    status = { unreachable: true };
  }
  if (!status || status.unreachable || status.invalid) return { unreachable: true };
  const jobState = typeof status.state === "string" ? status.state : null;
  const activeJobId = jobState === "active" ? id : str(status.continuesAs, RUN_ID_RE);
  const queuedJobId = activeJobId === null ? str(status.queuedAs, RUN_ID_RE) : null;
  const parkedRecord = record?.outcome === "completed" && record?.reason === "awaiting-input";
  const cached = searchNewer === "parked";
  let newer = searchNewer === "always" ? await newerRunOf(fleet, record) : cached && parkedRecord ? await newerRunCached(fleet, id, record, now) : { known: false, jobId: null };
  let parked = null;
  let answeringJobId = null;
  if (parkedRecord && newer.known && newer.jobId === null && activeJobId === null && typeof fleet.pendingAnswer === "function") {
    const read = cached ? await parkCheckCached(pendingCache, fleet, id, record, now, () => pendingRead(fleet, id, record), (got) => got !== null && typeof got === "object" && !got.unreachable) : { got: await pendingRead(fleet, id, record), answerLeft: false };
    if (read.answerLeft) {
      newerCache.get(fleet)?.delete(id);
      newer = await newerRunCached(fleet, id, record, now);
    }
    if (newer.known && newer.jobId === null) {
      const facts = pendingFactsOf(read.got);
      answeringJobId = facts.pendingJobId;
      parked = { answered: false, pending: facts.pending, pendingTooMany: facts.pendingTooMany };
    }
  }
  if (parked === null && parkedRecord && newer.known) parked = { answered: newer.jobId !== null };
  const facts = { state: jobState, record: record ?? null, activeJobId, queuedJobId, parked };
  const { mode, says } = chatModeOf(facts);
  return { found: status.found === true, jobState, activeJobId, queuedJobId, newer, answeringJobId, state: runStateOf(facts), mode, says };
}

/** The query: `{ id }`, `{ url }` or `{ refusal }`. Exactly one of the two, once, and nothing else. */
export function parseRunQuery(searchParams) {
  const keys = new Set(searchParams.keys());
  for (const key of keys) if (key !== "id" && key !== "url") return { refusal: "the run lookup takes only id or url" };
  if (keys.size !== 1) return { refusal: keys.size === 0 ? "the run lookup needs ?id= with a run's job id, or ?url= with an issue, pull request or merge request link" : "give id or url, not both" };
  const [key] = keys;
  const values = searchParams.getAll(key);
  if (values.length !== 1) return { refusal: `${key} is given more than once` };
  const value = values[0];
  if (key === "id") return RUN_ID_RE.test(value) ? { id: value } : { refusal: "id must be a run id (letters, digits and . _ : -, at most 200 characters)" };
  if (value === "" || value.length > FORGE_URL_MAX) return { refusal: `url must be a forge link of at most ${FORGE_URL_MAX} characters` };
  return { url: value };
}

/**
 * The run a URL names: `{ id }`, or `{ status, body }` to answer with (400 for a URL that names no target on a forge
 * this deployment knows, 404 for a target with no run, 409 for an Azure work item in several repositories, 503 for a
 * history that could not be searched).
 */
async function resolveUrl(fleet, url, env) {
  const t = forgeTargetOf(url, env);
  if (t === null) return { status: 400, body: { error: "url must be an issue, pull request or merge request link on github.com or on a forge instance this deployment names (GITLAB_URL, FORGEJO_URL, AZURE_ORG_URL)" } };
  const got = await runsOnTarget(fleet, t.kind, t.ambiguous ? workItemOf(t.project, t.number) : sameTarget(t.kind, t.target));
  if (got.unreadable) return { status: 503, body: { error: "the run history could not be searched for that link; try again" } };
  const runs = [...got.runs].sort((a, b) => runAt(b) - runAt(a)).filter((r) => RUN_ID_RE.test(String(r.jobId ?? "")));
  if (runs.length === 0) {
    const where = got.truncated ? `among the newest ${RUNS_PAGE_EXAMINE_MAX} runs this lookup searches` : "in this host's history or the fleet's run mirror";
    return { status: 404, body: { error: `no run on that target is ${where} (a running job's record is written at its end: give its run id instead)` } };
  }
  const targets = [...new Set(runs.map((r) => r.target))];
  if (targets.length > 1) {
    // The newest run per repository, so the person picks one by its id.
    const candidates = targets.slice(0, CANDIDATES_MAX).map((target) => ({ target, jobId: runs.find((r) => r.target === target).jobId }));
    return { status: 409, body: { error: "that work item has runs in more than one repository of its project; give one of these run ids", candidates } };
  }
  return { id: runs[0].jobId };
}

/**
 * One run's chat, looked up by `{ id }` or `{ url }` through `fleet`: `{ id, doc, record }` (the document `/api/run`
 * answers, and the full record the fleet read, for a caller on the deployment's own host), or `{ status, body }` to
 * answer with (`body.error` a sentence, `body.candidates` for an Azure work item in several repositories). THE ONE
 * RESOLUTION: `/api/run` and the panel's `/dispatch chat` (issue #647, part 2) both call it, so a link or an id names the
 * same run, and gets the same mode (`chatFactsOf`, `chatModeOf`), in a browser, a terminal and pi.
 */
export async function resolveRunChat(fleet, query, env = {}) {
  let id = query?.id;
  if (query?.url !== undefined) {
    const got = await resolveUrl(fleet, query.url, env);
    if (!got.id) return { status: got.status, body: got.body };
    id = got.id;
  }
  const body = await runDocument(fleet, id, env);
  if (body.status) return { status: body.status, body: { error: body.error } };
  return { id, doc: body.doc, record: body.record };
}

/** `/api/run`'s handler. `ctx` is the console dispatcher's (`server.mjs`). */
export async function getRun(ctx) {
  const { deps } = ctx;
  const fleet = deps.pageDeps?.fleet;
  if (!fleet) return ctx.json(503, { error: "this console has no fleet reader; see its log" });
  const parsed = parseRunQuery(ctx.searchParams);
  if (parsed.refusal) return ctx.json(400, { error: parsed.refusal });
  const got = await resolveRunChat(fleet, parsed, deps.pageDeps?.env ?? {});
  if (!got.doc) return ctx.json(got.status, got.body);
  return ctx.json(200, got.doc);
}

/**
 * The document for run `id`: `{ doc, record }` (`record` the run record the fleet read, or null; never in `doc`), or
 * `{ status, error }` (404 unknown, 503 unreadable).
 */
export async function runDocument(fleet, id, env = {}) {
  let got;
  try {
    got = await fleet.runById(id);
  } catch {
    got = { missing: true };
  }
  const record = got?.record ?? null;
  const facts = await chatFactsOf(fleet, id, record);
  if (facts === null || facts.unreachable) return { status: 503, error: RUN_UNREADABLE };
  // The live job's transcript and inbox (a recovery's, when the run goes on under another id), else this job's own.
  const attachId = facts.activeJobId ?? id;
  const [meta, box, prog] = await Promise.all([
    typeof fleet.transcriptMeta === "function" ? fleet.transcriptMeta(attachId).catch(() => null) : null,
    typeof fleet.inbox === "function" ? fleet.inbox(attachId).catch(() => null) : null,
    typeof fleet.progressOfRun === "function" ? fleet.progressOfRun(id, record).catch(() => null) : typeof fleet.progress === "function" ? fleet.progress(id).then((p) => ({ progress: p, continues: false }), () => null) : null,
  ]);
  const transcriptExists = meta?.exists === true;
  const boxRead = box !== null && typeof box === "object" && !box.unreachable && !box.invalid;
  const progressing = isProgressSnapshot(prog?.progress);
  if (!record && !facts.found && facts.activeJobId === null && facts.queuedJobId === null && !transcriptExists && !progressing) return { status: 404, error: NOT_FOUND };
  const doc = {
    version: RUN_API_VERSION,
    run: safeRunOf(id, record),
    state: facts.state,
    mode: facts.mode,
    says: facts.says,
    activeJobId: facts.activeJobId,
    // `armed` is true, false, or null when the inbox could not be read (never a guessed false: the terminal would say
    // "not steer-armed" about a run that is); `open` the same, and false for a job read as not armed.
    steer: boxRead ? { armed: box.found === true && box.steer === true, open: box.found === true && box.steer === true ? (box.open === true ? true : box.open === false ? false : null) : false } : { armed: null, open: null },
    transcript: { exists: transcriptExists, ended: transcriptExists && meta.ended === true, outcome: transcriptExists && meta.ended === true ? (LIVE_OUTCOMES.includes(meta.outcome) ? meta.outcome : "unknown") : null },
    progress: progressFactsOf(prog?.progress, record, { continues: prog?.continues === true }),
    forgeLink: record ? forgeLinkOf(record, env) : null,
    newerRunOnTarget: facts.newer.known ? facts.newer.jobId : null,
    // The job queued or running on a parked run's target that takes its answer (no record yet), or null.
    pendingRunOnTarget: facts.answeringJobId,
  };
  return { doc, record };
}
