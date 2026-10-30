/** Read-only rule discovery and hypothetical matching, using the published Triggers cards (#750). */
import {
  CHECK_EVENTS,
  CHECK_ACTORS,
  CHECK_PR_AUTHORS,
  CHECK_REVIEW_BODIES,
  CHECK_REVIEW_STATES,
  CHECK_PR_ACTIONS,
  CHECK_LIMITS,
} from "../../trigger-check.mjs";
import { TRIGGER_LIST_KINDS } from "../../trigger-list.mjs";
import { triggerWhoMayFire } from "../../trigger-policy.mjs";
import { fmtCost } from "../../panel.mjs";
import { outcomeWord, recordReason, reasonWords } from "../../words.mjs";
import { html as escapedHtml } from "../html.mjs";
import * as ui from "../kit.mjs";
import { timeHtml, ageText, shownPath, runLink } from "./common.mjs";
const html = (strings, ...values) =>
  escapedHtml(
    strings.map((s) => s.replace(/[ \t]*\n[ \t]*/g, "\n")),
    ...values,
  );
const DAY = 86_400_000;
const KIND = Object.freeze({
  cron: ["clock", "Schedule"],
  label: ["tag", "Label"],
  comment: ["comment", "Comment"],
  pull_request: ["pr", "Pull request"],
  issue: ["issue", "Issue closed"],
});
const CHIP = Object.freeze({
  "costs-more": ["attention", "spend", "Costs more"],
  reaches: ["attention", "globe", "Reaches"],
  writes: ["attention", "edit", "Writes"],
  asks: ["parked", "parked", "Asks"],
  narrows: ["running", "fit", "Narrows"],
  spent: ["idle", "done", "Spent"],
});
const GROUP = Object.freeze({
  schedule: "On a schedule",
  github: "From GitHub",
  gitlab: "From GitLab",
  forgejo: "From Forgejo",
  azure: "From Azure DevOps",
  unknown: "Other rules",
});
const FILTER = Object.freeze({
  all: "All",
  schedule: "Schedules",
  label: "Labels",
  comment: "Comments",
  pull_request: "Pull requests",
  issue: "Issues",
});
const card = (title, body, options = {}) =>
  ui.card({ title, body, ...options });
const modelOf = (v) => v.data?.triggerList ?? null;
const ruleHref = (v, index) =>
  ui.pageHref(v.pages, "trigger", { index }) ??
  `/config/trigger?index=${index}`;
const rowsOf = (v) => {
  const rows = modelOf(v)?.rows ?? [];
  const kind = v.query?.kind ?? "all";
  return kind === "all"
    ? rows
    : rows.filter(
        (r) => r.trigger.type === (kind === "schedule" ? "cron" : kind),
      );
};
const countText = (number, incomplete = false) =>
  number == null || (number === 0 && incomplete)
    ? "unknown"
    : `${incomplete ? "at least " : ""}${number}`;
const costText = (stats) =>
  stats?.weekCost && !(stats.incomplete && stats.weekRuns === 0)
    ? `${fmtCost(stats.weekCost)}${stats.incomplete || stats.costIncomplete ? " (retained or partially metered history)" : ""}`
    : "unknown spend";
const atOf = (r) => Date.parse(r?.endedAt ?? r?.startedAt ?? "");
const shortList = (values) =>
  Array.isArray(values) && values.length ? values.join(", ") : "none";

export function triggersDescription(v) {
  return v.role === "viewer"
    ? "What starts a job, in plain words. Rules from the triggers file."
    : `What starts a job, in plain words. Rules in ${v.data?.configLocations?.triggers ?? "the triggers file"}.`;
}
export function triggersNavigation(v) {
  const counts = modelOf(v)?.counts;
  return html`<nav class="tabs tr-tabs" aria-label="Triggers views">
    <a
      href="/triggers"
      aria-current="${v.page === "trigger-check" ? "false" : "page"}"
      >${ui.icon("runs", { size: "sm" })}Rules
      <span class="count">${counts?.all ?? "?"}</span></a
    ><a href="${ui.pageHref(v.pages, "watch") ?? "/watch"}"
      >${ui.icon("eye", { size: "sm" })}Watch
      <span class="count">${counts?.watch ?? "?"}</span></a
    ><span class="tr-tab-unavailable" aria-disabled="true"
      >${ui.icon("flows", { size: "sm" })}Dispatchers
      <span class="count">proposed</span></span
    >
  </nav>`;
}
export function triggersViewer(v) {
  return v.role === "viewer"
    ? html`<p class="collapsed tr-viewer">
        ${ui.icon("eye", { size: "sm" })}<b>Viewer.</b> You can read every rule
        and check a hypothetical event. Adding and changing rules is for
        operators.
      </p>`
    : v.readOnly
      ? html`<p class="collapsed tr-viewer">
          ${ui.icon("shield", { size: "sm" })}Changes are off. The event checker
          only reads and remains available.
        </p>`
      : html``;
}
export function triggersCount(v) {
  const m = modelOf(v),
    c = m?.counts;
  return card(
    "Set up",
    html`${ui.kpi(c?.all ?? "?", "rules")}
      <p class="tr-kp">
        ${c?.schedule ?? "?"} on a schedule,
        ${c?.all == null || c?.schedule == null ? "?" : c.all - c.schedule} from
        forges; ${c?.spent ?? "?"} spent one-shots.
      </p>
      ${(m?.problems ?? []).map(
        (p) =>
          html`<p class="tr-problem">
            ${ui.icon("attention", { size: "sm" })}${p}
          </p>`,
      )}`,
  );
}
export function triggersNext(v) {
  const m = modelOf(v),
    n = m?.next;
  return card(
    "Next to fire",
    n
      ? html`${ui.kpi(ageText(n.at - m.now), `until ${n.id}`)}
          <p class="tr-kp">
            ${timeHtml(n.at)} ·
            <a href="${ruleHref(v, n.index)}">row ${n.index + 1}</a>
          </p>`
      : html`<p class="tr-empty">
          No next fire is published. Check the schedule's owning worker and its
          doctor result.
        </p>`,
  );
}
export function triggersSpend(v) {
  const m = modelOf(v);
  return card(
    "Recorded this UTC week",
    html`${ui.kpi(
        m?.stats?.weekCost && !(m.stats.incomplete && m.stats.weekRuns === 0)
          ? fmtCost(m.stats.weekCost)
          : "unknown",
        "attributed to these rules",
      )}
      <p class="tr-kp">
        ${countText(m?.stats?.weekRuns, m?.stats?.incomplete)} run records since
        ${m?.weekStart == null
          ? "the start of this UTC week"
          : timeHtml(m.weekStart)}.
        ${m?.stats?.incomplete || m?.stats?.costIncomplete
          ? "Coverage is retained or partially metered history. "
          : ""}Shared
        flows alone never attribute a run.
      </p>`,
  );
}
export function triggersFilters(v) {
  const c = modelOf(v)?.counts;
  return html`<nav class="tr-filters" aria-label="Show rules">
    ${TRIGGER_LIST_KINDS.map((kind) =>
      ui.fpill({
        label: FILTER[kind],
        count: typeof c?.[kind] === "number" ? c[kind] : null,
        href: kind === "all" ? "/triggers" : `/triggers?kind=${kind}`,
        on: (v.query?.kind ?? "all") === kind,
      }),
    )}
  </nav>`;
}
function labelPredicate(t) {
  const clauses = [
    t.any?.length
      ? html`any of <span class="code">${shortList(t.any)}</span>`
      : null,
    t.all?.length
      ? html`all of <span class="code">${shortList(t.all)}</span>`
      : null,
    t.none?.length
      ? html`none of <span class="code">${shortList(t.none)}</span>`
      : null,
  ].filter(Boolean);
  return html`${clauses.map((clause, i) => html`${i ? " and " : ""}${clause}`)}`;
}
function whenOf(t) {
  if (t.type === "cron")
    return html`Schedule
      <span class="code">${t.pattern ?? "unknown pattern"}</span>`;
  if (t.type === "comment")
    return html`A comment contains
      <span class="code">${t.phrase ?? "an unavailable phrase"}</span>`;
  if (t.type === "label")
    return html`An issue has labels matching ${labelPredicate(t)}`;
  return html`${t.type === "issue" ? "An issue" : "A pull request"}${t.number
      ? html` <span class="code">#${t.number}</span>`
      : null}
    has action <span class="code">${shortList(t.action)}</span>${t.reviewState
      ?.length
      ? html`, verdict <span class="code">${shortList(t.reviewState)}</span>`
      : null}${t.any?.length || t.all?.length || t.none?.length
      ? html`, with labels on labeled deliveries matching ${labelPredicate(t)}`
      : null}`;
}
function goodToKnow(t) {
  if (t.disarmed)
    return "This one-shot matches nothing now. Remove on.disarmed in the triggers file to arm it again; keeping the row preserves its history number.";
  if (t.type === "comment")
    return "A comment can select another declared flow. It still uses this comment rule's options and reviewed constraints.";
  if (t.forge === "github" && t.type === "label")
    return "GitHub matches the issue's whole label set. Re-labelling or reopening can start another paid run, including each configured replica.";
  if (t.forge === "gitlab" && t.type === "pull_request")
    return "On GitLab, changing labels counts as an update. A merge does not fire a close rule.";
  if (t.forge === "azure" && t.type === "pull_request")
    return "Azure pull request actions use created or updated. Pull request labels and close-only actions are not available.";
  return null;
}
function ruleRow(v, r) {
  const t = r.trigger,
    [glyph, word] = KIND[t.type] ?? ["info", "Rule"],
    last = r.lastRun;
  const outcome = last ? outcomeWord(last.outcome, recordReason(last)) : null;
  const note = goodToKnow(t),
    next = r.nextFire;
  const hostNames = r.nextFire?.hosts ?? [];
  return html`<li class="tr${t.disarmed ? " tr--spent" : ""}">
    <span class="tr-n" aria-label="Row ${r.index + 1}">${r.index + 1}</span>
    <div class="tr-when">
      <span class="tile tile--sm tr-kind">${ui.icon(glyph)}</span>
      <div>
        <p class="tr-k">${word}</p>
        <p class="tr-s"><a href="${ruleHref(v, r.index)}">${whenOf(t)}</a></p>
        <p class="tr-sub">
          ${t.type === "cron"
            ? html`In
                <span class="code"
                  >${shownPath(t.folder) ?? "an unpublished folder"}</span
                >;
                ${hostNames.length
                  ? html`on ${hostNames.join(", ")}`
                  : "owning host not published"}${next?.zone
                  ? html`; schedule zone ${next.zone}`
                  : null}`
            : html`${triggerWhoMayFire(t)}
              ${t.repository
                ? html`In <span class="code">${t.repository}</span>.`
                : "In repositories wired to this deployment."}`}
        </p>
      </div>
    </div>
    <span class="tr-arrow" aria-hidden="true">${ui.icon("chev-r")}</span>
    <div class="tr-then">
      <p class="tr-s">
        runs
        <span class="tr-flow"
          >${ui.icon(t.command ? "terminal" : "skill", {
            size: "sm",
          })}${t.command ?? t.flow ?? "deployment entrypoint"}</span
        >
      </p>
      <p class="tr-sub">
        ${[t.provider, t.model].filter(Boolean).join(" / ") ||
        "deployment default model"}
        · ${t.backend ?? "each host's default"} venue
      </p>
      <p class="tr-chips">
        ${r.chips.map((c) => {
          const [status, icon, label] = CHIP[c.kind] ?? [
            null,
            "info",
            "Option",
          ];
          return ui.chip(`${label}: ${c.text}`, { status, icon });
        })}
      </p>
    </div>
    <div class="tr-status">
      ${last
        ? html`<p>
              ${ui.badge(
                outcome?.known ? outcome.status : "failed",
                outcome?.word ?? last.outcome ?? "unknown",
              )}${timeHtml(atOf(last))}
            </p>
            <p class="tr-sub">
              ${runLink(last.jobId)}${last.project
                ? html` · ${ui.ptag(last.project)}`
                : null}
            </p>
            ${recordReason(last)
              ? html`<p class="tr-sub">
                  ${reasonWords(recordReason(last)).sentence ??
                  "No explanation is available for the recorded reason."}
                </p>`
              : null}`
        : html`<p class="tr-sub">
            ${r.stats.runs30d == null
              ? "Last run unavailable"
              : "No run in retained history"}
          </p>`}${next
        ? html`<p class="tr-next">
              Next: ${next.at === null ? "unknown" : timeHtml(next.at)} ·
              ${next.health === "on-time" ? "on time" : next.health} · stalls
              ${next.stalls ?? "unknown"} of ${next.stallLimit}
            </p>
            ${next.problem
              ? html`<p class="tr-problem">${next.problem}</p>`
              : null}`
        : null}
      <p class="tr-sub">
        ${countText(r.stats.runs30d, r.stats.incomplete)} runs in 30 days ·
        ${costText(r.stats)} this UTC week
      </p>
      ${r.unknown.map((p) => html`<p class="tr-problem">${p}</p>`)}
    </div>
    <a
      class="tr-open btn btn--sm btn--ghost"
      href="${ruleHref(v, r.index)}"
      aria-label="Open row ${r.index + 1}"
      >${ui.icon("chev-r", { size: "sm" })}</a
    >${note
      ? html`<p class="tr-note tr-note-desktop">
            ${ui.icon("info", { size: "sm" })}<span>${note}</span>
          </p>
          <details class="tr-note tr-note-phone">
            <summary>${ui.icon("info", { size: "sm" })}Good to know</summary>
            <p>${note}</p>
          </details>`
      : null}
  </li>`;
}
function groupPanel(v, key) {
  const rows = rowsOf(v).filter(
    (r) =>
      r.group === key || (key === "unknown" && !Object.hasOwn(GROUP, r.group)),
  );
  if (!rows.length) return html``;
  return card(
    GROUP[key],
    html`<ol class="tr-list">
      ${rows.map((r) => ruleRow(v, r))}
    </ol>`,
    {
      flush: true,
      sub: `${rows.length} ${rows.length === 1 ? "rule" : "rules"}`,
    },
  );
}
export function triggersSchedules(v) {
  return groupPanel(v, "schedule");
}
export function triggersGithub(v) {
  return groupPanel(v, "github");
}
export function triggersGitlab(v) {
  return groupPanel(v, "gitlab");
}
export function triggersForgejo(v) {
  return groupPanel(v, "forgejo");
}
export function triggersAzure(v) {
  return groupPanel(v, "azure");
}
export function triggersUnknown(v) {
  const rows = rowsOf(v);
  if (!modelOf(v))
    return card(
      "Rules unavailable",
      html`<p>
        The deployment's rule facts could not be read. Reload and check
        pi-dispatch doctor.
      </p>`,
    );
  if (!rows.length)
    return card(
      "Rules",
      html`<p>
        ${modelOf(v).problems?.length
          ? "No rule can be shown from the available file."
          : "No rule matches this filter."}
      </p>`,
    );
  return groupPanel(v, "unknown");
}
function pct(at, w) {
  return Number.isFinite(at) && w.end > w.start
    ? Math.max(
        0,
        Math.min(100, ((at - w.start) / (w.end - w.start)) * 100),
      ).toFixed(3)
    : "0";
}
export function triggersWeek(v) {
  const m = modelOf(v),
    w = m?.week;
  if (!w)
    return card(
      "When schedules fire",
      html`<p>Schedule and quiet-window projections are unavailable.</p>`,
    );
  const lanes = [
    ...w.lanes.map((l) => ({
      kind: "schedule",
      name: `${l.index + 1} · ${l.id}`,
      sub: l.zone ?? "zone unknown",
      ...l,
    })),
    ...w.quiet.map((q) => ({
      kind: "quiet",
      name: `Quiet: ${shownPath(q.scope)}`,
      sub:
        q.affects === "forge"
          ? "forge jobs only"
          : q.affects === "local"
            ? "local folder jobs, including schedules"
            : "all matching jobs, including schedules",
      ...q,
    })),
  ];
  const height = Math.max(36, lanes.length * 36),
    future = m.rows
      .filter((r) => r.nextFire?.at != null && r.nextFire.at >= m.now)
      .sort((a, b) => a.nextFire.at - b.nextFire.at);
  return card(
    "When schedules fire",
    html`<div class="tr-week-desktop">
        <div class="wk-scroll">
          <div class="wk">
            <div class="wk-labels">
              ${lanes.map(
                (l) => html`<p><b>${l.name}</b><span>${l.sub}</span></p>`,
              )}
            </div>
            <div class="wk-track">
              <svg
                class="wk-svg"
                height="${height + 28}"
                role="img"
                aria-label="${`Seven-day UTC projection: ${w.lanes.length} schedules and ${w.quiet.length} quiet windows. Filled dots are recorded runs; outlined dots are future fires.`}"
              >
                ${lanes.map(
                  (l, i) =>
                    html`<rect
                        class="wk-band"
                        x="0"
                        y="${i * 36 + 5}"
                        width="100%"
                        height="26"
                        rx="13"
                      />${l.kind === "schedule"
                        ? l.occurrences.map(
                            (t) =>
                              html`<circle
                                class="${t.kind === "ran"
                                  ? "wk-ran"
                                  : "wk-next"}"
                                cx="${pct(t.at, w)}%"
                                cy="${i * 36 + 18}"
                                r="6"
                                ><title>
                                  ${t.kind === "ran"
                                    ? "Recorded run"
                                    : "Projected fire"}:
                                  ${new Date(t.at).toISOString()}${t.jobId
                                    ? `; ${t.jobId}`
                                    : ""}
                                </title></circle
                              >`,
                          )
                        : l.intervals.map(
                            (q) =>
                              html`<rect
                                class="wk-quiet"
                                x="${pct(q.start, w)}%"
                                y="${i * 36 + 8}"
                                width="${(
                                  Number(pct(q.end, w)) -
                                  Number(pct(q.start, w))
                                ).toFixed(3)}%"
                                height="20"
                                rx="8"
                                ><title>
                                  ${l.name}: ${new Date(q.start).toISOString()}
                                  to ${new Date(q.end).toISOString()}
                                </title></rect
                              >`,
                          )}`,
                )}${Array.from(
                  { length: 7 },
                  (_, d) =>
                    html`${d
                        ? html`<line
                            class="wk-day"
                            x1="${((d / 7) * 100).toFixed(3)}%"
                            x2="${((d / 7) * 100).toFixed(3)}%"
                            y1="0"
                            y2="${height}"
                          />`
                        : null}<text
                        class="wk-ax"
                        x="${(((d + 0.5) / 7) * 100).toFixed(3)}%"
                        y="${height + 20}"
                        text-anchor="middle"
                        >${new Date(w.start + d * DAY)
                          .toISOString()
                          .slice(5, 10)}</text
                      >`,
                )}
                <line
                  class="wk-now"
                  x1="${pct(m.now, w)}%"
                  x2="${pct(m.now, w)}%"
                  y1="0"
                  y2="${height}"
                />
                <text
                  class="wk-now-label"
                  x="${pct(m.now, w)}%"
                  y="-10"
                  text-anchor="middle"
                >
                  now
                </text>
              </svg>
            </div>
          </div>
        </div>
        <p class="keyrow tr-week-key">
          <span><i class="wk-k wk-k--ran"></i>recorded run</span
          ><span><i class="wk-k wk-k--next"></i>projected fire</span
          ><span><i class="wk-k wk-k--quiet"></i>quiet window</span>
        </p>
      </div>
      <div class="tr-week-phone">
        <h3>Next fires</h3>
        <ul class="tr-next-fires">
          ${future.map(
            (r) =>
              html`<li>
                <b>${timeHtml(r.nextFire.at)}</b
                ><a href="${ruleHref(v, r.index)}"
                  >${r.trigger.id} · row ${r.index + 1}</a
                ><span
                  >${r.nextFire.health === "on-time"
                    ? "on time"
                    : r.nextFire.health}</span
                >
              </li>`,
          )}
        </ul>
        ${!future.length
          ? html`<p>No next fire is published.</p>`
          : null}${w.quiet.map(
          (q) =>
            html`<p>
              <b>Quiet: ${shownPath(q.scope)}</b> ${q.intervals[0]
                ? html`${timeHtml(q.intervals[0].start)} to
                  ${timeHtml(q.intervals[0].end)}`
                : "no interval in view"};
              ${q.affects === "forge"
                ? "forge jobs only"
                : q.affects === "local"
                  ? "local folder jobs, including schedules"
                  : "all matching jobs, including schedules"}.
            </p>`,
        )}
      </div>
      <p class="tr-sub">
        ${w.label}. Schedule times use their owning host's verified timezone and
        are plotted as UTC instants. Forge repository quiet windows do not hold
        cron; matching local-folder and global windows can hold it.
      </p>
      ${lanes
        .filter((l) => l.problem || l.incomplete)
        .map(
          (l) =>
            html`<p class="tr-problem">
              ${l.name}:
              ${l.problem ??
              "Only a bounded selection of retained runs and projected times is shown."}
            </p>`,
        )}${w.lanesCut
        ? html`<p class="tr-problem">
            ${w.lanesCut} schedule lanes are omitted.
          </p>`
        : null}${w.quietCut
        ? html`<p class="tr-problem">
            ${w.quietCut} quiet windows are omitted.
          </p>`
        : null}${w.quietUnknown
        ? html`<p class="tr-problem">
            Quiet windows could not be read; no absence of bands proves they are
            off.
          </p>`
        : null}`,
    { sub: "UTC instants, not an execution guarantee" },
  );
}
function checkSelect(name, label, values, { forges = false } = {}) {
  const options = forges
    ? Object.entries(values).flatMap(([forge, words]) =>
        words.map(
          (value) =>
            html`<option value="${value}" data-check-forge="${forge}">
              ${value}
            </option>`,
        ),
      )
    : values.map((value) => html`<option value="${value}">${value}</option>`);
  return html`<div class="field" data-check-field="${name}">
    <label
      >${label}<select class="select" name="${name}">
        ${options}
      </select></label
    >
  </div>`;
}
export function triggerCheckForm() {
  return html`<form data-trigger-check autocomplete="off">
    <fieldset data-trigger-check-fields disabled>
      <legend class="sr">Describe a hypothetical forge event</legend>
      <div class="tr-form">
        ${checkSelect("forge", "Forge", Object.keys(CHECK_EVENTS))}
        <div class="field" data-check-field="repository">
          <label
            >Repository<input
              class="input input--code"
              name="repository"
              maxlength="${CHECK_LIMITS.repository}"
              placeholder="owner/repository"
              required
              autocomplete="off"
              spellcheck="false"
          /></label>
        </div>
        ${checkSelect("event", "What happens", CHECK_EVENTS, {
          forges: true,
        })}${checkSelect("actor", "Who acts (assumed authority)", CHECK_ACTORS)}
        <div class="field" data-check-field="number">
          <label
            >Issue or pull request number<input
              class="input"
              type="number"
              name="number"
              min="1"
              max="2147483647"
              placeholder="1"
              autocomplete="off"
          /></label>
        </div>
        ${checkSelect("action", "Pull request action", CHECK_PR_ACTIONS, {
          forges: true,
        })}${checkSelect(
          "prAuthor",
          "Pull request author's authority",
          CHECK_PR_AUTHORS,
        )}${checkSelect(
          "reviewState",
          "Review verdict",
          CHECK_REVIEW_STATES,
        )}${checkSelect("reviewBody", "Review body", CHECK_REVIEW_BODIES)}
        <div class="field tr-span" data-check-field="labels">
          <label
            >Current labels, one per line<textarea
              class="textarea"
              name="labels"
              rows="2"
              maxlength="${CHECK_LIMITS.labels * (CHECK_LIMITS.label + 1)}"
              spellcheck="false"
            ></textarea>
          </label>
        </div>
        <div class="field tr-span" data-check-field="previousLabels">
          <label
            >Previous labels, one per line<textarea
              class="textarea"
              name="previousLabels"
              rows="2"
              maxlength="${CHECK_LIMITS.labels * (CHECK_LIMITS.label + 1)}"
              spellcheck="false"
            ></textarea>
          </label>
        </div>
        <div class="field tr-span" data-check-field="comment">
          <label
            >Comment<textarea
              class="textarea"
              name="comment"
              rows="3"
              maxlength="${CHECK_LIMITS.comment}"
              spellcheck="false"
            ></textarea>
          </label>
        </div>
      </div>
      <p class="tr-sub">
        Authority is a hypothetical assumption. Comment text stays in this
        request; it is never placed in the address bar or audit log.
      </p>
      <button class="btn btn--primary" type="submit">
        ${ui.icon("search", { size: "sm" })}Check an event
      </button>
    </fieldset>
    <noscript
      ><p class="tr-problem">
        Enable JavaScript to check an event. Rules, filters and navigation
        remain available; no event text can be submitted into the address bar.
      </p></noscript
    >
    <div
      data-trigger-check-result
      role="region"
      aria-label="Event check result"
      aria-live="polite"
      tabindex="-1"
    >
      <p class="tr-sub">
        Describe an event to see hypothetical matching. Nothing will be sent to
        a forge, queued or spent.
      </p>
    </div>
  </form>`;
}
export function triggersCheck(v) {
  return card(
    "Which rule would run?",
    html`<p class="tr-p">
        Describe an event and see which rule matches, and why the others do not.
        Nothing is sent to a forge or spent.
      </p>
      <p class="tr-check-phone-link">
        ${ui.btn({
          label: "Check an event",
          href: ui.pageHref(v.pages, "trigger-check") ?? "/triggers/check",
          kind: "primary",
          icon: "search",
        })}
      </p>
      <div class="tr-check-embedded">${triggerCheckForm()}</div>`,
    { sub: "Hypothetical matching, not delivery authentication" },
  );
}
export function triggerCheckPage() {
  return card("Which rule would run?", triggerCheckForm(), {
    sub: "Read-only and available to viewers",
  });
}
export function renderTriggerCheckResult(result) {
  if (result?.refusal)
    return html`<div class="tr-check-error" role="alert">
      <h3>
        ${ui.icon("refused", { size: "sm" })}The event could not be checked
      </h3>
      <p>${result.refusal.sentence ?? "The event description was refused."}</p>
      <p>No delivery was sent or queued; nothing was spent.</p>
    </div>`;
  if (!result || typeof result !== "object")
    return html`<div class="tr-check-error" role="alert">
      <p>
        The console could not read a matching result. Nothing was sent or
        queued.
      </p>
    </div>`;
  const match = result.matched;
  return html`<div class="tr-result">
    <h3 class="tr-res__h">
      ${ui.icon(match ? "done" : "info", { size: "sm" })}${match
        ? html`Rule ${match.row ?? match.index + 1} would
          match${match.flow
            ? html` with flow <b>${match.flow}</b>`
            : match.command
              ? html` with command <b>${match.command}</b>`
              : null}`
        : "No rule would match this description"}
    </h3>
    ${match
      ? html`<p>
          Route:
          <span class="code">${match.route ?? "hypothetical match"}</span>. This
          is not a promise that a real delivery will start a paid job.
        </p>`
      : null}
    <p class="tr-res__s">
      ${result.notice ??
      "Hypothetical matching only. Nothing was authenticated, sent, queued or spent."}
    </p>
    <h4>The rules</h4>
    <ol class="tr-why">
      ${(result.rules ?? []).map(
        (r) =>
          html`<li>
            <span class="tr-n tr-n--sm">${r.row ?? r.index + 1}</span
            ><span
              ><b>${r.status ?? "unknown"}</b>:
              ${r.sentence ?? "No explanation was provided."}</span
            >
          </li>`,
      )}
    </ol>
    <h4>Checks a real delivery must still pass</h4>
    <ul class="tr-gates">
      ${(result.gates ?? []).map(
        (g) =>
          html`<li>
            ${ui.icon(g.state === "would-refuse" ? "refused" : "info", {
              size: "sm",
            })}<b>${g.id}</b><span>${g.state}: ${g.sentence}</span>
          </li>`,
      )}
    </ul>
    ${!result.gates?.length
      ? html`<p>
          Delivery authentication and current admission gates were not checked
          here.
        </p>`
      : null}
  </div>`;
}
