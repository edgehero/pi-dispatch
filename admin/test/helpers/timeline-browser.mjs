import { startSetupBrowserFixture, SETUP_BROWSER_TOKENS } from "./setup-browser.mjs";
import { SETUP_AT } from "./setup-goldens.mjs";

export { SETUP_BROWSER_TOKENS as TIMELINE_BROWSER_TOKENS };
export const TIMELINE_AT = SETUP_AT;
export function timelineFixtureRows(count = 10000, projects = 4) {
  const day = 86400000;
  return Array.from({ length: count }, (_, i) => {
    const startedAt = SETUP_AT - (i < 250 ? 30 * 60000 : (i - 250) * 30 * day / count);
    return { jobId: "gh-timeline-" + i, project: i < 250 ? "dense" : (projects === 4 ? ["api", "billing", "ops", "web"][i % 4] : "project-" + String(i % projects).padStart(3, "0")), host: "build3", target: "acme/web#" + i, outcome: i % 11 === 0 ? "failed" : "completed", reason: null, startedAt, endedAt: startedAt + (i % 17 === 0 ? 500 : 15 * 60000) };
  });
}
export async function startTimelineBrowserFixture(dir, { count = 10000, projects = 4 } = {}) {
  const rows = timelineFixtureRows(count, projects), calls = [];
  rows[0].target = "<img src=x onerror=window.timelineInjected=true>";
  for (const [name,start,end] of [
    ["autumn","2026-10-25T00:30:00Z","2026-10-25T01:30:00Z"],
    ["spring","2026-03-29T00:30:00Z","2026-03-29T01:30:00Z"],
    ["winter","2026-01-15T12:00:00Z","2026-01-15T12:15:00Z"],
    ["summer","2026-07-15T12:00:00Z","2026-07-15T12:15:00Z"],
  ]) rows.push({ jobId:"gh-"+name,project:"clock",host:"build3",target:"acme/clock#1",outcome:"completed",startedAt:Date.parse(start),endedAt:Date.parse(end) });
  let offline = false, delay = 0;
  const fleetReads = {
    historySources: async () => ({ hosts: ["build3"], partial: offline }),
    historyPage: async ({ query, cursor, host }) => {
      calls.push({ ...query, cursor, host });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (host === "build3") return offline ? { error: "host-unavailable" } : { runs: [], next: null };
      if (host === "@mirror") return { runs: [], next: null };
      const offset = cursor ? parseInt(cursor, 16) : 0;
      const matching = rows.filter(r => (!query.project || r.project === query.project) && r.startedAt < query.end && r.endedAt >= query.start);
      const earlier = rows.filter(r => (!query.project || r.project === query.project) && r.endedAt < query.start);
      return { runs: matching.slice(offset, offset + 100), next: offset + 100 < matching.length ? (offset + 100).toString(16).padStart(32, "0") : null, partial: false, olderAt: earlier.length ? Math.max(...earlier.map(r => r.endedAt)) : null };
    },
    runById: async id => { const r = rows.find(r => r.jobId === id); return r ? { record: { ...r, kind: "github", startedAt: new Date(r.startedAt).toISOString(), endedAt: new Date(r.endedAt).toISOString() } } : { missing: true }; },
  };
  const app = await startSetupBrowserFixture(dir, { fleetReads });
  Object.assign(app.snapshot, {
    queue: { workers: 1, counts: { active: 1, waiting: 1, delayed: 0, failed: 0 }, pausedState: false },
    runsDay: { runs: rows.filter(r => r.endedAt >= SETUP_AT - 86400000), partial: false }, runs: rows.slice(0, 20),
    hostBudgets: [{ name: "build3", concurrency: "3", ttlAgeMs: 1000, jobs: [{ id: "gh-live", p: "web", at: SETUP_AT - 60000 }] }],
    active: [{ jobId: "gh-live", host: "build3", startedAt: SETUP_AT - 60000 }],
    parked: [], waiting: { rows: [{ jobId: "gh-wait", project: "web", host: "build3", bucket: "due", dueAt: SETUP_AT + 60000 }], truncated: false },
  });
  return { ...app, rows, calls, offline(value) { offline = value; }, delay(value) { delay = value; } };
}
