import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTAINER_START_MAX_MS, makeContainerActivity } from "../src/container-activity.mjs";

// Issue #1023: the worker's count of the job containers it is starting and running, which the sandbox retention sweep
// reads. On a clock the test moves; nothing here waits.
function onAClock() {
	let t = 1_000;
	return { activity: makeContainerActivity({ now: () => t }), advance: (ms) => (t += ms) };
}
const counts = (activity) => [activity.starting(), activity.running()];

test("the bound on a start is pinned by literal (issue #1023)", () => {
	// By literal: a test derived from the constant would follow it to any value.
	assert.equal(CONTAINER_START_MAX_MS, 120_000);
});

test("a run is starting from enter(), running from started(), and counted no more from ended() (issue #1023)", () => {
	const { activity } = onAClock();
	assert.deepEqual(counts(activity), [0, 0]);
	const a = activity.enter();
	assert.deepEqual(counts(activity), [1, 0]);
	const b = activity.enter();
	assert.deepEqual(counts(activity), [2, 0], "each enter() is its own run");
	a.started();
	assert.deepEqual(counts(activity), [1, 1]);
	b.started();
	assert.deepEqual(counts(activity), [0, 2]);
	a.ended();
	assert.deepEqual(counts(activity), [0, 1]);
	b.ended();
	assert.deepEqual(counts(activity), [0, 0]);
});

test("started() and ended() are idempotent and safe in any order (issue #1023)", () => {
	const { activity } = onAClock();
	// Twice each: a run is counted once, and ended once.
	const twice = activity.enter();
	twice.started();
	twice.started();
	assert.deepEqual(counts(activity), [0, 1]);
	twice.ended();
	twice.ended();
	assert.deepEqual(counts(activity), [0, 0]);
	// ended() before started(): a run that never started a container, and a late started() does not bring it back.
	const never = activity.enter();
	never.ended();
	assert.deepEqual(counts(activity), [0, 0]);
	never.started();
	assert.deepEqual(counts(activity), [0, 0], "a report after the end counts nothing");
	// One run's reports never touch another's.
	const other = activity.enter();
	never.ended();
	twice.started();
	assert.deepEqual(counts(activity), [1, 0]);
	other.ended();
	assert.deepEqual(counts(activity), [0, 0]);
});

test("a start that never reports stops counting as a start at the bound, and is counted as running until it ends (issue #1023)", () => {
	// The sweep waits while a start is counted, so a start that never reports must not be able to hold it for good. It is
	// not dropped: a container still coming up after two minutes is what the sweep's small passes are for.
	const { activity, advance } = onAClock();
	const slow = activity.enter();
	advance(119_999);
	assert.deepEqual(counts(activity), [1, 0], "one millisecond short of the bound it is still a start");
	advance(1);
	assert.deepEqual(counts(activity), [0, 1], "at the bound it holds no sweep any more");
	advance(3_600_000);
	assert.deepEqual(counts(activity), [0, 1], "and stays counted as running, however long");
	// A run that entered later has its own two minutes.
	const next = activity.enter();
	assert.deepEqual(counts(activity), [1, 1]);
	slow.started();
	assert.deepEqual(counts(activity), [1, 1], "a late started() changes nothing it was not already");
	slow.ended();
	assert.deepEqual(counts(activity), [1, 0]);
	next.ended();
	assert.deepEqual(counts(activity), [0, 0]);
});

test("a run that said it started is running for as long as it runs: the bound is on starts only (issue #1023)", () => {
	const { activity, advance } = onAClock();
	const run = activity.enter();
	advance(5_000);
	run.started();
	advance(6 * 3_600_000);
	assert.deepEqual(counts(activity), [0, 1]);
	run.ended();
	assert.deepEqual(counts(activity), [0, 0]);
});

test("the default clock needs no argument and steps forward on its own (issue #1023)", () => {
	const activity = makeContainerActivity();
	const run = activity.enter();
	assert.deepEqual(counts(activity), [1, 0]);
	run.ended();
	assert.deepEqual(counts(activity), [0, 0]);
});

test("the default clock is the monotonic one, not the wall clock: a clock set ten minutes on does not age a start (issue #1023)", (t) => {
	// The bound on a start is a duration. Read off the wall clock, a time sync or an operator setting the clock forward
	// would end every start at once (the sweep then stops waiting for containers that are still coming up), and one
	// set back would keep a start that never reports alive past its two minutes.
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const activity = makeContainerActivity();
	const run = activity.enter();
	t.mock.timers.setTime(1_000_000 + 5 * CONTAINER_START_MAX_MS);
	assert.deepEqual(counts(activity), [1, 0], "still starting, whatever the wall clock says");
	run.ended();
	assert.deepEqual(counts(activity), [0, 0]);
});
