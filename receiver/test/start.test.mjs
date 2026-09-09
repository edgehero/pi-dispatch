import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { entryExitCode } from "../src/cli.mjs";
import { resolveGitLabSelfId } from "@edgehero/pi-dispatch/gitlab-identity";
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
// The collector is INJECTED into the code under test, never installed over `process.stdout.write`.
// `node --test` runs each file in a child process that serialises its own results over that same stdout,
// so a helper holding a replacement across an `await` swallows the runner's result frames -- three tests
// in `worker/test/start-wiring.test.mjs` were reported as never existing at all, exit code 0 (issue #266).
async function bootLogLines(fn) {
	const chunks = [];
	const write = (chunk) => (chunks.push(String(chunk)), true);
	await fn(write);
	return chunks
		.join("")
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

/**
 * `startReceiver` with the watch closer drained before returning. Since issue #301 EVERY boot arms the
 * triggers watch -- including here, where `baseEnv` points `PI_TRIGGERS_FILE` at the repo's own
 * `deploy/triggers.json` -- so a call that does not drain leaves a real FSWatcher on a repo directory for
 * the life of the test process. Draining immediately is safe for everything this file asserts: the
 * handler and the server outlive the closer, only the watch dies. The tests that assert on the watch
 * itself pass their own `closers` and close by hand.
 */
async function startReceiverClosed(env, deps) {
	const closers = [];
	try {
		return await startReceiver(env, { ...deps, closers });
	} finally {
		for (const c of closers) c.close();
	}
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
	const closers = [];
	await assert.rejects(
		startReceiver(baseEnv(), { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer, closers }),
		(e) => e.piDispatchConfig === true,
	);
	// The guard did not boot disarmed: without selfId neither the handler nor the listen happened.
	assert.equal(captured.handler, undefined, "the handler must never be built without selfId");
	assert.equal(captured.listen, undefined, "the receiver must never listen without the bot-loop guard");
	// And the watch never armed (issue #301): `closers.push(watchTriggers(...))` is deliberately the LAST
	// fallible step in the boot, so a refusal can never leave a closer with no one to drain it. This call
	// bypasses the draining helper on purpose -- an empty array is the assertion, and a helper that
	// drains would make it true by cleanup instead of by placement.
	assert.equal(closers.length, 0, "a refused boot must arm NOTHING: whatever sat here would be an FSWatcher no teardown reaches");
});

test("happy path binds the configured host and port (defaults) and returns the server", async () => {
	const { captured, createServer } = capturingServer();
	const server = await startReceiverClosed(baseEnv(), { makeAuth: okAuth, makeQueueFn: stubQueue, createServer });
	assert.equal(captured.listen.bind, "0.0.0.0");
	assert.equal(captured.listen.port, 3000);
	assert.ok(server, "startReceiver returns the server for tests and keep-alive");
});

test("RECEIVER_PORT/RECEIVER_BIND overrides reach listen", async () => {
	const { captured, createServer } = capturingServer();
	await startReceiverClosed(baseEnv({ RECEIVER_PORT: "8080", RECEIVER_BIND: "127.0.0.1" }), {
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
	await startReceiverClosed(baseEnv(), { makeAuth: okAuth, makeQueueFn: () => queue, createServer });
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

	const lines = await bootLogLines(async (write) => {
		const server = await startReceiverClosed(gitlabOnlyEnv(), { write, makeAuth: forbiddenAuth, makeQueueFn: stubQueue, createServer, ...gitlabFakes });
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
		startReceiverClosed(baseEnv(), { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer }),
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
		startReceiverClosed(env, { makeAuth: throwingAuth, makeQueueFn: stubQueue, createServer, ...gitlabFakes }),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(captured.listen, undefined, "an armed github endpoint with no identity must not listen");
});

test("a github-free deployment 404s `/` -- the skipped identity resolution and the absent route are one decision", async () => {
	// The coupling, end to end through the real wiring: `selfId` is undefined here, so a mounted `/` would
	// run the bot-loop guard comparing every sender against undefined. The route must therefore be gone, and
	// this asserts it through the handler startReceiver actually built rather than through makeReceiver alone.
	const { captured, createServer } = capturingServer();
	await bootLogLines((write) =>
		startReceiverClosed(gitlabOnlyEnv(), { write, makeAuth: async () => assert.fail("no github arm here"), makeQueueFn: stubQueue, createServer, ...gitlabFakes }),
	);

	const payload = JSON.stringify({ action: "labeled", sender: { id: 1 }, repository: { full_name: "octo/repo" }, issue: { number: 42, labels: [{ name: "pi:frontend" }] } });
	const req = mockReq({ headers: headersFor("issues", "d-nogithub", payload) });
	req.url = "/";
	const res = mockRes();
	await drive(captured.handler, req, res, payload);
	assert.equal(res.statusCode, 404, "not 401: an endpoint that answers is an endpoint an operator can believe is armed");
});

test("the github closer resolver is built over the boot auth object's OWN mintToken and reaches the wired handler", async () => {
	// The wiring claim of issue #231, end to end through startReceiver: the SAME auth object that
	// hard-fail resolved selfId is what the closer resolver mints through -- identity and mint capability
	// are one credential decision, which is exactly why the receiver-side missing-resolver 503 is
	// unreachable in a wired receiver. The factory is injected (the DI convention every resolver build in
	// start.mjs follows) and handed a minter; the test proves that minter is the boot auth object's, by
	// watching the mint land there when a signed close delivery drives the handler startReceiver built.
	const dir = mkdtempSync(join(tmpdir(), "receiver-start-close-"));
	const triggersPath = join(dir, "triggers.json");
	writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "issue", action: ["closed"], number: 40 }, run: { kind: "github", flow: "deploy" } }] }), "utf8");

	const { captured, createServer } = capturingServer();
	const mints = [];
	const auth = { selfId: 12345, source: "pat", mintToken: async (job) => (mints.push(job), "ghs_x") };
	const adds = [];
	const queue = { add: async (name, data, opts) => (adds.push({ name, data, opts }), { id: opts?.jobId }), close: async () => {} };
	const makeResolveGitHubAuthority = ({ mintToken }) =>
		async (repo, login) => {
			// The resolver the factory hands back mints through what it was given; a wiring that built it
			// over anything but auth.mintToken leaves `mints` empty and fails below.
			const token = await mintToken({ repo });
			assert.equal(token, "ghs_x", "the token is the boot auth object's answer");
			assert.equal(login, "closer-login", "the subset's sender.login reaches the resolver");
			return { authorized: true };
		};

	await bootLogLines((write) =>
		startReceiverClosed({ WEBHOOK_SECRET: SECRET, PI_TRIGGERS_FILE: triggersPath }, { write, makeAuth: async () => auth, makeQueueFn: () => queue, createServer, makeResolveGitHubAuthority }),
	);

	const payload = JSON.stringify({
		action: "closed",
		sender: { id: 7, login: "closer-login" },
		repository: { full_name: "octo/repo" },
		issue: { number: 40, title: "T", body: "B" },
	});
	const res = mockRes();
	await drive(captured.handler, mockReq({ headers: headersFor("issues", "d-close-wired", payload) }), res, payload);

	assert.equal(res.statusCode, 202, "the close one-shot fired through the wired resolver");
	assert.deepEqual(mints, [{ repo: "octo/repo", permissions: { metadata: "read" } }], "one mint, job-shaped, repo-scoped AND narrowed to metadata:read -- the lookup token must not be able to write");
	assert.equal(adds.length, 1);
	assert.equal(adds[0].data.flow, "deploy");
	assert.deepEqual(adds[0].data.trigger.sender, { id: 7 }, "the login served the lookup and never entered the job");
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

test("a TRANSIENT identity failure at boot exits 1, so the supervisor brings the receiver back", async () => {
	// Issue #316, and this is the consequence that made it urgent rather than latent. Identity resolution
	// here is hard-fail by design, and every failure used to be tagged: a forge restarting, answering 502,
	// or refusing a connection during the seconds the receiver booted therefore produced EXIT_POLICY, which
	// deploy/receiver.service's RestartPreventExitStatus=2 deliberately leaves STOPPED. Nothing redelivers
	// a webhook to a process that is not listening, so the first signal was a human noticing that nothing
	// had run.
	//
	// Asserted through the pure resolver plus the pure mapping rather than a second subprocess: the two
	// halves are what a real boot composes, and neither needs a socket to be true.
	const transient = [
		["the instance refused the connection", async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:443"); }],
		["the instance answered 502 mid-restart", async () => ({ ok: false, status: 502, headers: new Headers() })],
		["a proxy returned something that is not JSON", async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error("bad json"); } })],
	];
	for (const [name, fetchFn] of transient) {
		const err = await resolveGitLabSelfId({ apiUrl: "https://gl.internal", token: "glpat-x", fetchFn }).then(
			() => null,
			(e) => e,
		);
		assert.ok(err, `${name} must still fail closed -- an unresolved id disarms the bot-loop guard`);
		assert.equal(err.piDispatchConfig, undefined, `${name} is not a misconfiguration`);
		assert.equal(entryExitCode(err), 1, `${name} must exit 1, which Restart=on-failure brings back`);
	}

	// And the bound, in the same shape: the cases an operator really does have to fix still stop the
	// service, because restarting into an untrusted CA or a scope-less token only hides the message.
	const determinate = [
		["a private CA the host does not trust", async () => { throw new TypeError("fetch failed", { cause: new Error("unable to verify the first certificate") }); }],
		["a token that is not authorized", async () => ({ ok: false, status: 401, headers: new Headers() })],
	];
	for (const [name, fetchFn] of determinate) {
		const err = await resolveGitLabSelfId({ apiUrl: "https://gl.internal", token: "glpat-x", fetchFn }).then(
			() => null,
			(e) => e,
		);
		assert.equal(err?.piDispatchConfig, true, `${name} is the operator's to fix`);
		assert.equal(entryExitCode(err), 2, `${name} must stay stopped rather than restart-loop`);
	}
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

test("the triggers watch ARMS under test, and a shut-down watch writes NOTHING (issue #301)", async () => {
	// The pre-#301 shape muted this defect instead of closing it: the watch was armed only when
	// `createServer === http.createServer`, so under injection it never existed, nothing could leak, and
	// nothing could prove the arming line fires either. This is the receiver's copy of the worker's
	// "the live-edit watchers are CLOSED with the worker that armed them", with one difference worth
	// knowing when reading the assertions: `reloadTriggers` is SYNCHRONOUS, so the receiver has no
	// in-flight-reload window -- the closer's silence here comes from the closed FSWatcher and the
	// cancelled debounce, and `reloadLog`'s own gate is pinned by the worker's unit test.
	const dir = mkdtempSync(join(tmpdir(), "receiver-watch-close-"));
	const triggersPath = join(dir, "triggers.json");
	writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:x"] }, run: { kind: "gitlab", flow: "gl-f" } }] }));

	// ONE chunks array for the whole test, sliced rather than re-captured: the receiver holds the `write`
	// it booted with, so a second collector would prove silence vacuously by listening on the wrong wire.
	const chunks = [];
	const write = (chunk) => (chunks.push(String(chunk)), true);
	const parse = (from) => chunks.slice(from).join("").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

	const { captured, createServer } = capturingServer();
	const closers = [];
	await startReceiver(
		{ PI_TRIGGERS_FILE: triggersPath, GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "gl-secret", GITLAB_TOKEN: "glpat-x" },
		{ write, makeQueueFn: stubQueue, createServer, closers, ...gitlabFakes },
	);
	assert.ok(captured.handler, "booted");
	assert.ok(parse(0).some((l) => l.event === "triggers_watching"), "the canary must ARM the watch it claims to close");
	assert.equal(closers.length, 1, "the watch closer rides the injected closers array, the worker's extraClosers shape");

	// Before the close, the watch is REAL: an edit lands as a reload. This is the arming coverage the old
	// entry-point guard deleted, and it is also what keeps the silence assertion below honest -- the same
	// write on the same wire, first observed loud, then observed quiet.
	const beforeEdit = chunks.length;
	writeFileSync(triggersPath, `${JSON.stringify({ triggers: [] })}\n`);
	// POLLED, not slept: the reload's arrival depends on fs.watch delivery latency plus the 150ms
	// debounce, and a fixed wait is a fuse on a loaded runner. The silence half below keeps its fixed
	// window, because "nothing arrives" has no event to poll for.
	const deadline = Date.now() + 5000;
	while (!parse(beforeEdit).some((l) => l.event === "triggers_reloaded") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(parse(beforeEdit).some((l) => l.event === "triggers_reloaded"), "a live watch reloads, or this test is asserting silence from a watch that never worked");

	for (const c of closers) c.close();

	const afterClose = chunks.length;
	writeFileSync(triggersPath, `${JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:y"] }, run: { kind: "gitlab", flow: "gl-g" } }] })}\n`);
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.deepEqual(parse(afterClose), [], "a shut-down receiver's watch must write NOTHING: whatever lands here would land in a later test's capture");
});

test("the real shutdown drains the closers before it exits (source pin)", () => {
	// The shutdown lives behind `createServer === http.createServer` and ends in `process.exit(0)`, so no
	// in-process test can drive it without registering process-wide signal handlers -- the exact leak the
	// guard exists to prevent. Pinned against the source instead, the `wiring.test.mjs` SIGBREAK
	// precedent: the drain must sit between the router close and the exit, or a real stop leaks the watch
	// the boot armed.
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const routerClose = src.indexOf("await router.close();");
	const drain = src.indexOf("for (const c of closers)");
	const exit = src.indexOf("process.exit(0);");
	assert.ok(routerClose > 0 && drain > 0 && exit > 0, "the three anchors must exist");
	assert.ok(routerClose < drain && drain < exit, "the closer drain runs after the handles close and before the exit");
	assert.match(src, /closers\.push\(watchTriggers\(/, "the watch closer must be REGISTERED, not merely returned");
	// The RETAINED handle is the whole of issue #301: `watch(dir, cb).unref?.()` kept nothing, so nothing
	// could ever close it. The behavioural test above cannot see this -- with the handle discarded, the
	// `closed` flag still delivers silence and every assertion stays green while the FSWatcher leaks -- so
	// the retention is pinned here, where the mutation has nowhere to hide.
	assert.match(src, /handles\.watcher = watch\(/, "the FSWatcher must be RETAINED on the handles bag the closer tears down");
});

// --- the transient-boot bound moves in-process (issue #318) ----------------------------------------
//
// #316 made a transient identity failure exit 1 so the supervisor restarts through a forge outage; the
// shipped unit then bounded that recovery at ~25 seconds while launchd and nssm bounded it not at all.
// These tests pin the replacement: the boot itself retries TRANSIENT identity failures inside
// RECEIVER_IDENTITY_RETRY_SECONDS, per arm, with the determinate path exactly as fast as before.

test("a TRANSIENT github identity failure at boot retries in-process, then serves (issue #318)", async () => {
	const { captured, createServer } = capturingServer();
	let calls = 0;
	const flakyAuth = async () => {
		calls++;
		if (calls < 3) throw new Error(`connect ECONNREFUSED 10.0.0.5:443 (attempt ${calls})`);
		return { selfId: 12345, source: "gh" };
	};
	let t = 0;
	const sleeps = [];
	const lines = await bootLogLines((write) =>
		startReceiverClosed(baseEnv(), {
			write,
			makeAuth: flakyAuth,
			makeQueueFn: stubQueue,
			createServer,
			now: () => t,
			sleep: async (ms) => {
				sleeps.push(ms);
				t += ms;
			},
		}),
	);
	assert.equal(calls, 3, "two transient failures, then the forge came back");
	assert.deepEqual(sleeps, [5_000, 10_000], "the documented gaps: RestartSec's 5s first, then doubling");
	assert.ok(captured.listen, "and the boot SERVED -- before #318 this deployment was on its way to a failed unit");
	const retries = lines.filter((l) => l.event === "identity_retry");
	assert.equal(retries.length, 2);
	assert.ok(retries.every((l) => l.forge === "github"), "the line names the arm that is retrying");
});

test("a tagged identity refusal never sleeps: the determinate path stays same-tick (issue #318)", async () => {
	// The sibling of the HARD-FAIL test at the top of this file, with the retry seams armed to explode:
	// retrying a misconfiguration only hides the message, and the subprocess exit-2 test in this file
	// stays sub-second only while this property holds.
	const { captured, createServer } = capturingServer();
	const closers = [];
	await assert.rejects(
		startReceiver(baseEnv(), {
			makeAuth: throwingAuth,
			makeQueueFn: stubQueue,
			createServer,
			closers,
			sleep: async () => assert.fail("a tagged refusal must never sleep"),
		}),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(captured.handler, undefined);
	assert.equal(captured.listen, undefined);
	assert.equal(closers.length, 0);
});

test("the retry wraps EACH arm: a gitlab retry re-resolves gitlab alone and rebuilds nothing (issue #318)", async () => {
	// The whole-boot alternative was rejected because every attempt would rebuild the queue and the
	// router (two live connections leaked per retry) and re-run arms that already answered. This pins the
	// grain: one github resolution, one queue build, two gitlab attempts -- and the operator-visible
	// order, where github's outcome still lands before gitlab's first failure.
	const dir = mkdtempSync(join(tmpdir(), "receiver-retry-arms-"));
	const triggersPath = join(dir, "triggers.json");
	writeFileSync(
		triggersPath,
		JSON.stringify({
			triggers: [
				{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "gh-f" } },
				{ on: { type: "label", any: ["pi:y"] }, run: { kind: "gitlab", flow: "gl-f" } },
			],
		}),
		"utf8",
	);
	const env = { WEBHOOK_SECRET: SECRET, PI_TRIGGERS_FILE: triggersPath, GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "gl-secret", GITLAB_TOKEN: "glpat-x" };

	const { captured, createServer } = capturingServer();
	let authCalls = 0;
	let queueBuilds = 0;
	let gitlabCalls = 0;
	let t = 0;
	const sleeps = [];
	const lines = await bootLogLines((write) =>
		startReceiverClosed(env, {
			write,
			makeAuth: async () => (authCalls++, { selfId: 12345, source: "gh" }),
			makeQueueFn: (...args) => (queueBuilds++, stubQueue(...args)),
			createServer,
			resolveGitLabSelfId: async () => {
				gitlabCalls++;
				if (gitlabCalls === 1) throw new Error("502 mid-restart");
				return 4242;
			},
			makeResolveAuthority: () => async () => ({ authorized: true }),
			now: () => t,
			sleep: async (ms) => {
				sleeps.push(ms);
				t += ms;
			},
		}),
	);
	assert.equal(authCalls, 1, "the github arm resolved ONCE: a whole-boot retry would re-run it per attempt");
	assert.equal(queueBuilds, 1, "the queue was built ONCE: a whole-boot retry would leak a connection per attempt");
	assert.equal(gitlabCalls, 2);
	assert.deepEqual(sleeps, [5_000]);
	const githubIdentityAt = lines.findIndex((l) => l.event === "self_identity" && l.forge === undefined);
	const gitlabRetryAt = lines.findIndex((l) => l.event === "identity_retry" && l.forge === "gitlab");
	assert.ok(githubIdentityAt >= 0 && gitlabRetryAt >= 0, "both lines must exist for the order to mean anything");
	assert.ok(githubIdentityAt < gitlabRetryAt, "arms resolve in declaration order: hoisting them above the queue would reorder the first failure an operator sees");
	assert.ok(captured.listen, "and the boot served");
});

test("an exhausted window is still a refusal that arms NOTHING, and it maps to exit 1 (issue #318)", async () => {
	// The HARD-FAIL test's arm-last pin (`closers.length === 0`), extended to the refusal path this
	// change ADDED: a boot that spent its whole window must leave exactly as clean as one that refused
	// on its first tick, and its throw must stay untagged so the supervisor restarts into a fresh window.
	const { captured, createServer } = capturingServer();
	const closers = [];
	let t = 0;
	const sleeps = [];
	let err = null;
	const lines = await bootLogLines((write) =>
		startReceiver(baseEnv({ RECEIVER_IDENTITY_RETRY_SECONDS: "60" }), {
			write,
			makeAuth: async () => {
				throw new Error("connect ECONNREFUSED 10.0.0.5:443");
			},
			makeQueueFn: stubQueue,
			createServer,
			closers,
			now: () => t,
			sleep: async (ms) => {
				sleeps.push(ms);
				t += ms;
			},
		}).then(
			() => assert.fail("a forge that never answers must not produce a serving receiver"),
			(e) => (err = e),
		),
	);
	assert.ok(err);
	assert.equal(err.piDispatchConfig, undefined, "an exhausted transient window is still not a misconfiguration");
	assert.equal(entryExitCode(err), 1, "exit 1: the supervisor restarts into a FRESH window, so the default bounds one cycle, not recovery");
	assert.deepEqual(sleeps, [5_000, 10_000, 20_000], "the floored 60s window admits exactly three gaps before the fourth would cross");
	assert.equal(captured.handler, undefined);
	assert.equal(captured.listen, undefined);
	assert.equal(closers.length, 0, "the arm-last invariant covers the NEW refusal path too");
	assert.equal(lines.at(-1)?.event, "identity_retry_exhausted", "the give-up is loud, with the window on the line");
});

test("every identity arm rides retryIdentity, and no bare identity await remains (source pin, issue #318)", () => {
	// Cheaper than building forgejo/azure boot fixtures, and it kills the mutation the behavioural tests
	// cannot see: ONE arm quietly unwrapped, its three siblings still green.
	const startSrc = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const pollerSrc = readFileSync(new URL("../src/poller.mjs", import.meta.url), "utf8");
	assert.equal(startSrc.match(/await retryIdentity\(/g)?.length, 4, "all four serve arms retry: github, gitlab, forgejo, azure");
	assert.ok(/await retryIdentity\(/.test(pollerSrc), "the poller's boot gate retries too -- a pure-polling deployment loses work to a stopped process just as surely");
	assert.ok(!/await makeAuth\(/.test(startSrc), "the bare github await must stay gone");
	assert.ok(!/await resolveSelfIdFn\(/.test(startSrc), "the bare gitlab await must stay gone");
	assert.ok(!/await resolveForgejoSelfIdFn\(/.test(startSrc), "the bare forgejo await must stay gone");
	assert.ok(!/await resolveAzureSelfIdFn\(/.test(startSrc), "the bare azure await must stay gone");
});
