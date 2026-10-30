/**
 * The published doctor results as the console and the `/dispatch` panel read them (issue #712, `INT-DOCTOR-RESULTS-KEY`).
 *
 * Pure: the snapshot's `doctor` field (`readDoctorResults`, already through the worker's allowlist) in, words and rows
 * out. Both surfaces share these so they cannot disagree about when a result is stale or which check a sentence quotes.
 * Every label here is another host's text, redacted at the source; each surface still escapes it as untrusted.
 *
 * Since issue #737 also the first run's checklist (`firstRunState`), which judges its egress, provider and forge steps
 * from these same results, in doctor's own order, so the overview's setup state and the Doctor panel read one record.
 */

const HOUR = 3_600_000;

/**
 * A result is STALE once it is older than this many of its host's own doctor intervals: one missed daily run is a
 * worker that was down for a while, two is a host whose results no longer describe it. A host whose interval is 0 (the
 * worker runs no doctor) or unknown is never called stale: only an operator's run publishes there, and its age is shown.
 */
export const DOCTOR_STALE_INTERVALS = 2;

/** How many warn and fail checks a host's block lists before it counts the rest. */
export const DOCTOR_CHECKS_SHOWN = 8;

/**
 * The checks the console's "does not load" sentences quote, by the file each sentence names: the worker's
 * `NAMED_CHECK_IDS` for the service's verdict on that file. Pinned against the worker's list by a test.
 */
export const DOCTOR_FILE_CHECKS = Object.freeze({
  "triggers file": "triggers.file",
  "pause-windows file": "pause-windows.file",
  "scoped-limits file": "scoped-limits.file",
  "projects file": "projects.file",
  "settings overlay": "settings.overlay",
  "model-endpoints file": "model-endpoints.file",
});

/** The snapshot's doctor rows, readable ones first by name; `[]` when nothing was published or read. */
export function doctorHostsOf(snapshot) {
  const rows = Array.isArray(snapshot?.doctor?.hosts) ? snapshot.doctor.hosts : [];
  return rows.filter((r) => r && typeof r.name === "string");
}

/** Whether a row is older than `DOCTOR_STALE_INTERVALS` of its own interval. */
export function doctorStale(row) {
  return Number.isSafeInteger(row?.every) && row.every > 0 && Number.isSafeInteger(row?.ageMs) && row.ageMs > DOCTOR_STALE_INTERVALS * row.every * HOUR;
}

/** A row's counts in words: `2 failing, 1 warning, 40 passing`, the failing first. */
export function doctorCountsText(row) {
  const c = row?.counts ?? {};
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return `${n(c.fail)} failing, ${n(c.warn)} warning${n(c.warn) === 1 ? "" : "s"}, ${n(c.ok)} passing`;
}

/** A row's warn and fail checks, failing first, each `{ id, level, label, fix }`; ok checks are never listed. */
export function doctorProblems(row) {
  const list = Array.isArray(row?.checks) ? row.checks.filter((c) => c && c.level !== "ok") : [];
  return [...list.filter((c) => c.level === "fail"), ...list.filter((c) => c.level === "warn")];
}

/** This console's own host name as the worker names it (`doctorSelf`, the fleet reader's), or null. */
function selfOf(snapshot) {
  return typeof snapshot?.doctorSelf === "string" && snapshot.doctorSelf !== "" ? snapshot.doctorSelf : null;
}

/**
 * The published check a sentence quotes, `{ host, own, ageMs, level, label, fix }`, or null. The files are per host, so
 * THIS host's record decides first (`doctorSelf`, named by the worker's rule): its warn or fail for `id` is quoted as
 * its own; its ok result for `id` quotes nothing (the run that saw the file load is newer evidence than another host's
 * failure, and the sentence then falls back to "run pi-dispatch doctor"). Only where this host's record does not judge
 * that file at all is another host's newest warn or fail quoted, marked `own: false` so the sentence says it is that
 * host's own copy.
 */
export function doctorQuote(snapshot, id) {
  const rows = doctorHostsOf(snapshot).filter((r) => !r.unreadable);
  const pick = (row) => (Array.isArray(row?.checks) ? row.checks : []).find((c) => c?.id === id) ?? null;
  const quote = (row, hit, own) => ({ host: row.name, own, ageMs: Number.isSafeInteger(row.ageMs) ? row.ageMs : Number.MAX_SAFE_INTEGER, level: hit.level, label: hit.label, fix: typeof hit.fix === "string" ? hit.fix : null });
  const usable = (hit) => hit && hit.level !== "ok" && typeof hit.label === "string" && hit.label !== "";
  const self = selfOf(snapshot);
  const mine = self === null ? null : rows.find((r) => r.name === self);
  const myHit = pick(mine);
  if (myHit) return usable(myHit) ? quote(mine, myHit, true) : null;
  let best = null;
  for (const row of rows) {
    if (row.name === self) continue;
    const hit = pick(row);
    if (!usable(hit)) continue;
    const q = quote(row, hit, false);
    if (best === null || q.ageMs < best.ageMs) best = q;
  }
  return best;
}

/** Who ran a result, in words: the worker, or an operator's account (with its uid where the platform has one). */
export function doctorByText(row) {
  if (row?.by?.worker === true) return "run by the worker";
  return Number.isSafeInteger(row?.by?.uid) ? `run by hand (uid ${row.by.uid})` : "run by hand";
}

// ---- the first run (issue #737) ----------------------------------------------------------------------------------------

/**
 * The first run's steps, in doctor's own order: where the console reads its files, the queue, the console's tokens,
 * a worker, its egress proxy, the provider key, a first trigger and the forge credentials.
 */
export const FIRST_RUN_STEPS = Object.freeze(["deployment", "queue", "token", "worker", "egress", "provider", "trigger", "forge"]);

/** Each step state's word and the status its tile, chip and segment are drawn in (`kit.mjs` `STATUS`). */
export const FIRST_RUN_STATES = Object.freeze({
  ready: Object.freeze({ word: "Ready", status: "ok" }),
  "not-yet": Object.freeze({ word: "Not yet", status: "failed" }),
  check: Object.freeze({ word: "Check", status: "attention" }),
  "to-do": Object.freeze({ word: "To do", status: "idle" }),
  optional: Object.freeze({ word: "Optional", status: "idle" }),
});

/**
 * The commands the first run offers, as argument lists (`kit.mjs` `cmd` quotes each for a shell): a viewer token,
 * the worker as a service or in a terminal, `up` (the egress proxy among what it starts), doctor, the GitHub App
 * setup, and the guided setup in pi. Each is pinned against its CLI's usage by a test. `setup github` is refused
 * without `--webhook-url` or `--no-webhook`, so it is offered whole, its URL a placeholder the copy box quotes and
 * `FIRST_RUN_COMMAND_HINTS` says what to put there.
 */
export const FIRST_RUN_COMMANDS = Object.freeze({
  token: Object.freeze(["pi-dispatch-console", "token", "add", "--name", "<name>", "--role", "viewer"]),
  service: Object.freeze(["pi-dispatch", "service", "install"]),
  worker: Object.freeze(["pi-dispatch", "worker"]),
  up: Object.freeze(["pi-dispatch", "up"]),
  doctor: Object.freeze(["pi-dispatch", "doctor"]),
  github: Object.freeze(["pi-dispatch", "setup", "github", "--webhook-url", "<receiver URL>"]),
  pi: Object.freeze(["/dispatch", "setup"]),
});

/**
 * What fills each command's placeholder (an argument in angle brackets), as sentence parts like a step's, drawn with the
 * command: a command copied with its placeholder in it does something nobody asked for (`setup github` would start the
 * App Manifest flow with "<receiver URL>" as the webhook). Pinned: every placeholder of `FIRST_RUN_COMMANDS` has one.
 */
export const FIRST_RUN_COMMAND_HINTS = Object.freeze({
  token: Object.freeze(["Put a name for whoever will hold the token in place of ", { code: "<name>" }, "; the command prints the token once."]),
  github: Object.freeze(["Put the public URL of this deployment's pi-dispatch-receiver, where GitHub delivers events, in place of ", { code: "<receiver URL>" }, "; without a receiver, pass ", { code: "--no-webhook" }, " instead of ", { code: "--webhook-url" }, " and its URL."]),
});

/** The hint for a command of `FIRST_RUN_COMMANDS` (the same list, as a step's `commands` holds it), or null. */
export function firstRunCommandHint(argv) {
  const name = Object.keys(FIRST_RUN_COMMANDS).find((k) => FIRST_RUN_COMMANDS[k] === argv);
  return name !== undefined && Object.hasOwn(FIRST_RUN_COMMAND_HINTS, name) ? FIRST_RUN_COMMAND_HINTS[name] : null;
}

/** How old a host's beat may be for the worker step to count it (the console's `BEAT_FRESH_MS`, pinned by a test). */
const FIRST_RUN_FRESH_MS = 60_000;

const STEP_TITLES = Object.freeze({
  deployment: Object.freeze({ todo: "Deployment", done: "Deployment found" }),
  queue: Object.freeze({ todo: "Queue", done: "Queue reachable" }),
  token: Object.freeze({ todo: "Console token", done: "Console token" }),
  worker: Object.freeze({ todo: "Start a worker", done: "A worker runs" }),
  egress: Object.freeze({ todo: "Start the egress proxy", done: "Egress proxy running" }),
  provider: Object.freeze({ todo: "Provider key", done: "Provider key" }),
  trigger: Object.freeze({ todo: "Add a first trigger", done: "A first trigger" }),
  forge: Object.freeze({ todo: "Forge credentials", done: "Forge credentials" }),
});

/**
 * What a step that is not yet ready stands for in the sentence under the progress ("Jobs start once ..."). A step to
 * do is not among them: a first trigger is what starts jobs by itself, but `pi-dispatch run` queues one without any.
 */
const STEP_NEEDS = Object.freeze({
  deployment: "the console finds its deployment",
  queue: "Valkey answers",
  worker: "a worker runs",
  egress: "its egress proxy is up",
  provider: "the provider key is found",
  trigger: "the triggers file loads",
  forge: "the forge credentials work",
});

const LEVEL_RANK = Object.freeze({ ok: 0, warn: 1, fail: 2 });
const NUMBER_WORDS = Object.freeze(["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"]);

/** A doctor check's id is the egress proxy's (`egress.proxy`, or a repeat of it: `egress.proxy-2`). */
const EGRESS_ID_RE = /^egress\.proxy(?:-\d+)?$/;
/** The provider key's named id, or a repeat of it. */
const PROVIDER_ID_RE = /^provider\.key(?:-\d+)?$/;
/** A check of the provider section that is not the named one: the derived ids an older doctor wrote there. */
const PROVIDER_DERIVED_RE = /^provider\.\d+(?:-\d+)?$/;
/** A forge credentials check: any check of the `github` or the `forges` section (no one check holds them). */
const FORGE_ID_RE = /^(?:github|forges)\./;

/**
 * The worst published level of the checks `test` picks, across the readable doctor rows: `{ level, host, ageMs, label }`
 * of the failing one first, then a warning, then a pass; among equals the newest. Null when no row holds such a check.
 */
function worstCheck(rows, test) {
  let best = null;
  for (const row of rows) {
    for (const c of Array.isArray(row.checks) ? row.checks : []) {
      if (typeof c?.id !== "string" || !test(c.id) || !Object.hasOwn(LEVEL_RANK, c.level)) continue;
      const ageMs = Number.isSafeInteger(row.ageMs) ? row.ageMs : Number.MAX_SAFE_INTEGER;
      const hit = { level: c.level, host: row.name, ageMs, label: typeof c.label === "string" && c.label !== "" ? c.label : null };
      if (best === null || LEVEL_RANK[hit.level] > LEVEL_RANK[best.level] || (LEVEL_RANK[hit.level] === LEVEL_RANK[best.level] && hit.ageMs < best.ageMs)) best = hit;
    }
  }
  return best;
}

/** The newest readable doctor row as `{ host, ageMs }`, or null when no host has published one. */
function newestDoctor(rows) {
  let best = null;
  for (const row of rows) {
    const ageMs = Number.isSafeInteger(row.ageMs) ? row.ageMs : null;
    if (best === null || (ageMs !== null && (best.ageMs === null || ageMs < best.ageMs))) best = { host: row.name, ageMs };
  }
  return best;
}

/** A doctor label as a sentence's end: without its own closing period, so the sentence adds one. */
const labelOf = (label) => String(label).replace(/\.$/, "");

/** A step's state by the worst level a doctor published for it. */
const stateOfLevel = (level) => (level === "fail" ? "not-yet" : level === "warn" ? "check" : "ready");

/**
 * The words of a step judged by a doctor check. A check's label names the check, and for many checks it reads as the
 * passing case ("Provider key set (...)"), so a check that did not pass is quoted as the check it failed or warned on,
 * never as what doctor says is so.
 */
function doctorSaid(hit, { ok, notOk }) {
  if (hit.level === "ok") return ["Doctor on ", { b: hit.host }, ` ${ok}.`];
  const what = hit.level === "fail" ? "a failing check" : "a warning";
  return ["Doctor on ", { b: hit.host }, ...(hit.label === null ? [` reports ${what}. `] : [` reports ${what}: `, labelOf(hit.label), ". "]), ...notOk];
}

/** The sentence when no host has published a doctor result at all. */
const NO_DOCTOR_YET = (what) => [`No doctor result yet. A worker runs doctor a minute after it starts, and doctor says ${what}.`];

/**
 * How long ago a host row last beat: Valkey's measure (`ttlAgeMs`, the row's TTL minus its PTTL, on Valkey's clock as a
 * duration) where the reader had it, since every beat refreshes the row's expiry; else the console's clock minus the
 * host's `beatAt` (`staleMs`), which a host clock out of step makes wrong. Null when neither is known.
 */
export function beatAgeOf(h) {
  if (Number.isSafeInteger(h?.ttlAgeMs) && h.ttlAgeMs >= 0) return h.ttlAgeMs;
  return Number.isSafeInteger(h?.staleMs) ? h.staleMs : null;
}

/**
 * What stands between this deployment and its first job (issue #737, the SetupScreen card): `{ applies, ready, total,
 * lead, sub, doctor, steps }`, from the snapshot (`createFleetReader`'s), the session asking (its ROLE only: a live
 * panel is drawn once per role, so a name here would be one session's name on every operator's page) and the console's
 * deployment folder (`{ folder }`, its last folder alone).
 *
 * `applies` is true only when the snapshot was read, no run is on record (neither the newest runs nor the last 24
 * hours'), and there is no host row or no trigger: a Valkey blink (no snapshot) or every worker down on a deployment
 * that has run jobs never turns the overview into this checklist. `ready` counts the steps that are ready, `total` is
 * 8, `lead` is the headline (how many steps are not yet ready: those stand before the first job), `sub` the sentence
 * under the progress (what jobs wait for), `doctor` the newest published doctor run `{ host, ageMs }` or null.
 *
 * Each step is `{ id, state, title, sentence, commands }`, in `FIRST_RUN_STEPS`' order: `state` a key of
 * `FIRST_RUN_STATES`; `sentence` a list of parts (text, `{ code }`, `{ b }`), so each surface draws a name in its own
 * face and nothing is concatenated into markup, and a step a doctor run judged names that run's host in it ("Doctor
 * on build3 reports a failing check: ..."); `commands` the argument lists to offer. Who may read a command or use an action is each
 * surface's rule, by role and by whether the console takes changes, not a field here: the overview draws the commands
 * for an operator alone and the trigger step's Add button only where the console takes changes. A doctor that wrote
 * the provider section but not its `provider.key` check (one older than the id) is said in that step's sentence.
 *
 * The egress and provider steps take the WORST published level of their named check across every host's record
 * (`egress.proxy` with its repeats, one per venue that runs a proxy); the forge step is optional without a forge
 * trigger, and otherwise the worst of every check in the `github` and `forges` sections, since no one check holds a
 * forge's credentials (`INT-DOCTOR-RESULTS-KEY`).
 */
export function firstRunState(snapshot, { session = null, deployment = null, freshMs = FIRST_RUN_FRESH_MS } = {}) {
  const s = snapshot !== null && typeof snapshot === "object" ? snapshot : null;
  const hosts = Array.isArray(s?.hostBudgets) ? s.hostBudgets.filter((h) => h && typeof h.name === "string") : [];
  const triggerList = Array.isArray(s?.triggers?.triggers) ? s.triggers.triggers : [];
  const runsDay = s?.runsDay ?? null;
  const noRun = s !== null && Array.isArray(s.runs) && s.runs.length === 0 && runsDay !== null && Array.isArray(runsDay.runs) && runsDay.runs.length === 0 && runsDay.partial !== true;
  const noHost = hosts.length === 0 && !s?.queue?.fleetDegraded;
  const applies = s !== null && noRun && (noHost || triggerList.length === 0);
  const doctorRows = doctorHostsOf(s).filter((r) => !r.unreadable);
  const doctorRead = s !== null && s.doctor && !s.doctor.unreachable;
  const role = session?.role === "operator" ? "operator" : session?.role === "viewer" ? "viewer" : null;

  const step = (id, state, sentence, { commands = [] } = {}) => ({ id, state, title: state === "ready" ? STEP_TITLES[id].done : STEP_TITLES[id].todo, sentence, commands });

  const steps = [];
  // 1. Where the console reads its files: the deployment folder, by its last folder.
  const folder = typeof deployment?.folder === "string" && deployment.folder !== "" ? deployment.folder : null;
  steps.push(folder !== null ? step("deployment", "ready", ["The console reads its files from the deployment in ", { code: folder }, "."]) : step("deployment", "check", ["The console did not say which deployment folder it reads."]));
  // 2. The queue. Never its address: a viewer's page carries none.
  steps.push(s !== null ? step("queue", "ready", ["Valkey answers."]) : step("queue", "not-yet", ["Valkey does not answer, so nothing can be queued or read."]));
  // 3. The console's tokens: the role of the session asking.
  if (role === "operator") steps.push(step("token", "ready", ["You are signed in as ", { b: "an operator" }, ". Give people who only watch a viewer token."], { commands: [FIRST_RUN_COMMANDS.token] }));
  else if (role === "viewer") steps.push(step("token", "ready", ["You are signed in as ", { b: "a viewer" }, "."]));
  else steps.push(step("token", "check", ["The console could not say who is signed in."]));
  // 4. A worker: a registry row that beats, or a worker BullMQ sees (a worker from before the registry).
  const workerCommands = [FIRST_RUN_COMMANDS.service, FIRST_RUN_COMMANDS.worker];
  const connected = Number.isSafeInteger(s?.queue?.workers) && s.queue.workers > 0 ? s.queue.workers : 0;
  const fresh = hosts.filter((h) => { const age = beatAgeOf(h); return age !== null && age <= freshMs; });
  if (s?.queue?.fleetDegraded) steps.push(step("worker", "check", ["The host registry could not be read, so whether a worker runs is not known."], { commands: workerCommands }));
  else if (fresh.length > 0) steps.push(step("worker", "ready", fresh.length === 1 ? [{ b: fresh[0].name }, " beats."] : [`${fresh.length} hosts beat, `, { b: fresh[0].name }, " among them."]));
  else if (hosts.length > 0) {
    const newest = hosts.reduce((a, h) => (beatAgeOf(h) !== null && (a === null || beatAgeOf(h) < beatAgeOf(a)) ? h : a), null);
    steps.push(step("worker", "check", newest === null ? ["A host is registered, but no beat from it can be read."] : [{ b: newest.name }, " is registered, but its last beat is ", { age: beatAgeOf(newest) }, " old."], { commands: workerCommands }));
  } else if (connected > 0) steps.push(step("worker", "ready", ["The queue sees a worker connected."]));
  else steps.push(step("worker", "not-yet", ["No host is registered. A worker registers when it starts, and until one does nothing in the queue starts."], { commands: workerCommands }));
  // 5. The egress proxy, on every venue that runs one: the worst any host's doctor published.
  const egress = doctorRead ? worstCheck(doctorRows, (id) => EGRESS_ID_RE.test(id)) : null;
  const newest = newestDoctor(doctorRows);
  if (egress !== null) {
    steps.push(step("egress", stateOfLevel(egress.level), doctorSaid(egress, { ok: "found the egress proxy running", notOk: ["Every job is refused before it starts until the egress proxy runs."] }), { commands: egress.level === "ok" ? [] : [FIRST_RUN_COMMANDS.up] }));
  } else if (newest !== null) {
    steps.push(step("egress", "check", ["Doctor on ", { b: newest.host }, " names no egress proxy: egress may be off there, or its doctor predates the check."], { commands: [FIRST_RUN_COMMANDS.doctor] }));
  } else steps.push(step("egress", "to-do", NO_DOCTOR_YET("whether the egress proxy runs"), { commands: [FIRST_RUN_COMMANDS.doctor] }));
  // 6. The provider key: present or not, never its value.
  const provider = doctorRead ? worstCheck(doctorRows, (id) => PROVIDER_ID_RE.test(id)) : null;
  if (provider !== null) {
    steps.push(step("provider", stateOfLevel(provider.level), doctorSaid(provider, { ok: "found the provider key", notOk: ["Jobs use this host's pi login if it has one; otherwise set the key in the deployment's ", { code: ".env" }, ", then run doctor again."] }), { commands: provider.level === "ok" ? [] : [FIRST_RUN_COMMANDS.doctor] }));
  } else if (newest !== null) {
    const predates = doctorRows.some((r) => (Array.isArray(r.checks) ? r.checks : []).some((c) => typeof c?.id === "string" && PROVIDER_DERIVED_RE.test(c.id)));
    steps.push(step("provider", "check", predates ? ["Doctor on ", { b: newest.host }, " checked the provider but not the key by name: its doctor predates the check."] : ["Doctor on ", { b: newest.host }, " did not judge the provider key."], { commands: [FIRST_RUN_COMMANDS.doctor] }));
  } else steps.push(step("provider", "to-do", NO_DOCTOR_YET("whether the provider key is found"), { commands: [FIRST_RUN_COMMANDS.doctor] }));
  // 7. A first trigger: nothing starts a job until one matches.
  if (triggerList.length > 0) steps.push(step("trigger", "ready", [`The triggers file holds ${triggerList.length} ${triggerList.length === 1 ? "trigger" : "triggers"}.`]));
  else if (s?.triggers?.invalid) steps.push(step("trigger", "not-yet", ["The triggers file does not load, so no trigger can match."]));
  else steps.push(step("trigger", "to-do", ["Nothing starts a job until a trigger matches: a cron trigger for a folder, or a label, comment or pull request trigger for a repository."]));
  // 8. The forge credentials: only a forge's triggers need them.
  const forgeTrigger = triggerList.some((t) => t && t.type !== "cron");
  const forge = forgeTrigger && doctorRead ? worstCheck(doctorRows, (id) => FORGE_ID_RE.test(id)) : null;
  if (!forgeTrigger) steps.push(step("forge", "optional", ["Only label, comment, issue and pull request triggers need them. Cron triggers on local folders run without."], { commands: [FIRST_RUN_COMMANDS.github] }));
  else if (forge !== null) steps.push(step("forge", stateOfLevel(forge.level), doctorSaid(forge, { ok: "found the forge credentials", notOk: ["A forge trigger's jobs need them to read and answer on the forge."] }), { commands: forge.level === "ok" ? [] : [FIRST_RUN_COMMANDS.github] }));
  else steps.push(step("forge", "to-do", newest === null ? NO_DOCTOR_YET("whether the forge credentials work") : ["Doctor on ", { b: newest.host }, " did not check the forge credentials."], { commands: [FIRST_RUN_COMMANDS.github] }));

  const ready = steps.filter((x) => x.state === "ready").length;
  const missing = steps.filter((x) => x.state === "not-yet");
  const n = missing.length;
  const lead = n === 0 ? "The console is up. A first trigger, or a job run by hand, starts its first job." : `The console is up. ${NUMBER_WORDS[n] ?? String(n)} ${n === 1 ? "step stands" : "steps stand"} between this deployment and its first job.`;
  const needs = missing.map((x) => STEP_NEEDS[x.id]);
  const list = needs.length <= 1 ? needs.join("") : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
  const sub = n === 0 ? "Nothing a job needs is missing. This page updates as each step is done." : `Jobs start once ${list}. This page updates as each step is done.`;
  return { applies, ready, total: FIRST_RUN_STEPS.length, lead, sub, doctor: newest, steps };
}

/** A step's sentence as plain text (`firstRunState`'s parts joined; an age in the console's words). */
export function stepSentenceText(parts, ageText = (ms) => `${Math.round(ms / 1000)}s`) {
  return (Array.isArray(parts) ? parts : []).map((p) => (typeof p === "string" ? p : typeof p?.code === "string" ? p.code : typeof p?.b === "string" ? p.b : Number.isFinite(p?.age) ? ageText(p.age) : "")).join("");
}
