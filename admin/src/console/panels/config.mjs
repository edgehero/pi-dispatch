/**
 * The configuration screen's panels, split out of `../panels.mjs` (issue #737), which re-exports what this module
 * exports. The rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the
 * role and run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { secretCountTrouble } from "../../secrets-view.mjs";
import { triggerBundleOf } from "../../read-model.mjs";
import { VENUE_LABEL } from "../../words.mjs";
import { html as escapedHtml } from "../html.mjs";
// Keep indented source readable without emitting whitespace-only lines when an optional fragment is absent.
const html = (strings, ...values) => escapedHtml(strings.map(s => s.replace(/[ \t]*\n[ \t]*/g, "\n")), ...values);
import { DOCTOR_FILE_CHECKS, doctorQuote } from "../../doctor-view.mjs";
import { cell, ageText, shownPath, runLink, canAct } from "./common.mjs";
import {
  actForm,
  field,
  area,
  editor,
  table,
  facts,
  fromSnapshot,
  filesSnapshot,
  rowDelete,
} from "./config-ui.mjs";
import * as ui from "../kit.mjs";
import { KNOWN_KEYS } from "@edgehero/pi-dispatch/runtime-settings";

// ---- configuration ---------------------------------------------------------------------------------------------------

/**
 * Why a file does not load, as one sentence: the newest published doctor check about that file where one was published
 * (issue #712, `doctorQuote`), naming the host and its age, else the pointer to run doctor. Never the parser's own
 * message, which names this host's path; a published label had its paths cut before it left the host that wrote it.
 */
function doctorReason(s, what) {
  const id = DOCTOR_FILE_CHECKS[what];
  const q = id ? doctorQuote(s, id) : null;
  if (!q)
    return `The ${what} does not load; run pi-dispatch doctor for the reason.`;
  const where = q.own
    ? `on this host (${q.host}, ${ageText(q.ageMs)} ago)`
    : `on ${q.host} (its own copy of the file, ${ageText(q.ageMs)} ago)`;
  return `The ${what} does not load. pi-dispatch doctor ${where} says: ${q.label}${q.fix ? `. Fix: ${q.fix}` : ""}`;
}

/**
 * A settings overlay nobody could read, as its own sentence (issue #988): the settings reader folds a file it could not
 * read into `invalid`, and "does not load" is the word for a file that was read and is refused. Null for any other
 * view.
 */
const settingsUnreadable = (v) => {
  const code = /^settings file unreadable(?: \((E[A-Z0-9]{1,20})\))?/.exec(String(v?.unreadable ?? v?.invalid ?? ""));
  return code === null ? null : `The settings overlay cannot be read${code[1] ? ` (${code[1]})` : ""}.`;
};

/** A file view's trouble as one sentence (no parser message: it names the host's path), or null when it loaded. */
export function fileTrouble(v, what, s = null) {
  if (!v) return `The ${what} could not be read.`;
  if (v.unset) return `No ${what} is configured.`;
  if (v.missing) return `The ${what} does not exist.`;
  if (v.invalid) return doctorReason(s, what);
  // An agent's copy holds only that the read failed (`agentReadProjection`), so there is no code to name, and REJECTED is printing what it holds: "(true)".
  if (v.unreadable)
    return `The ${what} cannot be read${typeof v.unreadable === "string" ? ` (${v.unreadable})` : ""}.`;
  return null;
}

/** The sentence for a file this page can draw and the worker's own parser refuses, or null where it does not (`readTriggers`' `doesNotLoad`). */
export const fileRefused = (v, what, s = null) => (v?.doesNotLoad === true ? doctorReason(s, what) : null);

/** A trigger's selector, in the triggers file's own words. */
function triggerOn(t) {
  const list = (name, v) =>
    Array.isArray(v) && v.length > 0 ? `${name} ${v.join(", ")}` : null;
  switch (t.type) {
    case "watch":
      return `watch ${cell(t.id)} from ${cell(t.source)}`;
    case "cron":
      return [`cron ${cell(t.id)}`, t.pattern].filter(Boolean).join(" ");
    case "label":
      return [
        "label",
        list("any", t.any),
        list("all", t.all),
        list("none", t.none),
      ]
        .filter(Boolean)
        .join("; ");
    case "comment":
      return `comment ${JSON.stringify(t.phrase ?? "")}`;
    case "pull_request":
      return [
        "pull request",
        list("action", t.action),
        list("any", t.any),
        t.number ? `#${t.number}` : null,
        t.once ? "once" : null,
        t.disarmed ? "spent" : null,
      ]
        .filter(Boolean)
        .join("; ");
    case "issue":
      return [
        "issue",
        list("action", t.action),
        t.number ? `#${t.number}` : null,
        t.once ? "once" : null,
        t.disarmed ? "spent" : null,
      ]
        .filter(Boolean)
        .join("; ");
    default:
      return cell(t.type);
  }
}

/** A trigger's project secret bundle (issue #704) in words: the bundle a cron trigger's jobs hold, or its opt-out. */
function triggerBundleNote(t, bundles) {
  const at = triggerBundleOf(t, bundles);
  if (at === null) return null;
  return at.optedOut
    ? `opted out of ${at.id !== null ? `bundle ${at.id}` : "every project's bundle"}`
    : `bundle ${at.id}`;
}

/** What a trigger's jobs carry beyond the flow: each a short word or count, never a value. */
function triggerNotes(t, bundles = null) {
  return [
    t.resume ? "keeps a session" : null,
    t.replicas ? `${t.replicas} replicas` : null,
    t.secrets > 0
      ? `${t.secrets} secrets${t.secretsProfile ? ` (profile ${t.secretsProfile})` : ""}`
      : null,
    triggerBundleNote(t, bundles),
    Array.isArray(t.mcp) ? `mcp ${t.mcp.join(", ")}` : null,
    t.packages === false ? null : "staged packages",
    t.instructions ? "has instructions" : null,
    t.skillsDir ? `skills ${shownPath(t.skillsDir)}` : null,
    t.image ? `image ${t.image}` : null,
    t.backend ? `venue ${t.backend}` : null,
    t.maxCostUsd ? `job cap $${t.maxCostUsd}` : null,
    t.modelSelection?.strategy === "random" ? `random pool ${t.modelSelection.candidates.join(", ")}` : null,
    Array.isArray(t.fallbackModels) && t.fallbackModels.length > 0
      ? `fallbacks ${t.fallbackModels.join(", ")}`
      : null,
    t.portfolio ? "writes the budget split" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Human row numbers match the row buttons; machine indexes remain zero-based. */
const triggerAt = (i) => `row ${i + 1}`;

/** The triggers editor: a JSON entry to add (the add tool's fields), the edit tool's fields, and a delete by row. */
function triggersEditor(view) {
  return canAct(view)
    ? ui.btn({
        label: "Add a trigger",
        href: ui.pageHref(view.pages, "trigger-add") ?? "/config/trigger-add",
        kind: "primary",
      })
    : null;
}

export const configTriggers = fromSnapshot("Triggers", (s, view) => {
  const v = s.triggers;
  const trouble = fileTrouble(v, "triggers file", s);
  if (trouble)
    return html`<p class="warn">${trouble}</p>
      ${triggersEditor(view)}`;
  const list = Array.isArray(v.triggers) ? v.triggers : [];
  return html`<p><a class="btn" href="/triggers">Read trigger rules and check an event</a></p>${list.some((t) => t.type === "watch")
    ? html`<p><a href="/watch">Watch findings and boards</a></p>`
    : null}${table(
    "Triggers",
    [{ num: "Row" }, "On", "Runs", "Model", "Notes", "Actions"],
    list.map((t, position) => {
      const i = t.index ?? position;
      const what = t.command ? `command ${t.command}` : `flow ${cell(t.flow)}`;
      const where =
        t.type === "cron"
          ? t.folder
            ? ` in ${shownPath(t.folder)}`
            : ""
          : t.forge
            ? ` on ${t.forge}`
            : "";
      const model =
        [t.provider, t.model].filter(Boolean).join(" / ") ||
        "deployment default";
      return html`<tr>
        <td class="num">${i + 1}</td>
        <td>
          <a href="${ui.pageHref(view.pages, "trigger", { index: i })}"
            >${triggerOn(t)}</a
          >
        </td>
        <td>${what}${where}</td>
        <td>${model}</td>
        <td>${triggerNotes(t, s.secretBundles) || "-"}</td>
        <td>
          <div class="acts">
            ${canAct(view)
              ? html`${ui.btn({
                  label: `Edit row ${i + 1}`,
                  href: `${ui.pageHref(view.pages, "trigger", { index: i })}#p-trigger-edit`,
                  kind: "sm",
                })}${rowDelete("trigger-delete", i)}`
              : null}
          </div>
        </td>
      </tr>`;
    }),
    "The triggers file declares no trigger.",
  )}${triggersEditor(view)}`;
}, { files: true });

/** Settings shown with their value; every other key the overlay sets is listed by name only. */
const SETTINGS_SHOWN = Object.freeze([
  "provider",
  "model",
  "maxTurns",
  "maxTokens",
  "concurrency",
  "dailyCap",
  "weeklyCap",
  "monthlyCap",
  "dailyTokenCap",
  "softHoldPct",
  "maxCostUsd",
  "dailyCostUsd",
  "weeklyCostUsd",
  "monthlyCostUsd",
]);

/** The settings editor: set a key to a value, or unset it back to its default (the `dispatch_set` tool's two shapes). */
function settingsEditor(view) {
  if (!canAct(view)) return null;
  return editor(
    "Change a setting",
    html`${actForm("setting-set", {
      fields: html`${field("key", "Key", { options: KNOWN_KEYS })}${field(
        "value",
        "Value",
        { required: true },
      )}`,
      label: "Preview the change",
    })}${actForm("setting-unset", {
      fields: field("key", "Key", { options: KNOWN_KEYS }),
      label: "Preview the unset",
    })}`,
  );
}

export const configSettings = fromSnapshot("Settings overlay", (s, view) => {
  const v = s.settings;
  if (!v || v.invalid)
    return html`<p class="warn">${settingsUnreadable(v) ?? doctorReason(s, "settings overlay")}</p>
      ${settingsEditor(view)}`;
  const overlay = v.overlay ?? {};
  const shown = KNOWN_KEYS;
  const others = Object.keys(overlay)
    .filter((k) => !SETTINGS_SHOWN.includes(k))
    .sort();
  return html`${shown.length === 0
    ? html`<p class="note">
        The overlay sets nothing; every setting is the deployment's environment
        or its default.
      </p>`
    : facts(
        shown.map((k) => [
          k,
          overlay[k] === undefined ? "deployment default" : String(overlay[k]),
        ]),
      )}${others.length > 0
    ? html`<p class="note">Also set: ${others.join(", ")}</p>`
    : null}${settingsEditor(view)}`;
}, { files: true });

/** A pause window's fields, as the add and edit tools take them (an edit leaves a blank field as it was). */
function pauseFieldsHtml(required, w = {}) {
  return html`${field("scope", "Scope", {
    value:
      typeof w.scope === "string" && w.scope.startsWith("/")
        ? ""
        : (w.scope ?? ""),
    required,
    placeholder: w.scope
      ? `Blank keeps ${shownPath(w.scope)}`
      : "owner/name, a folder, or *",
    max: 4096,
  })}${field("from", "From (HH:MM)", {
    value: w.from ?? "",
    required,
    max: 5,
  })}${field("to", "To (HH:MM)", {
    value: w.to ?? "",
    required,
    max: 5,
  })}${field("tz", "Zone (IANA, default UTC)", {
    value: w.tz ?? "",
    max: 64,
  })}${field("days", "Days (mon..sun)", {
    value: w.days?.join(", ") ?? "",
    type: "list",
    max: 64,
  })}${field("dateFrom", "From date (YYYY-MM-DD)", {
    value: w.dateFrom ?? "",
    max: 10,
  })}${field("dateTo", "To date (YYYY-MM-DD)", {
    value: w.dateTo ?? "",
    max: 10,
  })}`;
}

function pauseEditor(view) {
  if (!canAct(view)) return null;
  return editor(
    "Change the pause windows",
    html`${actForm("pause-window-add", {
      fields: pauseFieldsHtml(true),
      label: "Preview the add",
    })}`,
  );
}

export const configPauseWindows = fromSnapshot("Pause windows", (s, view) => {
  const v = s.pauseWindows;
  const trouble = fileTrouble(v, "pause-windows file", s);
  if (trouble)
    return html`<p class="note">${trouble}</p>
      ${pauseEditor(view)}`;
  const list = Array.isArray(v.windows) ? v.windows : [];
  return html`${table(
    "Pause windows",
    ["Row", "Scope", "From", "To", "Zone", "Days", "Dates", "Actions"],
    list.map(
      (w, i) =>
        html`<tr>
          <td>${i + 1}</td>
          <td class="code">${shownPath(cell(w.scope))}</td>
          <td>${cell(w.from)}</td>
          <td>${cell(w.to)}</td>
          <td>${cell(w.tz)}</td>
          <td>
            ${Array.isArray(w.days) && w.days.length > 0
              ? w.days.join(", ")
              : "every day"}
          </td>
          <td>
            ${w.dateFrom || w.dateTo
              ? `${cell(w.dateFrom)} to ${cell(w.dateTo)}`
              : "-"}
          </td>
          <td>
            ${canAct(view)
              ? html`${editor(
                  `Edit row ${i + 1}`,
                  actForm("pause-window-edit", {
                    hidden: [["index", i, "int"]],
                    fields: pauseFieldsHtml(false, w),
                    label: `Preview edit of row ${i + 1}`,
                  }),
                )}${rowDelete("pause-window-delete", i)}`
              : null}
          </td>
        </tr>`,
    ),
    "No pause window is set.",
  )}${pauseEditor(view)}`;
}, { files: true });

/** The scoped-limit fields a row may set, in the file's order, with how each reads. */
const LIMIT_FIELDS = Object.freeze([
  ["day", "jobs a day"],
  ["week", "jobs a week"],
  ["month", "jobs a month"],
  ["concurrent", "at once"],
  ["dayUsd", "a day"],
  ["weekUsd", "a week"],
  ["monthUsd", "a month"],
  ["memory", "memory"],
  ["cpus", "CPUs"],
  ["hostShare", "host share"],
  ["minJobs", "min jobs"],
]);

/** The scoped-limits editor: a row as the limit tools' fields (JSON), an edit of row N, a delete. */
function limitsEditor(view) {
  if (!canAct(view)) return null;
  const json = area("limit", "The row, as the limit tools' fields (JSON)", {
    type: "json",
    rows: 4,
    required: true,
    placeholder: '{"scope": "acme/web", "day": 10, "concurrent": 2}',
  });
  return editor(
    "Change the scoped limits",
    html`${actForm("limit-add", { fields: json, label: "Preview the add" })}`,
  );
}

export const configScopedLimits = fromSnapshot("Scoped limits", (s, view) => {
  const v = s.scopedLimits;
  const trouble = fileTrouble(v, "scoped-limits file", s);
  if (trouble)
    return html`<p class="note">${trouble}</p>
      ${limitsEditor(view)}`;
  const list = Array.isArray(v.limits) ? v.limits : [];
  return html`${table(
    "Scoped limits",
    ["Row", "Scope", "Limits", "Actions"],
    list.map(
      (l, i) =>
        html`<tr>
          <td>${i + 1}</td>
          <td class="code">${shownPath(cell(l.scope))}</td>
          <td>
            ${LIMIT_FIELDS.filter(([k]) => l[k] !== null && l[k] !== undefined)
              .map(
                ([k, words]) =>
                  `${k.endsWith("Usd") ? `$${l[k]}` : l[k]} ${words}`,
              )
              .join("; ") || "-"}
          </td>
          <td>
            ${canAct(view)
              ? html`${editor(
                  `Edit row ${i + 1}`,
                  actForm("limit-edit", {
                    hidden: [["index", i, "int"]],
                    fields: area(
                      "limit",
                      "Fields to change (JSON; omitted fields keep their values)",
                      {
                        type: "json",
                        value: JSON.stringify(
                          {
                            ...l,
                            ...(typeof l.scope === "string" &&
                            l.scope.startsWith("/")
                              ? { scope: undefined }
                              : {}),
                          },
                          null,
                          2,
                        ),
                      },
                    ),
                    label: `Preview edit of row ${i + 1}`,
                  }),
                )}${rowDelete("limit-delete", i)}`
              : null}
          </td>
        </tr>`,
    ),
    "No scoped limit is set.",
  )}${limitsEditor(view)}`;
}, { files: true });

/** The projects, envelope, priorities and revert editors. */
function projectsEditor(view) {
  if (!canAct(view)) return null;
  const members = (required) =>
    area("members", "Members, one repository or folder per line", {
      rows: 3,
      required,
      max: 16384,
    });
  return editor(
    "Change the projects",
    html`${actForm("project-add", {
        fields: html`${field("id", "Id", { required: true, max: 64 })}${field(
          "name",
          "Name (optional)",
        )}${members(true)}`,
        label: "Preview the add",
      })}
      <p class="note">
        <a href="/insights/budget-split"
          >Edit the envelope, priorities and allocation history in Budget
          split</a
        >.
      </p>`,
  );
}

export const configProjects = fromSnapshot("Projects", (s, view) => {
  const v = s.projects;
  const trouble = fileTrouble(v, "projects file", s);
  if (trouble)
    return html`<p class="note">${trouble}</p>
      ${projectsEditor(view)}`;
  const list = Array.isArray(v.projects) ? v.projects : [];
  return html`${table(
    "Projects",
    ["Row", "Project", "Name", "Members", "Actions"],
    list.map(
      (p, i) =>
        html`<tr>
          <td>${i + 1}</td>
          <td class="code"><a href="${`/config/project?id=${encodeURIComponent(p.id)}`}">${cell(p.id)}</a></td>
          <td>${cell(p.name)}</td>
          <td class="mono">
            ${Array.isArray(p.members) && p.members.length > 0
              ? p.members.map(shownPath).join(", ")
              : "-"}
          </td>
          <td>
            ${canAct(view)
              ? html`${editor(
                  `Edit row ${i + 1}`,
                  actForm("project-edit", {
                    hidden: [["id", p.id]],
                    fields: html`${field("name", "Name", {
                      value: p.name ?? "",
                    })}${area(
                      "members",
                      "Members (blank keeps the current list)",
                      {
                        value: p.members?.some((m) => m.startsWith("/"))
                          ? ""
                          : (p.members?.join("\n") ?? ""),
                      },
                    )}`,
                    label: `Preview edit of row ${i + 1}`,
                  }),
                )}${actForm("project-delete", {
                  hidden: [["id", p.id]],
                  label: `Delete row ${i + 1}`,
                })}`
              : null}
          </td>
        </tr>`,
    ),
    "The projects file declares no project.",
  )}${facts([
    ["Allocation envelope", s.envelopeSet ? "set" : "not set"],
  ])}${projectsEditor(view)}`;
}, { files: true });

/** The detail pages own these panels and writes; Configuration keeps one useful line per source. */
// An overlay that cannot be read whole answers an empty list beside `unreadable` (`readOverlayMcpView`): that is not a
// count of none, and the line says which it was: a file that does not load ("invalid") or one that could not be read.
const mcpUnread = (u) => (u === "invalid" ? "the overlay's MCP file does not load" : `the overlay's MCP file cannot be read${typeof u === "string" && /^E[A-Z0-9]{1,20}$/.test(u) ? ` (${u})` : ""}`);
export const configMcp = fromSnapshot("MCP servers", (s) => html`<p>${s.overlayMcp?.unreadable ? `Overlay servers not known: ${mcpUnread(s.overlayMcp.unreadable)}.` : `${s.overlayMcp?.servers?.length ?? "Unknown"} overlay ${s.overlayMcp?.servers?.length === 1 ? "server" : "servers"}.`} <a class="link" href="/config/connections#p-mcp">Open Connections</a></p>`, { files: true });
/** The staged-packages card over a manifest that is there and could not be read (issue #962): never "0 packages staged". */
export const PACKAGES_UNREAD_TEXT = "Staged packages not known: the manifest could not be read.";
/** The same over a manifest that was read and holds no list this console can use, in the Triggers card's word for it. */
export const PACKAGES_MALFORMED_TEXT = "Staged packages not known: the manifest does not load.";
export const configPackages = fromSnapshot("Staged pi packages", (s) => html`<p>${s.stagedPackages?.unreadable ? (s.stagedPackages.malformed === true ? PACKAGES_MALFORMED_TEXT : PACKAGES_UNREAD_TEXT) : `${s.stagedPackages?.packages?.length ?? "Unknown"} packages staged.`} <a class="link" href="/config/connections#p-packages">Open Connections</a>. <a class="link" href="/config/updates">See what is newer</a></p>`, { files: true });
/**
 * The two secret cards' counts (issue #962), by the Secrets page's own rule (`secretCountTrouble`): the profiles are
 * named by the settings overlay and the triggers file, the bundles bound by the triggers file, and a source that could
 * not be read or does not load leaves its list short. The count is then not known, or a floor, never a zero, and the
 * line says which source and which of the two it was. A file that is not there names and binds nothing: its zero stands.
 */
const secretCount = (trouble, n, noun) => (trouble ? (n > 0 ? `At least ${n} ${noun} in view; the rest is not known: ${trouble}.` : `${noun[0].toUpperCase()}${noun.slice(1)} not known: ${trouble}.`) : `${n} ${noun} in view.`);
export const configSecretProfiles = fromSnapshot("Secret profiles", (s) => html`<p>${secretCount(secretCountTrouble(s).profiles, s.secretProfiles?.profiles?.length ?? 0, "profiles")} <a class="link" href="/config/secrets#p-secret-profiles">Open Secrets</a></p>`);
export const configSecretBundles = fromSnapshot("Secret bundles", (s) => html`<p>${secretCount(secretCountTrouble(s).bundles, s.secretBundles?.bundles?.length ?? 0, "project bundles")} <a class="link" href="/config/secrets#p-secret-bundles">Open Secrets</a></p>`);

const shortFile = (path, fallback) => typeof path === "string" && path ? `…/${path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}` : fallback;
export function configDescription(v) {
  const s = v.data?.snapshot ?? filesSnapshot(v);
  const locations = v.data?.configLocations ?? {};
  const settings = locations.settings ?? (s?.settings?.path?.endsWith("/.pi-dispatch/settings.json") ? "~/.pi-dispatch/settings.json" : shortFile(s?.settings?.path, "settings overlay unavailable"));
  const outside = locations.settingsOutsideDeployment === true || settings === "~/.pi-dispatch/settings.json";
  return `Settings: ${settings}${outside ? " (outside the deployment folder)" : ""}. Triggers: ${locations.triggers ?? shortFile(s?.triggers?.path, "triggers file unavailable")}.`;
}
export function configNavigation(v) {
  // Issue #844: with no snapshot a count comes from the files, or is not drawn at all (`fpill` draws none for null):
  // never a number above a card that says it could not be read.
  // Issue #962: the same holds for one file under a snapshot that loaded. A file that cannot be read or does not load
  // has no count, where a zero would say it holds nothing; a file that is not there, or not configured, holds none,
  // and that zero is a read's own answer.
  const s = v.data?.snapshot ?? filesSnapshot(v);
  const fileCount = (view, list) => (Array.isArray(list) ? list.length : view?.missing === true || view?.unset === true ? 0 : null);
  const overlay = s?.settings?.overlay;
  const sections = [
    ["settings", "Settings", overlay !== null && typeof overlay === "object" ? Object.keys(overlay).length : null],
    ["triggers", "Triggers", fileCount(s?.triggers, s?.triggers?.triggers)],
    ["pause-windows", "Pause windows", fileCount(s?.pauseWindows, s?.pauseWindows?.windows)],
    ["scoped-limits", "Scoped limits", fileCount(s?.scopedLimits, s?.scopedLimits?.limits)],
    ["projects", "Projects", fileCount(s?.projects, s?.projects?.projects)],
    ["files", "Files", s ? 2 : null],
    ["unset", "Unset", s ? 0 : null],
    ["mcp-servers", "MCP servers", s?.overlayMcp?.unreadable ? null : fileCount(null, s?.overlayMcp?.servers)],
  ];
  return html`<nav class="config-sections" aria-label="Configuration sections">
    ${sections.map(([id, label, count]) =>
      ui.fpill({ label, count, href: `#cf-${id}` }),
    )}<span class="config-divider" aria-hidden="true"></span>${ui.btn({
      label: "Secrets",
      href: ui.pageHref(v.pages, "secrets") ?? "/config",
      kind: "sm",
    })}${ui.btn({
      label: "Connections",
      href: ui.pageHref(v.pages, "connections") ?? "/config",
      kind: "sm",
    })}${ui.btn({
      label: "Remembered browsers",
      href: ui.pageHref(v.pages, "devices") ?? "/config",
      kind: "sm",
    })}
  </nav>`;
}
export const configFiles = fromSnapshot(
  "Files",
  (s, v) => html`<p>${configDescription(v)}</p>`,
  { files: true },
);
export const configUnset = fromSnapshot("Unset a setting", (s, v) =>
  canAct(v)
    ? actForm("setting-unset", {
        fields: field("key", "Key", { options: KNOWN_KEYS }),
        label: "Preview the unset",
      })
    : html`<p>Unset keys fall back to the deployment defaults.</p>`,
  { files: true },
);
