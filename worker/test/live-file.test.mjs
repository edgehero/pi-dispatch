import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanup, makePrepareWorkspace } from "../src/prepare.mjs";
import { makeLiveTranscript, stageLiveFile } from "../src/live-transcript.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #643: the live transcript file every job now gets, and the publisher's wiring in runContainer. run-container
// imports env-allowlist -> @earendil-works/pi-ai, so those tests skip below the node floor, as run-container.test.mjs's do.
let rc;
let proc;
let importError;
try {
	rc = await import("../src/run-container.mjs");
	proc = await import("../src/processor.mjs");
} catch (error) {
	importError = error;
}
if (!rc && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`live-file tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = rc ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

const HOST = { ANTHROPIC_API_KEY: "sk-ant-live-file-test-key-0001" };
const JOB = { kind: "github", repo: "o/n", provider: "anthropic", model: "m", maxTurns: 5 };

/** The mounts of an argv, as `host -> container`, by `-v` adjacency (docker-run.mjs spells every mount that way). */
const mountsOf = (args) => args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));

/** A fake runtime child: runs `during(args)` (the container "working"), then closes with `code`. */
function fakeSpawn(rec, { code = 0, during = () => {} } = {}) {
	return (cmd, args) => {
		rec.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		setImmediate(async () => {
			await during(args);
			child.emit("close", code);
		});
		return child;
	};
}

/** A fake Valkey with the one transaction shape the publisher uses; `writes` holds every XADD's field list. */
function recordingRedis() {
	const redis = { writes: [], ttls: [], dels: 0 };
	redis.multi = () => {
		const ops = [];
		const tx = {
			del: () => (ops.push(() => (redis.dels += 1)), tx),
			xadd: (_key, ...rest) => (ops.push(() => redis.writes.push(rest.slice(4))), tx),
			pexpire: (_key, ms) => (ops.push(() => redis.ttls.push(ms)), tx),
			exec: async () => ops.map((op) => [null, op()]),
		};
		return tx;
	};
	return redis;
}

/** A pi session line, as the pinned pi writes it (session-manager.js `appendMessage`). */
const piLine = (message, at = "2026-10-16T10:00:00.000Z") => `${JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: at, message })}\n`;

// --- the file -----------------------------------------------------------------------------------------------

test("a non-resume job gets an empty live file in a 0700 session directory inside its job dir, and no session field (#643)", async () => {
	const jobsDir = tempDir("pi-live-jobs-");
	const prepareWorkspace = makePrepareWorkspace({ jobsDir, preparers: { github: async (_job, _token, { jobDir }) => ({ workspace: join(jobDir, "workspace"), jobDir }) } });
	const prepared = await prepareWorkspace(JOB, "tok");
	assert.equal(prepared.live.hostDir, join(prepared.jobDir, "session"), "the same directory a resume job's transcript is staged in");
	assert.equal(statSync(prepared.live.hostDir).mode & 0o777, 0o700);
	assert.equal(readFileSync(join(prepared.live.hostDir, "current.jsonl"), "utf8"), "", "empty, so pi writes its own header there");
	assert.equal("session" in prepared, false, "resume stays keyed on prepared.session, which a non-resume job never has");
	await cleanup(prepared);
	assert.equal(existsSync(prepared.jobDir), false, "and it goes with the job directory");
});

test("a resume job's staged transcript IS its live file: the preparer adds nothing beside it (#643)", async () => {
	const jobsDir = tempDir("pi-live-jobs-");
	let session;
	const prepareWorkspace = makePrepareWorkspace({
		jobsDir,
		preparers: {
			github: async (_job, _token, { jobDir }) => {
				session = { key: "k", hostDir: join(jobDir, "session"), resume: true, reason: "resumed", bytes: 3 };
				return { workspace: join(jobDir, "workspace"), jobDir, session };
			},
		},
	});
	const prepared = await prepareWorkspace({ ...JOB, resume: true }, "tok");
	assert.equal("live" in prepared, false, "no second file");
	assert.equal(prepared.session, session, "the session object is the preparer's own, untouched");
	assert.equal(existsSync(join(prepared.jobDir, "session")), false, "nothing staged by the live path (the fake preparer staged nothing)");
});

test("a refusal gets no live file, and a staging that fails is said and runs the job without one (#643)", async () => {
	const jobsDir = tempDir("pi-live-jobs-");
	const refused = await makePrepareWorkspace({ jobsDir, preparers: { github: async () => ({ outcome: "policy", reason: "sha-gone" }) } })(JOB, "tok");
	assert.deepEqual(refused, { outcome: "policy", reason: "sha-gone" });
	const logs = [];
	const prepared = await makePrepareWorkspace({ jobsDir, stageLive: () => null, log: (e, f) => logs.push([e, f]), preparers: { github: async (_j, _t, { jobDir }) => ({ workspace: jobDir, jobDir }) } })(JOB, "tok");
	assert.equal("live" in prepared, false);
	assert.deepEqual(logs, [["live_transcript_unstaged", { kind: "github" }]]);
	assert.equal(stageLiveFile(""), null);
	assert.equal(stageLiveFile(join(jobsDir, "missing", "\0bad")), null, "never throws");
});

// --- the mount and the variable -------------------------------------------------------------------------------

test("a non-resume job now mounts its live file at /session and gets PI_SESSION_FILE, on docker and rootless podman alike (#643)", { skip }, async () => {
	const { buildPodmanRunArgs } = await import("../src/docker-run.mjs");
	const { CONTAINER_HOME } = await import("../src/container-spec.mjs");
	const jobDir = "/host/jobs/j1";
	const live = { workspace: `${jobDir}/workspace`, jobDir, live: { hostDir: `${jobDir}/session` } };
	for (const podman of [false, true]) {
		const rec = {};
		const venue = podman ? { buildArgs: buildPodmanRunArgs, bin: "podman" } : {};
		const as = podman ? { user: "1000:1000", home: CONTAINER_HOME } : {};
		await rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec), ...venue })({ job: JOB, token: "ghs_x", prepared: live, name: "j1", signal: new AbortController().signal, ...as });
		if (podman) assert.ok(rec.args.includes("--userns=keep-id"), "the rootless podman argv");
		assert.ok(rec.args.includes("PI_SESSION_FILE=/session/current.jsonl"), "the runner is pointed at the file");
		const sessionMounts = mountsOf(rec.args).filter((m) => m.split(":")[1] === "/session");
		assert.equal(sessionMounts.length, 1);
		assert.ok(sessionMounts[0].startsWith(`${jobDir}/session:`), "CONST-ISOLATION-CONTAINER-PER-JOB: the mount is the job's own directory");
		for (const m of mountsOf(rec.args)) {
			const host = m.split(":")[0];
			assert.ok(host === jobDir || host.startsWith(`${jobDir}/`), `no mount outside the job dir: ${host}`);
		}
		assert.ok(!rec.args.some((a) => String(a).startsWith("PI_AWAIT_INPUT")), "parking stays keyed on a resume transcript");
	}
});

test("a resume job's argv is unchanged, and a caller that staged no file gets no mount at all (#643)", { skip }, async () => {
	const argvFor = async (prepared) => {
		const rec = {};
		await rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec) })({ job: JOB, prepared, name: "j1", signal: new AbortController().signal });
		return rec.args;
	};
	const session = { key: "k", hostDir: "/host/jobs/j1/session", resume: true, reason: "resumed" };
	const resumed = await argvFor({ workspace: "/w", jobDir: "/host/jobs/j1", session });
	const both = await argvFor({ workspace: "/w", jobDir: "/host/jobs/j1", session, live: { hostDir: "/elsewhere" } });
	assert.deepEqual(both, resumed, "the resume transcript wins: a stray live field cannot move a resume job's mount");
	const bare = await argvFor({ workspace: "/w", jobDir: "/host/jobs/j1" });
	assert.ok(!bare.some((a) => String(a).startsWith("PI_SESSION_FILE")));
	assert.ok(!mountsOf(bare).some((m) => m.includes(":/session")));
});

// --- the publisher's wiring -----------------------------------------------------------------------------------

test("runContainer opens the publisher with the file, the job id and a redactor, starts it at spawn and finishes it before the sink closes (#643)", { skip }, async () => {
	const order = [];
	const opened = [];
	const opener = (o) => {
		opened.push(o);
		return { start: () => order.push("start"), finish: async (outcome) => order.push(`finish:${outcome}`) };
	};
	const sink = { write() {}, close: async () => (order.push("sink-close"), { turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null }) };
	const run = (code, extra = {}) =>
		rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener, openJobLog: () => sink, spawnFn: fakeSpawn({}, { code, during: () => order.push("running") }) })({
			job: JOB,
			token: "ghs_minted_token_value_1234",
			prepared: { workspace: "/w", jobDir: "/host/jobs/j1", live: { hostDir: "/host/jobs/j1/session" } },
			name: "pi-job-42",
			signal: new AbortController().signal,
			jobId: "42",
			...extra,
		});
	await run(0);
	assert.deepEqual(order, ["start", "running", "finish:completed", "sink-close"]);
	assert.equal(opened[0].file, "/host/jobs/j1/session/current.jsonl");
	assert.equal(opened[0].jobId, "42");
	assert.equal(opened[0].redact("token ghs_minted_token_value_1234 and key sk-ant-live-file-test-key-0001"), "token [redacted] and key [redacted]", "built from this job's own credentials");
	for (const [code, outcome] of [[2, "policy"], [1, "failed"], [137, "unknown"]]) {
		order.length = 0;
		await run(code);
		assert.deepEqual(order, ["start", "running", `finish:${outcome}`, "sink-close"]);
	}
	opened.length = 0;
	await run(0, { jobId: null });
	assert.equal(opened.length, 0, "no job id, no stream");
	await rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener, spawnFn: fakeSpawn({}) })({ job: JOB, prepared: { workspace: "/w", jobDir: "/j" }, name: "n", signal: new AbortController().signal, jobId: "43" });
	assert.equal(opened.length, 0, "no staged file, no stream");
});

test("an opener or a publisher that throws, and a Valkey that refuses every write, never fail or hold the run (#643)", { skip }, async () => {
	const prepared = { workspace: "/w", jobDir: "/host/jobs/j1", live: { hostDir: "/host/jobs/j1/session" } };
	const go = (openLiveTranscript) => rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript, spawnFn: fakeSpawn({}) })({ job: JOB, prepared, name: "n", signal: new AbortController().signal, jobId: "7" });
	assert.equal((await go(() => {
		throw new Error("boom");
	})).code, 0);
	assert.equal((await go(() => ({ start() {
		throw new Error("start");
	}, finish: async () => {
		throw new Error("finish");
	} }))).code, 0);
	const down = { multi: () => ({ del() {
		return this;
	}, xadd() {
		return this;
	}, pexpire() {
		return this;
	}, exec: () => Promise.reject(new Error("connection is closed")) }) };
	const hung = { multi: () => ({ del() {
		return this;
	}, xadd() {
		return this;
	}, pexpire() {
		return this;
	}, exec: () => new Promise(() => {}) }) };
	for (const redis of [down, hung]) {
		const began = Date.now();
		const r = await go((o) => makeLiveTranscript({ ...o, redis, pollMs: 60_000, now: () => 0, timeoutMs: 50, finishTimeoutMs: 200 }));
		assert.equal(r.code, 0);
		assert.ok(Date.now() - began < 2_000, "bounded, whatever Valkey does");
	}
});

test("the transcript's last lines are published BEFORE the processor's cleanup removes the file (#643)", { skip }, async () => {
	const jobsDir = tempDir("pi-live-jobs-");
	const redis = recordingRedis();
	let jobDirSeen = null;
	const prepareWorkspace = makePrepareWorkspace({ jobsDir, preparers: { github: async (_j, _t, { jobDir }) => ((jobDirSeen = jobDir), { workspace: join(jobDir, "workspace"), jobDir }) } });
	const runContainer = rc.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		// A poll far longer than the run: only `finish`'s final read can see what the container wrote.
		openLiveTranscript: (o) => makeLiveTranscript({ ...o, redis, pollMs: 60_000, now: () => Date.parse("2026-10-16T10:00:00.000Z") }),
		spawnFn: fakeSpawn({}, {
			during: (args) => {
				const host = mountsOf(args).find((m) => m.split(":")[1] === "/session").split(":")[0];
				appendFileSync(join(host, "current.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-16T10:00:00.000Z", cwd: "/workspace" })}\n`);
				appendFileSync(join(host, "current.jsonl"), piLine({ role: "assistant", content: [{ type: "text", text: "the very last words" }] }));
			},
		}),
	});
	const signal = new AbortController().signal;
	const result = await proc.runJob(JOB, {
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null },
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace,
		runContainer: (ctx) => runContainer({ ...ctx, name: "pi-job-9", signal, jobId: "9" }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup,
		comment: async () => {},
		now: new Date("2026-07-16T10:00:00Z"),
	});
	assert.equal(result.outcome, "completed");
	assert.equal(existsSync(jobDirSeen), false, "the cleanup ran and the file is gone");
	const kinds = redis.writes.map((f) => f[1]);
	assert.deepEqual(kinds, ["note", "assistant", "end"], "header, the last line, then the end marker");
	assert.equal(redis.writes[1][redis.writes[1].indexOf("text") + 1], "the very last words");
	assert.equal(redis.writes[2][redis.writes[2].indexOf("outcome") + 1], "completed");
});

// --- the record ---------------------------------------------------------------------------------------------

test("a non-resume job's run result is byte-identical with the live file: its session reads disabled, as before (#643)", { skip }, async () => {
	const base = {
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null },
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async () => {},
		now: new Date("2026-07-16T10:00:00Z"),
	};
	// Before the feature: no file, and the runner said `disabled`. With it: the live file, and the runner says `absent`.
	const before = await proc.runJob(JOB, { ...base, prepareWorkspace: async () => ({ workspace: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: false, turns: 2, tokens: null, session: { resumed: false, reason: "disabled" } }) });
	const after = await proc.runJob(JOB, { ...base, prepareWorkspace: async () => ({ workspace: "/w", jobDir: "/j", live: { hostDir: "/j/session" } }), runContainer: async () => ({ code: 0, aborted: false, turns: 2, tokens: null, session: { resumed: false, reason: "absent" } }) });
	assert.equal(JSON.stringify(after), JSON.stringify(before));
	assert.deepEqual(after.session, { resumed: false, reason: "disabled", bytes: null });
	// Narrow: without the live file, an `absent` is carried as it always was.
	const bare = await proc.runJob(JOB, { ...base, prepareWorkspace: async () => ({ workspace: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: false, turns: 2, tokens: null, session: { resumed: false, reason: "absent" } }) });
	assert.equal(bare.session.reason, "absent");
});

test("with publishing off (stageLive null) a non-resume job stages no live file and runs as before the feature (#643)", async () => {
	const jobsDir = tempDir("pi-live-off-");
	const prepareWorkspace = makePrepareWorkspace({ jobsDir, stageLive: null, preparers: { github: async (_job, _token, { jobDir }) => ({ workspace: join(jobDir, "workspace"), jobDir }) } });
	const prepared = await prepareWorkspace(JOB, "tok");
	assert.equal("live" in prepared, false, "no live file, so no /session mount and no PI_SESSION_FILE");
	assert.equal(existsSync(join(prepared.jobDir, "session")), false);
	await cleanup(prepared);
});

// --- review round -----------------------------------------------------------------------------------------------

test("a never-started exit ends the stream failed, as a spawn error does: the container never ran (#643)", { skip }, async () => {
	assert.equal(rc.liveOutcomeOf(125, false, [125, 126, 127]), "failed");
	assert.equal(rc.liveOutcomeOf(127, false, [125, 126, 127]), "failed");
	assert.equal(rc.liveOutcomeOf(125, false, []), "unknown", "only what this runtime spells never-started");
	assert.equal(rc.liveOutcomeOf(137, false, [125, 126, 127]), "unknown");
	assert.equal(rc.liveOutcomeOf(125, true, [125, 126, 127]), "policy", "a worker stop outranks it");
	const finished = [];
	const opener = () => ({ start() {}, finish: async (o) => void finished.push(o) });
	const prepared = { workspace: "/w", jobDir: "/host/jobs/j1", live: { hostDir: "/host/jobs/j1/session" } };
	// No cidfile: the detached check answers "not detached" and the run's own exit stands.
	const noCid = {
		readFileSync: () => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
		rmSync() {},
	};
	await rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener, neverStartedExits: [125, 126, 127], fs: noCid, spawnFn: fakeSpawn({}, { code: 125 }) })({ job: JOB, prepared, name: "n", signal: new AbortController().signal, jobId: "8" });
	assert.deepEqual(finished, ["failed"], "the close path hands the venue's never-started list");
	// The spawn error path: the runtime binary could not run at all.
	const erroring = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		setImmediate(() => child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })));
		return child;
	};
	finished.length = 0;
	await assert.rejects(rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, openLiveTranscript: opener, spawnFn: erroring })({ job: JOB, prepared, name: "n", signal: new AbortController().signal, jobId: "9" }), (e) => e.reason === "container-never-started");
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(finished, ["failed"]);
});

test("the redactor runContainer builds: a forwarded proxy URL with a password is redacted, the worker's own egress proxy is not (#643)", { skip }, async () => {
	const opened = [];
	const opener = (o) => (opened.push(o), { start() {}, finish: async () => {} });
	const prepared = { workspace: "/w", jobDir: "/host/jobs/j1", live: { hostDir: "/host/jobs/j1/session" } };
	const forwarded = "http://bob:Hunter2Proxy@corp-proxy.example:3128";
	// The minted token in a shape no rule knows: only the value list built here can catch it.
	const minted = "plainMintedValue-0001";
	await rc.makeRunContainer({ image: "pi-job:x", hostEnv: { ...HOST, HTTPS_PROXY: forwarded }, forwardEnv: ["HTTPS_PROXY"], openLiveTranscript: opener, spawnFn: fakeSpawn({}) })({ job: JOB, token: minted, prepared, name: "n", signal: new AbortController().signal, jobId: "p1" });
	assert.equal(opened[0].redact(`t=${minted}`), "t=[redacted]", "the minted token, by value");
	assert.equal(opened[0].redact(`proxy ${forwarded}`), "proxy [redacted]", "PI_EGRESS=0 and forwarded: secret");
	assert.equal(opened[0].redact(`p=${encodeURIComponent(forwarded)}`), "p=[redacted]");
	// Armed: the worker's own proxy URL stays readable. A spawn that answers every network step with 0.
	const { egressProxyUrl, DEFAULT_EGRESS_PROXY } = await import("../src/egress.mjs");
	const own = egressProxyUrl(DEFAULT_EGRESS_PROXY);
	await rc.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, egress: true, openLiveTranscript: opener, spawnFn: fakeSpawn({}) })({ job: JOB, prepared, name: "n", signal: new AbortController().signal, jobId: "p2" });
	assert.equal(opened[1].redact(`via ${own}`), `via ${own}`);
});

test("mergeSession maps only the live file's {resumed:false, reason:\"absent\"}: another reason is carried as it is (#643)", { skip }, async () => {
	const base = {
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null },
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async () => {},
		now: new Date("2026-07-16T10:00:00Z"),
		prepareWorkspace: async () => ({ workspace: "/w", jobDir: "/j", live: { hostDir: "/j/session" } }),
	};
	for (const session of [{ resumed: false, reason: "corrupt" }, { resumed: true, reason: "resumed" }]) {
		const r = await proc.runJob(JOB, { ...base, runContainer: async () => ({ code: 0, aborted: false, turns: 2, tokens: null, session }) });
		assert.equal(r.session.reason, session.reason, session.reason);
	}
});
