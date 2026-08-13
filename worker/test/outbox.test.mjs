import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { test } from "node:test";
import { chainedJobId } from "../src/job-id.mjs";
import { makeCollectChain } from "../src/outbox.mjs";

/**
 * A fake fs exposing only what the collector touches -- readdirSync, statSync{size}, lstatSync{isFile},
 * readFileSync -- with call tracking for the "never read" / "gate not reached" assertions. `files` maps
 * a `request-<n>.json` name to `{ content, size, lstatIsFile, statThrows, lstatThrows, readThrows }`;
 * `size` defaults to the content byte length and `lstatIsFile` to true. `readdirThrows` simulates a
 * missing outbox dir; `readdirReturns` forces a non-array so the collector's outer never-throw boundary
 * can be exercised; `throwAll` makes every op throw.
 */
function makeFakeFs({ files = {}, readdirThrows = false, readdirReturns, throwAll = false } = {}) {
	const calls = { readdir: 0 };
	const reads = [];
	const stats = [];
	const lstats = [];
	const lookup = (p) => files[basename(p)] ?? {};
	return {
		calls,
		reads,
		stats,
		lstats,
		readdirSync() {
			calls.readdir++;
			if (throwAll || readdirThrows) throw new Error("readdir failed");
			if (readdirReturns !== undefined) return readdirReturns;
			return Object.keys(files);
		},
		statSync(p) {
			stats.push(p);
			if (throwAll) throw new Error("stat failed");
			const f = lookup(p);
			if (f.statThrows) throw new Error("stat failed");
			return { size: f.size ?? Buffer.byteLength(f.content ?? "") };
		},
		lstatSync(p) {
			lstats.push(p);
			if (throwAll) throw new Error("lstat failed");
			const f = lookup(p);
			if (f.lstatThrows) throw new Error("lstat failed");
			const isFile = f.lstatIsFile ?? true;
			return { isFile: () => isFile };
		},
		readFileSync(p) {
			reads.push(p);
			if (throwAll) throw new Error("read failed");
			const f = lookup(p);
			if (f.readThrows) throw new Error("read failed");
			return f.content ?? "";
		},
	};
}

/** A stub enqueue that records the args the collector hands it, mirroring the queue.test fake. */
function makeCapture() {
	const enqueued = [];
	return {
		enqueued,
		queue: { sentinel: true },
		enqueue: async (queue, args) => {
			enqueued.push({ queue, args });
			return args.jobId;
		},
	};
}

/** A stub readFlowGate that records every call so the "gate not reached" ordering can be asserted. */
function makeGate(fn = ({ flow }) => ({ gate: flow === "ok" ? "allow" : "deny" })) {
	const calls = [];
	return {
		calls,
		gate: async (args) => {
			calls.push(args);
			return fn(args);
		},
	};
}

const PREPARED = { jobDir: "/job", workspace: "/proj", sha: "abcsha" };
const localJob = (data = {}) => ({ id: "parent-1", data: { kind: "local", ...data } });
const req = (obj) => JSON.stringify(obj);

test("happy path: one valid request enqueues one child on the parent's folder", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "do it" }) } } });
	const cap = makeCapture();
	const gate = makeGate();
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: gate.gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 1, refused: 0 });
	assert.equal(cap.enqueued.length, 1);
	const { args } = cap.enqueued[0];
	assert.equal(args.folder, "/proj"); // forced to the parent's own folder, not read from the outbox
	assert.equal(args.flow, "ok");
	assert.equal(args.task, "do it");
	assert.equal(args.chainDepth, 1); // host-computed parent(0) + 1
	assert.equal(args.parentJobId, "parent-1");
	assert.equal(args.jobId, chainedJobId({ parentJobId: "parent-1", flow: "ok", task: "do it" }));
});

test("a chained child inherits the PARENT'S image, and never the request file's", async () => {
	// A chained child runs the parent's OWN folder, so it needs the parent's toolchain by definition -- unlike
	// provider/model, where a fallback still runs the flow. A child in the wrong image cannot find its tools,
	// writes a plausible report and exits 0: success as far as the queue can tell.
	//
	// And the agent must not get to choose it. `req` is agent-authored; INT-OUTBOX-CONTRACT reads explicit
	// properties off it and never spreads it, exactly as it does for folder and depth.
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "do it", image: "evil:latest" }) } } });
	const cap = makeCapture();
	const gate = makeGate();
	const collect = makeCollectChain({ queue: cap.queue, enqueue: cap.enqueue, readFlowGate: gate.gate, config: { chainMaxPerJob: 2, chainDepthMax: 1 }, fs });

	const parent = localJob();
	parent.data = { ...parent.data, image: "my-python:1.2.0" };
	await collect({ job: parent, prepared: PREPARED });

	const { args } = cap.enqueued[0];
	assert.equal(args.image, "my-python:1.2.0", "the child inherits the parent's toolchain");
	assert.notEqual(args.image, "evil:latest", "the agent cannot choose its child's image");
	// Identity stays (parent, flow, task): folding the image in would let a triggers.json edit fan out a
	// duplicate PAID child from a retried parent.
	assert.equal(args.jobId, chainedJobId({ parentJobId: "parent-1", flow: "ok", task: "do it" }));
});

test("a parent with no image chains a child whose data carries none either", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "do it" }) } } });
	const cap = makeCapture();
	const gate = makeGate();
	const collect = makeCollectChain({ queue: cap.queue, enqueue: cap.enqueue, readFlowGate: gate.gate, config: { chainMaxPerJob: 2, chainDepthMax: 1 }, fs });

	await collect({ job: localJob(), prepared: PREPARED });
	assert.equal(cap.enqueued[0].args.image, undefined, "byte-identical to a pre-issue chain");
});

test("count cap: files beyond chainMaxPerJob are dropped and never read", async () => {
	const fs = makeFakeFs({
		files: {
			"request-1.json": { content: req({ flow: "ok", task: "a" }) },
			"request-2.json": { content: req({ flow: "ok", task: "b" }) },
			"request-3.json": { content: req({ flow: "ok", task: "c" }) },
		},
	});
	const cap = makeCapture();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 2, refused: 1 });
	assert.ok(logs.some((l) => l.event === "chain-count-cap"), "the dropped file is logged");
	// The over-cap file is never opened (bounds parse cost): neither statted nor read.
	assert.ok(!fs.stats.some((p) => basename(p) === "request-3.json"), "over-cap file is not statted");
	assert.ok(!fs.reads.some((p) => basename(p) === "request-3.json"), "over-cap file is not read");
});

test("size cap: an oversize file is refused before any read", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "x" }), size: 5 * 1024 } } });
	const cap = makeCapture();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 1 });
	assert.ok(logs.some((l) => l.event === "chain-oversize"));
	assert.equal(fs.reads.length, 0, "an oversize file is never read/parsed");
});

test("non-regular file: an lstat that is not a regular file is refused before any read", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "x" }), lstatIsFile: false } } });
	const cap = makeCapture();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 1 });
	assert.ok(logs.some((l) => l.event === "chain-not-regular-file"));
	assert.equal(fs.reads.length, 0, "a symlink/dir/device is never read");
});

test("bad JSON: an unparseable request is refused and never throws", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: "not json {" } } });
	const cap = makeCapture();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 1 });
	assert.ok(logs.some((l) => l.event === "chain-parse-error"));
});

test("bad flow charset: a traversal flow name is refused before the gate is consulted", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "../evil", task: "x" }) } } });
	const cap = makeCapture();
	const gate = makeGate();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: gate.gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 1 });
	assert.ok(logs.some((l) => l.event === "chain-bad-flow-name"));
	assert.equal(gate.calls.length, 0, "the gate is never consulted for a bad flow name");
});

test("depth cap: childDepth over chainDepthMax is refused before the gate", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "x" }) } } });
	const cap = makeCapture();
	const gate = makeGate();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: gate.gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob({ chainDepth: 1 }), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 1 }); // 1 + 1 > 1
	assert.ok(logs.some((l) => l.event === "chain-depth-cap"));
	assert.equal(gate.calls.length, 0, "depth is checked before the gate");
});

test("depth kill-switch: chainDepthMax 0 refuses every request", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "x" }) } } });
	const cap = makeCapture();
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 0 },
		fs,
	});

	const res = await collect({ job: localJob(), prepared: PREPARED }); // childDepth 1 > 0

	assert.deepEqual(res, { enqueued: 0, refused: 1 });
});

test("gate deny and no-skill both refuse with no enqueue", async () => {
	for (const gateValue of ["deny", "no-skill"]) {
		const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "guarded", task: "x" }) } } });
		const cap = makeCapture();
		const logs = [];
		const collect = makeCollectChain({
			queue: cap.queue,
			enqueue: cap.enqueue,
			readFlowGate: makeGate(() => ({ gate: gateValue })).gate,
			config: { chainMaxPerJob: 2, chainDepthMax: 1 },
			fs,
			log: (event, fields) => logs.push({ event, fields }),
		});

		const res = await collect({ job: localJob(), prepared: PREPARED });

		assert.deepEqual(res, { enqueued: 0, refused: 1 }, `gate=${gateValue}`);
		assert.equal(cap.enqueued.length, 0, `gate=${gateValue} enqueues nothing`);
		assert.ok(logs.some((l) => l.event === "chain-gate-deny"), `gate=${gateValue} logs a deny`);
	}
});

test("a request naming a command refuses as chain-command-refused -- commands are never AI-reachable", async () => {
	// Issue #189, and unlike the flow gate there is no opt-in to widen: the gate reads a committed
	// SKILL.md at a pinned sha, and a command is an operator-staged extension with no committed artifact
	// to read. Fires even when the request ALSO carries a perfectly valid flow, and BEFORE the charset
	// check -- which field the request used is decided before any opinion about its spelling.
	const fs = makeFakeFs({
		files: {
			"request-1.json": { content: req({ command: "wf run", flow: "ok", task: "x" }) },
			"request-2.json": { content: req({ command: "wf run", flow: "../evil", task: "x" }) },
		},
	});
	const cap = makeCapture();
	const gate = makeGate();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: gate.gate,
		config: { chainMaxPerJob: 4, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	const res = await collect({ job: localJob(), prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 2 });
	assert.ok(logs.some((l) => l.event === "chain-command-refused"), "the refusal is its own log-stream event");
	assert.ok(!logs.some((l) => l.event === "chain-bad-flow-name"), "the command refusal outranks the charset check -- request-2's bad flow never gets an opinion");
	assert.equal(gate.calls.length, 0, "the gate is never consulted -- there is no opt-in for a command");
	assert.equal(cap.enqueued.length, 0, "a valid flow riding beside the command buys nothing");
	assert.ok(!JSON.stringify(logs).includes("wf run"), "the refusal log carries jobId/reason/index only, never the command text");
});

test("retry-idempotent: two collects on the same parent+requests produce identical child ids", async () => {
	const files = { "request-1.json": { content: req({ flow: "ok", task: "same" }) } };
	const run = async () => {
		const cap = makeCapture();
		const collect = makeCollectChain({
			queue: cap.queue,
			enqueue: cap.enqueue,
			readFlowGate: makeGate().gate,
			config: { chainMaxPerJob: 2, chainDepthMax: 1 },
			fs: makeFakeFs({ files }),
		});
		await collect({ job: localJob(), prepared: PREPARED });
		return cap.enqueued.map((e) => e.args.jobId);
	};

	const first = await run();
	const second = await run();
	assert.deepEqual(first, second, "a retried parent re-enqueues identical child ids (BullMQ dedups)");
});

test("never throws: a hostile fs returns counts instead of propagating", async () => {
	const config = { chainMaxPerJob: 2, chainDepthMax: 1 };
	const make = (fs, prepared = PREPARED, job = localJob()) => {
		const collect = makeCollectChain({ queue: {}, enqueue: makeCapture().enqueue, readFlowGate: makeGate().gate, config, fs });
		return collect({ job, prepared });
	};

	// readdir throws (missing dir), every op throws, a non-array listing (trips the outer boundary),
	// and a malformed `prepared` (join throws) all resolve to a counts object, never a rejection.
	await assert.doesNotReject(async () => {
		assert.deepEqual(await make(makeFakeFs({ readdirThrows: true })), { enqueued: 0, refused: 0 });
		assert.deepEqual(await make(makeFakeFs({ throwAll: true })), { enqueued: 0, refused: 0 });
		assert.deepEqual(await make(makeFakeFs({ readdirReturns: null })), { enqueued: 0, refused: 0 });
		assert.deepEqual(await make(makeFakeFs({}), { workspace: "/proj", sha: "s" }), { enqueued: 0, refused: 0 });
	});
});

test("PII: the agent task text reaches the child but never a log line", async () => {
	const marker = "SUPERSECRET_TASK_MARKER";
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: marker }) } } });
	const cap = makeCapture();
	const logs = [];
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
		log: (event, fields) => logs.push({ event, fields }),
	});

	await collect({ job: localJob(), prepared: PREPARED });

	assert.equal(cap.enqueued[0].args.task, marker, "the task is DATA -- it must reach the child's prompt");
	const loggedJson = JSON.stringify(logs);
	assert.ok(!loggedJson.includes(marker), "the task text must never enter a log line");
});

test("kind guard: a github parent is a no-op with no fs access", async () => {
	const fs = makeFakeFs({ files: { "request-1.json": { content: req({ flow: "ok", task: "x" }) } } });
	const cap = makeCapture();
	const collect = makeCollectChain({
		queue: cap.queue,
		enqueue: cap.enqueue,
		readFlowGate: makeGate().gate,
		config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs,
	});

	const res = await collect({ job: { id: "gh-1", data: { kind: "github" } }, prepared: PREPARED });

	assert.deepEqual(res, { enqueued: 0, refused: 0 });
	assert.equal(fs.calls.readdir, 0, "a github parent's outbox is never even listed");
	assert.equal(cap.enqueued.length, 0);
});
