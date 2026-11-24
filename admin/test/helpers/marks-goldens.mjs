/**
 * The pages over a snapshot that ANSWERED and holds a mark of something it did not read (issues #1037, #1036, #1064
 * and #986), one page per kind of sentence, each drawn through the real page loader on the REAL fleet reader: the
 * marks are the reader's own over a Valkey that fails one read the way Valkey fails it, never a snapshot put together
 * by hand. `helpers/real-console.mjs` holds the console and its failing Valkeys.
 */
import assert from "node:assert/strict";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { registryKeys } from "./fleet-reader-fakes.mjs";
import { consoleOn, erroringKey, failing, healthy, queuesWith, NOW, RUN } from "./real-console.mjs";

/** A registry row of a host that declared its name, beating two seconds before the page's clock. */
const row = (pid) => ({ version: "5.4.2", image: "ghcr.io/edgehero/pi-dispatch-job:5.4.2", piVersion: "1.6.0", tz: "UTC", concurrency: "2", pid, beatAt: String(NOW - 2_000), startedAt: String(NOW - 3_600_000), jobs: "[]", jobsMore: "0", routes: "true" });
const ONE = registryKeys({ build3: row("1") });
const TWO = registryKeys({ build3: row("1"), build4: row("2") });
/** A row whose expiry was set two seconds ago: a row that will leave the registry by itself, as a live worker's does. */
const valkey = (keys) => healthy(keys, { pttlOf: () => 88_000 });
/** A cron rule and a forge rule. */
const TRIGGERS = { triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy" } }, { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }] };
/** One job in the wait list of build3's own queue. */
const WAITING_JOB = { "bull:pi-jobs@build3:wait": ["gh-77"], "bull:pi-jobs@build3:gh-77": { timestamp: String(NOW - 300_000), attemptsMade: "0" } };

const STATES = {
  // The look for the queues that exist does not answer: the set of queues behind the waiting jobs may be short.
  queuesShort: () => ({ redis: failing(valkey(ONE), ["scan"]), records: [RUN], triggers: TRIGGERS }),
  // The same over the deployment's own triggers file, whose one rule needs no folder of this host: Models loads it.
  queuesShortForge: () => ({ redis: failing(valkey(ONE), ["scan"]), records: [RUN] }),
  // The shared queue's wait list is answered with an error, and build3's own queue's record holds a string, so its
  // paused flag and its counts are too: a job waits there, for a free slot or on a pause.
  waitingUnread: () => ({ redis: erroringKey(valkey({ ...ONE, ...WAITING_JOB }), /^bull:pi-jobs(?::wait|@build3:meta)$/), queue: queuesWith(["pi-jobs@build3"], ["isPaused", "getJobCounts"]), records: [RUN] }),
  // One queue Valkey answers with an error, and nothing else.
  queueErrored: () => ({ redis: valkey(ONE), queue: queuesWith(["pi-jobs@build3"], ["isPaused", "getJobCounts"]), records: [RUN] }),
  // build4's row is answered with an error, on a console that never read it.
  rowErrored: () => ({ redis: erroringKey(valkey(TWO), /^host:h:build4$/), records: [RUN] }),
  // The schedules of build3's own queue are not answered; the shared queue's are.
  schedulesPart: () => ({ redis: valkey(ONE), queue: queuesWith(["pi-jobs@build3"], ["getJobSchedulers"], null), records: [RUN], triggers: TRIGGERS }),
};

async function draw(page, qs, state, role = "operator") {
  const deps = consoleOn({ ...STATES[state](), registryClock: true });
  const parsed = parsePageQuery(page, new URLSearchParams(qs));
  assert.ok(parsed.query, parsed.refusal);
  const data = await loadPageData(page, parsed.query, deps, { role });
  const result = await renderPage(page, { query: parsed.query, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly: false, theme: null, maxStreams: 4 });
  assert.equal(result.status, 200, `${page}?${qs}`);
  return String(result.html);
}

export const MARKS_DRAW = Object.freeze({
  // #1037: the waiting jobs over a set of queues that may be short, on each reader of them.
  "overview-waiting-short.operator": () => draw("overview", "", "queuesShort"),
  "project-waiting-short.operator": () => draw("project", "id=web", "queuesShort"),
  "trigger-waiting-short.operator": () => draw("trigger", "index=1", "queuesShort"),
  "models-waiting-short.viewer": () => draw("models", "", "queuesShortForge", "viewer"),
  // #1036: a list that was not read, and a paused flag that was not: the job that waits under its own reason.
  "overview-waiting-unread.operator": () => draw("overview", "", "waitingUnread"),
  "fleet-waiting-unread.viewer": () => draw("fleet", "", "waitingUnread", "viewer"),
  // #1064: a queue Valkey answered with an error.
  "fleet-queue-errored.operator": () => draw("fleet", "", "queueErrored"),
  "host-queue-errored.operator": () => draw("host", "name=build3", "queueErrored"),
  // #1036: a host row Valkey answered with an error, never read here.
  "fleet-host-row-unread.operator": () => draw("fleet", "", "rowErrored"),
  "host-row-unread.operator": () => draw("host", "name=build4", "rowErrored"),
  "venue-host-row-unread.viewer": () => draw("venue", "name=local", "rowErrored", "viewer"),
  // #986: a schedule list read in part.
  "fleet-schedules-short.operator": () => draw("fleet", "", "schedulesPart"),
  "triggers-schedules-short.operator": () => draw("triggers", "", "schedulesPart"),
  "trigger-schedule-short.operator": () => draw("trigger", "index=0", "schedulesPart"),
});
export const MARKS_PANEL_STATES = Object.freeze(Object.keys(MARKS_DRAW));
