import { test } from "node:test";
import { SKEW_UNKNOWN_TEXT } from "../src/console/panels/trigger.mjs";
import assert from "node:assert/strict";
import { hostKey } from "@edgehero/pi-dispatch/host-registry";
import { waitingLine } from "../src/console/actions.mjs";
import { dataUnread, erroredReadSentence, hostPartCase, registryPartText, REGISTRY_PART_TEXT, schedulesCount, unaskedQueuesText, WAIT_BUCKETS, WAITING_CUT_TEXT, WAITING_QUEUES_SHORT_TEXT, waitingFloor, waitingPausedUnread } from "../src/console/panels/common.mjs";
import { ACTIVE_UNREAD_TEXT } from "../src/console/panels/fleet.mjs";
import { HOST_ACTIVE_UNREAD_TEXT } from "../src/console/panels/host.mjs";
import { WAITLISTS_CALM } from "../src/console/panels/overview.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { modelsForAgent } from "../src/models-view.mjs";
import { SCHEDULES_PART_TEXT } from "../src/trigger-list.mjs";
import { readUpdates } from "../src/updates-view.mjs";
import { waitingMarksOf } from "../src/waiting-marks.mjs";
import { registryKeys } from "./helpers/fleet-reader-fakes.mjs";
import { consoleOn, drawn, erroringKey, failing, failingQueue, healthy, queuesWith, unanswered, HOST, HOSTS, NOW, ROUTED, RUN, REFUSED } from "./helpers/real-console.mjs";

/**
 * The marks of a snapshot that ANSWERED, on the pages (issues #1037, #1036, #1064, #986): a waiting read that is a
 * floor, a schedule list read in part, a queue Valkey answered with an error, and a host row that was not read. Each
 * state is the real fleet reader's, over a Valkey that fails one read the way Valkey fails it.
 */

/** A cron rule and a forge rule, so a schedule and a queued job each have a trigger. */
const TRIGGERS = { triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy" } }, { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }] };
/** One job in the wait list of build3's own queue. */
const WAITING_JOB = { "bull:pi-jobs@build3:wait": ["gh-77"], "bull:pi-jobs@build3:gh-77": { timestamp: String(NOW - 300_000), attemptsMade: "0" } };

/** The look for queues that exist does not answer: the set of queues behind the waiting jobs may be short. */
const QUEUES_SHORT = (over = {}) => ({ redis: failing(healthy(ROUTED), ["scan"]), records: [RUN], ...over });
/** Valkey answers the shared queue's wait list with an error. */
const LIST_ERRORED = () => ({ redis: erroringKey(healthy(ROUTED), /^bull:pi-jobs:wait$/), records: [RUN] });
/** build3's own queue's record holds a string: its paused flag and its counts are answered with an error. */
const QUEUE_ERRORED = (keys = {}) => ({ redis: erroringKey(healthy({ ...ROUTED, ...keys }), /^bull:pi-jobs@build3:meta$/), queue: queuesWith(["pi-jobs@build3"], ["isPaused", "getJobCounts"]), records: [RUN] });
/** The schedules of build3's own queue are not answered; the shared queue's are. */
const SCHEDULES_PART = () => ({ redis: healthy(ROUTED), queue: queuesWith(["pi-jobs@build3"], ["getJobSchedulers"], null), records: [RUN], triggers: TRIGGERS });
/** Valkey answers build4's row with an error, on a console that never read it. */
const ROW_ERRORED = () => ({ redis: erroringKey(healthy(HOSTS), /^host:h:build4$/), records: [RUN, REFUSED] });

const page = async (name, qs, state, role = "operator") => drawn(name, qs, consoleOn(state), role);
/** The words of one card of a page, from its title to the next card's. */
const card = (got, id) => { const at = got.whole.indexOf(`id="${id}"`); const end = at < 0 ? -1 : got.whole.indexOf("</section>", at); return at < 0 ? "" : got.whole.slice(at, end < 0 ? undefined : end).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " "); };

test("the pill holds the three parts of a snapshot page by page: a part no card of a page draws does not mark it", () => {
  const registry = { queue: { fleetDegraded: "Command timed out" }, hostsReadAt: null };
  const marks = { registry, active: { activeUnreachable: true }, parked: { parkedUnreachable: "the run mirror could not be read" } };
  const drawnBy = { overview: ["registry", "active", "parked"], fleet: ["registry", "active"], host: ["registry", "active"], setup: ["registry"], parked: ["parked"], runs: [], sandboxes: [], run: [] };
  for (const [name, parts] of Object.entries(drawnBy)) {
    for (const [part, snapshot] of Object.entries(marks)) assert.equal(dataUnread({ page: name, snapshot }, name), parts.includes(part), `/${name}: the ${part}`);
  }
  // Data on no page that has a pill is judged by every part, as before.
  for (const snapshot of Object.values(marks)) assert.equal(dataUnread({ snapshot }), true);
});

test("the pill knows who looks: a read only an operator's cards say does not mark a viewer's or an agent's page", async () => {
  // The search for a run's children, behind a mirror that did not answer: the Chain card's, which a viewer is not drawn.
  const mirrorDown = () => ({ redis: failing(healthy(HOST), ["zrevrangebyscore"]), records: [RUN] });
  const operator = await page("run", "id=gh-1", mirrorDown(), "operator");
  assert.deepEqual([operator.data.childrenIncomplete, operator.pill, operator.marked], [true, true, true]);
  assert.match(operator.words, /The search for child runs was incomplete/);
  for (const role of ["viewer", "agent"]) {
    const got = await page("run", "id=gh-1", mirrorDown(), role);
    assert.deepEqual([got.data.childrenIncomplete, got.pill, got.marked], [true, false, false], `${role}: the read was made, and no card of this page says it`);
    assert.doesNotMatch(got.words, /search for child runs|search for them was incomplete/, role);
  }
  // A viewer's banner does say it where it counts the runs queued: there the read marks their page too.
  const counted = { page: "run", run: { record: { ...RUN, chainRefused: 2 } }, children: [], childrenIncomplete: true, inbox: { found: false } };
  assert.deepEqual(["operator", "viewer", "agent"].map((role) => dataUnread(counted, "run", role)), [true, true, true]);
  assert.deepEqual(["operator", "viewer", "agent"].map((role) => dataUnread({ ...counted, run: { record: RUN } }, "run", role)), [true, false, false]);
  // A run refused before it started: its two cards are an operator's, and so are the reads behind them.
  const refused = () => ({ redis: failing(healthy(HOST), ["mget"]), records: [REFUSED] });
  assert.deepEqual([(await page("run", "id=gh-2", refused(), "operator")).pill, (await page("run", "id=gh-2", refused(), "viewer")).pill, (await page("run", "id=gh-2", refused(), "agent")).pill], [true, false, false]);
});

test("a host's page is Not live over the fleet's running jobs only where its Jobs card says a job of its own is missing", async () => {
  // The queues' lists of running jobs do not answer: the fleet's list is not whole, on every page that draws it.
  const row = (jobs) => registryKeys({ build3: { version: "5.4.2", image: "pi-job:latest", concurrency: "2", pid: "1", beatAt: String(Date.now() - 2_000), startedAt: String(NOW - 3_600_000), jobs: JSON.stringify(jobs), jobsMore: "0" } });
  const state = (jobs) => ({ redis: healthy(row(jobs)), queue: failingQueue(["getActive"]), records: [RUN] });
  // A row that names no running job: nothing of this host's can be missing, so its page says nothing and stays Live.
  for (const role of ["operator", "viewer", "agent"]) {
    const idle = await page("host", "name=build3", state([]), role);
    assert.equal(idle.data.snapshot.activeUnreachable, true, "the reader's own mark (vacuous otherwise)");
    assert.doesNotMatch(card(idle, "p-hostjobs"), /may be missing here|not listed here/, role);
    assert.deepEqual([idle.pill, idle.marked], [false, false], role);
    // A row that names one, which no list held: the card counts it, and the page is Not live.
    const busy = await page("host", "name=build3", state([{ id: "gh-55", p: "web", m: 4096, c: 200, at: NOW - 60_000 }]), role);
    assert.match(card(busy, "p-hostjobs"), /build3 says it runs 1 job that is not listed here: the running jobs could not be read whole\./, role);
    assert.deepEqual([busy.pill, busy.marked], [true, true], role);
  }
  // Fleet draws the whole list: Not live either way.
  assert.deepEqual([(await page("fleet", "", state([]))).pill, (await page("overview", "", state([]))).pill], [true, true]);
});

test("a host with no row whose run files could not be listed says its run records could not be read, never that no record names it", async () => {
  for (const role of ["operator", "viewer", "agent"]) {
    const got = await page("host", "name=build9", { redis: healthy(HOST), logs: "file" }, role);
    assert.match(got.words, /This host's run records could not be read\./, role);
    assert.doesNotMatch(got.words, /No retained run record names this host/, role);
    assert.deepEqual([got.pill, got.marked], [true, true], role);
  }
  const read = await page("host", "name=build9", { redis: healthy(HOST), records: [RUN] }, "viewer");
  assert.match(read.words, /No retained run record names this host\./, "a history that was read and names no such host");
});

test("why the waiting rows are a floor: a list not read, a set of queues that may be short, a bound; and only the first two are a read that failed", () => {
  assert.equal(waitingFloor({ rows: [], truncated: false, queuesCut: 0, byQueue: [] }), null);
  assert.equal(waitingFloor({ unreachable: true }), null, "a read that did not answer is the page's own sentence");
  const short = waitingFloor({ rows: [], truncated: false, queuesShort: true });
  assert.deepEqual([short.unread, short.text], [true, WAITING_QUEUES_SHORT_TEXT]);
  const list = waitingFloor({ rows: [], truncated: true, listsUnread: [{ queue: "pi-jobs", error: "WRONGTYPE" }, { queue: "pi-jobs@b", error: null }], byQueue: [{ queue: "pi-jobs", truncated: true, listsUnread: true }, { queue: "pi-jobs@b", truncated: true, listsUnread: true }] });
  assert.deepEqual([list.unread, list.text], [true, "A list of waiting jobs could not be read: pi-jobs (Valkey answered WRONGTYPE) and pi-jobs@b (no answer). Jobs waiting there may be missing here."]);
  // A bound of the read's own: the rows are a floor, and nothing failed, so the pill does not follow it.
  for (const bound of [{ rows: [], truncated: true, queuesCut: 3, byQueue: [] }, { rows: [], truncated: true, queuesCut: 0, byQueue: [{ queue: "pi-jobs", truncated: true }] }, { rows: [], truncated: true }]) {
    assert.deepEqual([waitingFloor(bound).unread, waitingFloor(bound).text], [false, WAITING_CUT_TEXT]);
  }
  // Every cause that holds is said, the failed reads first.
  assert.equal(waitingFloor({ rows: [], truncated: true, queuesShort: true, queuesCut: 2, byQueue: [] }).text, `${WAITING_QUEUES_SHORT_TEXT} ${WAITING_CUT_TEXT}`);
  // A reader of some queues' rows: another queue's list is none of its own, a short set and the bound are everyone's.
  const mine = (queue) => queue === "pi-jobs" || queue === "pi-jobs@a";
  assert.equal(waitingFloor({ rows: [], truncated: true, queuesCut: 0, listsUnread: [{ queue: "pi-jobs@b", error: "WRONGTYPE" }], byQueue: [{ queue: "pi-jobs", truncated: false }, { queue: "pi-jobs@b", truncated: true, listsUnread: true }] }, mine), null);
  assert.equal(waitingFloor({ rows: [], truncated: false, queuesShort: true, byQueue: [] }, mine).text, WAITING_QUEUES_SHORT_TEXT);
  assert.equal(waitingPausedUnread({ rows: [], pausedUnread: [{ queue: "pi-jobs@b", error: "WRONGTYPE" }] }, mine), null);
  assert.match(waitingPausedUnread({ rows: [], pausedUnread: [{ queue: "pi-jobs@b", error: "WRONGTYPE" }] }).text, /^Whether a queue is paused could not be read: pi-jobs@b \(Valkey answered WRONGTYPE\)\. /);
  // No client's words reach a page: a code is one word, anything else is "no answer".
  assert.match(waitingFloor({ rows: [], truncated: true, listsUnread: [{ queue: "pi-jobs", error: "WRONGTYPE Operation against a key at 10.0.0.9" }] }).text, /pi-jobs \(no answer\)/);
});

test("a set of queues that may be short makes every reader of the waiting jobs say a floor, in one sentence, and never nothing waits (#1037)", async () => {
  const overview = await page("overview", "", QUEUES_SHORT());
  assert.equal(overview.data.snapshot.waiting.queuesShort, true, "the reader's own mark");
  assert.equal(overview.data.snapshot.waiting.truncated, false, "and nothing else makes it a floor (vacuous otherwise)");
  // In line: no count of none, each reason a dash, the sentence; the Waitlists: the same cause, and no calm line.
  assert.match(card(overview, "p-waiting"), /jobs waiting: not known/);
  assert.ok(card(overview, "p-waiting").includes(WAITING_QUEUES_SHORT_TEXT));
  assert.doesNotMatch(card(overview, "p-waiting"), /Nothing is waiting|Free slot 0/);
  assert.ok(card(overview, "p-waitlists").includes(`${WAITING_QUEUES_SHORT_TEXT} The counts are a floor.`));
  assert.ok(!overview.words.includes(WAITLISTS_CALM) && !overview.words.includes("No run in this window, and nothing in line."));
  assert.ok(card(overview, "p-timeline").includes(WAITING_QUEUES_SHORT_TEXT));
  // With no run in the window either, the timeline does not say that nothing is in line; over a read made whole it does.
  const NOTHING = "No run in this window, and nothing in line.";
  assert.ok(!(await page("overview", "", QUEUES_SHORT({ records: [] }))).words.includes(NOTHING));
  assert.ok((await page("overview", "", { redis: healthy(ROUTED), records: [] })).words.includes(NOTHING), "the sentence of a read that showed none (vacuous otherwise)");
  // Fleet's Delayed card, a host's Jobs card, for every role.
  for (const role of ["operator", "viewer", "agent"]) {
    for (const [name, qs, id] of [["fleet", "", "p-delayed"], ["host", "name=build3", "p-hostjobs"]]) {
      const got = await page(name, qs, QUEUES_SHORT(), role);
      assert.ok(card(got, id).includes(WAITING_QUEUES_SHORT_TEXT), `/${name} for ${role}: ${card(got, id).slice(0, 200)}`);
      assert.deepEqual([got.pill, got.marked], [true, true], `/${name} for ${role}: the look for queues is a read that failed`);
    }
  }
  // A project's in-line count, a trigger's queued list and its skew, and the Models page's list.
  const project = await page("project", "id=web", QUEUES_SHORT());
  assert.match(project.words, new RegExp(`0 in line \\(at least\\) ${WAITING_QUEUES_SHORT_TEXT.replace(/[.]/g, "\\.")}`));
  const trigger = await page("trigger", "index=1", QUEUES_SHORT({ triggers: TRIGGERS }));
  assert.ok(trigger.words.includes(`Jobs in line now: none found, and a job may be missing. ${WAITING_QUEUES_SHORT_TEXT}`), trigger.words.match(/Jobs in line now[^]{0,200}/)?.[0]);
  // Issue #1073: over a check that saw none, the count is not known, never "At least 0"; and why the list is a floor is
  // said once, under "Jobs in line now" above, not again here.
  assert.ok(trigger.words.includes(SKEW_UNKNOWN_TEXT) && !trigger.words.includes("At least 0 jobs"), trigger.words.match(/[^.]*would be refused[^.]*\./)?.[0]);
  assert.equal(trigger.words.split(WAITING_QUEUES_SHORT_TEXT).length - 1, 1, "the floor is said once");
  for (const role of ["operator", "viewer", "agent"]) {
    const models = await page("models", "", QUEUES_SHORT(), role);
    assert.ok(models.words.includes(`No job found waiting on model cooldown, model window or subscription quota, and one may be missing. ${WAITING_QUEUES_SHORT_TEXT}`), `/models for ${role}`);
    assert.doesNotMatch(models.words, /No retained jobs are waiting on model/, role);
  }
  // Each of them says "none" only over a read that was whole.
  const whole = { redis: healthy(ROUTED), records: [RUN], triggers: TRIGGERS };
  assert.match((await page("trigger", "index=1", whole)).words, /Jobs in line now: none in view\./);
  assert.match((await page("models", "", { redis: healthy(ROUTED), records: [RUN] }, "viewer")).words, /No retained jobs are waiting on model cooldown, model window or subscription quota\./);
  assert.match((await page("project", "id=web", whole)).words, /; 0 in line(?! \(at least\))/);
});

test("the Models tool gives waiting as null where the waiting jobs were not read, and says a floor with its cause (#1037)", async () => {
  // Not read at all: null, never an empty list, which says no job waits on a model.
  const down = await page("models", "", { redis: { ...healthy(ROUTED), pipeline: () => unanswered }, records: [RUN] }, "agent");
  assert.equal(Boolean(down.data.snapshot?.waiting?.unreachable), true, "the waiting read did not answer (vacuous otherwise)");
  assert.deepEqual([down.data.models.waiting, down.data.models.waitingUnread, down.data.models.waitingIncomplete, Object.hasOwn(down.data.models, "waitingMarks")], [null, true, false, false], "an agent's page data is the tool's projection");
  assert.match(down.words, /The waiting jobs could not be read, so which jobs wait on a model is not known\./);
  const unread = modelsForAgent({ waitingUnread: true, waiting: [], waitingMarks: { truncated: true } });
  assert.deepEqual([unread.waiting, unread.waitingUnread, unread.waitingIncomplete, Object.hasOwn(unread, "waitingMarks")], [null, true, false, false]);
  // Read, and a floor: the list with its marks, a queue's name and a one-word code only.
  const short = await page("models", "", QUEUES_SHORT(), "agent");
  assert.deepEqual([short.data.models.waiting, short.data.models.waitingUnread, short.data.models.waitingIncomplete, short.data.models.waitingMarks], [[], false, true, { truncated: false, queuesCut: 0, queuesShort: true, listsUnread: [] }]);
  const list = modelsForAgent({ waitingUnread: false, waiting: [], waitingMarks: waitingMarksOf({ rows: [], truncated: true, listsUnread: [{ queue: "pi-jobs", error: "WRONGTYPE" }, { queue: "pi-jobs@b", error: "an address 10.0.0.9" }, { queue: "not a name", error: null }] }) });
  assert.deepEqual([list.waitingIncomplete, list.waitingMarks.listsUnread], [true, [{ queue: "pi-jobs", error: "WRONGTYPE" }, { queue: "pi-jobs@b", error: null }]]);
  // Whole: an empty list is one that was read.
  const whole = await page("models", "", { redis: healthy(ROUTED), records: [RUN] }, "agent");
  assert.deepEqual([whole.data.models.waiting, whole.data.models.waitingUnread, whole.data.models.waitingIncomplete], [[], false, false]);
});

test("a list Valkey answers with an error is named with its code where the waiting jobs are drawn, and marks the pill; a list of another host's queue is none of a host's page", async () => {
  const said = "A list of waiting jobs could not be read: pi-jobs (Valkey answered WRONGTYPE). Jobs waiting there may be missing here.";
  for (const [name, qs, id] of [["overview", "", "p-waiting"], ["overview", "", "p-waitlists"], ["fleet", "", "p-delayed"], ["host", "name=build3", "p-hostjobs"]]) {
    const got = await page(name, qs, LIST_ERRORED());
    assert.deepEqual(got.data.snapshot.waiting.listsUnread, [{ queue: "pi-jobs", error: "WRONGTYPE" }]);
    assert.ok(card(got, id).includes(said.slice(0, id === "p-waitlists" ? said.indexOf(" Jobs") : undefined)), `/${name} ${id}: ${card(got, id).slice(-300)}`);
    assert.deepEqual([got.pill, got.marked], [true, true], `/${name}`);
  }
  // build3's own wait list: said on build3's page, and neither said nor marked on another host's.
  const own = () => ({ redis: erroringKey(healthy(HOSTS), /^bull:pi-jobs@build3:wait$/), records: [RUN] });
  const there = await page("host", "name=build3", own());
  assert.ok(card(there, "p-hostjobs").includes("A list of waiting jobs could not be read: pi-jobs@build3 (Valkey answered WRONGTYPE)."));
  assert.deepEqual([there.pill, there.marked], [true, true]);
  const elsewhere = await page("host", "name=build4", own(), "viewer");
  assert.doesNotMatch(card(elsewhere, "p-hostjobs"), /could not be read|may be missing/);
  assert.deepEqual([elsewhere.pill, elsewhere.marked], [false, false]);
});

test("a job whose queue's paused flag was not read is drawn under neither a free slot nor a reason this console does not know (#1036)", async () => {
  const overview = await page("overview", "", QUEUE_ERRORED(WAITING_JOB));
  const row = overview.data.snapshot.waiting.rows.find((r) => r.jobId === "gh-77");
  assert.deepEqual([row.bucket, row.pausedUnknown, overview.data.snapshot.waiting.pausedUnread], ["unknown", true, [{ queue: "pi-jobs@build3", error: "WRONGTYPE" }]], "the reader's own row and mark");
  // In line: one job, under its own reason; a free slot has none of it, and the unknown reason has none of it either.
  assert.match(card(overview, "p-waiting"), /1 job waiting to start Free slot 0 Another run 0 Time or check 0 Retry backoff 0 Slot or pause, not known 1 /);
  assert.doesNotMatch(card(overview, "p-waiting"), /Unknown reason/);
  assert.ok(card(overview, "p-waiting").includes("Whether a queue is paused could not be read: pi-jobs@build3 (Valkey answered WRONGTYPE). A job in its wait list waits for a free slot or on a pause, and which is not known."));
  // The Waitlists: its own group, its own line, no calm line; the timeline's title says the same.
  assert.match(card(overview, "p-waitlists"), /A free slot or a pause: the queue's paused flag could not be read 1 gh-77 Waits for a free slot or on a pause: whether its queue is paused could not be read/);
  assert.doesNotMatch(overview.words, /A reason this console does not know|a reason this console does not know/);
  assert.ok(!overview.words.includes(WAITLISTS_CALM), "nothing waits for a slot is not known");
  assert.match(overview.whole, /gh-77: waits for a free slot or on a pause; whether its queue is paused could not be read/);
  // Fleet's Delayed card and the host's Jobs card: the same group and line.
  const fleet = await page("fleet", "", QUEUE_ERRORED(WAITING_JOB));
  assert.match(card(fleet, "p-delayed"), /A free slot or a pause: the queue's paused flag could not be read .*gh-77 Waits for a free slot or on a pause: whether its queue is paused could not be read/);
  assert.doesNotMatch(card(fleet, "p-delayed"), /A reason this console does not know/);
  const host = await page("host", "name=build3", QUEUE_ERRORED(WAITING_JOB));
  assert.match(card(host, "p-hostjobs"), /gh-77 .*Waits for a free slot or on a pause: whether its queue is paused could not be read/);
  for (const got of [overview, fleet, host]) assert.deepEqual([got.pill, got.marked], [true, true]);
  // The flag alone not read (the queue's own calls answer): a read that failed, said and marked without any other.
  const flagOnly = await page("fleet", "", { redis: erroringKey(healthy({ ...ROUTED, ...WAITING_JOB }), /^bull:pi-jobs@build3:meta$/), records: [RUN] });
  assert.deepEqual([flagOnly.data.snapshot.queueErrors, flagOnly.data.snapshot.waiting.truncated, flagOnly.pill, flagOnly.marked], [{}, false, true, true]);
  assert.ok(card(flagOnly, "p-delayed").includes("Whether a queue is paused could not be read: pi-jobs@build3 (Valkey answered WRONGTYPE)."));
  // The cancel preview's line for that row.
  assert.deepEqual(waitingLine(row).text, "Waits for a free slot or on a pause: whether its queue is paused could not be read");
  assert.ok(WAIT_BUCKETS.includes("slot-or-pause") && WAIT_BUCKETS.indexOf("slot-or-pause") === WAIT_BUCKETS.indexOf("paused") + 1);
});

test("a schedule list read in part is a floor: at least N schedules, more may be registered, and a next fire that is not known (#986)", async () => {
  const fleet = await page("fleet", "", SCHEDULES_PART());
  assert.deepEqual([fleet.data.snapshot.schedulersReadInPart, fleet.data.snapshot.schedulers.length], [true, 0]);
  assert.match(card(fleet, "p-delayed"), /no cron schedule was read; /);
  assert.ok(card(fleet, "p-delayed").includes(SCHEDULES_PART_TEXT));
  assert.match(card(fleet, "p-schedules"), /Schedules no schedule was read .*No schedule was read\./);
  assert.ok(card(fleet, "p-schedules").includes(SCHEDULES_PART_TEXT));
  assert.doesNotMatch(fleet.words, /No schedule is registered|at least 0/);
  assert.deepEqual([fleet.pill, fleet.marked], [true, true]);
  // With some read: "at least".
  assert.equal(schedulesCount({ schedulersReadInPart: true, schedulers: [{}, {}] }), "at least 2 schedules");
  assert.equal(schedulesCount({ schedulersReadInPart: true, schedulers: [{}] }, "cron schedule"), "at least 1 cron schedule");
  assert.equal(schedulesCount({ schedulersReadInPart: false, schedulers: [{}, {}] }), "2 schedules");
  // The overview's scheduled line, the Triggers page and the trigger's own page.
  const overview = await page("overview", "", SCHEDULES_PART());
  assert.ok(card(overview, "p-waitlists").includes(`Scheduled: not known. ${SCHEDULES_PART_TEXT}`));
  assert.deepEqual([overview.pill, overview.marked], [true, true]);
  const triggers = await page("triggers", "", SCHEDULES_PART());
  assert.equal(triggers.data.triggerList.schedulesReadInPart, true);
  assert.ok(triggers.words.includes(SCHEDULES_PART_TEXT));
  assert.match(triggers.words, /Next fire not known: not every queue's schedules could be read · stalls 0 of 3/);
  assert.match(triggers.words, /Next to fire Not known\. Not every queue's schedules could be read, so more may be registered\./);
  assert.match(triggers.words, /owning host not known/);
  assert.doesNotMatch(triggers.words, /No next fire is published|Scheduler next fire unavailable|owning host not published|timezone is not published/);
  const trigger = await page("trigger", "index=0", SCHEDULES_PART());
  assert.match(trigger.words, /Next fire: not known\. Health: not known \(not every queue's schedules could be read, so this one may be registered\); stalls/);
  assert.doesNotMatch(trigger.words, /schedule not published/);
  // Over a list that was read whole, a schedule that is not in it is not published, as before.
  const whole = { redis: healthy(ROUTED), records: [RUN], triggers: TRIGGERS };
  assert.match((await page("trigger", "index=0", whole)).words, /Health: not known \(schedule not published\)/);
  assert.match((await page("triggers", "", whole)).words, /No next fire is published/);
  assert.match(card(await page("fleet", "", whole), "p-schedules"), /Schedules 0 schedules .*No schedule is registered\./);
});

test("a queue Valkey answers with an error is named where its counts are missing: Fleet, the overview's queue row and its Hosts card, and its host's page (#1064)", async () => {
  const line = "Not read, so not in these counts: pi-jobs@build3 (Valkey answered WRONGTYPE); whether it is paused is not known.";
  const overview = await page("overview", "", QUEUE_ERRORED());
  assert.deepEqual(overview.data.snapshot.queueErrors, { "pi-jobs@build3": "WRONGTYPE" });
  assert.match(card(overview, "p-waitlists"), /Queues pi-jobs 0 @build3 not read Not read, so not in these counts: pi-jobs@build3 \(Valkey answered WRONGTYPE\)/);
  assert.ok(card(overview, "p-hosts").includes(`A queue was not read ${line}`));
  assert.match(card(overview, "p-hosts"), /@build3 not read \(Valkey answered WRONGTYPE\)/, "on its host's row");
  const fleet = await page("fleet", "", QUEUE_ERRORED());
  assert.ok(card(fleet, "p-fleetbar").includes(line));
  assert.match(card(fleet, "p-queues"), /pi-jobs@build3 Not read: Valkey answered WRONGTYPE\. Not known not read not read not read not read not read/);
  assert.match(card(fleet, "p-delayed"), /or more delayed jobs/, "the delayed count leaves that queue out");
  const host = await page("host", "name=build3", QUEUE_ERRORED());
  assert.ok(card(host, "p-hoststate").includes(line), card(host, "p-hoststate"));
  for (const got of [overview, fleet, host]) assert.deepEqual([got.pill, got.marked], [true, true]);
  // Its counts alone answered with an error: paused or running as its flag reads, never "not known".
  const counts = { redis: healthy(ROUTED), queue: queuesWith(["pi-jobs"], ["getJobCounts"]), records: [RUN] };
  assert.match(card(await page("fleet", "", counts), "p-queues"), /pi-jobs Not read: Valkey answered WRONGTYPE for its counts\. Running not read/);
  // Another host's page draws nothing that queue is missing from: not said, not marked.
  const other = await page("host", "name=build9", QUEUE_ERRORED(), "viewer");
  assert.doesNotMatch(other.words, /Not read, so not in these counts/);
  assert.deepEqual([other.pill, other.marked], [false, false]);
});

test("a host row Valkey answers with an error is named with its key and its code, and each page says what that leaves unknown and nothing more (#1036)", async () => {
  const sentence = "The host registry was read in part. The row of build4 was not read: this console never read it, so it has no row. Valkey answers host:h:build4 with WRONGTYPE: the key holds another kind of value. Waiting does not change that: an operator has to remove or repair that key first.";
  const unasked = "The queue of build4 was not asked: a host's own queue is named by its row, and this console never read that row. A job running there is not listed here.";
  const fleet = await page("fleet", "", ROW_ERRORED());
  assert.deepEqual(fleet.data.snapshot.queue.unreadHosts, [{ name: "build4", error: "WRONGTYPE" }]);
  assert.ok(card(fleet, "p-fleetbar").includes(sentence) && card(fleet, "p-hosts").includes(sentence), card(fleet, "p-hosts").slice(0, 400));
  // The running jobs were read for every queue that was asked: the card says whose queue was not, and promises nothing.
  assert.ok(card(fleet, "p-active").includes(unasked));
  assert.ok(!fleet.words.includes(ACTIVE_UNREAD_TEXT) && !/as they were last seen|next refresh tries again/.test(card(fleet, "p-active") + card(fleet, "p-hosts")));
  const overview = await page("overview", "", ROW_ERRORED());
  assert.ok(card(overview, "p-hosts").includes(`Registry read in part ${sentence}`));
  assert.ok(card(overview, "p-active").includes(unasked));
  // The host's own page: its row's key and code, in its headline, its state card and each card that has no row to draw.
  const there = await page("host", "name=build4", ROW_ERRORED());
  assert.match(there.words, /Not known: the row of build4 was not read, so nothing here says whether it is live\./);
  assert.match(there.words, /Row not read Valkey answers host:h:build4 with WRONGTYPE: the key holds another kind of value\. Waiting does not change that: an operator has to remove or repair that key first\. This console never read that row, so nothing here says whether build4 is live, late or gone\./);
  assert.ok(card(there, "p-hostjobs").includes(unasked));
  assert.doesNotMatch(there.words, /Host has gone|This host has no live registry row/);
  // A host whose row WAS read: nothing of it is missing, so its page says nothing of running jobs that may be.
  const read = await page("host", "name=build3", ROW_ERRORED());
  assert.equal(read.data.snapshot.activeUnreachable, true, "the fleet's list is a floor (vacuous otherwise)");
  assert.ok(!read.words.includes(HOST_ACTIVE_UNREAD_TEXT) && !/not listed here/.test(card(read, "p-hostjobs")), card(read, "p-hostjobs"));
  // A host that read names as none of the rows it missed has gone: said as that, never as not known.
  const gone = await page("host", "name=build9", ROW_ERRORED());
  assert.match(gone.words, /No live registry row for build9\./);
  assert.match(gone.words, /Host has gone/);
  assert.equal(hostPartCase(gone.data.snapshot, "build9"), null);
  assert.equal(hostPartCase(gone.data.snapshot, "build4"), "unread");
  // A venue's lists of hosts say which host they lack.
  const venue = await page("venue", "name=local", ROW_ERRORED());
  assert.match(venue.words, /Blessed on Not known for build4, whose row was not read Default on Not known for build4, whose row was not read/);
  assert.ok(venue.words.includes(sentence));
  assert.doesNotMatch(venue.words, /no live host|No live host/);
});

test("a row that was read before and is not now is drawn as it was last seen, and the page says that of it alone", async () => {
  // The same console over two reads: every row read, then build4's answered with an error.
  let broken = false;
  const sound = healthy(HOSTS);
  const junk = erroringKey(healthy(HOSTS), /^host:h:build4$/);
  const redis = new Proxy(sound, { get: (_target, name) => (broken ? junk : sound)[name] });
  const deps = consoleOn({ redis, records: [RUN] });
  const before = await drawn("fleet", "", deps, "operator");
  assert.deepEqual([before.pill, before.data.snapshot.hostBudgets.map((h) => h.name)], [false, ["build3", "build4"]]);
  broken = true;
  const after = await drawn("fleet", "", deps, "operator");
  assert.deepEqual(after.data.snapshot.hostBudgets.map((h) => [h.name, h.notRead === true]), [["build3", false], ["build4", true]]);
  assert.ok(after.words.includes("The host registry was read in part. The row of build4 was not read: it is as it was last seen. Valkey answers host:h:build4 with WRONGTYPE: the key holds another kind of value."));
  // Its queue is still asked (the last row names it), so no list is a floor for it.
  assert.deepEqual([after.data.snapshot.activeUnreachable, unaskedQueuesText(after.data.snapshot)], [false, null]);
  const host = await drawn("host", "name=build4", deps, "operator");
  assert.match(host.words, /Row not read this time .*Valkey answers host:h:build4 with WRONGTYPE: .* What is drawn here is the row as it was last seen\./);
});

test("the words of a reply's code promise only what its class supports, and the registry's sentence names each host once", () => {
  assert.equal(erroredReadSentence("host:h:a", "WRONGTYPE"), "Valkey answers host:h:a with WRONGTYPE: the key holds another kind of value. Waiting does not change that: an operator has to remove or repair that key first.");
  assert.match(erroredReadSentence("host:h:a", "NOPERM"), /^Valkey answers host:h:a with NOPERM: the Valkey user this connects as may not run the command or read the key\. Waiting does not change that: an operator has to /);
  assert.doesNotMatch(erroredReadSentence("host:h:a", "NOPERM"), /remove or repair/);
  assert.equal(erroredReadSentence("host:h:a", "BUSY"), "Valkey answers host:h:a with BUSY: Valkey could not serve the command just then. A later read may succeed.");
  assert.equal(erroredReadSentence("host:h:a", "ERR"), "Valkey answers host:h:a with ERR.");
  const snapshot = (unreadHosts, more = 0) => ({ hostsReadAt: NOW, hostBudgets: [{ name: "hosta", notRead: true }, { name: "hostb" }], queue: { fleetDegraded: "x", registryReadInPart: true, unreadHosts, ...(more ? { unreadHostsMore: more } : {}) } });
  assert.equal(registryPartText(snapshot([{ name: "hosta", error: null }, { name: "hostw", error: "WRONGTYPE" }, { name: "hostx", error: "WRONGTYPE" }])),
    `The host registry was read in part. The rows of hosta, hostw and hostx were not read: hosta is as it was last seen; hostw and hostx were never read here, so they have no row. Valkey answers ${hostKey("hostw")} and ${hostKey("hostx")} with WRONGTYPE: the key holds another kind of value. Waiting does not change that: an operator has to remove or repair that key first.`);
  assert.equal(registryPartText(snapshot([{ name: "hosta", error: null }], 2)), "The host registry was read in part. The row of hosta was not read, nor were 2 more hosts': it is as it was last seen.");
  // A read that names no host says both cases, and a name is never written with a capital of the sentence's.
  assert.equal(registryPartText(snapshot([])), REGISTRY_PART_TEXT);
  assert.doesNotMatch(registryPartText(snapshot([{ name: "hostw", error: null }])), /Hostw/);
  // A value that is no host's name or no code is not put on a page.
  assert.equal(registryPartText(snapshot([{ name: "a b; rm", error: "WRONGTYPE" }])), REGISTRY_PART_TEXT);
  assert.doesNotMatch(registryPartText(snapshot([{ name: "hostw", error: "WRONGTYPE Operation against 10.0.0.9" }])), /Operation|10\.0\.0\.9|Valkey answers/);
});

test("a host whose row was not read is still a host to the views that ask about each host: what it loads, and what it applied", async () => {
  const redis = () => erroringKey(healthy(HOSTS), /^host:h:build4$/);
  const loads = await readHostLoadsView(redis(), { now: () => NOW });
  assert.deepEqual(loads.hosts.map((h) => [h.name, h.rowUnread === true, h.image]), [["build3", false, "pi-job:latest"], ["build4", true, null]]);
  // And with the publications themselves unread, it is still listed, as unknown.
  const down = await readHostLoadsView(failing(redis(), ["mget"]), { now: () => NOW });
  assert.deepEqual([down.unreachable, down.hosts.map((h) => [h.name, h.state, h.rowUnread === true])], [true, [["build3", "unknown", false], ["build4", "unknown", true]]]);
  // The Updates page asks each host for what it applied: the host whose row was not read is asked too.
  const asked = [];
  const recording = new Proxy(redis(), { get: (target, name) => (typeof target[name] !== "function" || name === "on" || name === "disconnect" ? target[name] : (...args) => { asked.push(args.flat().filter((arg) => typeof arg === "string").join(" ")); return target[name](...args); }) });
  await readUpdates({ redis: recording, staged: { packages: [{ name: "pi-a", version: "1.0.0", dir: "pi-a--1.0.0--aaaaaaaa", from: "pi-packages" }] }, now: NOW });
  assert.ok(asked.some((key) => /build4/.test(key) && key !== hostKey("build4")), `a read about build4 beside its row: ${JSON.stringify(asked.filter((key) => /build/.test(key)))}`);
});
