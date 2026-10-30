/** Trigger pages keep prompt text private and use the same add/edit contracts as the tools (#750). */
import { triggerWhoMayFire } from "../../trigger-policy.mjs";
import { outcomeWord, reasonWords, recordReason } from "../../words.mjs";
import { planTriggerAdd } from "../../write-plans.mjs";
import { triggerBundleOf } from "../../read-model.mjs";
import { BACKENDS } from "@edgehero/pi-dispatch/backends";
import { triggerSandboxHosts } from "../trigger-sandbox.mjs";
import { reserveText } from "../actions.mjs";
import { PR_ACTIONS } from "@edgehero/pi-dispatch/triggers";
import { fileTrouble } from "./config.mjs";
import { html as escapedHtml } from "../html.mjs";
// Keep indented source readable without emitting whitespace-only lines when an optional fragment is absent.
const html = (strings, ...values) => escapedHtml(strings.map(s => s.replace(/[ \t]*\n[ \t]*/g, "\n")), ...values);
import * as ui from "../kit.mjs";
import { canAct, shownPath, runLink, moneyHtml, timeHtml } from "./common.mjs";
import { actForm, field, area, table, facts } from "./config-ui.mjs";
const card = (title, body) => ui.card({ title, body });
const detail = (v) => v.data?.triggerDetail ?? {};
const trigger = (v) =>
  detail(v).trigger ?? v.data?.snapshot?.triggers?.triggers?.[v.query?.index];
const defaults = (v) =>
  v.data?.triggerEditor?.defaults ??
  v.data?.snapshot?.triggerEditor?.defaults ??
  {};
const opts = (v) =>
  v.data?.triggerEditor ?? v.data?.snapshot?.triggerEditor ?? {};
const show = (x) =>
  x === undefined || x === null
    ? "not set"
    : typeof x === "object"
      ? JSON.stringify(x)
      : String(x);
const gateText = triggerWhoMayFire;
export function triggerTitle(v) {
  const t = trigger(v);
  return t
    ? `${t.type} ${t.phrase ?? t.id ?? t.action?.join(", ") ?? ""} → ${t.flow ?? t.command ?? "deployment default"}${t.forge ? ` · ${t.forge}` : ""} · row ${v.query.index + 1}`
    : "Trigger unavailable";
}
export function triggerOn(v) {
  const t = trigger(v);
  if (!t)
    return card(
      "What starts it",
      html`<p>
        ${fileTrouble(v.data?.snapshot?.triggers, "triggers file", v.data?.snapshot) ?? "This row does not exist. Return to Configuration."}
      </p>`,
    );
  return card(
    "What starts it",
    html`${facts([
      ["Kind", t.type],
      ["Phrase or schedule", t.phrase ?? t.pattern ?? show(t.action)],
      ["Forge", t.forge ?? "local"],
      ["Repository", t.repository ?? "any allowed repository"],
      [
        "Who may fire it",
        gateText(t),
      ],
    ])}`,
  );
}
export function triggerRuns(v) {
  const d = detail(v);
  const rows = d.lastRuns ?? [];
  return card(
    "Runs it started",
    html`<p>
        <b
          >${d.historyIncomplete ? "at least " : ""}${d.count24h ??
          "unknown"}</b
        >
        runs in the last 24 hours · ${moneyHtml(d.cost24hMicros)} metered
        spend${d.costIncomplete
          ? " (metered portion only; some runs have no cost)"
          : ""}.
      </p>
      ${table(
        "Last five trigger runs",
        ["Run", "Project", "Outcome", "Reason"],
        rows.map(
          (r) =>
            html`<tr>
              <td>${runLink(r.jobId)}</td>
              <td>${r.project ?? r.target ?? "-"}</td>
              <td>${outcomeWord(r.outcome, recordReason(r)).word ?? r.outcome ?? "-"}</td>
              <td>${recordReason(r) ? reasonWords(recordReason(r)).sentence ?? `No explanation is available for ${recordReason(r)}.` : "No reason was recorded."}</td>
            </tr>`,
        ),
        "No runs were found in the available history.",
      )}
      <p>
        Jobs in line now:
        ${(d.queued ?? []).map((j) => runLink(j.jobId ?? j.id))}${d.queued
          ?.length
          ? null
          : d.queued == null ? "unavailable; the queue could not be read" : "none in view"}.
      </p>`,
  );
}
export const EDIT_FIELDS = Object.freeze([
  "flow",
  "backend",
  "provider",
  "model",
  "maxTurns",
  "progress",
  "statusComment",
  "steer",
  "recover",
]);
export const HAND_FIELDS = Object.freeze([
  "maxCostUsd",
  "models",
  "mcp",
  "secrets",
  "secretBundle",
  "resume",
  "awaitInput",
  "image",
  "waitFor",
  "replicas",
  "packages",
  "skillsDir",
  "instructions",
  "task",
  "kind",
  "folder",
  "repository",
  "command",
  "portfolio",
  "github",
  "fallbackModels",
  "secretsProfile",
  "gates",
  "gateTimeout",
  "gateBudgetRaiseUsd",
  "excludeTools",
]);
export function triggerRun(v) {
  const t = trigger(v);
  if (!t) return html``;
  const def = defaults(v);
  const backend = t.backend ?? def.backend ?? "local";
  const venue = BACKENDS[backend];
  const hostRows = triggerSandboxHosts(t, v.data?.snapshot);
  const bundle = triggerBundleOf(t, v.data?.snapshot?.secretBundles);
  const bundleNames = (v.data?.snapshot?.secretBundles?.bundles ?? []).map(b=>`${b.project ?? "project"}: ${b.id}`).join(", ");
  return card(
    "What it runs",
    html`<h3>Edit here</h3>
      ${facts(
        EDIT_FIELDS.filter(
          (k) => t.type !== "cron" || !["statusComment", "recover"].includes(k),
        ).map((k) => [
          `run.${k}`,
          `${["folder", "skillsDir"].includes(k) ? show(shownPath(t[k])) : show(k === "kind" ? t.forge ?? "local" : t[k])}; deployment default: ${show(def[k])}`,
        ]),
      )}
      <h3>By hand</h3>
      ${facts(
        HAND_FIELDS.map((k) => [
          `run.${k}`,
          `${["instructions", "task"].includes(k) ? (t[k] ? "set (operator only)" : "not set") : ["folder", "skillsDir"].includes(k) ? show(shownPath(t[k])) : show(k === "kind" ? t.forge ?? "local" : t[k])}; deployment default: ${show(def[k])}`,
        ]),
      )}
      <h3>Its runs' sandbox</h3>
      ${hostRows.length ? facts(hostRows.map((h) => [h.name, `${h.backend ?? "venue not published"}${h.deploymentDefault ? " (that host's deployment default)" : " (trigger override)"}; ${h.blessed === null ? "blessing not published" : h.blessed ? "blessed" : "not blessed"}${h.capabilityUnknown ? "; required profile capabilities not published" : ""}${h.backend && BACKENDS[h.backend] ? `; ${Object.entries(BACKENDS[h.backend].serves).map(([key, value]) => `${key}: ${value === "image" ? "with the image" : value}`).join(", ")}` : ""}`])) : html`<p>No live host blessing facts are available.</p>`}
      <p>These live host declarations show published venue choices; a host that does not bless the selected venue refuses it before spend. ${t.type === "cron" ? "The schedule's owning host runs a cron trigger's local folder; the registry alone does not prove which host has that folder." : "Hosts missing its required secret or wait profile are excluded where their capability list is published."}</p>
      <p>
        ${ui.icon("shield")}
        <a href="${ui.pageHref(v.pages, "venue", { name: backend })}"
          >${backend}</a
        >${t.backend ? " (trigger override)" : " (deployment default)"}.
      </p>
      ${facts(
        Object.entries(venue?.serves ?? {}).map(([k, value]) => [
          k,
          value === "image" ? "with the image" : value,
        ]),
      )}
      <p>
        ${venue?.serves?.sandboxShell === "yes"
          ? "Reopen a retained workspace with pi-dispatch sandbox <job id>."
          : "This venue has no sandbox shell for reopening a workspace."}
        Workspaces are kept for ${detail(v).sandbox?.retentionHours ?? 24} hours; 0
        keeps none.
      </p>
      ${backend.startsWith("openshell")
        ? html`<p>
            OpenShell ${backend === "openshell-bind" ? "bind" : "copy"} mode.
            Current egress rule hosts in this deployment: ${opts(v).egressProblem ?? (Array.isArray(opts(v).egressHosts) ? opts(v).egressHosts.join(", ") || "none in these base policy sources" : "not published")}.
            Other hosts read their own deployment's rules; credentials and project-bundle endpoints can further qualify a run's policy.
          </p>`
        : null}
      <p>
        ${t.once
          ? "A one-shot never races."
          : `${t.replicas ?? 1} independent sandbox(s) race each event, on separate branches and, for development flows, separate pull requests.`}
        Secret profile: ${t.secretsProfile ?? "none"}. Bundle:
        ${t.secretBundle === false
          ? "opted out"
          : (bundle?.id ?? (bundleNames ? `By event project: ${bundleNames}` : "no declared project bundle"))}.
      </p>`,
  );
}
export function editFields(v, t = {}, group = null) {
  return html`${EDIT_FIELDS.filter(
    (k) => (t.type !== "cron" || !["statusComment", "recover"].includes(k)) && (group === null || (group === "options" ? ["progress","statusComment","steer","recover"].includes(k) : !["progress","statusComment","steer","recover"].includes(k))),
  ).map((k) =>
    field(k, k === "backend" ? "Venue (run.backend)" : ({ progress: "Report phases (run.progress)", statusComment: "Status comment (run.statusComment)", steer: "Take messages (run.steer)", recover: "Recover (run.recover)" }[k] ?? `run.${k}`), {
      value: t[k] ?? "",
      required: k === "flow",
      type:
        k === "maxTurns"
          ? "int"
          : ["progress", "statusComment", "steer", "recover"].includes(k)
            ? "json"
            : null,
      options: ["progress", "statusComment", "steer", "recover"].includes(k)
        ? [
            {
              value: "",
              label: t.type ? `Keep current (${show(t[k])})` : `Deployment default (${show(defaults(v)[k])})`,
            },
            "true",
            "false",
          ]
        : k === "backend"
          ? [
              {
                value: "",
                label: t.type ? `Keep current (${t.backend ?? "deployment default"})` : `Deployment default (${defaults(v).backend ?? "local"})`,
              },
              ...(opts(v).backends ?? []).map((b) =>
                typeof b === "string" ? b : { value: b.name, label: `${b.name}: live transcript ${b.serves?.liveTranscript ?? "no"}, steering ${b.serves?.steering ?? "no"}, recovery ${b.serves?.recovery ?? "no"}, sandbox shell ${b.serves?.sandboxShell ?? "no"}` },
              ),
            ]
          : null,
      hint: k === "flow" ? "Required: name the skill to run; its location is explained below." : t.type ? `Blank keeps the current value (${show(t[k])}); deployment default: ${show(defaults(v)[k])}.` : `Blank uses ${show(defaults(v)[k])}. ${{ progress: "Needs progress publishing and a capable image.", statusComment: "Needs forge access; unavailable for cron.", steer: "Needs a venue and image that support steering.", recover: "Needs recovery support, a safe workspace and a replayable event; unavailable for cron." }[k] ?? ""}`,
    }),
  )}`;
}
export function triggerEdit(v) {
  const t = trigger(v);
  return !t || !canAct(v)
    ? html``
    : card(
        "Edit",
        actForm("trigger-edit", {
          hidden: [["index", v.query.index, "int"]],
          fields: editFields(v, t),
          label: `Preview edit of row ${v.query.index + 1}`,
        }),
      );
}
export function triggerTrust(v) {
  const t = trigger(v);
  if (!t) return null;
  return card(
    "Trust model",
    html`<p>
        ${gateText(t)} Each forge delivery is checked against its configured authentication, bot-loop guard, sender permissions and duplicate protection, then applicable quiet hours, image, repository protection and spend caps. Cron starts from the deployment schedule instead of a webhook. A comment may select another flow; only one
        comment trigger per forge may be declared.
      </p>
      <p>
        Keeping a session continues its retained conversation on the same issue.
        Nothing merges by itself.
      </p>
      ${t.instructions
        ? v.role === "operator"
          ? html`<h3>Instructions</h3>
              <blockquote>
                <pre>
${v.data?.snapshot?.triggerInstructions?.[v.query.index] ??
                  "Instructions could not be read. Reload to try again."}</pre
                >
              </blockquote>`
          : html`<p>
              This trigger has instructions. Their text is available to an
              operator only.
            </p>`
        : html`<p>No instructions are set.</p>`}${t.task &&
      v.role === "operator"
        ? html`<h3>Task</h3>
            <pre>
${v.data?.snapshot?.triggerTasks?.[v.query.index] ??
              "Task could not be read."}</pre
            >`
        : null}`,
  );
}
export function triggerKinds(v) {
  const t = trigger(v);
  if (!t) return null;
  const d = detail(v);
  return card(
    "Other kinds",
    html`${t.type === "cron"
      ? html`<p>
            Next fire: ${timeHtml(d.cron?.next ?? t.next)}. Health:
            ${d.cron?.next == null ? "not known (schedule not published)" : d.cron.overdueMs > 0 ? "overdue" : "on time"}; stalls
            ${t.stalls ?? d.cron?.stalls ?? "not known"} of ${d.cron?.stallLimit ?? "not published"}.
          </p>
          ${canAct(v)
            ? v.data?.triggerFireCheck?.refusal
              ? html`<p>${v.data.triggerFireCheck.refusal}</p>`
              : v.data?.triggerFireCheck?.plan
                ? html`<p>
                      ${v.data.triggerFireCheck.plan.summary ?? "Fire this schedule once."}
                      Paid: ${reserveText(v.data.triggerFireCheck.plan.reserve)}
                    </p>
                    ${actForm("trigger-fire", {
                      hidden: [["index", v.query.index, "int"]],
                      label: "Fire now",
                    })}`
                : html`<p>Fire now cannot be checked here.</p>`
            : null}`
      : html`<p>
          ${t.once
            ? t.disarmed
              ? `Spent by ${t.disarmed.jobId ?? "a run"}; clear on.disarmed by hand to re-arm it.`
              : "One-shot armed."
            : "This trigger is not a schedule or a one-shot."}
        </p>`}`,
  );
}
export function triggerChange(v) {
  const t = trigger(v);
  return card(
    "Before you change it",
    html`<p>
        A job already in line is refused if this trigger has gained a field the
        job lacks. Adding or deleting a row renumbers the rows after it.
      </p>
      <p>
        ${!t || detail(v).skewed == null
          ? (detail(v).skewReason ??
            "Jobs that would be refused cannot be checked here.")
          : `${detail(v).skewIncomplete ? "At least " : ""}${detail(v).skewed?.length ?? 0} jobs in view would be refused now.${detail(v).skewIncomplete ? " The queue check was incomplete." : ""}`}
      </p>
      <p>${fileTrouble(v.data?.snapshot?.triggers, "triggers file", v.data?.snapshot) ?? "The triggers file loads."}</p>
      ${(detail(v).skewed ?? []).map(job => html`<p>${runLink(job.jobId)}: ${job.field ?? job.conditions ?? "trigger changed"}</p>`)}
      ${t && canAct(v)
        ? actForm("trigger-delete", {
            hidden: [["index", v.query.index, "int"]],
            label: `Delete row ${v.query.index + 1}`,
          })
        : null}`,
  );
}
export function triggerAdd(v) {
  if (v.readOnly)
    return card(
      "Add a trigger",
      html`<p>Forms are off on this read-only console.</p>`,
    );
  const kinds = ["cron", "label", "comment", "pull_request", "issue"];
  const starts = html`${field("kind", "Kind", {
    options: kinds,
    value: "label",
  })}${kinds.map(
    (kind) =>
      html`<fieldset data-trigger-kind="${kind}">
        <legend>${kind}</legend>
        ${kind === "cron"
          ? html`${field("id", "Scheduler id")}${field(
              "pattern",
              "Cron pattern (5 or 6 fields)",
            )}${field("folder", "Local repository folder")}${area(
              "task",
              "Task",
            )}`
          : html`${field("forge", "Forge", {
              options: opts(v).forges ?? [], required: true, hint: opts(v).forges?.length ? "Only forges with configured webhooks are offered." : "No webhook is configured. Configure a forge connection or choose cron.",
            })}${["label", "comment"].includes(kind)
              ? field("repository", "Repository (optional)")
              : null}${kind === "comment"
              ? field("phrase", "Comment phrase")
              : null}${["label", "pull_request"].includes(kind)
              ? field("labels", "Labels (required for labeled)", {
                  type: "list",
                })
              : null}${["pull_request", "issue"].includes(kind)
              ? html`${field("action", "Actions (forge words)", {
                  type: "list",
                  options: kind === "issue" ? ["closed"] : [...PR_ACTIONS.github],
                  hint: "Submitted reviews fire on every verdict unless reviewState narrows them.",
                })}${kind === "pull_request"
                  ? field("reviewState", "Review states", { type: "list" })
                  : null}${field("number", "Issue or pull request number", {
                  type: "int",
                })}${field("once", "One-shot", {
                  type: "json",
                  options: ["false", "true"],
                })}`
              : null}`}
      </fieldset>`,
  )}`;
  return card(
    "Add a trigger",
    html`<p>
        Preview the added lines, then confirm with a person's single-use
        five-minute ticket.
      </p>
      ${actForm("trigger-add", {
        structured: "trigger",
        fields: html`<h3>1. What starts it</h3>
          ${starts}
          <h3>2. What it runs</h3>
          ${editFields(v, {}, "run")}
          <p>
            The flow's skill must live in the repository's .pi/skills or
            .agents/skills, or an available deployment skill tier. Suggestions:
            ${(opts(v).flows ?? [])
              .map((f) => (typeof f === "string" ? f : `${f.name} (${f.tier})`))
              .join(", ") || "none found"}.
          </p>
          <h3>Venue capabilities</h3>${facts((opts(v).backends ?? []).map(b => [typeof b === "string" ? b : b.name, Object.entries((typeof b === "string" ? BACKENDS[b]?.serves : b.serves) ?? {}).map(([k,value])=>`${k}: ${value === "image" ? "with the image" : value}`).join("; ")]))}
          <h3>3. Run options</h3><div class="config-options">${editFields(v, {}, "options")}</div>
          <p>
            run.progress reports phases; run.statusComment needs forge access;
            run.steer needs steering support; run.recover needs recovery
            support. Cron cannot set statusComment or recover to true.
          </p>
          <h3>4. Set by hand</h3>
          <p>
            The console never sets the job cap, allowed models, MCP servers,
            session, image, secrets, waits or replicas; new adds opt out of project secret bundles (run.secretBundle: false). Change the bundle opt-out and these other fields by hand in the triggers file.
          </p>`,
        label: "Preview the add",
      })}
      <details>
        <summary>Or paste the add tool's fields as JSON</summary>
        ${actForm("trigger-add", {
          fields: area("trigger", "Add tool fields (JSON)", {
            type: "json",
            required: true,
          }),
          label: "Preview the JSON add",
        })}
      </details>`,
  );
}
export function triggerKindHelp() { return card(
    "The five kinds",
    html`<p>
      Cron runs a task in a local repository on a schedule. Label starts on an
      issue label, never a pull request. Comment matches a phrase, with one per
      forge. Pull request matches forge actions and reviews. Issue matches
      closing; a one-shot also names its number.
    </p>`,
  );
}

export function triggerForgeWords() { return card(
    "Pull request words per forge",
    facts(
      Object.entries(PR_ACTIONS).map(([forge, words]) => [
        forge,
        [...words].join(", "),
      ]),
    ),
  );
}

export function triggerRefusalExamples() {
  const shared = { paths: { triggersPath: "triggers.json" }, env: { PI_BACKENDS: "local" }, tool: "this form", surface: "console" };
  return [
    { field: "maxTurns", params: { kind: "label", flow: "triage", labels: ["pi"], maxTurns: 0 } },
    { field: "statusComment", params: { kind: "cron", id: "nightly", pattern: "0 3 * * *", folder: "repository", task: "Review", flow: "triage", statusComment: true } },
    { field: "backend", params: { kind: "label", flow: "triage", labels: ["pi"], backend: "openshell" } },
    { field: "maxCostUsd", params: { kind: "label", flow: "triage", labels: ["pi"], maxCostUsd: "1" } },
  ].map(({field,params}) => ({field, sentence: planTriggerAdd({ ...shared, params }).refusal}));
}
export function triggerRefusals() {
  return card("Refusals",html`<p>Each field below shows the shared planner's own refusal.</p>${triggerRefusalExamples().map(({field,sentence}) => html`<p><b>${field}</b>: ${sentence}${sentence?.includes("Nothing was changed") ? "." : " Nothing was changed."}</p>`)}`);
}
