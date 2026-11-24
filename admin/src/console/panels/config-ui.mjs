/** Configuration controls share the Pulse kit, including errors associated with each control. */
import { html as escapedHtml } from "../html.mjs";
// Keep indented source readable without emitting whitespace-only lines when an optional fragment is absent.
const html = (strings, ...values) => escapedHtml(strings.map(s => s.replace(/[ \t]*\n[ \t]*/g, "\n")), ...values);
import * as ui from "../kit.mjs";
export function field(
  name,
  label,
  {
    type = null,
    input = "text",
    required = false,
    placeholder = null,
    max = 512,
    value = "",
    options = null,
    hint = null,
    id = null,
  } = {},
) {
  const fid = id ?? `cfg-${name}`;
  return html`<div class="field">
    <label
      >${label}${options
        ? html`<select
            class="select"
            name="${name}"
            ${required ? html` required` : null}
            ${type ? html` data-type="${type}"` : null}
          >
            ${options.map((o) => {
              const v = typeof o === "string" ? o : o.value;
              return html`<option
                value="${v}"
                ${String(value) === String(v) ? html` selected` : null}
              >
                ${typeof o === "string" ? o : o.label}
              </option>`;
            })}
          </select>`
        : html`<input
            class="input"
            name="${name}"
            type="${input}"
            value="${value}"
            ${type ? html` data-type="${type}"` : null}${required
              ? html` required`
              : null}${placeholder ? html` placeholder="${placeholder}"` : null}
            maxlength="${max}"
            autocomplete="off"
            spellcheck="false"
          />`}</label
    >${hint ? html`<p class="field__hint">${hint}</p>` : null}
    <p class="field__err" data-field-error="${name}" hidden></p>
  </div>`;
}
export function area(
  name,
  label,
  {
    type = null,
    rows = 4,
    required = false,
    placeholder = null,
    max = 16384,
    value = "",
  } = {},
) {
  return html`<div class="field">
    <label
      >${label}<textarea
        class="textarea"
        name="${name}"
        rows="${rows}"
        ${type ? html` data-type="${type}"` : null}${required
          ? html` required`
          : null}${placeholder ? html` placeholder="${placeholder}"` : null}
        maxlength="${max}"
      >
${value}</textarea
      >
    </label>
    <p class="field__err" data-field-error="${name}" hidden></p>
  </div>`;
}
export function actForm(
  action,
  { hidden = [], fields = null, label, structured = null, danger = false, icon = null } = {},
) {
  return html`<form
    class="act config-form stack"
    data-action="${action}"
    ${structured ? html` data-structured="${structured}"` : null}
    autocomplete="off"
  >
    <fieldset data-config-controls disabled>
    ${hidden.map(
      ([k, v, t]) =>
        html`<input
          type="hidden"
          name="${k}"
          value="${String(v)}"
          ${t ? html` data-type="${t}"` : null}
        />`,
    )}${fields}${ui.btn({
      type: "submit",
      label,
      ...(icon ? { icon } : {}),
      kind: danger || action.endsWith("delete") ? ["danger", "sm"] : action === "trigger-fire" || action === "package-canary" ? ["paid", "sm"] : action === "package-undo" ? ["sm"] : ["primary", "sm"],
    })}
    </fieldset>
    <noscript><p class="muted">Enable JavaScript to preview and confirm a change. Reading and navigation work without it.</p></noscript>
    <p class="field__err" data-form-error hidden role="alert"></p>
  </form>`;
}
export const editor = (summary, forms) =>
  html`<details class="config-editor">
    <summary>${summary}</summary>
    <div class="stack">${forms}</div>
  </details>`;
export const table = (label, heads, rows, empty) =>
  rows.length
    ? html`<div class="tbl-wrap">
        <table class="tbl" aria-label="${label}">
          <thead>
            <tr>
              ${heads.map(
                (h) =>
                  html`<th scope="col">
                    ${typeof h === "string" ? h : h.num}
                  </th>`,
              )}
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`
    : html`<p class="muted">${empty}</p>`;
export const facts = (pairs) => ui.facts(pairs);
/** Above a card drawn from the files alone (issue #844): what it shows, and why it offers no change. */
export const FILES_ONLY_TEXT = "Valkey could not be read, so this shows what the file holds and offers no change. Reload to try again.";
/**
 * The snapshot a file-backed card draws from where the snapshot itself failed (issue #844): the reader's `fileViews`
 * under the snapshot's own keys, or null where there is none (they are only read when the snapshot failed). Nothing
 * in it came from Valkey.
 */
export const filesSnapshot = (view) =>
  view.data?.files && typeof view.data.files === "object" ? view.data.files : null;
/**
 * A card drawn from the snapshot. `files: true` marks one whose facts are all the deployment's files': with no
 * snapshot it is drawn from `filesSnapshot`, read-only (a change is previewed against the queue and the hosts, which
 * were not read), under `FILES_ONLY_TEXT`. Any other card says the read failed, never an empty list.
 */
export const fromSnapshot = (title, render, { files = false } = {}) => (view) => {
  const only = files ? filesSnapshot(view) : null;
  return ui.card({
    title,
    body: view.data?.snapshot
      ? render(view.data.snapshot, view)
      : only
        ? html`<p class="muted">${FILES_ONLY_TEXT}</p>${render(only, { ...view, readOnly: true })}`
        : html`<p class="muted">
          The deployment's Valkey could not be read. Reload to try again.
        </p>`,
  });
};
export const rowDelete = (action, index) =>
  actForm(action, {
    hidden: [["index", index, "int"]],
    label: `Delete row ${index + 1}`,
  });
