/** #750: trigger states outside the fixture deployment, drawn by production renderers. */
import assert from "node:assert/strict";
import { triggerRefusalExamples } from "../../src/console/panels/trigger.mjs";
import { html } from "../../src/console/html.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { loadPageData, renderPage } from "../../src/console/pages.mjs";
const cron = {
  type: "cron",
  index: 0,
  id: "nightly",
  flow: "tidy",
  pattern: "0 3 * * *",
  task: true,
  backend: "openshell",
  stalls: 1,
};
export async function triggerGolden({
  trigger = cron,
  role = "operator",
  invalid = false,
  editor = false,
  forges = ["github", "gitlab"],
} = {}) {
  const snapshot = {
    readAt: NOW,
    triggers: invalid ? { invalid: true } : { triggers: [trigger] },
    triggerTasks: { 0: "Review the repository safely." },
    triggerInstructions: { 0: "Keep changes focused." },
    runs: [],
    waiting: { rows: [] },
    schedulers: [],
    settings: { overlay: {} },
    ...(invalid ? { doctorSelf: "build3", doctor: { hosts: [{ name: "build3", ageMs: 120000, checks: [{ id: "triggers.file", level: "fail", label: "trigger 5: once needs number", fix: "Set on.number before re-arming the trigger" }] }] } } : {}),
  };
  const name = editor ? "trigger-add" : "trigger";
  const query = editor ? {} : { index: 0 };
  const data = await loadPageData(
    name,
    query,
    {
      now: () => NOW,
      fleet: { snapshot: async () => snapshot },
      triggerEditor: () => ({
        backends: [
          {
            name: "local",
            serves: {
              liveTranscript: "yes",
              steering: "yes",
              recovery: "yes",
              sandboxShell: "yes",
            },
          },
        ],
        forges,
        flows: [{ name: "tidy", tier: "repository" }],
        defaults: { backend: "local", maxTurns: 30 },
      }),
      triggerFireCheck: () => ({
        refusal: "The schedule is not served by this deployment's queue.",
      }),
    },
    { role },
  );
  return (
    await renderPage(name, { query, session: { name: "ops", role }, data })
  ).html;
}
export const TRIGGER_DRAW = {
  "trigger-editor-no-webhook.operator": () => triggerGolden({ editor: true, forges: [] }),
  "trigger-cron.operator": () => triggerGolden(),
  "trigger-spent.operator": () =>
    triggerGolden({
      trigger: {
        type: "issue",
        index: 0,
        action: ["closed"],
        flow: "close",
        forge: "github",
        number: 42,
        once: true,
        disarmed: { jobId: "gh-spent" },
        instructions: true,
      },
    }),
  "trigger-file-invalid.operator": () => triggerGolden({ invalid: true }),
  "trigger-readonly.viewer": () => triggerGolden({ role: "viewer" }),
  "trigger-editor-refusals.operator": async () => {
    let page = String(await triggerGolden({ editor: true }));
    const error = triggerRefusalExamples().find(e=>e.field === "maxTurns").sentence;
    const errorField = /<div class="field">(?:(?!<div class="field">)[^])*?name="maxTurns"/g;
    assert.equal([...page.matchAll(errorField)].length, 1, "one field wrapper to mark");
    page = page.replace(errorField, field => field.replace('class="field"', 'class="field field--err"'));
    const control = /<input\b[^>]*name="maxTurns"[^>]*>/g;
    assert.equal([...page.matchAll(control)].length, 1, "one maxTurns control to refuse");
    page = page.replace(control, tag => tag.replace(/value="[^"]*"/, 'value="0"').replace(/<input/, '<input aria-invalid="true" aria-describedby="trigger-turns-error"'));
    const slot = /<p class="field__err" data-field-error="maxTurns" hidden><\/p>/g;
    assert.equal([...page.matchAll(slot)].length, 1, "one inline error slot");
    return page.replace(slot, String(html`<p class="field__err" id="trigger-turns-error" data-field-error="maxTurns">${error} Nothing was changed.</p>`));
  },
};
export const TRIGGER_PANEL_STATES = Object.freeze(Object.keys(TRIGGER_DRAW));
