import assert from "node:assert/strict";
import { test } from "node:test";
import { FLEET_CARD_SNAPSHOT } from "./helpers/fleet-goldens.mjs";
import { NOW } from "../../launch/fixture-deployment.mjs";
import {
  fleetBar,
  fleetActive,
  fleetQueues,
  fleetHeld,
  fleetHosts,
  fleetDoctor,
  fleetVenues,
  fleetSchedulers,
  fleetFailed,
} from "../src/console/panels/fleet.mjs";

const view = (role = "operator", snapshot = FLEET_CARD_SNAPSHOT()) => ({
  role,
  readOnly: false,
  now: NOW,
  query: {},
  data: { snapshot },
});
const render = (fn, v = view()) => String(fn(v)).replace(/\s+/g, " ");

test("the Fleet bar follows the design's tile, state title, inline capsules and grouped switches", () => {
  const out = render(fleetBar);
  assert.match(out, /class="fl-bar"/);
  assert.match(out, /class="fl-bar__row"/);
  assert.match(out, /class="tile tone-ok"/);
  assert.match(out, /<h2>The fleet is running<\/h2>/);
  assert.match(out, /class="fl-bar__stats"/);
  assert.ok(out.includes(`<b>${FLEET_CARD_SNAPSHOT().queue.counts.active}</b> active`));
  assert.match(out, /class="fl-bar__btns"/);
  assert.match(out, /class="pp-src"/);
  assert.doesNotMatch(out, /<dl/);
});

test("part paused is a ringed warning with both switches and the paused-queue capsule", () => {
  const snapshot = FLEET_CARD_SNAPSHOT();
  snapshot.queueCounts[1].paused = true;
  const out = render(fleetBar, view("operator", snapshot));
  assert.match(out, /card--ring tone-attention/);
  assert.ok(out.includes(`Part paused: 1 of ${snapshot.queueCounts.length} queues are paused`));
  assert.match(out, /in paused queues/);
  assert.match(out, /data-action="fleet-pause"/);
  assert.match(out, /data-action="fleet-resume"/);
  assert.doesNotMatch(
    render(fleetBar, view("viewer", snapshot)),
    /data-action=/,
  );
});

test("the active table separates job and project and keeps phases, stripes and orphan explanation", () => {
  const snapshot = FLEET_CARD_SNAPSHOT();
  snapshot.active.push({
    jobId: "gh-absent",
    host: "build3",
    project: "web",
    progress: { absent: true },
  });
  const out = render(fleetActive, view("operator", snapshot));
  assert.match(out, /<th scope="col">Job<\/th><th scope="col">Project<\/th>/);
  assert.match(out, /class="fl-prog"/);
  assert.match(out, /aria-label="Run phases"/);
  assert.match(out, /This worker reports no progress/);
  assert.match(out, /Orphaned hold/);
  assert.match(out, /#p-hostsandboxes/);
});

test("queues have numerical columns, quiet zeros and play/pause state chips", () => {
  const out = render(fleetQueues);
  assert.match(out, /card--flush/);
  assert.match(out, /class="chip tone-ok"/);
  assert.match(out, /href="#i-play"/);
  assert.match(out, /class="faint">0<\/span>/);
  assert.ok(out.includes(`shared by ${FLEET_CARD_SNAPSHOT().hostBudgets.length} hosts`));
});

test("held jobs use inset per-job cards and individual condition checklist rows, not a data table", () => {
  const out = render(fleetHeld);
  assert.match(out, /class="fl-held"/);
  assert.match(out, /class="fl-held__h"/);
  assert.match(out, /class="fl-cond"/);
  assert.match(out, /href="#i-clock"/);
  assert.match(out, /Pending/);
  assert.match(out, /Not yet/);
  assert.match(out, /14 of 96 checks/);
  assert.doesNotMatch(out, /<table/);
  assert.doesNotMatch(render(fleetHeld, view("viewer")), /data-action=/);
});

test("each host is a resource card with identity, slots, heartbeat, aligned meters and running jobs", () => {
  const out = render(fleetHosts);
  assert.match(out, /class="hosts"/);
  assert.match(out, /class="hostrow"/);
  assert.match(out, /class="hostrow__n"/);
  assert.match(out, /class="hostrow__beat"/);
  assert.match(out, /class="fl-res"/);
  assert.match(out, /class="fl-res__v"/);
  assert.match(out, /16 of 24 GiB/);
  assert.match(out, /8 of 12 cores/);
  assert.match(out, /orphaned hold/);
  assert.doesNotMatch(out, /<table/);
});

test("Doctor uses per-host count strips and compact semantic problem rows with fixes", () => {
  const out = render(fleetDoctor);
  assert.match(out, /class="fl-doc"/);
  assert.match(out, /class="fl-doc__h"/);
  assert.match(out, /class="fl-cnt"/);
  assert.match(out, /class="fl-chks"/);
  assert.match(out, /class="fl-chk"/);
  assert.match(out, /class="fl-chk__fix"/);
  assert.match(out, /Fix:<\/b>/);
  assert.doesNotMatch(out, /<table/);
});

test("Venues is one row per venue with properties, capability chips and custody together", () => {
  const out = render(fleetVenues);
  assert.equal((out.match(/<table /g) ?? []).length, 1);
  for (const title of [
    "Egress",
    "Local folders",
    "Steering",
    "Live transcript",
    "Recovery",
    "Sandbox shell",
    "Credentials held by",
  ])
    assert.ok(out.includes(title), title);
  assert.match(out, /with the image/);
  assert.match(out, /class="fl-vfoot"/);
  assert.match(out, /All 14 properties/);
  assert.doesNotMatch(out, /<th[^>]*>Property<\/th>/);
});

test("schedule next occurrence carries its distance below it and failed cards show header bulk controls", () => {
  const schedule = render(fleetSchedulers);
  assert.match(schedule, /<span class="reason">in 3h 0m<\/span>/);
  assert.doesNotMatch(schedule, /How far off/);
  const failed = render(fleetFailed);
  assert.match(failed, /kept by the queue until you retry or remove/);
  assert.match(failed, /Retry all 3/);
  assert.match(failed, /class="reason fl-why"/);
});


test("designed host cards keep free slots unknown when the inventory or slot capacity is unknown", () => {
  for (const change of [{ concurrency: null }, { jobsMore: 3 }, { jobsUnreadable: true }, { ttlAgeMs: 180000, staleMs: 180000 }]) {
    const snapshot = FLEET_CARD_SNAPSHOT();
    Object.assign(snapshot.hostBudgets[0], change);
    const out = render(fleetHosts, view("operator", snapshot));
    assert.match(out, /Free slots not known/);
    assert.doesNotMatch(out, /aria-label="1 running, 1 held, 1 free"/);
  }
});
