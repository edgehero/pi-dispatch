import assert from "node:assert/strict";
import { test } from "node:test";
import { makeForgeRouter } from "../src/route.mjs";

// A router wired entirely to fakes: no Valkey, no BullMQ, no network.
function harness({ hosts = [], readThrows = false, ttlMs = 5_000 } = {}) {
	const opened = [];
	const reads = [];
	let clock = 1_000_000;
	const shared = { name: "pi-jobs", async close() {} };
	const router = makeForgeRouter({
		valkeyUrl: "redis://x",
		shared,
		ttlMs,
		now: () => clock,
		makeQueueFn: (_c, opts) => {
			opened.push(opts?.name);
			return { name: opts?.name, async close() {} };
		},
		parseConnectionFn: () => ({}),
		redisFn: () => ({ on() {}, disconnect() {} }),
		readLiveHostsFn: async () => {
			reads.push(clock);
			if (readThrows) throw new Error("ECONNREFUSED");
			return { hosts };
		},
	});
	return { router, opened, reads, shared, tick: (ms) => (clock += ms) };
}

const capable = [
	{ name: "mini1", caps: "s:prod", routes: "true", staleMs: 0 },
	{ name: "mini2", caps: "", routes: "true", staleMs: 0 },
];
const delivery = (extra = {}) => ({ trigger: { deliveryId: "d-1" }, ...extra });

test("a delivery that binds nothing never touches the registry at all", async () => {
	// The overwhelming majority of deliveries. They must not pay a cache lookup, let alone a read, for a
	// decision that cannot apply to them -- this sits in front of every webhook the deployment receives.
	const { router, reads, shared } = harness({ hosts: capable });
	assert.equal(await router.queueFor("github", delivery()), shared);
	assert.deepEqual(reads, []);
	await router.close();
});

test("a delivery bound to one host's profile is enqueued onto that host's queue", async () => {
	const { router, opened } = harness({ hosts: capable });
	const q = await router.queueFor("github", delivery({ secretsProfile: "prod" }));
	assert.equal(q.name, "pi-jobs@mini1");
	assert.deepEqual(opened, ["pi-jobs@mini1"], "and the handle is opened lazily, only for a host actually routed to");
	await router.close();
});

test("an unreachable registry falls back to the shared queue and does not retry per delivery", async () => {
	// Failing open is the whole posture: a webhook handler is the wrong place to invent a new way to drop
	// work. Caching the FAILURE matters as much -- an unreachable Valkey during a delivery burst must cost
	// one read per window, not one per delivery, or the fallback becomes its own outage.
	const { router, reads, shared } = harness({ readThrows: true });
	for (let i = 0; i < 5; i++) assert.equal(await router.queueFor("github", delivery({ secretsProfile: "prod" })), shared);
	assert.equal(reads.length, 1);
	await router.close();
});

test("the host list is cached for the window and re-read after it", async () => {
	const { router, reads, tick } = harness({ hosts: capable, ttlMs: 5_000 });
	await router.queueFor("github", delivery({ secretsProfile: "prod" }));
	tick(4_000);
	await router.queueFor("github", delivery({ secretsProfile: "prod" }));
	assert.equal(reads.length, 1, "inside the window, no second read");
	tick(2_000);
	await router.queueFor("github", delivery({ secretsProfile: "prod" }));
	assert.equal(reads.length, 2, "past it, one more");
	await router.close();
});

test("a burst on a cold cache issues ONE read, not one per delivery", async () => {
	// The moment a deployment can least afford N registry reads is the moment N deliveries arrive at once.
	const { router, reads } = harness({ hosts: capable });
	await Promise.all(Array.from({ length: 8 }, () => router.queueFor("github", delivery({ secretsProfile: "prod" }))));
	assert.equal(reads.length, 1);
	await router.close();
});

test("one queue handle per host, reused across deliveries", async () => {
	const { router, opened } = harness({ hosts: capable });
	for (let i = 0; i < 4; i++) await router.queueFor("github", { trigger: { deliveryId: `d-${i}` }, secretsProfile: "prod" });
	assert.deepEqual(opened, ["pi-jobs@mini1"], "opened once, not once per delivery");
	await router.close();
});

test("a delivery with no id is still routable rather than a crash", async () => {
	// `forgeDeliveryJobId` throws on an unknown forge, and a poller-sourced job may carry no deliveryId.
	// Neither is a reason to drop a delivery, so both land on the shared queue.
	const { router, shared } = harness({ hosts: capable });
	assert.equal(await router.queueFor("not-a-forge", { trigger: { deliveryId: "d" }, secretsProfile: "prod" }), shared);
	await router.close();
});
