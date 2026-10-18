import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { inboxAck } from "../src/steer-ack.mjs";
import { join } from "node:path";
import { buildDockerRunArgs, buildPodmanRunArgs } from "../src/docker-run.mjs";
import { CONTAINER_INBOX_DIR } from "../src/container-spec.mjs";
import { makeLiveTranscriptOpener } from "../src/live-transcript.mjs";
import { steerTargetKey } from "../src/steer-inbox.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #646: the inbox mount and the arming of a steer job in runContainer.

let mod;
let importError;
try {
	mod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`run-container steer tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

// --- the mount -----------------------------------------------------------------------------------------------------

const BASE = { image: "pi-job:x", env: { A: "1" }, jobDir: "/host/jobs/j1", workspace: "/host/jobs/j1/ws", name: "pi-job-j1", sessionDir: "/host/jobs/j1/session" };
const mountsOf = (args) => args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));

test("the inbox is mounted read-only at /inbox only when the spec names it, on both runtimes", () => {
	assert.equal(CONTAINER_INBOX_DIR, "/inbox");
	const armed = buildDockerRunArgs({ ...BASE, steerInboxDir: "/host/jobs/j1.inbox" });
	assert.ok(mountsOf(armed).includes("/host/jobs/j1.inbox:/inbox:ro"), "docker: read-only");
	const podman = buildPodmanRunArgs({ ...BASE, user: "1000:1000", steerInboxDir: "/host/jobs/j1.inbox" });
	assert.ok(mountsOf(podman).includes("/host/jobs/j1.inbox:/inbox:ro"), "podman: read-only");
	const relabelled = buildDockerRunArgs({ ...BASE, steerInboxDir: "/host/jobs/j1.inbox", relabel: true });
	assert.ok(mountsOf(relabelled).includes("/host/jobs/j1.inbox:/inbox:ro,Z"), "a per-job directory, relabelled private like the others");
});

test("UNARMED: the argv is byte-identical to one built without the field (undefined, null and absent alike)", () => {
	const before = buildDockerRunArgs(BASE);
	assert.deepEqual(buildDockerRunArgs({ ...BASE, steerInboxDir: undefined }), before);
	assert.deepEqual(buildDockerRunArgs({ ...BASE, steerInboxDir: null }), before);
	assert.ok(!before.some((a) => String(a).includes("/inbox")));
	const podmanBefore = buildPodmanRunArgs({ ...BASE, user: "1000:1000" });
	assert.deepEqual(buildPodmanRunArgs({ ...BASE, user: "1000:1000", steerInboxDir: undefined }), podmanBefore);
});

// --- arming in runContainer ----------------------------------------------------------------------------------------

const HOST = { ANTHROPIC_API_KEY: "sk-real" };
const STEER_JOB = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, provider: "anthropic", model: "m", maxTurns: 5, steer: true };

function staged() {
	const dir = tempDir("pi-rc-steer-");
	const jobDir = join(dir, "job-x1");
	mkdirSync(join(jobDir, "session"), { recursive: true });
	mkdirSync(join(jobDir, "ws"));
	writeFileSync(join(jobDir, "session", "current.jsonl"), "");
	return { jobDir, prepared: { workspace: join(jobDir, "ws"), jobDir, live: { hostDir: join(jobDir, "session") } } };
}

/** A runtime child that records its argv, checks the inbox while it "runs", and exits `code`. */
function child(rec, { code = 0, during = () => {} } = {}) {
	return (cmd, args) => {
		rec.args = args;
		const c = new EventEmitter();
		c.stdout = new EventEmitter();
		c.stderr = new EventEmitter();
		c.stdin = { on() {}, end(v) {
			rec.stdin = v;
		} };
		setImmediate(async () => {
			await during();
			c.emit("close", code);
		});
		return c;
	};
}

/** A relay opener that records what it was opened with and the order of start and stop. */
function relays({ deliverMs = 0 } = {}) {
	const opened = [];
	const order = [];
	const delivered = [];
	const open = (args) => {
		opened.push(args);
		return {
			start: async () => order.push("start"),
			afterBaseline: () => order.push("baseline"),
			delivered: async (id) => {
				if (deliverMs > 0) await new Promise((r) => setTimeout(r, deliverMs));
				delivered.push(id);
				order.push(`delivered:${id.slice(0, 2)}`);
			},
			stop: async () => (order.push("stop"), {}),
		};
	};
	return { opened, order, delivered, open };
}

const sinkSaying = (fields) => () => ({ write() {}, close: async () => ({ turns: 1, tokens: null, session: null, usage: null, context: null, exitReason: null, exitAuth: "verified", ...fields }) });
const opener = () => makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000 });
const envOf = (args) => args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));

test("ARMED: binds, a key and the wiring give PI_STEER=1, the read-only /inbox mount, a 0700 inbox beside the job dir, and the relay for the run", { skip }, async () => {
	const { jobDir, prepared } = staged();
	const rec = {};
	const r = relays();
	let inboxDuring = null;
	const inboxDir = `${jobDir}.inbox`;
	const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, openJobLog: sinkSaying({ steer: { delivered: 2, pending: 1 } }), spawnFn: child(rec, { during: () => (inboxDuring = statSync(inboxDir).mode & 0o777) }) })({
		job: STEER_JOB,
		prepared,
		name: "pi-job-r9",
		signal: new AbortController().signal,
		jobId: "r9",
		exitAuth: true,
		binds: true,
	});
	assert.ok(envOf(rec.args).includes("PI_STEER=1"));
	assert.ok(mountsOf(rec.args).includes(`${inboxDir}:/inbox:ro`));
	assert.equal(inboxDuring, 0o700, "made 0700 before the container ran");
	assert.equal(existsSync(inboxDir), false, "removed once the run is over");
	assert.equal(r.opened.length, 1);
	assert.equal(r.opened[0].runId, "r9", "the run id (index.mjs passes runIdOf as jobId), so a recovery writes the same inbox");
	assert.equal(r.opened[0].inboxDir, inboxDir);
	assert.equal(r.opened[0].targetKey, steerTargetKey({ kind: "github", repo: "o/r", targetType: "issue", number: 7 }));
	assert.equal(r.opened[0].ref, "issue #7");
	assert.deepEqual(r.order.filter((o) => o !== "baseline"), ["start", "stop"], "started with the container, stopped after it");
	assert.ok(r.order.includes("baseline"), "the tail's first pass released the writing");
	assert.deepEqual(result.steer, { delivered: 2, pending: 1 }, "the runner's counts off its exit line");
	assert.equal(result.steerSkipped, undefined);
});

test("the arming matrix: a copying venue, no exit key, or no wiring each run the job unarmed, named, with the argv of a job that never asked", { skip }, async () => {
	const plainArgv = async (job, extra = {}) => {
		const { prepared } = staged();
		const rec = {};
		await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: relays().open, openJobLog: sinkSaying({}), spawnFn: child(rec) })({ job, prepared, name: "pi-job-m", signal: new AbortController().signal, jobId: "m", ...extra });
		return rec.args.map((a) => String(a).replace(/job-x1[^/:]*/g, "J").replace(/pi-rc-steer-[^/]*/g, "D"));
	};
	const { steer: _s, ...noSteer } = STEER_JOB;
	const cases = [
		{ name: "venue-copies", call: { exitAuth: true, binds: false } },
		{ name: "venue-copies", call: { exitAuth: true } },
		{ name: "venue-copies", call: { exitAuth: true, binds: undefined } },
		{ name: "venue-copies", call: { exitAuth: true, binds: "true" } },
		{ name: "no-exit-key", call: { exitAuth: false, binds: true } },
		{ name: "no-transcript", call: { exitAuth: true, binds: true }, factory: { openInboxRelay: null } },
		{ name: "no-transcript", call: { exitAuth: true, binds: true }, factory: { openLiveTranscript: null } },
	];
	for (const c of cases) {
		const { jobDir, prepared } = staged();
		const rec = {};
		const r = relays();
		const logs = [];
		const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, openJobLog: sinkSaying({ steer: { delivered: 9, pending: 9 } }), log: (e, f) => logs.push([e, f]), spawnFn: child(rec), ...(c.factory ?? {}) })({ job: STEER_JOB, prepared, name: "pi-job-m", signal: new AbortController().signal, jobId: "m", ...c.call });
		assert.equal(result.steerSkipped, c.name, JSON.stringify(c.call));
		assert.equal(result.steer, undefined, "no counts from a runner that was not armed");
		assert.ok(!envOf(rec.args).includes("PI_STEER=1"), "never PI_STEER: the runner would refuse it without the channel");
		assert.ok(!mountsOf(rec.args).some((m) => m.includes(":/inbox")));
		assert.equal(existsSync(`${jobDir}.inbox`), false, "no inbox made");
		assert.equal(r.opened.length, 0, "no relay opened, so the run never takes a message");
		assert.deepEqual(logs.find((l) => l[0] === "steer_skipped")?.[1], { container: "pi-job-m", reason: c.name });
		const strip = rec.args.map((a) => String(a).replace(/job-x1[^/:]*/g, "J").replace(/pi-rc-steer-[^/]*/g, "D"));
		assert.deepEqual(strip, await plainArgv(noSteer, c.call), "the argv of the same job without run.steer");
	}
});

test("a job that never asked resolves the object it always did (no steer keys) and opens no relay", { skip }, async () => {
	const { prepared } = staged();
	const r = relays();
	const { steer: _s, ...noSteer } = STEER_JOB;
	const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, openJobLog: sinkSaying({ steer: { delivered: 1, pending: 0 } }), spawnFn: child({}) })({ job: noSteer, prepared, name: "pi-job-n", signal: new AbortController().signal, jobId: "n", exitAuth: true, binds: true });
	assert.equal("steer" in result, false);
	assert.equal("steerSkipped" in result, false);
	assert.equal(r.opened.length, 0);
});

test("FINALLY: a throw before the spawn (an unconfigured provider) removes the inbox and starts no relay", { skip }, async () => {
	const { jobDir, prepared } = staged();
	const r = relays();
	await assert.rejects(
		mod.makeRunContainer({ image: "pi-job:x", hostEnv: {}, openLiveTranscript: opener(), openInboxRelay: r.open, spawnFn: child({}) })({ job: STEER_JOB, prepared, name: "pi-job-t", signal: new AbortController().signal, jobId: "t", exitAuth: true, binds: true }),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(existsSync(`${jobDir}.inbox`), false, "the directory made for it is gone");
	assert.deepEqual(r.order, [], "never started");
});

test("FINALLY: a spawn error stops the relay and removes the inbox", { skip }, async () => {
	const { jobDir, prepared } = staged();
	const r = relays();
	const spawnFn = () => {
		const c = new EventEmitter();
		c.stdout = new EventEmitter();
		c.stderr = new EventEmitter();
		c.stdin = { on() {}, end() {} };
		setImmediate(() => c.emit("error", new Error("spawn docker ENOENT")));
		return c;
	};
	await assert.rejects(mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, spawnFn })({ job: STEER_JOB, prepared, name: "pi-job-e", signal: new AbortController().signal, jobId: "e", exitAuth: true, binds: true }), /container-never-started/);
	assert.equal(existsSync(`${jobDir}.inbox`), false);
	assert.ok(r.order.includes("start") && r.order.at(-1) === "stop", "started, then stopped");
});

test("an inbox that cannot be made is a named skip, and the job runs unarmed", { skip }, async () => {
	const { prepared } = staged();
	const rec = {};
	const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: relays().open, openJobLog: sinkSaying({}), inboxFs: { rmSync() {}, mkdirSync() {
		throw Object.assign(new Error("nope"), { code: "EACCES" });
	} }, spawnFn: child(rec) })({ job: STEER_JOB, prepared, name: "pi-job-i", signal: new AbortController().signal, jobId: "i", exitAuth: true, binds: true });
	assert.equal(result.steerSkipped, "no-inbox");
	assert.ok(!envOf(rec.args).includes("PI_STEER=1"));
});

test("the registry hands `binds` to a steer job's runContainer only, from the bundle's own declaration", async () => {
	const { makeBackendRegistry } = await import("../src/backend-registry.mjs");
	const seen = [];
	const bundle = (name, binds) => ({ name, declares: {}, namePrefix: "pi-job-", containerName: (j) => `pi-job-${j.id}`, neverStartedExits: [125], binds, runContainer: async (args) => (seen.push([name, args]), { code: 0 }), imagePreflight: async () => ({ ok: true }), egressPreflight: async () => ({ ok: true }), stopContainer: async () => {}, reap: async () => ({}), listJobContainers: async () => [], containerGone: async () => true });
	let registry;
	try {
		registry = makeBackendRegistry({ bundles: [bundle("local", true)], defaultName: "local" });
	} catch (e) {
		// The registry's own shape checks are the registry test's; this one needs only a bundle it accepts.
		throw new Error(`fixture bundle refused: ${e.message}`);
	}
	await registry.runContainer({ job: { steer: true }, name: "a" });
	await registry.runContainer({ job: {}, name: "b" });
	assert.equal(seen[0][1].binds, true);
	assert.equal("binds" in seen[1][1], false, "every other call bag is the caller's");
});

// --- review round 1 ------------------------------------------------------------------------------------------------

const KEY = "3c".repeat(32);
const IDA = "a".repeat(32);
const IDB = "b".repeat(32);
const IDC = "c".repeat(32);
const ackJson = (id, ack) => `${JSON.stringify({ type: "custom_message", customType: "pi-dispatch-inbox", content: [], details: { id, mode: "steer", source: "cli", ack } })}\n`;

test("RC05 + RC06: the ack is over the CONTAINER NAME (PI_JOB_ID), not the job id; a mark still in flight at exit is awaited before the relay stops", { skip }, async () => {
	const { jobDir, prepared } = staged();
	const file = join(jobDir, "session", "current.jsonl");
	const r = relays({ deliverMs: 30 });
	const rec = {};
	await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, openJobLog: sinkSaying({}), mintExitKey: () => KEY, spawnFn: child(rec, {
		during: () => appendFileSync(file, ackJson(IDA, inboxAck(KEY, "pi-job-run7", IDA)) + ackJson(IDB, inboxAck(KEY, "run7", IDB))),
	}) })({ job: STEER_JOB, prepared, name: "pi-job-run7", signal: new AbortController().signal, jobId: "run7", exitAuth: true, binds: true });
	assert.ok(envOf(rec.args).includes("PI_JOB_ID=pi-job-run7"), "the runner MACs over this string");
	assert.deepEqual(r.delivered, [IDA], "a MAC over the job id does not verify");
	assert.ok(r.order.indexOf("delivered:aa") < r.order.indexOf("stop"), "the slow mark finished before the relay stopped");
});

test("F3: with the transcript swapped for a symlink (the tail refuses it), the ids on the SIGNED exit line are still marked delivered", { skip }, async () => {
	const { jobDir, prepared } = staged();
	const file = join(jobDir, "session", "current.jsonl");
	const r = relays();
	const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, openJobLog: sinkSaying({ steer: { delivered: 2, pending: 0, deliveredIds: [IDA, IDC] } }), mintExitKey: () => KEY, spawnFn: child({}, {
		during: () => {
			// The agent replaces its transcript with a link (it may write /session) and forges nothing else.
			rmSync(file);
			symlinkSync("/etc/hosts", file);
		},
	}) })({ job: STEER_JOB, prepared, name: "pi-job-s1", signal: new AbortController().signal, jobId: "s1", exitAuth: true, binds: true });
	assert.deepEqual(r.delivered.sort(), [IDA, IDC]);
	assert.ok(r.order.indexOf("stop") > Math.max(r.order.indexOf("delivered:aa"), r.order.indexOf("delivered:cc")), "marked before the relay stops");
	assert.deepEqual(result.steer, { delivered: 2, pending: 0 }, "the ids are acted on, never handed on");
});

test("F3: an exit line that did not verify marks nothing, whatever ids it names", { skip }, async () => {
	const { prepared } = staged();
	const r = relays();
	const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: r.open, openJobLog: sinkSaying({ exitAuth: "unverified", steer: { delivered: 1, pending: 0, deliveredIds: [IDA] } }), mintExitKey: () => KEY, spawnFn: child({}) })({ job: STEER_JOB, prepared, name: "pi-job-s2", signal: new AbortController().signal, jobId: "s2", exitAuth: true, binds: true });
	assert.deepEqual(r.delivered, []);
	assert.equal(result.steer, undefined);
});

test("RC11: a stale inbox directory from an earlier attempt is emptied before the container sees it", { skip }, async () => {
	const { jobDir, prepared } = staged();
	const inboxDir = `${jobDir}.inbox`;
	mkdirSync(inboxDir);
	writeFileSync(join(inboxDir, `000001-${IDA}.json`), "{}");
	let seen = null;
	await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener(), openInboxRelay: relays().open, openJobLog: sinkSaying({}), spawnFn: child({}, { during: () => (seen = readdirSync(inboxDir)) }) })({ job: STEER_JOB, prepared, name: "pi-job-s3", signal: new AbortController().signal, jobId: "s3", exitAuth: true, binds: true });
	assert.deepEqual(seen, [], "no stale message reaches the new run");
});
