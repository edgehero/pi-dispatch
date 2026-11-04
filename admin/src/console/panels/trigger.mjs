import { TRIGGER_RECIPES } from "../../trigger-recipes.mjs";
/** Trigger pages keep prompt text private and use the same add/edit contracts as the tools (#750). */
import { triggerWhoMayFire } from "../../trigger-policy.mjs";
import { TRIGGER_GETS_WORDS } from "../../trigger-gets-view.mjs";
import { CARD_FIELDS } from "../../trigger-edit-core.mjs";
import { triggerGetsDrawn } from "./trigger-gets.mjs";
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
// The snapshot's, or with Valkey down the row the card read from the file itself, since nothing about that row needs Valkey.
const trigger = (v) =>
  detail(v).trigger ?? v.data?.snapshot?.triggers?.triggers?.[v.query?.index] ?? v.data?.triggerGets?.trigger;
// What failed, when the snapshot did: not the file, which the card has just read.
const othersUnread = (v) => !v.data?.snapshot && Boolean(v.data?.triggerGets);
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
/**
 * What an agent's page says of a field its read does not hold. `agentReadProjection` drops what it cannot vouch for: `on.phrase` and `run.image` are
 * accepted verbatim by the writer, `progress` and `secrets` hold prose and references elsewhere, `forge` is not on its list and the editor's defaults go
 * whole. So for an agent a missing key says nothing of the file. REJECTED: "not set", which is what this page said of `run.image` and `run.progress`
 * where the file sets them, and `[]` of a `run.mcp` naming a server. REJECTED too: widening the projection to fill these rows. It is what a model reads
 * from `dispatch_triggers`, and it goes by a field's name at any depth of any data, so one page's wording is no reason to move it.
 */
const AGENT_UNREAD = "not in an agent’s read";
const isAgent = (v) => v.role === "agent";
/** One row of what the file says of `run.<k>`, beside the deployment's default where this view can read that. */
function fieldRow(v, t, k) {
  const value = isAgent(v) && t[k] === undefined
    ? AGENT_UNREAD
    // The display holds these lists only where the file names something, so an empty one is names the read dropped: no server's name reaches an agent.
    : isAgent(v) && Array.isArray(t[k]) && t[k].length === 0
      ? `set, and its names are ${AGENT_UNREAD}`
    : ["instructions", "task"].includes(k)
      ? (t[k] ? "set (operator only)" : "not set")
      : ["folder", "skillsDir"].includes(k)
        ? show(shownPath(t[k]))
        : show(k === "kind" ? t.forge ?? "local" : t[k]);
  return [`run.${k}`, isAgent(v) ? value : `${value}; deployment default: ${show(defaults(v)[k])}`];
}
const gateText = triggerWhoMayFire;
/** Who may fire it, where this view can say. Its forge decides that for all but a schedule, and with none to read the rule would read as GitHub's. */
const whoMayFire = (v, t) => (isAgent(v) && t.type !== "cron" ? null : gateText(t));
export function triggerTitle(v) {
  const t = trigger(v);
  return t
    ? `${t.type} ${t.phrase ?? t.id ?? t.action?.join(", ") ?? ""} → ${t.flow ?? t.command ?? (isAgent(v) ? AGENT_UNREAD : "deployment default")}${t.forge ? ` · ${t.forge}` : ""} · row ${v.query.index + 1}`
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
      ["Phrase or schedule", t.phrase ?? t.pattern ?? (isAgent(v) && t.action === undefined ? AGENT_UNREAD : show(t.action))],
      ["Forge", isAgent(v) ? AGENT_UNREAD : t.forge ?? "local"],
      ["Repository", t.repository ?? "any allowed repository"],
      [
        "Who may fire it",
        whoMayFire(v, t) ?? AGENT_UNREAD,
      ],
    ])}${t.type === "comment" ? html`<p>Write ${t.phrase ? html`<code>${`${t.phrase} <flow>`}</code>` : "its phrase and a flow"} to choose another flow named by a trigger in this file. Otherwise this trigger's default flow runs.</p>` : null}`,
  );
}
export function triggerRuns(v) {
  // Runs are matched by what the row says, so with no row in the snapshot neither "no runs" nor "the queue could not be read" is known, whatever the
  // history and the queue hold: the file failed, or the row is not there. REJECTED: drawing the card's zeroes, which denied a run that exists. A file
  // that does not load still gives the page its row, so that one says it. Valkey down is `othersUnread`, and those words are the card's own below.
  if (!v.data?.triggerDetail && !othersUnread(v)) return trigger(v) ? card("Runs it started", html`<p>This page could not match runs to this row, so it says nothing of them.</p>`) : null;
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
        Array.isArray(d.history) || !othersUnread(v) ? "No runs were found in the available history." : TRIGGER_GETS_WORDS.historyUnread,
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
/**
 * The fields of a trigger's `run`, in three groups, and each key has one editor: `CARD_FIELDS` on What its jobs get (`p-trigger-gets`),
 * `EDIT_FIELDS` on the Edit form (`p-trigger-edit`), and `HAND_FIELDS` in the file alone. A new trigger has no card yet, so the add form
 * keeps its flow and its model (`ADD_FIELDS`). `trigger-edit` still takes those keys: `dispatch_trigger_edit` keeps its scope, and only
 * this page's form narrows. REJECTED: leaving them on both forms, where two previews of one key can each pass with the other's words stale.
 */
export const EDIT_FIELDS = Object.freeze([
  "backend",
  "maxTurns",
  "progress",
  "statusComment",
  "steer",
  "recover",
]);
const ADD_FIELDS = Object.freeze(["flow", "backend", "provider", "model", "maxTurns", "progress", "statusComment", "steer", "recover"]);
export const HAND_FIELDS = Object.freeze([
  "secrets",
  "secretBundle",
  "resume",
  "awaitInput",
  "image",
  "waitFor",
  "replicas",
  "skillsDir",
  "instructions",
  "task",
  "kind",
  "folder",
  "repository",
  "command",
  "portfolio",
  "github",
  "secretsProfile",
  "gates",
  "gateTimeout",
  "gateBudgetRaiseUsd",
]);
export function triggerRun(v) {
  const t = trigger(v);
  if (!t) return html``;
  const backend = t.backend ?? defaults(v).backend ?? "local";
  const venue = BACKENDS[backend];
  const hostRows = triggerSandboxHosts(t, v.data?.snapshot ?? {});
  const bundle = triggerBundleOf(t, v.data?.snapshot?.secretBundles);
  const bundleNames = (v.data?.snapshot?.secretBundles?.bundles ?? []).map(b=>`${b.project ?? "project"}: ${b.id}`).join(", ");
  return card(
    "What it runs",
    // Each key has one editor, and a view with no card has none of these in a form: so their rows go where the card's would have been, read-only.
    html`${triggerGetsDrawn(v) ? html`<p>The flow, the model and its cap, the staged packages, the MCP servers and the tools are in What its jobs get.</p>` : html`<h3>What its jobs get</h3>${facts(CARD_FIELDS.map((k) => fieldRow(v, t, k)))}`}<h3>Edit here</h3>
      ${facts(
        EDIT_FIELDS.filter(
          (k) => t.type !== "cron" || !["statusComment", "recover"].includes(k),
        ).map((k) => fieldRow(v, t, k)),
      )}
      <h3>By hand</h3>
      ${facts(HAND_FIELDS.map((k) => fieldRow(v, t, k)))}
      <h3>Its runs' sandbox</h3>
      ${hostRows.length ? facts(hostRows.map((h) => [h.name, `${h.backend ?? "venue not published"}${h.deploymentDefault ? " (that host's deployment default)" : " (trigger override)"}; ${h.blessed === null ? "blessing not published" : h.blessed ? "blessed" : "not blessed"}${h.capabilityUnknown ? "; required profile capabilities not published" : ""}${h.backend && BACKENDS[h.backend] ? `; ${Object.entries(BACKENDS[h.backend].serves).map(([key, value]) => `${key}: ${value === "image" ? "with the image" : value}`).join(", ")}` : ""}`])) : html`<p>No live host blessing facts are available.</p>`}
      <p>These live host declarations show published venue choices; a host that does not bless the selected venue refuses it before spend. ${t.type === "cron" ? "The schedule's owning host runs a cron trigger's local folder; the registry alone does not prove which host has that folder." : isAgent(v) ? null : "Hosts missing its required secret or wait profile are excluded where their capability list is published."}</p>
      ${isAgent(v) && !t.backend
        ? html`<p>The deployment’s default venue is ${AGENT_UNREAD}.</p>`
        : html`<p>
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
      </p>`}
      ${v.role === "operator" ? html`<p><a class="link" href="${`/runs/sandboxes?${new URLSearchParams({ index: String(v.query.index) })}`}">Prepare a sandbox as this trigger</a></p>` : null}
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
        ${isAgent(v) ? null : html`Secret profile: ${t.secretsProfile ?? "none"}. Bundle:
        ${t.secretBundle === false
          ? "opted out"
          : (bundle?.id ?? (bundleNames ? `By event project: ${bundleNames}` : "no declared project bundle"))}.`}
      </p>`,
  );
}
export function editFields(v, t = {}, group = null) {
  return html`${(group === null ? EDIT_FIELDS : ADD_FIELDS).filter(
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
        html`<p class="muted">${TRIGGER_GETS_WORDS.reloadDrops}</p>${actForm("trigger-edit", {
          hidden: [["index", v.query.index, "int"]],
          fields: editFields(v, t),
          label: `Preview edit of row ${v.query.index + 1}`,
        })}`,
      );
}
export function triggerTrust(v) {
  const t = trigger(v);
  if (!t) return null;
  return card(
    "Trust model",
    html`<p>
        ${whoMayFire(v, t)} Each forge delivery is checked against its configured authentication, bot-loop guard, sender permissions and duplicate protection, then applicable quiet hours, image, repository protection and spend caps. Cron starts from the deployment schedule instead of a webhook. A comment may select another flow; only one
        comment trigger per forge may be declared.
      </p>
      <p>
        Keeping a session continues its retained conversation on the same issue.
        Nothing merges by itself.
      </p>
      ${isAgent(v) ? html`<p>Whether it has instructions is ${AGENT_UNREAD}.</p>` : t.instructions
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
        A job already in line keeps what it was queued with and runs without a
        change here, unless this trigger has gained a narrowing field the job
        lacks, such as a list of models, a cap or a server: then it is refused.
        Adding or deleting a row renumbers the rows after it.
      </p>
      <p>
        ${!t || detail(v).skewed == null
          ? (detail(v).skewReason ??
            "Jobs that would be refused cannot be checked here.")
          : `${detail(v).skewIncomplete ? "At least " : ""}${detail(v).skewed?.length ?? 0} jobs in view would be refused now.${detail(v).skewIncomplete ? " The queue check was incomplete." : ""}`}
      </p>
      <p>${othersUnread(v) ? TRIGGER_GETS_WORDS.othersUnread : fileTrouble(v.data?.snapshot?.triggers, "triggers file", v.data?.snapshot) ?? "The triggers file loads."}</p>
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
  const recipe = TRIGGER_RECIPES[v.query?.recipe] ?? null;
  const prefill = recipe?.fields ?? {};
  const forges = opts(v).forges ?? [];
  const missingForge = Boolean(prefill.forge && !forges.includes(prefill.forge));
  const kinds = ["cron", "label", "comment", "pull_request", "issue"];
  const starts = html`${field("kind", "Kind", {
    options: kinds,
    value: prefill.kind ?? "label",
  })}${kinds.map(
    (kind) =>
      html`<fieldset data-trigger-kind="${kind}">
        <legend>${kind}</legend>
        ${kind === "cron"
          ? html`${field("id", "Scheduler id", { value: prefill.id ?? "" })}${field(
              "pattern",
              "Cron pattern (5 or 6 fields)", { value: prefill.pattern ?? "" },
            )}${field("folder", "Local repository folder", { required: prefill.kind === "cron", hint: prefill.kind === "cron" ? "Choose the existing local repository folder. No sample path is saved for you." : null })}${area(
              "task",
              "Task", { required: prefill.kind === "cron", hint: null },
            )}`
          : html`${field("forge", "Forge", {
              options: missingForge ? [{ value: "", label: "Choose a configured forge" }, ...forges] : forges, value: missingForge ? "" : prefill.forge ?? "", required: true, hint: opts(v).forges?.length ? "Only forges with configured webhooks are offered." : "No webhook is configured. Configure a forge connection or choose cron.",
            })}${["label", "comment"].includes(kind)
              ? field("repository", "Repository (optional)")
              : null}${kind === "comment"
              ? field("phrase", "Comment phrase", { value: prefill.phrase ?? "" })
              : null}${["label", "pull_request"].includes(kind)
              ? field("labels", "Labels (required for labeled)", {
                  type: "list", value: prefill.labels ?? "",
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
    html`${recipe ? html`<p class="su-small">Recipe: <b>${recipe.title}</b>. Change any field before the preview.${missingForge ? " This recipe needs a GitHub webhook; configure Connections or choose a different configured forge." : null}${prefill.kind === "cron" ? " Add the existing folder; the schedule is 02:00 in the deployment’s configured timezone (UTC by default)." : null}</p>` : null}<p>
        Preview the added lines, then confirm with a person's single-use
        five-minute ticket.
      </p>
      ${actForm("trigger-add", {
        structured: "trigger",
        fields: html`<h3>1. What starts it</h3>
          ${starts}
          <h3>2. What it runs</h3>
          ${editFields(v, { flow: prefill.flow ?? "" }, "run")}
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
            Adding a trigger never sets the job cap, allowed models, MCP servers, session, image, secrets, waits or replicas; new adds opt out of project secret bundles (run.secretBundle: false). Once it exists, a person changes its job cap, allowed models and MCP servers on its page; change the rest and the bundle opt-out by hand in the triggers file.
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
  return card("Refusals",html`<p>Each field below shows the shared planner's own refusal.</p>${triggerRefusalExamples().map(({field,sentence}) => html`<p><b>${field}</b>: ${sentence}${sentence?.includes("Nothing was changed") ? "." : ". Nothing was changed."}</p>`)}`);
}
