import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { entryExitCode } from "../src/cli.mjs";
import { startReceiver } from "../src/start.mjs";

// The committed unified triggers file, addressed absolutely so loadReceiverConfig's real fs reads
// succeed regardless of the test runner's cwd. Every side-effecting collaborator (gh, Valkey, socket) is
// injected, so this suite touches none of them.
const TRIGGERS_PATH = fileURLToPath(new URL("../../deploy/triggers.json", import.meta.url));
const SECRET = "shh";

function baseEnv(overrides = {}) {
	return { WEBHOOK_SECRET: SECRET, PI_TRIGGERS_FILE: TRIGGERS_PATH, ...overrides };
}

const okAuth = async () => ({ selfId: 12345, source: "gh" });
const throwingAuth = async () => {
	throw Object.assign(new Error("no identity"), { piDispatchConfig: true });
};
const stubQueue = () => ({ add: async () => {}, close: async () => {} });

/**
 * A gitlab-only triggers file, written to a real temp path because `startReceiver` owns its own
 * `loadReceiverConfig` call and reads the filesystem itself (only the network/socket collaborators are
 * injectable). This is the deployment shape that could not boot at all before issue #99: no github rules,
 * so no `/` endpoint, so no webhook secret to supply and no `gh` CLI to install.
 */
const GITLAB_ONLY_TRIGGERS_PATH = (() => {
	const dir = mkdtempSync(join(tmpdir(), "receiver-start-gitlab-only-"));
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "gitlab", flow: "gl-fix" } }] }), "utf8");
	return path;
})();

/** A gitlab-only env: the gitlab endpoint fully configured, and NOTHING naming github -- no secret, no source. */
function gitlabOnlyEnv(overrides = {}) {
	return {
		PI_TRIGGERS_FILE: GITLAB_ONLY_TRIGGERS_PATH,
		GITLAB_WEBHOOK_MODE: "token",
		GITLAB_WEBHOOK_SECRET: "gl-secret",
		GITLAB_TOKEN: "glpat-x",
		...overrides,
	};
}

/** The gitlab arm's injected collaborators, so the boot touches no GitLab instance. */
const gitlabFakes = {
	resolveGitLabSelfId: async () => 4242,
	makeResolveAuthority: () => async () => ({ authorized: true }),
};

/**
 * Run `fn` with `process.stdout.write` captured, returning the receiver's single-object log LINES parsed
 * back. `startReceiver` writes them itself (the sink is deliberately not injectable -- one line, one
 * object, one place), so capturing the stream is how a boot decision gets asserted.
 */
async function bootLogLines(fn) {
	const chunks = [];
	const real = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = real;
	}
	return chunks
		.join("")
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

/** A createServer fake that records the handler and the listen args and never opens a socket. */
function capturingServer() {
	const captured = {};
	const server = {
		listen: (port, bind, cb) => {
			captured.listen = { port, bind };
			cb?.();
			return server;
		},
		close: (cb) => cb?.(),
	};
	const createServer = (handler) => {
		captured.handler = handler;
		return server;
	};
	return { captured, createServer };
}

/** GitHub's `X-Hub-Signature-256` shape, computed the same way GitHub computes it. */
function sign(secret, raw) {
	return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

/** EventEmitter-backed request mock: real streams are EventEmitters, so `on`/`emit` come for free. */
function mockReq({ method = "POST", headers = {} } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = headers;
	req.destroyed = false;
	req.destroy = () => {
		req.destroyed = true;
	};
	return req;
}

/** Plain object response mock recording writeHead/statusCode/end -- no real socket. */
function mockRes() {
	return {
		statusCode: 0,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
			return this;
		},
		end(body) {
			this.body = body;
			return this;
		},
	};
}

/** Drive a handler: attach synchronously, then feed the raw bytes and await completion. */
async function drive(handler, req, res, raw) {
	const done = handler(req, res);
	if (raw !== undefined) {
		req.emit("data", Buffer.from(raw, "utf8"));
		req.emit("end");
	}
	await done;
}

function headersFor(event, delivery, raw) {
	return {
		"content-type": "application/json",
		"x-hub-signature-256": sign(SECRET, raw),
		"x-github-event": event,
		"x-github-delivery": delivery,
	};
}

test("HARD-FAIL: an unresolvable identity rejects and NO server is ever created", async () => {
	const { captured, createServer } = capturingServer();
	await assert.rejects(
		startReceiver(baseEnv(), { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer }),
		(e) => e.piDispatchConfig === true,
	);
	// The guard did not boot disarmed: without selfId neither the handler nor the listen happened.
	assert.equal(captured.handler, undefined, "the handler must never be built without selfId");
	assert.equal(captured.listen, undefined, "the receiver must never listen without the bot-loop guard");
});

test("happy path binds the configured host and port (defaults) and returns the server", async () => {
	const { captured, createServer } = capturingServer();
	const server = await startReceiver(baseEnv(), { makeAuth: okAuth, makeQueueFn: stubQueue, createServer });
	assert.equal(captured.listen.bind, "0.0.0.0");
	assert.equal(captured.listen.port, 3000);
	assert.ok(server, "startReceiver returns the server for tests and keep-alive");
});

test("RECEIVER_PORT/RECEIVER_BIND overrides reach listen", async () => {
	const { captured, createServer } = capturingServer();
	await startReceiver(baseEnv({ RECEIVER_PORT: "8080", RECEIVER_BIND: "127.0.0.1" }), {
		makeAuth: okAuth,
		makeQueueFn: stubQueue,
		createServer,
	});
	assert.equal(captured.listen.port, 8080);
	assert.equal(captured.listen.bind, "127.0.0.1");
});

test("the makeReceiver handler is wired to createServer and a signed delivery enqueues onto the stub queue", async () => {
	const { captured, createServer } = capturingServer();
	const adds = [];
	const queue = {
		add: async (name, data, opts) => {
			adds.push({ name, data, opts });
			return { id: opts?.jobId };
		},
		close: async () => {},
	};
	await startReceiver(baseEnv(), { makeAuth: okAuth, makeQueueFn: () => queue, createServer });
	assert.equal(typeof captured.handler, "function", "the makeReceiver handler was passed to createServer");

	// Drive a real signed issues.labeled through the wired handler; the triggers file maps pi:frontend.
	const payload = {
		action: "labeled",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	};
	const raw = JSON.stringify(payload);
	const req = mockReq({ headers: headersFor("issues", "d-wired", raw) });
	const res = mockRes();
	await drive(captured.handler, req, res, raw);

	assert.equal(res.statusCode, 202);
	assert.equal(adds.length, 1);
	assert.equal(adds[0].data.kind, "github");
	assert.equal(adds[0].data.flow, "frontend-fix");
});

// --- the github arm is conditional, like the other three (issue #99) -------------------------------
//
// Before this, `makeAuth(cfg.github)` ran unconditionally at boot while the gitlab/forgejo/azure arms were
// each gated on their own config. With GITHUB_AUTH_SOURCE defaulting to `gh`, that meant a GitLab-only
// deployment had to have the GitHub CLI installed and logged in -- and a WEBHOOK_SECRET for an endpoint it
// never served -- or it could not start. Both directions are pinned: skipped when github is not served,
// still a hard-fail boot gate when it is.

test("a gitlab-only deployment boots without ever calling makeAuth, and says so in one log line", async () => {
	const { captured, createServer } = capturingServer();
	// An auth fake that FAILS the test if it is reached, rather than one that returns a stub: the property is
	// "never called", and a stub would let a silent regression (github arm still resolving identity) pass.
	const forbiddenAuth = async () => assert.fail("makeAuth must not be called on a deployment that serves no github");

	const lines = await bootLogLines(async () => {
		const server = await startReceiver(gitlabOnlyEnv(), { makeAuth: forbiddenAuth, makeQueueFn: stubQueue, createServer, ...gitlabFakes });
		assert.ok(server, "the receiver boots and returns its server -- this deployment could not start at all before");
	});

	assert.equal(captured.listen.port, 3000, "it really listened, on the usual port");
	assert.equal(typeof captured.handler, "function");

	// The skip is EXPLICIT in the log, so an operator debugging "my label trigger does nothing" sees the
	// reason on the boot line instead of inferring it from an absent one.
	const skipped = lines.find((l) => l.event === "github_arm_skipped");
	assert.ok(skipped, `the skip must be logged; boot lines were: ${JSON.stringify(lines)}`);
	assert.match(skipped.reason, /github triggers/);
	assert.match(skipped.reason, /GITHUB_AUTH_SOURCE/, "the reason names both signals, which are the two ways out");
	assert.equal(lines.some((l) => l.event === "self_identity" && l.forge === undefined), false, "no github identity line, because no github identity was resolved");
	// The gitlab arm is untouched by any of this: its own identity resolution still ran, hard-fail as ever.
	assert.equal(lines.find((l) => l.event === "self_identity" && l.forge === "gitlab")?.id, 4242);
});

test("a github-serving deployment still HARD-FAILS when makeAuth throws -- no server, guard never disarmed", async () => {
	// The unchanged direction. `baseEnv()` reads the committed github triggers file, so servesGithub is true
	// and identity resolution is the boot gate it always was (the sibling test at the top of this file
	// asserts the same for the default env; this one states the coupling in servesGithub's terms).
	const { captured, createServer } = capturingServer();
	await assert.rejects(
		startReceiver(baseEnv(), { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer }),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(captured.handler, undefined, "the handler must never be built without selfId");
	assert.equal(captured.listen, undefined, "the receiver must never listen without the bot-loop guard");
});

test("an explicit GITHUB_AUTH_SOURCE re-arms the boot gate even with no github triggers", async () => {
	// Explicit intent wins in the loader, and this is what that costs: the endpoint exists, so identity
	// resolution is mandatory again and an unresolvable one is still a refusal to boot.
	const { captured, createServer } = capturingServer();
	const env = gitlabOnlyEnv({ WEBHOOK_SECRET: SECRET, GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_x" });
	await assert.rejects(
		startReceiver(env, { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer, ...gitlabFakes }),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(captured.listen, undefined, "an armed github endpoint with no identity must not listen");
});

test("a github-free deployment 404s `/` -- the skipped identity resolution and the absent route are one decision", async () => {
	// The coupling, end to end through the real wiring: `selfId` is undefined here, so a mounted `/` would
	// run the bot-loop guard comparing every sender against undefined. The route must therefore be gone, and
	// this asserts it through the handler startReceiver actually built rather than through makeReceiver alone.
	const { captured, createServer } = capturingServer();
	await bootLogLines(() =>
		startReceiver(gitlabOnlyEnv(), { makeAuth: async () => assert.fail("no github arm here"), makeQueueFn: stubQueue, createServer, ...gitlabFakes }),
	);

	const payload = JSON.stringify({ action: "labeled", sender: { id: 1 }, repository: { full_name: "octo/repo" }, issue: { number: 42, labels: [{ name: "pi:frontend" }] } });
	const req = mockReq({ headers: headersFor("issues", "d-nogithub", payload) });
	req.url = "/";
	const res = mockRes();
	await drive(captured.handler, req, res, payload);
	assert.equal(res.statusCode, 404, "not 401: an endpoint that answers is an endpoint an operator can believe is armed");
});

test("a config refusal exits 2, so a supervisor stops instead of restart-looping forever", () => {
	// The unit execs THIS file, not cli.mjs, so cli.mjs's entryExitCode -- and the reason it exists,
	// "a supervisor restarting on exit 2 would loop on a config that can never parse" -- never reached a
	// real deployment. Every receiver config error exited 1, and deploy/receiver.service pairs
	// Restart=on-failure with RestartSec=5 and (until #187) no RestartPreventExitStatus and no start
	// limit: an unbounded five-second loop, one JSON line per iteration, no failed-unit state to notice.
	//
	// Driven as a SUBPROCESS because an exit code is the whole assertion: the entry guard only runs when
	// this module is argv[1], which is exactly the path the unit takes and the path no in-process test
	// can reach. A refusal is answered before any socket or queue connection, so this costs no network.
	const dir = mkdtempSync(join(tmpdir(), "pi-recv-exit-"));
	const triggers = join(dir, "triggers.json");
	writeFileSync(triggers, JSON.stringify({ triggers: [{ on: { type: "label", any: ["x"] }, run: { kind: "gitlab", flow: "f", replicas: 99 } }] }));

	const r = spawnSync(process.execPath, [fileURLToPath(new URL("../src/start.mjs", import.meta.url))], {
		env: { PATH: process.env.PATH, PI_TRIGGERS_FILE: triggers, WEBHOOK_SECRET: "s" },
		encoding: "utf8",
	});

	assert.equal(r.status, 2, "a determinate config refusal is EXIT_POLICY, never the retryable 1");
	const line = JSON.parse(r.stderr.trim().split("\n").at(-1));
	assert.equal(line.event, "receiver_start_failed");
	assert.match(line.reason, /run\.replicas must be an integer/, "and the reason names the entry, not just the file");
});

test("the INFRA half of the mapping is untouched -- only a tagged config refusal becomes 2", () => {
	// The pair matters: mapping everything to 2 would stop a supervisor restarting a receiver whose Valkey
	// was merely down, which is exactly what Restart=on-failure exists for. Asserted against the pure
	// function rather than a second subprocess, because every infra failure a real boot could produce
	// (a dead queue, a bound port) is one where the process either RETRIES or serves -- there is no
	// infra path that exits promptly enough to spawn in a unit test without risking a hang.
	const config = Object.assign(new Error("bad triggers"), { piDispatchConfig: true });
	assert.equal(entryExitCode(config), 2);
	assert.equal(entryExitCode(new Error("ECONNREFUSED")), 1);
	assert.equal(entryExitCode(undefined), 1);
});
