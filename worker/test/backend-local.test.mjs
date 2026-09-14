import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKEND_FUNCTIONS, DOCKER_ENDPOINT_ARGS, JOB_NAME_PREFIX, classifyDockerEndpoint, classifyEndpointFailure, execDockerBounded, jobContainerName, makeDockerEndpointResolver, makeLocalBackend, makeReaper, makeStopContainer, parseDockerEndpoint } from "../src/backend-local.mjs";
import { BACKENDS, DEFAULT_BACKEND } from "../src/backends.mjs";

const fns = () => ({ runContainer: async () => ({}), imagePreflight: async () => ({}), egressPreflight: async () => ({}), stopContainer: async () => {}, reap: async () => ({ reaped: true }) });

test("container-spec.mjs is a LEAF -- it imports nothing", () => {
	// Not in backends.test.mjs because it is a different module's property, and it is load-bearing from the
	// moment `packages.mjs` started importing CONTAINER_GLOBAL_PI_DIR from here: that comment's whole claim
	// is "this costs no cycle and no weight in the admin's bundle". docker-run.mjs, where the constant used
	// to live, has now GAINED an import, which is exactly the drift this pins against next time.
	const src = readFileSync(new URL("../src/container-spec.mjs", import.meta.url), "utf8");
	assert.equal(/^import\s/m.test(src), false, "container-spec.mjs must import nothing");
	assert.equal(/require\(/.test(src), false);
});

test("the namespace is one fact, and the producer builds names from it", () => {
	// Two boot sweeps in start.mjs match this as a SUBSTRING. A rename that landed in the producer and not
	// in the sweeps would leave every crashed worker's containers behind forever with both suites green.
	assert.equal(JOB_NAME_PREFIX, "pi-job-");
	assert.equal(jobContainerName("abc123"), "pi-job-abc123");
	assert.ok(jobContainerName("x").startsWith(JOB_NAME_PREFIX));
	// The sandbox names itself OUTSIDE this namespace on purpose, so a worker restart cannot tear down a
	// shell an operator is sitting in. A prefix that became a prefix of the sandbox's would silently break
	// that, and it is the one relationship between the two strings that matters.
	assert.equal("pi-sandbox-job1".startsWith(JOB_NAME_PREFIX), false);
});

test("a complete bundle carries the table's declaration, not its own", () => {
	const b = makeLocalBackend(fns());
	assert.equal(b.name, DEFAULT_BACKEND);
	assert.equal(b.declares, BACKENDS.local.declares, "read from the table, so it cannot drift from it");
	assert.equal(b.namePrefix, JOB_NAME_PREFIX);
	assert.equal(b.containerName("j"), "pi-job-j");
});

test("the declaration a bundle hands out cannot be rewritten through the bundle", () => {
	// The alias is deliberate and safe only because the table is frozen. Unfrozen, this assignment would
	// change what doctor, the boot refusal and the receiver are all told, process-wide and invisibly.
	const b = makeLocalBackend(fns());
	assert.throws(() => {
		b.declares.egress = "absent";
	}, TypeError);
	assert.equal(BACKENDS.local.declares.egress, "enforced");
});

test("an incomplete bundle is REFUSED, and the refusal names what is missing", () => {
	// A wiring mistake that would otherwise surface as `undefined is not a function` deep inside a paid job.
	for (const key of BACKEND_FUNCTIONS) {
		const parts = fns();
		delete parts[key];
		assert.throws(() => makeLocalBackend(parts), new RegExp(`missing ${key}`), key);
	}
	assert.throws(() => makeLocalBackend({}), /missing runContainer, imagePreflight, egressPreflight, stopContainer, reap/);
	assert.throws(() => makeLocalBackend(), /missing runContainer/, "no argument at all is the same refusal, not a TypeError");
	assert.throws(() => makeLocalBackend(null), /missing runContainer/);
});

test("a non-callable member is refused even though the key is present", () => {
	for (const bad of ["hello", 42, null, {}, { call() {} }, [], true]) {
		const parts = { ...fns(), egressPreflight: bad };
		assert.throws(() => makeLocalBackend(parts), /missing egressPreflight/, JSON.stringify(bad));
	}
});

test("the two once-deferred members are now REQUIRED, and an unknown one is still refused", () => {
	// An earlier slice refused `stopContainer` and `reap` BY NAME, because accepting and dropping them
	// would leave an adapter author believing a runaway job could be stopped through their backend while
	// the abort path still called docker directly. The seam is real now, so they are required rather than
	// refused -- and a bundle missing either is refused for the reason every member is.
	assert.ok(BACKEND_FUNCTIONS.includes("stopContainer") && BACKEND_FUNCTIONS.includes("reap"));
	assert.doesNotThrow(() => makeLocalBackend(fns()));
	assert.throws(() => makeLocalBackend({ ...fns(), nonsense: 1 }), /unknown bundle member "nonsense"/);
});

test("the bundle carries the abort path and the boot sweep, which used to be unreachable from it", () => {
	// `stopContainer` was a literal inside index.mjs's createWorker and `reap` lived in start.mjs, so the
	// only two functions that can end a runaway job or clear a crashed worker's strays were the two a
	// second backend could never provide. That is why `abortable` was declared in the table before this.
	const b = makeLocalBackend(fns());
	assert.equal(typeof b.stopContainer, "function");
	assert.equal(typeof b.reap, "function");
});

test("the completeness check proves ARITY and is not credited with more", () => {
	// The comment used to claim it prevented a silently-absent egress gate. It cannot: an unarmed
	// makeEgressPreflight returns a function answering {ok:true} that spawns nothing, so a stub passes.
	// Pinned so the overclaim cannot come back in a later edit.
	const stub = makeLocalBackend({ ...fns(), egressPreflight: async () => ({ ok: true }) });
	assert.equal(typeof stub.egressPreflight, "function", "a gate that does no gating passes this check");
});

test("dockerExtra cannot carry a flag that would supersede the isolation boundary", async () => {
	// `dockerExtra` lands AFTER ISOLATION_FLAGS and docker resolves a repeated option last-wins, so
	// `--privileged` supersedes `--cap-drop=ALL` while every member of the array is still present in the
	// argv. The two standing assertions test MEMBERSHIP, and membership is not effectiveness -- so without
	// this guard `isolation: enforced` would be a claim about an argv that had no boundary left.
	const { DOCKER_EXTRA_FORBIDDEN, buildDockerRunArgs } = await import("../src/docker-run.mjs");
	const base = { image: "i", name: "n", workspace: "/w" };
	// IMPORTED, never re-typed: a hand-written parallel list is the two-literals drift that JOB_NAME_PREFIX
	// and CONTAINER_GLOBAL_PI_DIR are exported to avoid, and it would leave a new entry untested in silence.
	assert.ok(DOCKER_EXTRA_FORBIDDEN.length >= 20);
	for (const flag of DOCKER_EXTRA_FORBIDDEN) {
		// Bare, and as `--flag=value`, because docker accepts both spellings and `--rm=false` is the whole
		// reason `--rm` is on the list at all.
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [flag] }), /supersede the isolation boundary/, flag);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [`${flag}=x`] }), /supersede the isolation boundary/, `${flag}=x`);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: ["-i", flag, "v"] }), /supersede the isolation boundary/, `mid-array ${flag}`);
	}
	// The four the re-verification proved supersede a real flag, named so a future edit cannot drop them.
	for (const flag of ["--rm", "--init", "--shm-size", "--name"]) {
		assert.ok(DOCKER_EXTRA_FORBIDDEN.includes(flag), `${flag} must stay denied`);
	}
	// A non-string is REFUSED, not skipped: skipping still pushed the value into the argv, so anything that
	// stringifies to a flag reached docker as that flag.
	for (const bad of [new String("--privileged"), { toString: () => "--privileged" }, 1, null]) {
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [bad] }), /must contain only strings/);
	}
	// What the sandbox actually passes stays allowed, or this guard would break the one caller there is.
	const ok = buildDockerRunArgs({ ...base, extraFlags: ["-i", "-t", "--entrypoint", "bash", "-p", "127.0.0.1:3000:3000"] });
	assert.ok(ok.includes("--entrypoint") && ok.includes("-p"));
	// And `--user` stays allowed on purpose: it is the documented Linux-only uid:gid for a bind-mounted
	// local folder, it changes which uid runs rather than what that uid may do, and the property it bears
	// on -- nonRoot -- is declared `asserted` already. Denying it would break local-folder jobs to make a
	// word honest that is already honest. docker-run.test.mjs pins the feature itself.
	assert.ok(buildDockerRunArgs({ ...base, extraFlags: ["--user", "1000:1000"] }).includes("--user"));
});

// --- which daemon the docker CLI resolves (issue #278) ---------------------------------------------------------

test("an endpoint is LOCAL only when its form shows it, and credentials in it are never displayed", () => {
	const local = ["unix:///var/run/docker.sock", "unix:///Users/x/.docker/run/docker.sock", "npipe:////./pipe/docker_engine", "npipe:////./pipe/dockerDesktopLinuxEngine", "npipe://./pipe/docker_engine", "tcp://127.0.0.1:2375", "tcp://127.255.0.9:2376", "tcp://localhost:2375", "tcp://[::1]:2375"];
	const notLocal = ["tcp://10.1.2.3:2375", "tcp://127.0.0.1.nip.io:2375", "tcp://localhost.evil.com:2375", "tcp://128.0.0.1:2375", "tcp://127.0.0.256:2375", "ssh://remote", "ssh://localhost", "ssh://bob@127.0.0.1", "npipe:////remotebox/pipe/docker_engine", "fd://", "http://localhost:2375", "", null, undefined, "garbage"];
	// Leading zeros make a NAME to Go's parser, which the CLI then sends through HTTP_PROXY when one is set.
	notLocal.push("tcp://127.0.0.09:2375", "tcp://127.000.000.001:2375", "tcp://0127.0.0.1:2375");
	// The `.` server followed by UNC is another host's share, not this machine's pipe namespace; and a `..` that
	// Windows would resolve could climb back out of `pipe`.
	notLocal.push("npipe:////./UNC/remotebox/pipe/docker_engine", "npipe:////./pipe/../UNC/remotebox/pipe/x", "npipe:////./pipe/./x", "npipe:////./pipe");
	// Case matters: Go treats only lowercase `localhost` as never-proxied (measured: `LOCALHOST` went through HTTP_PROXY).
	notLocal.push("tcp://LOCALHOST:2375");
	for (const h of local) assert.equal(classifyDockerEndpoint(h).local, true, h);
	for (const h of notLocal) assert.equal(classifyDockerEndpoint(h).local, false, String(h));
	assert.equal(classifyDockerEndpoint("ssh://bob:hunter2@remote:22").display, "ssh://remote:22");
	assert.equal(classifyDockerEndpoint("tcp://user@10.1.2.3:2375").display, "tcp://10.1.2.3:2375");
	assert.equal(classifyDockerEndpoint("tcp://user:p@ss@10.1.2.3:2375").display, "tcp://10.1.2.3:2375", "a password holding an @ is removed whole");
	assert.equal(classifyDockerEndpoint("unix:///run/user@1000/docker.sock").display, "unix:///run/user@1000/docker.sock", "an @ in a path is not userinfo");
	assert.equal(classifyDockerEndpoint("ssh://bob:s3cr/et@remote").display, "ssh://remote", "a password holding a / is removed whole, though the URL does not parse");
	assert.equal(classifyDockerEndpoint("ssh://bob:pa?ss@remote").display, "ssh://remote", "and one holding a ?");
	assert.equal(classifyDockerEndpoint("ssh://bob:pa#ss@remote").display, "ssh://remote", "and one holding a #");
	// A URL that PARSES keeps an `@` in its path: only the userinfo the parser found goes.
	assert.equal(classifyDockerEndpoint("ssh://bob@remote/p@x").display, "ssh://remote/p@x");
	// An `@` after `?` or `#` is not userinfo, and the display must name the host the CLI dials, not the one after it.
	assert.equal(classifyDockerEndpoint("tcp://10.1.2.3:2375?@localhost").display, "tcp://10.1.2.3:2375?@localhost");
	assert.deepEqual(classifyDockerEndpoint("tcp://127.0.0.1:2375#frag@10.1.2.3"), { local: true, display: "tcp://127.0.0.1:2375#frag@10.1.2.3" });
});

test("the CLI's answer is read from the last line that parses, so a warning ahead of it is not mistaken for it", () => {
	assert.deepEqual(parseDockerEndpoint('"desktop-linux"|"unix:///x.sock"\n'), { context: "desktop-linux", host: "unix:///x.sock" });
	assert.deepEqual(parseDockerEndpoint('WARNING: DOCKER_HOST overrides the context\n"default"|"tcp://10.1.2.3:2375"\n'), { context: "default", host: "tcp://10.1.2.3:2375" });
	assert.equal(parseDockerEndpoint(""), null);
	assert.equal(parseDockerEndpoint("context not found: /Users/x/.docker/contexts/meta/..."), null);
	assert.equal(parseDockerEndpoint('"a"|null'), null);
	assert.deepEqual([...DOCKER_ENDPOINT_ARGS], ["context", "inspect", "--format={{json .Name}}|{{json .Endpoints.docker.Host}}"], "never {{json .}}, which carries TLS paths");
});

test("a failed resolve names a fixed reason, and only a failure retrying can change is transient", () => {
	assert.deepEqual(classifyEndpointFailure({ error: { code: "ENOENT" } }), { reason: "docker-not-found", transient: false });
	assert.deepEqual(classifyEndpointFailure({ error: { timedOut: true } }), { reason: "timeout", transient: true });
	assert.deepEqual(classifyEndpointFailure({ error: { killed: true } }), { reason: "timeout", transient: true });
	assert.deepEqual(classifyEndpointFailure({ error: { signal: "SIGSEGV" } }), { reason: "signal-sigsegv", transient: true }, "only the timer's kill is a timeout");
	assert.deepEqual(classifyEndpointFailure({ error: { code: "EAGAIN" } }), { reason: "spawn-eagain", transient: true });
	assert.deepEqual(classifyEndpointFailure({ error: { code: "EMFILE" } }), { reason: "spawn-emfile", transient: true });
	assert.deepEqual(classifyEndpointFailure({ error: { code: "ENOTDIR" } }), { reason: "spawn-enotdir", transient: false });
	// A non-zero exit is the CLI's own answer and determinate (DES-TRANSIENT-VERSUS-DETERMINATE-IS-ONE-RULE's `gh`
	// precedent): no table of its stderr prose, which is not even handed over.
	assert.deepEqual(classifyEndpointFailure({ error: { code: 1 } }), { reason: "exit-1", transient: false });
	assert.deepEqual(classifyEndpointFailure({ code: 1 }), { reason: "exit-1", transient: false });
	assert.deepEqual(classifyEndpointFailure({}), { reason: "unparseable", transient: false });
});

test("the resolver asks the CLI with the narrow format and reports local, redirected and unanswered", async () => {
	const seen = [];
	const answer = (result) => makeDockerEndpointResolver({ run: async (args) => (seen.push(args), result) })();
	assert.deepEqual(await answer({ code: 0, stdout: '"desktop-linux"|"unix:///x.sock"\n' }), { local: true, context: "desktop-linux", endpoint: "unix:///x.sock", reason: null, transient: false });
	assert.deepEqual(await answer({ code: 0, stdout: '"default"|"ssh://bob@remote"\n' }), { local: false, context: "default", endpoint: "ssh://remote", reason: null, transient: false });
	assert.deepEqual(await answer({ code: 1, stdout: "", error: { code: 1 } }), { local: null, context: null, endpoint: null, reason: "exit-1", transient: false });
	assert.equal((await answer({ code: 1, stdout: '"a"|"unix:///x.sock"\n', error: { code: 1 } })).local, null, "an answer on a failed exit is not credited");
	assert.deepEqual(await answer({ code: 0, stdout: "nonsense" }), { local: null, context: null, endpoint: null, reason: "unparseable", transient: false });
	const thrown = await makeDockerEndpointResolver({ run: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } })();
	assert.equal(thrown.reason, "docker-not-found");
	assert.deepEqual(seen[0], DOCKER_ENDPOINT_ARGS);
});

test("the bounded runner passes NO env, and settles on its own timer when the CLI never answers", async () => {
	let opts = null;
	let killed = null;
	const hanging = (cmd, args, o) => {
		opts = o;
		return { kill: (sig) => (killed = sig), stdout: { destroy() {} }, stderr: { destroy() {} } };
	};
	const started = Date.now();
	const result = await execDockerBounded(["context", "inspect"], { timeoutMs: 50, execFileFn: hanging });
	assert.ok(Date.now() - started < 2000, "the promise settled although the child never called back");
	assert.deepEqual(result.error, { timedOut: true });
	assert.equal(killed, "SIGKILL");
	assert.equal(Object.hasOwn(opts, "env"), false, "the job's docker run inherits this process's env, so the read must too");

	const ok = await execDockerBounded(["x"], { execFileFn: (c, a, o, cb) => (queueMicrotask(() => cb(null, '"a"|"unix:///s"', "")), {}) });
	assert.deepEqual(ok, { code: 0, stdout: '"a"|"unix:///s"', error: null });
	const exit = await execDockerBounded(["x"], { execFileFn: (c, a, o, cb) => (queueMicrotask(() => cb(Object.assign(new Error("exit"), { code: 1 }), "", "parse \"ssh://bob:pa?ss@remote\": invalid port")), {}) });
	assert.equal(exit.code, 1);
	assert.equal(Object.hasOwn(exit, "stderr"), false, "stderr repeats an unparseable DOCKER_HOST with its credentials, and is not handed on");
});
