import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
/** #750 exceptional list/check states through the real page loader, facts and receiver-backed checker. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { normalizeTriggerForDisplay } from "../../src/read-model.mjs";
import { triggerListOf } from "../../src/trigger-list.mjs";
import { checkTriggerEvent } from "../../src/trigger-check.mjs";
import { loadPageData, renderPage } from "../../src/console/pages.mjs";
import { renderTriggerCheckResult } from "../../src/console/panels/triggers.mjs";

const entries = [
  { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy", task: "PRIVATE TASK CANARY" } },
  { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix", replicas: 2 } },
  { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", resume: true } },
  { on: { type: "pull_request", action: ["open"] }, run: { kind: "gitlab", flow: "review" } },
];
let checkerPath;
function checked(input) {
  if (!checkerPath) {
    checkerPath = join(tempDir("pd-trigger-list-golden-"), "triggers.json");
    writeFileSync(checkerPath, JSON.stringify({ triggers: entries }));
  }
  return checkTriggerEvent({ triggersPath: checkerPath, input });
}
export async function triggerListGolden({ role = "operator", state = "history-cut", readOnly = false, check = null, kind = "all", extraTriggers = [], recordsOverride = undefined, complete = false } = {}) {
  const triggers = entries.map((entry, index) => ({ ...normalizeTriggerForDisplay(entry), index }));
  triggers.push(...extraTriggers);
  if (state === "spent") triggers.push({ index: 4, type: "issue", forge: "github", flow: "close", action: ["closed"], number: 42, once: true, disarmed: { jobId: "gh-spent", at: new Date(NOW - 3600000).toISOString() } });
  if (state === "dense") triggers[0].pattern = "* * * * *";
  const snapshot = {
    readAt: NOW, triggers: state === "unreadable" ? { invalid: true } : { triggers: state === "empty" ? [] : triggers },
    runs: [], schedulers: [{ key: "nightly", pattern: state === "dense" ? "* * * * *" : "0 3 * * *", next: NOW + 3600_000 }],
    waiting: { rows: [] }, settings: { overlay: {} },
    pauseWindows: { windows: parsePauseWindows(JSON.stringify({ windows: [{ scope: "github:acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam" }] }), "fixture") },
  };
  const name = check ? "trigger-check" : "triggers";
  const records = recordsOverride !== undefined ? recordsOverride : state === "history-unknown" ? null : [{ jobId: "gh-list", kind: "github", triggerIndex: 1, triggerType: "label", flow: "fix", outcome: "completed", startedAt: new Date(NOW - 120000).toISOString(), endedAt: new Date(NOW - 60000).toISOString(), tokens: { metered: true, cost: 0.01, calls: 1, input: 1, output: 1, total: 2 } }];
  const data = await loadPageData(name, name === "triggers" ? { kind } : {}, {
    now: () => NOW,
    fleet: { snapshot: async () => snapshot, parkedCount: async () => 0 },
    triggerList: snap => triggerListOf({ snapshot: snap, now: NOW, records, coverage: { complete }, scheduleZones: state === "zone-unknown" ? {} : { nightly: "UTC" } }),
  }, { role });
  const rendered = await renderPage(name, { query: name === "triggers" ? { kind } : {}, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly });
  assert.equal(rendered.status, 200);
  let page = String(rendered.html);
  if (check) {
    const input = check === "invalid" ? { forge: "unsupported" } : { forge: "github", event: "issue-labeled", repository: "acme/web", actor: "write", labels: [check === "match" ? "go" : "different"] };
    const result = checked(input);
    assert.equal(Boolean(result.matched), check === "match");
    const slot = /(<div\s+data-trigger-check-result\b[^>]*>)[^]*?(<\/div>\s*<\/form>)/;
    assert.match(page, slot);
    page = page.replace(slot, (_, start, end) => `${start}${renderTriggerCheckResult(result)}${end}`);
  }
  assert.ok(!page.includes("PRIVATE TASK CANARY"));
  return page;
}
export const TRIGGER_LIST_DRAW = Object.freeze({
  "triggers-spent.operator": () => triggerListGolden({ state: "spent" }),
  "triggers-dense.operator": () => triggerListGolden({ state: "dense" }),
  "triggers-empty.viewer": () => triggerListGolden({ role: "viewer", state: "empty" }),
  "triggers-unreadable.viewer": () => triggerListGolden({ role: "viewer", state: "unreadable" }),
  "triggers-history-cut.operator": () => triggerListGolden(),
  "triggers-history-unknown.viewer": () => triggerListGolden({ role: "viewer", state: "history-unknown" }),
  "triggers-zone-unknown.operator": () => triggerListGolden({ state: "zone-unknown" }),
  "triggers-readonly.operator": () => triggerListGolden({ readOnly: true }),
  "trigger-check-match.viewer": () => triggerListGolden({ role: "viewer", check: "match" }),
  "trigger-check-no-match.viewer": () => triggerListGolden({ role: "viewer", check: "no-match" }),
  "trigger-check-invalid.viewer": () => triggerListGolden({ role: "viewer", check: "invalid" }),
});
export const TRIGGER_LIST_PANEL_STATES = Object.freeze(Object.keys(TRIGGER_LIST_DRAW));
