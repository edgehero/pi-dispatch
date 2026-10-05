/**
 * Pure text renderers for the admin extension: a read-model record (or array) in, a display string out.
 * No I/O, no clock, no process.env -- every input is a value the caller already fetched, so these are
 * testable with plain fixtures.
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): a renderer only ever sees the PII-free
 * record fields (`target` is `repo#issue` / `local:<basename>` only), the settings keys (`KNOWN_KEYS`,
 * imported from the worker, never a count), scheduler
 * keys, and flow labels. Raw `.log` bytes are untrusted, PII-bearing container output and NEVER reach a
 * renderer -- the logs overlay in index.ts is their only surface, so there is deliberately no code path
 * from here to a `.log` file (asserted by render.test.mjs).
 */

import { windowState } from "@edgehero/pi-dispatch/budget";
import { formatMicros } from "@edgehero/pi-dispatch/money";
// Pure-to-pure, the same standing as the windowState import above: panel.mjs is the admin's other no-I/O
// text module (asserted so by panel.test.mjs), and fmtCost is THE single renderer of typed cost values,
// so the what-if below routes every dollar through it rather than grow a second money formatter here.
import { clip, columnsOf, fmtCost, pad, scrubControls, sliceColumns } from "./panel.mjs";
// The overlay keys, IMPORTED rather than retyped. This was a verbatim copy of the worker's array, in the
// order the worker declares them, and the worker's side is pinned while this side was not -- so a key
// added there would have failed a test, been added, and left the settings VIEW silently ten keys wide
// while eleven were settable. read-model.mjs already imports and re-exports this exact array, so the copy
// was the second one. Imported straight from the worker rather than through read-model.mjs: this module
// is asserted to do no I/O of its own, and reaching for it through the I/O module is the wrong direction.
import { KNOWN_KEYS } from "@edgehero/pi-dispatch/runtime-settings";

// The three spend windows and the overlay cap key each reads. Order is day -> week -> month.
const BUDGET_WINDOWS = [
  { key: "day", label: "day", capKey: "dailyCap" },
  { key: "week", label: "week", capKey: "weeklyCap" },
  { key: "month", label: "month", capKey: "monthlyCap" },
];

const RUN_COLUMNS = [
  { key: "jobId", header: "JOB ID" },
  { key: "target", header: "TARGET" },
  { key: "flow", header: "FLOW" },
  { key: "outcome", header: "OUTCOME" },
  { key: "reason", header: "REASON" },
  { key: "turns", header: "TURNS" },
  // Per-job token accounting (issue #25). `tokens` is `{ input, output, total, cost }` | null; a derive
  // reaches into it so a null record still reads "-", and cost renders as a $-prefixed fixed-decimal.
  { key: "tokens", header: "TOKENS", derive: (r) => cell(r?.tokens?.total) },
  { key: "cost", header: "COST", derive: (r) => (typeof r?.tokens?.cost === "number" ? `$${r.tokens.cost.toFixed(4)}` : "-") },
  // Derived: a `d<n>` chain-depth marker for an outbox-chained child, "-" for a root run. A custom
  // derive is needed because `cell()` would render depth 0 as "0"; here depth 0/null/absent all read "-".
  { key: "chain", header: "CHAIN", derive: (r) => (r?.chainDepth > 0 ? `d${r.chainDepth}` : "-") },
  // Derived like CHAIN, and for the same reason: an unreplicated run must read "-" rather than "0". The
  // set size is shown alongside the index because `r2` alone does not say whether the sibling exists --
  // `r2/2` is what makes the pair legible in a list where the two rows need not be adjacent.
  { key: "replica", header: "REPLICA", derive: (r) => (r?.replica > 0 ? `r${r.replica}/${r?.replicas ?? "?"}` : "-") },
  { key: "endedAt", header: "ENDED" },
];

/**
 * One cell of a record in a PLAIN-TEXT pane: a nullish field renders as "-" so a stable record shape reads
 * cleanly, and a control byte becomes a space.
 *
 * THE SCRUB LIVES HERE rather than at the call sites, and that is the whole point (issue #367). A first
 * attempt added a second helper beside this one and called it from `renderHeldJobs` alone, which left
 * `renderRuns` -- six record fields instead of two, and the `/dispatch runs` surface -- printing raw, and
 * gave this file two rules where the framed panel has one. Every renderer in this file that prints a
 * RECORD field goes through this, and so does `schedulerLine`, which prints a CONFIG pane's key: the
 * carve-out that used to excuse the config panes is gone (issue #382), because "the operator typed it into
 * their own file" turned out not to be a property of the file. `DES-ADMIN-VIA-PI-EXTENSION` now states one
 * rule with no exceptions.
 *
 * Same class and same SUBSTITUTION as the framed panel's `cellOf` (`dashboard.ts`), so the two renderers
 * of one record cannot disagree about what they will print -- deleting instead of substituting would make
 * the panes clip differently. C1 is in the class as well as C0 and DEL, because U+009B is a CSI introducer
 * that needs no ESC in front of it.
 */
function cell(value) {
  if (value === null || value === undefined) return "-";
  return scrubControls(value);
}

/**
 * Render the queue slice of `status`: paused state, the five job counts, and the worker count.
 *
 * The optional second argument (issue #289) names the delayed parts the caller could count from their
 * own sources -- held from the wait index, cron-next from the scheduler list. ABSENT, the output is
 * byte-identical to before the argument existed; a part the caller could not read arrives undefined and
 * is simply not named, so an unreachable source degrades to today's line rather than an invented
 * number. The remainder stays undifferentiated on purpose: the per-job classifier is the thing
 * INT-WAIT-PROFILES-CONTRACT refuses.
 */
export function renderStatus(queue, { heldCount, cronNext } = {}) {
  if (!queue || queue.unreachable) {
    return `Queue: unreachable (${cell(queue?.unreachable ?? "unknown")})`;
  }
  const counts = queue.counts ?? {};
  const line = ["waiting", "active", "paused", "delayed", "failed"]
    .map((k) => `${k} ${counts[k] ?? 0}`)
    .join("  ");
  const delayed = Number(counts.delayed ?? 0);
  const held = Number.isFinite(heldCount) ? heldCount : 0;
  const cron = Number.isFinite(cronNext) ? cronNext : 0;
  const breakdown =
    delayed > 0 && held + cron > 0
      ? `\n  delayed: ${[...(cron > 0 ? [`${cron} cron-next`] : []), ...(held > 0 ? [`${held} held on waitFor`] : []), ...(delayed - cron - held > 0 ? [`${delayed - cron - held} other`] : [])].join(", ")}`
      : "";
  const workers = queue.workers === undefined ? "unknown" : queue.workers;
  // Issue #57: name them when the registry can. `getWorkers()` counts CLIENT LIST rows and reports
  // "unknown" where CLIENT SETNAME is unsupported, so a fleet that has declared its names deserves to see
  // them -- and a deployment that has not is unchanged, because there are no names to show.
  const named = Array.isArray(queue.workerNames) && queue.workerNames.length > 0 ? ` (${queue.workerNames.map(cell).join(", ")})` : "";
  // A half-paused deployment is its own state and must not read as either whole one: `setQueuePaused`
  // can leave one behind if it fails partway through the fleet, and an operator told "running" would
  // walk away from a host that is stopped.
  const state = queue.pausedPartial ? "PARTIALLY paused" : queue.pausedState ? "paused" : "running";
  return [`Queue: ${state}`, `  ${line}${breakdown}`, `  workers: ${workers}${named}`].join("\n");
}

/** The column count of `v` drawn after a space, which is where every cell of `renderRuns` is drawn. */
function afterSpace(v) {
  return columnsOf(" " + v) - 1;
}

/** Render the run history as aligned columns; a null field is "-", an unreachable/empty set degrades. */
export function renderRuns(runs) {
  if (runs && runs.unreachable) return `Runs: unreachable (${cell(runs.unreachable)})`;
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return "No runs recorded.";

  const headers = RUN_COLUMNS.map((c) => c.header);
  // `cell` on the DERIVED value too, which is the whole rule rather than one more site: a `derive` builds
  // its cell out of record fields (`chainDepth`, `replica`, `replicas`) and returned them raw, so the
  // belt covered the columns that did not need it and missed the three that did. Wrapping the output
  // instead of each derive means a column added later cannot reintroduce this, and it costs nothing on
  // the `-` and `r1/2` shapes a derive normally produces.
  const rows = list.map((r) => RUN_COLUMNS.map((c) => cell(c.derive ? c.derive(r) : r?.[c.key])));
  // COLUMNS, not code units (issue #401), and this table is the MODEL-visible channel rather than a pane.
  // `target` is `local:<basename>` for a local run, so an operator's own folder name reaches it, and one
  // CJK character there shifted every later column of that row against the rows around it.
  // AND IN CONTEXT (issue #417): no cell is drawn at column 0. pi draws this message inside a box with one
  // column of padding and the cells are joined by two spaces, so each is measured after a space. A cell
  // that begins with a cluster the renderer counts wider at the start of a string than after a space
  // (`\u0301\uff9e` is 2 there and 1 here) would otherwise shift every later column of its row.
  const widths = headers.map((h, i) => Math.max(columnsOf(h), ...rows.map((row) => afterSpace(row[i]))));
  const fmt = (cells) => cells.map((v, i) => pad(" " + v, widths[i] + 1).slice(1)).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

/**
 * Render the budget across the day/week/month windows, each `reserved / cap [state]`. A cap is only known
 * to the admin when the overlay sets it; otherwise the worker resolves it from its own env/default, which
 * this process cannot read authoritatively, so it renders as unknown rather than a guessed number. The
 * per-window state ("soft-hold" / "over") is computed via the worker's own `windowState` -- the same
 * classifier `reserveBudget` uses -- so the panel and the enforcement cannot drift.
 *
 * The day line always shows (parity with the single-window view). Week/month lines show only when they are
 * actually in play -- the overlay sets their cap, or the window has a non-zero reserved count (an
 * env-configured window the admin can see reserving but whose cap it cannot read). The soft-hold line shows
 * only when the overlay sets `softHoldPct`.
 */
export function renderBudget({ budget, settings } = {}) {
  if (!budget || budget.unreachable) {
    return `Budget: unreachable (${cell(budget?.unreachable ?? "unknown")})`;
  }
  const overlay = (settings && settings.overlay) ?? {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const lines = ["Budget:"];
  for (const w of BUDGET_WINDOWS) {
    const reserved = Number(budget[w.key] ?? 0);
    const cap = overlay[w.capKey];
    if (w.key !== "day" && !Number.isInteger(cap) && reserved === 0) continue; // window not in play
    lines.push(`  ${w.label}: reserved ${reserved} / cap ${capLabel(cap, reserved, pct)}`);
  }
  if (pct !== null) lines.push(`  soft-hold band: ${pct}%`);
  return lines.join("\n");
}

/**
 * Render the scoped limits (issue #242) as plain text: one line per configured row with used/cap per
 * capped window (`-` when the counter read failed) and the config-only concurrency ceiling -- per-scope
 * in-flight is worker-process state, so no live count is ever invented here. Degrades in place on a
 * missing (no lines) or invalid (one error line) file, like renderTriggers.
 */
/**
 * The held-jobs block for the NO-COLOR / non-TTY path (issue #230). Returns null when nothing is held, so
 * the caller adds no empty section.
 *
 * It has to exist for `renderRunList`'s stated reason: this is the renderer a non-TTY panel uses, and "a
 * job is being held, and for how long" must not be a fact only the pretty one tells. Both read the worker's
 * own hashes rather than a delayed job's data, so no `.data` -- no issue title, body or username -- reaches
 * either.
 *
 * THAT IS A PII ARGUMENT AND NOT A CONTROL-BYTE ONE, which this comment used to conflate by calling the
 * cells "host-chosen" (issue #367). Host-chosen is not control-byte-free: an id-only target is derived from
 * forge data and a condition label is whatever the operator typed. The framed row gained a scrub and this,
 * its plain twin, did not -- and the plain twin is the one the UNFRAMED degrade uses, where nothing goes
 * near `frame()` at all, so a belt applied only inside the frame builders misses it entirely.
 *
 * SCRUBBED HERE rather than by the caller, because this function is also exported for the non-TTY panel and
 * a belt that lives in one of two callers is the shape that produced the defect.
 */
export function renderHeldJobs({ held } = {}) {
	if (!held) return null;
	if (held.unreachable) return `unreadable (${cell(held.unreachable)})`;
	const rows = Array.isArray(held.rows) ? held.rows : [];
	if (rows.length === 0) return null;
	const more = Number(held.more) || 0;
	const lines = rows.map((r) => `${cell(r.target ?? r.jobId)}  ${cell(r.label)}  waited ${plainDuration(r.waitedMs)}`);
	if (more > 0) lines.push(`... and ${more} more`);
	return lines.join("\n");
}

/** `?` rather than a fabricated zero when the worker recorded no hold clock. Mirrors the framed twin. */
function plainDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

export function renderScopedLimits({ limits, scopedBudget, projects = null } = {}) {
  if (limits?.invalid) return `Scoped limits: file invalid (${limits.invalid})`;
  const list = Array.isArray(limits?.limits) ? limits.limits : [];
  if (list.length === 0) return null; // nothing configured: say nothing (the mutex needs no line)
  const lines = ["Scoped limits:"];
  list.forEach((l, i) => {
    const used = scopedBudget?.rows?.[i] ?? null;
    const bits = [];
    for (const key of ["day", "week", "month"]) {
      if (!Number.isInteger(l[key])) continue;
      const u = used && Number.isFinite(used[key]) ? used[key] : "-";
      bits.push(`${key} ${u}/${l[key]}`);
    }
    if (Number.isInteger(l.concurrent)) bits.push(`<=${l.concurrent} at once`);
    // Version 2's dollar windows (issues #501, #502): the cap, and what is held or settled when the counter was read.
    for (const key of ["day", "week", "month"]) {
      const cap = l[`${key}Usd`];
      if (typeof cap !== "string") continue;
      const micros = used?.usdMicros?.[key];
      const u = Number.isSafeInteger(micros) && micros >= 0 ? formatMicros(micros) : "-";
      bits.push(`${key} $${u}/$${cap}`);
    }
    // A project row (issue #499 part C): its member count, or that its project is missing (the panel's framed twin).
    if (typeof l.scope === "string" && l.scope.startsWith("project:")) {
      const id = l.scope.slice("project:".length);
      const p = Array.isArray(projects?.projects) ? projects.projects.find((x) => x?.id === id) : undefined;
      if (projects?.unset || (Array.isArray(projects?.projects) && !p)) bits.push("not in projects.json");
      else if (p) bits.push(`${p.members.length} member${p.members.length === 1 ? "" : "s"}`);
    }
    lines.push(`  ${l.scope}: ${bits.join(" · ")}`);
  });
  return lines.join("\n");
}

/** One window's cap + state suffix: the overlay cap and its classified state, or the unknown-cap notice. */
function capLabel(cap, reserved, pct) {
  if (!Number.isInteger(cap)) return "unknown (worker env/default)";
  const state = windowState(reserved, cap, pct);
  return state === "ok" ? `${cap} (overlay)` : `${cap} (overlay) [${state}]`;
}

/**
 * Render just the schedulers block: a header and one line per resident scheduler with its next fire time
 * and next-drift. `overdueMs` surfaces the silent under-firing BullMQ's no-overlap scheduler can hide
 * (design.md:249). An unreachable read or an empty set degrades in place rather than throwing.
 */
export function renderSchedulers(schedulers) {
  const out = ["Schedulers:"];
  if (schedulers && schedulers.unreachable) {
    out.push(`  unreachable (${cell(schedulers.unreachable)})`);
  } else {
    const list = Array.isArray(schedulers) ? schedulers : [];
    if (list.length === 0) out.push("  (none configured)");
    else for (const s of list) out.push(`  ${schedulerLine(s)}`);
  }
  return out.join("\n");
}

/**
 * The skills dir's last path segment, the ONE rule both trigger surfaces badge with (issue #482): either
 * separator, so a win32 path names its folder too, and a trailing separator ignored. A dir with no segment
 * at all (`"/"`) reads `-`, this module's absence mark, where it used to print `undefined`.
 */
export function skillsBasename(dir) {
  return String(dir).split(/[\\/]/).filter(Boolean).pop() ?? "-";
}

/**
 * A trigger display record with every string field, and every string in an array field, through
 * `scrubControls` (issue #482). Applied where EVERY trigger renderer begins -- this module's
 * `renderTriggers`, and the panel's LIST row and TRIGGER_DETAIL -- which is the rule rather than a list of
 * sites. The panes' gate cannot cover this class: it keeps an SGR run BECAUSE the styler emits them, so an
 * SGR run inside a label, a phrase, an image tag or a secrets profile painted the pane and, since the gate
 * runs after the line was measured, pushed it past the frame; and the unframed degrade, which substitutes
 * only a bare ESC, printed it raw. Shallow on purpose: the one nested value, `disarmed`, is printed only as
 * `[spent]` here and through the panel's scrubbing `spentMark` there. Exported for the panel, not re-spelled.
 */
export function scrubTrigger(t) {
  if (!t || typeof t !== "object") return t;
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    out[k] = typeof v === "string" ? scrubControls(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? scrubControls(x) : x)) : v;
  }
  return out;
}

/**
 * Render triggers display-only (OQ-008): the schedulers block, then the committed unified `triggers.json`
 * as a discriminated list -- cron, label, comment, and pull_request entries each on their own line.
 */
export function renderTriggers({ schedulers, triggers } = {}) {
  const out = [renderSchedulers(schedulers), "", "Triggers:"];
  if (triggers && triggers.missing) {
    out.push("  (triggers file not found)");
  } else if (triggers && triggers.invalid) {
    out.push(`  (triggers file invalid: ${triggers.invalid})`);
  } else {
    const list = (triggers && triggers.triggers) ?? [];
    if (list.length === 0) out.push("  (no triggers)");
    else for (const t of list) out.push(`  ${triggerLine(scrubTrigger(t))}`);
  }
  return out.join("\n");
}

/**
 * One trigger's display line, discriminated on `type`. A null field reads as "-".
 *
 * A webhook trigger listening to a forge other than github names it. GitHub is unmarked, so an existing
 * deployment's lines are byte-identical -- but the marker is not cosmetic: two rules can select the same
 * label on two forges, and which one a line describes is otherwise unreadable.
 *
 * A trigger that loads the operator-staged third-party pi packages carries a trailing `[packages]` marker:
 * it must never read the same as one that does not. Loading is the DEFAULT (`run.packages` is an opt-out),
 * so the marker is the common case once the operator has staged anything, and its absence means the trigger
 * carries an explicit `run.packages: false`. Lines without it are byte-identical to before -- the marker is
 * purely additive.
 *
 * A trigger running a non-default image carries its tag too, for a sharper reason than packages: which image
 * a job runs IS which code it runs. A trigger on the deployment default renders byte-identically -- the
 * suffix is empty and appended last.
 */
function triggerLine(t) {
  const flow = t?.flow ?? commandSlashLabel(t) ?? "-";
  const forge = t?.forge && t.forge !== "github" ? `  [${t.forge}]` : "";
  const pkgs = t?.packages === true ? "  [packages]" : "";
  const img = t?.image ? `  [image ${t.image}]` : "";
  // A trigger that PERSISTS the agent's working history to disk says so. Without this badge it renders
  // identically to one that does not, which is the defect 0.1.4 fixed for [packages] arriving in a new
  // field -- and a transcript is a bigger disclosure than staged packages are.
  // A trigger whose jobs load operator-authored skills from the host says which directory (issue #60).
  // Same doctrine as [resume] and [image]: it must never render the same as one that does not, because
  // choosing the skills IS choosing what the agent can do. The BASENAME only, so the line stays skimmable;
  // the full path lives in the trigger detail view, where the panel is the operator's own session on their
  // own host and a path discloses nothing new.
  const skl = t?.skillsDir ? `  [skills ${skillsBasename(t.skillsDir)}]` : "";
  // A trigger that puts operator standing text into every job's prompt says so. Same doctrine as the
  // badges above: a trigger that changes what the agent is told must never render like one that does not.
  const ins = t?.instructions === true ? "  [instructions]" : "";
  const res = t?.resume === true ? "  [resume]" : "";
  // A trigger that turns one delivery into N paid runs says so (REQ-REPLICA-RUNS). Same class of badge as
  // [resume]: not a preference an operator can skim past, but the field that multiplies the bill. Absent on
  // an unreplicated trigger, appended last, so every existing line is byte-identical.
  const rep = t?.replicas > 1 ? `  [x${t.replicas}]` : "";
  // A trigger that hands its job live vault credentials says so, and it is the badge with the strongest
  // claim to being here: [image] and [skills] change what the agent CAN DO, this changes what it can REACH.
  // The COUNT and the profile name, never the references -- the reference list is the map of the operator's
  // vault. Appended last, absent when unbound, so every existing line is byte-identical.
  const sec = t?.secrets > 0 ? `  [secrets ${t.secrets}${t.secretsProfile ? ` via ${t.secretsProfile}` : ""}]` : "";
  // The two sides of a one-shot's life (issue #231), on the close-capable kinds only -- they are the
  // only records that can carry the fields. [once] on an ARMED one-shot: like [x N] it changes what a
  // rule can spend, here narrowing it to a single future run, so it must not render like a standing
  // rule. [spent] on a disarmed one: the read model renders the RAW file on purpose ("why did nothing
  // fire" needs the spent row in front of the operator), and a spent rule rendering like an armed one
  // is the exact confusion that choice would otherwise buy. Mutually exclusive by construction -- the
  // worker only ever disarms a once rule -- and absent otherwise, so every existing line is
  // byte-identical.
  const shot = t?.disarmed ? "  [spent]" : t?.once === true ? "  [once]" : "";
  // The two spend narrowings no tool can set (issues #501 and #502): which models the trigger's jobs may call, and
  // its per-job dollar cap. Listed in full: the models a job can reach are not a fact to summarize as a count.
  // Absent when unset, appended last, so every existing line is byte-identical.
  const pol = `${Array.isArray(t?.models) && t.models.length > 0 ? `  [models ${t.models.join(", ")}]` : ""}${t?.maxCostUsd ? `  [max $${t.maxCostUsd}]` : ""}`;
  // A portfolio trigger (issue #505) says so (issue #507): its jobs write the budget split every other project spends
  // under, and a trigger that sets the split must not read like one that only spends inside it. Cron only (the loader
  // refuses it elsewhere), the panel row's text (#482 parity), appended last so every other line is byte-identical.
  const pfo = t?.portfolio === true ? "  [portfolio]" : "";
  switch (t?.type) {
    case "cron":
      return `cron  ${t.id ?? "-"}  ${t.pattern ?? "-"} → ${t.folder ?? "-"}/${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${pol}${pfo}`;
    case "label":
      return `label  ${ruleClauses(t) || "(no selector)"} → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${pol}`;
    case "comment":
      return `comment  "${t.phrase ?? "-"}" → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${pol}`;
    case "pull_request": {
      const clauses = ruleClauses(t);
      const action = `action[${(t.action ?? []).join(",")}]`;
      // A close-only rule's `#<n>` narrowing renders exactly as the issue arm's does (issue #231): a
      // one-shot on PR #40 that renders like "every close" hides exactly what the operator armed.
      const num = Number.isInteger(t.number) ? ` #${t.number}` : "";
      return `pull_request  ${action}${num}${clauses ? ` ${clauses}` : ""} → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${pol}${shot}`;
    }
    case "issue": {
      // pull_request's shape with `#<n>` in the clause slot (issue #231): this plain line and the colored
      // dashboard row must state the same facts -- renderRunList's rule, the monochrome surface must not
      // silently tell a different story than the colored one -- and an issue rule's only clause is the
      // item number it may be narrowed to.
      const action = `action[${(t.action ?? []).join(",")}]`;
      const num = Number.isInteger(t.number) ? ` #${t.number}` : "";
      return `issue  ${action}${num} → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${pol}${shot}`;
    }
    default:
      return "(unknown trigger)";
  }
}

/**
 * The `/name` display token for a command trigger (issue #189, `run.command`), or null when the entry
 * carries no command. It renders in the flow position: the shared parser makes flow and command mutually
 * exclusive, so the column never has to hold both, and the slash marks "dispatches a registered extension
 * command" apart from a flow at a glance. The NAME only (the first space-delimited token, pi's own
 * dispatch grammar) so the line stays skimmable, the [skills basename] doctrine restated; the args belong
 * in the detail view. Exported as the one vocabulary (issue #188): the list line here, the TUI's target
 * column and the drill-in header must not drift on what a command trigger is called.
 */
export function commandSlashLabel(t) {
  return typeof t?.command === "string" && t.command.trim() !== "" ? `/${t.command.trim().split(/\s+/)[0]}` : null;
}

function ruleClauses(rule) {
  const clauses = [];
  for (const key of ["any", "all", "none"]) {
    const members = rule?.[key] ?? [];
    if (members.length > 0) clauses.push(`${key}[${members.join(",")}]`);
  }
  return clauses.join(" ");
}

function schedulerLine(s) {
  // THROUGH `cell`, because a scheduler key is read back from Valkey and nothing re-validates it on read
  // (issue #382, item 2). Defence in depth, not a live leak: the worker restricts a cron `on.id` to
  // `[A-Za-z0-9._-]+` before the upsert, so a key that arrives here with a control byte in it came from a
  // writer that is not the worker.
  const id = cell(s?.key ?? s?.name ?? "-");
  const next = typeof s?.next === "number" ? new Date(s.next).toISOString() : "no next";
  const drift =
    typeof s?.overdueMs === "number" && s.overdueMs > 0 ? `  overdue by ${Math.round(s.overdueMs / 1000)}s` : "";
  return `${id}  next ${next}${drift}`;
}

/**
 * Render one `whatIfFlow` estimate (costs.mjs) as a compact block. The measured path shows the estimate
 * through `fmtCost` with its coverage/excluded honesty and the rates version; the zero-knowledge path
 * shows the seeded band verbatim -- both bounds through `fmtCost`'s seeded shape, plus the fold's own
 * note -- so an unmeasured flow can never read like a measurement.
 */
export function renderWhatIf(result, { flow, target } = {}) {
  const head = `What-if ${flow} @ ${target}:`;
  if (!result || typeof result !== "object") return `${head}\n  no estimate`;
  if (result.class === "seeded") {
    return [
      head,
      `  no ledgered run to measure from — seeded band ${fmtCost({ usd: result.low, class: "seeded" })} to ${fmtCost({ usd: result.high, class: "seeded" })} · ${result.note}`,
    ].join("\n");
  }
  const pct = Math.round((result.coverage ?? 0) * 100);
  return [
    head,
    `  estimate ${fmtCost({ usd: result.usd, class: "estimated" })} total · ${fmtCost({ usd: result.perRun, class: "estimated" })} per run`,
    `  coverage ${pct}% of observed runs ledgered · excluded ${result.excluded} (no ledger)`,
    `  rates pi-ai ${result.ratesVersion ?? "unknown"}`,
  ].join("\n");
}

/** Render the settings overlay view: every overlay key, unset ones marked, or the fail-closed invalid reason. */
export function renderSettingsView(settings) {
  const path = settings?.path ?? "(unknown path)";
  if (settings && settings.invalid) return `Settings (${path}): invalid: ${settings.invalid}`;
  const overlay = (settings && settings.overlay) ?? {};
  const out = [`Settings (${path}):`];
  for (const key of KNOWN_KEYS) {
    const v = overlay[key];
    out.push(`  ${key}: ${v === undefined ? "(unset)" : v}`);
  }
  return out.join("\n");
}

/**
 * `/dispatch priorities` (issue #504 part C): the envelope, the applied split with what each entry spent and holds in
 * the envelope window, and the newest outcomes. NO reason text: this view goes to the PII-free channel, which reaches
 * model context, and a plan's reasons are agent text (`REQ-DELEGATED-ALLOCATION`); the panel's allocation view is the
 * one place they are drawn. `alloc` is `readAllocations`' result read WITHOUT reasons; `problem` says why there is no
 * envelope. Every amount is integer micro-dollars, shown in dollars.
 */
export function renderAllocations({ envelope = null, digest = null, problem = null, alloc = null, historyRows = 10 } = {}) {
  // `>= 0` as the panel's `usd` has it: `formatMicros` throws on a negative, and a counter another writer set below 0
  // made this whole view throw instead of showing "-" for the one cell.
  const usd = (m) => (Number.isSafeInteger(m) && m >= 0 ? `$${formatMicros(m)}` : "-");
  if (!envelope) return `ALLOCATION\n${cell(problem ?? "no envelope")}`;
  const d = envelope.delegation ?? {};
  const rules = d.enabled ? `delegation on (${(d.writers ?? []).join(", ")}; step ${d.maxStepPct}%, interval ${d.minIntervalHours}h, plans up to ${d.maxPlanDays}d)` : "delegation off";
  const lines = [`ALLOCATION · ${envelope.window} · total ${usd(envelope.totalMicros)} · ${rules}`, `envelope ${cell(digest)}`];
  if (!alloc) return lines.join("\n");
  if (alloc.unreachable) return [...lines, `split unreadable (${cell(alloc.unreachable)})`].join("\n");
  const s = alloc.state;
  if (alloc.stateProblem === "newer") lines.push("the applied split was written by a newer pi-dispatch: upgrade this console");
  else if (alloc.stateProblem === "unreadable") lines.push("the applied split does not decode; the next pickup replaces it with the neutral split");
  else if (!s) lines.push("no split applied yet: the first host to look writes the neutral split");
  if (s) {
    const plan = s.planId ? `plan ${cell(s.planId)}` : "neutral (no plan)";
    // The panel's plan line word for word (issue #507), the instant through `allocAt` and the expiry as its date, so it
    // fits 80 columns with the longest writer; `clamped` gets its own line, where no width can cut it.
    lines.push(`${plan} · ${cell(s.writer)} · ${allocAt(s.appliedAt)}${s.validUntil ? ` · until ${sliceColumns(cell(s.validUntil), 10)}` : ""}`);
    if (s.clamped) lines.push("  clamped by the step");
    if (s.envelopeDigest !== digest) lines.push(`made for envelope ${cell(s.envelopeDigest)}, not this host's: governed jobs here refuse as envelope-mismatch`);
    // The panel's outside-edit notice, by the same rule and in the same words (issue #507).
    const edit = outsideEdit(alloc.log, s.envelopeDigest);
    if (edit) lines.push(cell(outsideEditText(edit)));
  }
  const rows = Object.keys(envelope.floors).map((id) => [
    id,
    `floor ${usd(envelope.floors[id])}`,
    `weight ${s?.weights?.[id] ?? envelope.defaultWeights?.[id] ?? "-"}`,
    `allocation ${usd(s?.allocations?.[id])}`,
    `spent ${usd(alloc.spend?.projects?.[id]?.micros)}`,
  ]);
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  for (const r of rows) lines.push(`  ${r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd()}`);
  // The headroom beside the envelope it is headroom of (issue #507): the deployment's spend against the total.
  if (s) lines.push(`  unallocated ${usd(s.unallocated)} · deployment spent ${usd(alloc.spend?.deployment?.micros)} of ${usd(envelope.totalMicros)}`);
  const history = Array.isArray(alloc.log) ? alloc.log.slice(0, historyRows) : [];
  if (history.length > 0) {
    lines.push("history (newest first):");
    const hosts = allocHostsShown(history);
    for (const h of history) {
      const why = h.reason ? ` ${cell(h.reason)}${h.field ? ` (${cell(h.field)}: ${cell(h.rule)})` : ""}` : "";
      lines.push(`  ${allocAt(h.at)}  ${hosts ? `${allocHost(h.host)}  ` : ""}${cell(h.writer)}  ${h.planId ? `${allocPlanId(h.planId)}  ` : ""}${cell(h.outcome)}${why}${h.clamped ? "  clamped" : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * The cells of an `alloc:log` history row, shared by this text and the panel's `b` view (issue #507), so the two cannot
 * disagree about what a row says. A row is the instant, the host when it tells rows apart, the writer, the plan id, and
 * the outcome with its enum reason, in that order: the reason is the longest cell and the one a reader needs least, so
 * where a row is wider than its line (the panel clips; an `envelope-changed-externally envelope-mismatch` row is 87
 * columns on one host) the cut takes the reason's tail, never the plan id. With the full ISO instant and id first, a
 * refusal ran to 85 columns and the panel clipped the plan id off the end of every refusal row.
 *
 * The instant as `MM-DD HH:MM`, in UTC as written: a split is planned in days and the year is the one on the screen.
 * A value that is not an ISO instant (a row another writer set) is shown as its first 11 columns, never parsed.
 */
export function allocAt(at) {
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(at ?? ""));
  return m ? `${m[1]} ${m[2]}` : sliceColumns(cell(at), 11);
}

/**
 * The outside-edit notice (issue #504 part C's banner, one rule since issue #507 for the panel's `b` view, `/dispatch
 * priorities` and the insights page): the NEWEST `envelope-changed-externally` row in `log` (newest first, as
 * `alloc:log` is read), when the envelope digest it reports is not the one the applied split was made for. Returned as
 * its facts, `{ digest, at, split }` (8-hex digests and an `MM-DD HH:MM` instant), or null; `outsideEditText` words it.
 *
 * Historical on purpose: a host logs each digest once per process, so the log cannot say whether that host still runs
 * the edited file, nor see a hand restore; a later applied plan or a re-base to a third digest says nothing about the
 * host that refused either. The notice states what a host reported and when, and what follows for a host still on it.
 * Rejected: the earlier "newer than the last re-base or applied plan" rule, which cleared while that host still
 * refused and stayed after the edit was put back.
 */
export function outsideEdit(log, splitDigest) {
  if (typeof splitDigest !== "string" || splitDigest === "") return null;
  const row = (Array.isArray(log) ? log : []).find((r) => r?.outcome === "envelope-changed-externally");
  if (!row || typeof row.envelopeDigest !== "string" || row.envelopeDigest === splitDigest) return null;
  const hex8 = (d) => (/^[0-9a-f]{8}/.test(d) ? d.slice(0, 8) : "?");
  return { digest: hex8(row.envelopeDigest), at: allocAt(row.at), split: hex8(splitDigest) };
}

/** The outside-edit notice in words, the same on every surface. */
export function outsideEditText(e) {
  return `a host reported envelope ${e.digest} at ${e.at}, not the one the split was made for (${e.split}); a host still on it refuses governed jobs as envelope-mismatch`;
}

/**
 * Whether the host column earns its place: only when the rows shown name more than one host. On one host it says the
 * same word on every row and costs a sixth of the line; on a fleet it is what tells two hosts' refusals apart.
 */
export function allocHostsShown(rows) {
  const hosts = new Set((Array.isArray(rows) ? rows : []).map((r) => (typeof r?.host === "string" ? r.host : "")));
  return hosts.size > 1;
}

/** A row's host, cut to 10 columns with the ellipsis (a host name is the operator's, and its tail is rarely the part that differs). */
export function allocHost(host) {
  return clip(cell(host ?? "-"), 10);
}

/**
 * A row's plan id as its first 8 hex digits, the git short-id idiom: 16 is the content hash, 8 still tells the rows of
 * one history apart, and the full id stays on the applied-plan line, in `dispatch_allocations` and in the audit file.
 */
export function allocPlanId(id) {
  return sliceColumns(cell(id), 8);
}
