/**
 * A fleet reader over a Valkey that does not answer (issue #844): `snapshot()` rejects, and `fileViews()` still holds
 * what the deployment's files say, two triggers and one project among them. The pages drawn over it must say "not
 * known" for what only Valkey holds and still show the files, never an empty list or a zero.
 */
import { normalizeTriggerForDisplay } from "../../src/read-model.mjs";

const ENTRIES = Object.freeze([
  { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy" } },
  { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } },
]);

/** The reader's `fileViews()`: the snapshot's own keys and shapes, from the files alone. */
export function fileViewsFixture() {
  return {
    triggers: { path: "/srv/deployment/triggers.json", count: ENTRIES.length, triggers: ENTRIES.map((entry, index) => ({ ...normalizeTriggerForDisplay(entry), index })) },
    projects: { projects: [{ id: "web", members: ["github:acme/web"] }] },
    settings: { path: "/srv/deployment/settings.json", overlay: { maxTurns: 30, maxCostUsd: "2" } },
    scopedLimits: { limits: [{ scope: "acme/web", day: 10 }] },
    pauseWindows: { windows: [{ scope: "*", from: "01:00", to: "02:00" }] },
    stagedPackages: { stagedAt: null, packages: [] },
    overlayMcp: { servers: [], refused: [], unreadable: null },
    schedulerStallMax: 2,
    envelopeSet: false,
  };
}

/** The runs page as the real reader answers it in an outage: it does not throw, it holds no run and a mirror it could not reach. */
export const RUNS_PAGE_IN_OUTAGE = Object.freeze({ runs: [], mirror: "unreachable", next: null });

/** The reader: every Valkey read rejects, the file views answer. `over` lays other fakes on it. */
export function noSnapshotFleet(over = {}) {
  const down = async () => { throw new Error("Valkey does not answer"); };
  return { snapshot: down, runsPage: down, parkedCount: down, fileViews: fileViewsFixture, ...over };
}
