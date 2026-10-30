/**
 * The configuration screen's panels, split out of `../panels.mjs` (issue #737), which re-exports what this module
 * exports. The rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the
 * role and run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import {
  bundleDeclaredText,
  bundleEndpointsText,
  overlayBundleProfiles,
  secretProfileNames,
  triggerBundleOf,
  PROFILE_ROOTS_TEXT,
  PROFILE_SOURCE_TEXT,
  profileHostsText,
  profileLastText,
} from "../../read-model.mjs";
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

/** A file view's trouble as one sentence (no parser message: it names the host's path), or null when it loaded. */
export function fileTrouble(v, what, s = null) {
  if (!v) return `The ${what} could not be read.`;
  if (v.unset) return `No ${what} is configured.`;
  if (v.missing) return `The ${what} does not exist.`;
  if (v.invalid) return doctorReason(s, what);
  if (v.unreadable)
    return `The ${what} cannot be read (${String(v.unreadable)}).`;
  return null;
}

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
  return html`${list.some((t) => t.type === "watch")
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
});

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
    return html`<p class="warn">${doctorReason(s, "settings overlay")}</p>
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
});

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
});

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
});

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
          <td class="code">${cell(p.id)}</td>
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
});

export const configMcp = fromSnapshot("MCP servers", (s) => {
  const v = s.overlayMcp ?? {};
  if (v.unreadable)
    return html`<p class="warn">
      The overlay's MCP file cannot be used (${String(v.unreadable)}).
    </p>`;
  const list = Array.isArray(v.servers) ? v.servers : [];
  return html`${table(
    "MCP servers",
    ["Server", "Transport", "Where", "Exposure", "On", "References"],
    list.map(
      (m) =>
        html`<tr>
          <td class="mono">${cell(m.name)}</td>
          <td>${cell(m.transport)}</td>
          <td class="mono">${cell(m.where)}</td>
          <td>${cell(m.exposure)}</td>
          <td>${m.enabled ? "yes" : "no"}</td>
          <td class="mono">
            ${Array.isArray(m.refs) && m.refs.length > 0
              ? m.refs.join(", ")
              : "-"}
          </td>
        </tr>`,
    ),
    "The overlay declares no MCP server.",
  )}${Array.isArray(v.refused) && v.refused.length > 0
    ? html`<p class="warn">Refused: ${v.refused.join(", ")}</p>`
    : null}`;
});

export const configPackages = fromSnapshot("Staged pi packages", (s) => {
  const v = s.stagedPackages ?? {};
  const list = Array.isArray(v.packages) ? v.packages : [];
  if (list.length === 0)
    return html`<p class="note">No pi package is staged.</p>`;
  return html`${v.stagedAt
      ? html`<p class="note">Staged ${v.stagedAt}.</p>`
      : null}
    <ul class="plain">
      ${list.map((p) => html`<li class="mono">${p}</li>`)}
    </ul>`;
});

/** The secret profiles editor: a name and its resolver's absolute path, never a reference or a value. */
function profilesEditor(view) {
  if (!canAct(view)) return null;
  return editor(
    "Change the secret profiles",
    html`${actForm("secret-profile-add", {
      fields: html`${field("name", "Name", { required: true, max: 64 })}${field(
        "path",
        "Resolver (absolute path)",
        { required: true, max: 4096 },
      )}`,
      label: "Preview the add",
    })}${actForm("secret-profile-remove", {
      fields: field("name", "Name", { required: true, max: 64 }),
      label: "Preview the removal",
    })}`,
  );
}

export const configSecretProfiles = fromSnapshot(
  "Secret profiles",
  (s, view) => {
    const names = secretProfileNames(s.settings);
    // Issue #712: the PI_SECRET_PROFILES names too (the snapshot's `secretProfilesEnv`), since the worker merges both; a
    // name in both is the worker's ambiguity, which refuses every secrets job, and is marked so.
    const env = s.secretProfilesEnv ?? null;
    const fromEnv = Array.isArray(env?.names) ? env.names : [];
    const envNote = env?.malformed
      ? html`<p class="warn">
          PI_SECRET_PROFILES does not parse, so the worker refuses to boot until
          it is fixed.
        </p>`
      : null;
    // "None" only where the console can see both sources; otherwise it names the one it read.
    if (names.length === 0 && fromEnv.length === 0)
      return html`<p class="note">
          No secret profile is
          declared${env?.seen === true ? "" : " in the settings overlay"}.
        </p>
        ${envNote}${profileUse(s.secretProfiles)}${profilesEditor(view)}`;
    const overlayItem = (n) =>
      fromEnv.includes(n)
        ? html`<li class="mono warn">
            ${n} (AMBIGUOUS: also in PI_SECRET_PROFILES, so the worker refuses
            every secrets job)
          </li>`
        : html`<li class="mono">${n}</li>`;
    return html`<p class="note">
        Names only: a profile's resolver and its references stay in the settings
        file${fromEnv.length > 0 ? " or the .env" : ""}.
      </p>
      <ul class="plain">
        ${fromEnv.map(
          (n) => html`<li class="mono">${n} (PI_SECRET_PROFILES)</li>`,
        )}${names.map(overlayItem)}
      </ul>
      ${envNote}${profileUse(s.secretProfiles)}${profilesEditor(view)}`;
  },
);

/**
 * Each profile's use (issue #712, the snapshot's `secretProfiles`, `secretProfilesView`): its source, where its resolver
 * stands against PI_SECRET_RESOLVER_ROOTS on this host, the triggers and projects that use it, the last resolve a run in
 * view recorded, and the live hosts that advertise it. Words and names only: the view carries no resolver path, so the
 * page cannot (REQ-OPERATOR-CONSOLE-SCREENS (g)). Nothing when no profile is declared or named.
 */
function profileUse(v) {
  const rows = Array.isArray(v?.profiles) ? v.profiles : [];
  if (rows.length === 0) return null;
  return table(
    "Secret profiles in use",
    [
      "Profile",
      "Source",
      "Resolver roots",
      "Triggers",
      "Projects",
      "Last resolve",
      "Served by",
    ],
    rows.map((row) => {
      // A trigger by the index the Triggers table above shows (issue #737: "index 0", one wording on the page).
      const trig =
        row.triggers.length > 0
          ? `${row.triggers.map(triggerAt).join(", ")}${row.triggersMore > 0 ? ` and ${row.triggersMore} more` : ""}`
          : "none";
      const proj =
        [
          ...row.projects,
          ...(row.projectsMore > 0 ? [`${row.projectsMore} more`] : []),
          ...(row.anyRepo ? ["any (a webhook trigger)"] : []),
        ].join(", ") || "-";
      const last = row.last
        ? html`${profileLastText(row.last).replace(/^last resolve: /, "")}${row
            .last.jobId
            ? html` (${runLink(row.last.jobId)})`
            : null}`
        : "no run in view";
      const warnSource =
        row.source === "ambiguous" || row.source === "undeclared";
      const warnRoots = row.roots === "outside" || row.roots === "empty";
      return html`<tr><td class="mono">${row.name}</td><td${warnSource ? html` class="warn"` : null}>${PROFILE_SOURCE_TEXT[row.source] ?? "-"}</td><td${warnRoots ? html` class="warn"` : null}>${row.roots !== null ? (PROFILE_ROOTS_TEXT[row.roots] ?? "-") : "not bounded (an env resolver)"}</td><td>${trig}</td><td class="mono">${proj}</td><td${row.last?.outcome === "refused" ? html` class="warn"` : null}>${last}</td><td class="mono">${profileHostsText(row, v).replace(/^served by: /, "")}</td></tr>`;
    }),
    "",
  );
}

/** The bundle resolvers editor (issue #704): a name, its resolver's absolute path and the format it prints. */
function bundleProfilesEditor(view) {
  if (!canAct(view)) return null;
  return editor(
    "Change the bundle resolvers",
    html`${actForm("secret-bundle-add", {
      fields: html`${field("name", "Name", { required: true, max: 64 })}${field(
        "path",
        "Resolver (absolute path)",
        { required: true, max: 4096 },
      )}${field("format", "Format it prints (dotenv or json)", {
        required: true,
        max: 16,
        placeholder: "dotenv",
      })}`,
      label: "Preview the add",
    })}${actForm("secret-bundle-remove", {
      fields: field("name", "Name", { required: true, max: 64 }),
      label: "Preview the removal",
    })}`,
  );
}

/**
 * The project secret bundles (issue #704): the overlay's bundle resolvers (names and formats), then each bundle the
 * triggers file binds, with its project, its profile and whether this deployment declares it, fork reviews, the
 * endpoints, the triggers that opt out and the variable NAMES the newest run in view received. Never a reference or a
 * value, and nothing is resolved to draw it: `pi-dispatch doctor --secrets` does that on the host that runs the jobs.
 */
export const configSecretBundles = fromSnapshot("Secret bundles", (s, view) => {
  const resolvers = overlayBundleProfiles(s.settings);
  const names = Object.keys(resolvers).sort();
  const rows = Array.isArray(s.secretBundles?.bundles)
    ? s.secretBundles.bundles
    : [];
  const declared =
    names.length === 0
      ? html`<p class="note">
          No bundle resolver is declared in the settings overlay.
        </p>`
      : html`<p class="note">
            Bundle resolvers in the settings overlay (names and formats; the
            path stays in the file):
          </p>
          <ul class="plain">
            ${names.map(
              (n) =>
                html`<li class="mono">${n} (${cell(resolvers[n].format)})</li>`,
            )}
          </ul>`;
  return html`${declared}${table(
    "Secret bundles",
    [
      "Bundle",
      "Project",
      "Profile",
      "Fork reviews",
      "Endpoints",
      "Opted out",
      "Last received",
    ],
    rows.map((b) => {
      // Under the column headers, so each cell holds the value alone (final review: no repeated label).
      const project = `${b.project ?? "-"}${b.projectKnown === false ? " (not in projects.json)" : ""}`;
      const profile = `${b.profile ?? "-"} (${bundleDeclaredText(b)})`;
      const fork = b.forkReviews ? "yes" : "no";
      const ends =
        Array.isArray(b.endpoints) && b.endpoints.length > 0
          ? bundleEndpointsText(b)
          : "none";
      const opted =
        Array.isArray(b.optedOut) && b.optedOut.length > 0
          ? b.optedOut.map(triggerAt).join(", ")
          : "none";
      const last = b.last
        ? html`${b.last.variables.length > 0
            ? b.last.variables.join(", ")
            : "none"}
          (${b.last.jobId ? runLink(b.last.jobId) : "-"})`
        : "no run in view";
      return html`<tr><td class="mono">${cell(b.id)}</td><td>${project}</td><td${b.declared === "env" || b.declared === "overlay" ? null : html` class="warn"`}>${profile}</td><td>${fork}</td><td class="mono">${ends}</td><td>${opted}</td><td class="mono">${last}</td></tr>`;
    }),
    "The triggers file binds no secret bundle.",
  )}${bundleProfilesEditor(view)}`;
});

const shortFile = (path, fallback) =>
  typeof path === "string" && path
    ? `…/${path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}`
    : fallback;
export function configDescription(v) {
  const s = v.data?.snapshot;
  const locations = v.data?.configLocations ?? {};
  const settings = locations.settings ?? (s?.settings?.path?.endsWith("/.pi-dispatch/settings.json") ? "~/.pi-dispatch/settings.json" : shortFile(s?.settings?.path, "settings overlay unavailable"));
  const outside = locations.settingsOutsideDeployment === true || settings === "~/.pi-dispatch/settings.json";
  return `Settings: ${settings}${outside ? " (outside the deployment folder)" : ""}. Triggers: ${locations.triggers ?? shortFile(s?.triggers?.path, "triggers file unavailable")}.`;
}
export function configNavigation(v) {
  const s = v.data?.snapshot ?? {};
  const sections = [
    ["settings", "Settings", Object.keys(s.settings?.overlay ?? {}).length],
    ["triggers", "Triggers", s.triggers?.triggers?.length ?? 0],
    ["pause-windows", "Pause windows", s.pauseWindows?.windows?.length ?? 0],
    ["scoped-limits", "Scoped limits", s.scopedLimits?.limits?.length ?? 0],
    ["projects", "Projects", s.projects?.projects?.length ?? 0],
    ["files", "Files", 2],
    ["unset", "Unset", 0],
    ["mcp-servers", "MCP servers", s.overlayMcp?.servers?.length ?? 0],
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
    })}
  </nav>`;
}
export const configFiles = fromSnapshot(
  "Files",
  (s, v) => html`<p>${configDescription(v)}</p>`,
);
export const configUnset = fromSnapshot("Unset a setting", (s, v) =>
  canAct(v)
    ? actForm("setting-unset", {
        fields: field("key", "Key", { options: KNOWN_KEYS }),
        label: "Preview the unset",
      })
    : html`<p>Unset keys fall back to the deployment defaults.</p>`,
);
