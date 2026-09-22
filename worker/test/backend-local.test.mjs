import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKEND_FUNCTIONS, DOCKER_ENDPOINT_ARGS, JOB_NAME_PREFIX, classifyDockerEndpoint, classifyEndpointFailure, endpointShown, execDockerBounded, isJobNamespace, jobContainerName, makeDockerEndpointResolver, makeLocalBackend, makeReaper, makeStopContainer, parseDockerEndpoint } from "../src/backend-local.mjs";
import { BACKENDS, DEFAULT_BACKEND } from "../src/backends.mjs";
import { networkNameFor } from "../src/egress.mjs";

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
	// `--user` is REFUSED here since issue #341: the job user is the spec's `user` field, validated non-root, and a
	// repeat in dockerExtra would win last and could name uid 0. (An earlier comment here called `--user` "the
	// documented Linux-only uid:gid"; nothing documented or passed it.) docker-run.test.mjs pins the field.
	for (const flag of ["--user", "-u"]) assert.ok(DOCKER_EXTRA_FORBIDDEN.includes(flag), `${flag} must stay denied`);
	assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: ["--user", "1000:1000"] }), /supersede the isolation boundary/);
});

// --- which daemon the docker CLI resolves (issue #278) ---------------------------------------------------------

test("an endpoint is LOCAL only when its form shows it, and credentials in it are never displayed", () => {
	const local = ["unix:///var/run/docker.sock", "unix:///Users/x/.docker/run/docker.sock", "npipe:////./pipe/docker_engine", "npipe:////./pipe/dockerDesktopLinuxEngine", "npipe://./pipe/docker_engine", "tcp://127.0.0.1:2375", "tcp://127.255.0.9:2376", "tcp://localhost:2375", "tcp://[::1]:2375"];
	const notLocal = ["tcp://10.1.2.3:2375", "tcp://127.0.0.1.nip.io:2375", "tcp://localhost.evil.com:2375", "tcp://128.0.0.1:2375", "tcp://127.0.0.256:2375", "ssh://remote", "ssh://localhost", "ssh://bob@127.0.0.1", "npipe:////remotebox/pipe/docker_engine", "fd://", "http://localhost:2375", "", null, undefined, "garbage"];
	// Leading zeros make a NAME to Go's parser, which the CLI then sends through HTTP_PROXY when one is set.
	notLocal.push("tcp://127.0.0.09:2375", "tcp://127.000.000.001:2375", "tcp://0127.0.0.1:2375");
	// The `.` server followed by UNC is another host's share, not this machine's pipe namespace; and a `..` that
	// Windows would resolve could climb back out of `pipe`.
	notLocal.push("npipe:////./UNC/remotebox/pipe/docker_engine", "npipe:////./pipe/../UNC/remotebox/pipe/x", "npipe:////./pipe/./x", "npipe:////./pipe", "npipe:////./pipe/..\\UNC\\remotebox\\share", "npipe:////./pipe/x\\..\\..\\UNC\\remotebox");
	// Case matters: Go treats only lowercase `localhost` as never-proxied (measured: `LOCALHOST` went through HTTP_PROXY).
	notLocal.push("tcp://LOCALHOST:2375");
	for (const h of local) assert.equal(classifyDockerEndpoint(h).local, true, h);
	for (const h of notLocal) assert.equal(classifyDockerEndpoint(h).local, false, String(h));
	// With an `@` present the value is REDUCED, never edited. The rule is one fact about URLs: userinfo ends at
	// an `@`, so exactly ONE `@`, INSIDE the raw authority, means everything after it is host and port under
	// every parse. Anything else is withheld (issue #340).
	const hidden = "ssh://(credentials not shown)";
	for (const h of ["ssh://bob:s3cr/et@remote", "ssh://bob:pa?ss@remote", "ssh://bob:pa#ss@remote", "ssh://bob:p@ss?word@remote", "ssh://bob:p@ss#word@remote", "ssh://bob:p@ss/word@remote", "ssh://bob:pa?ss\n@remote", "ssh://bob:pa?s@s@remote"]) {
		assert.equal(classifyDockerEndpoint(h).display, hidden, JSON.stringify(h));
	}
	// The three shapes `new URL` got wrong, which is what this rule replaced: it computes an authority of its own
	// and takes the LAST `@` in it, so each of these displayed part of the password.
	assert.equal(classifyDockerEndpoint("ssh://bob:@secret/word@remote").display, hidden, "`bob:` reads as no password to URL and the host became `secret`");
	assert.equal(classifyDockerEndpoint("ssh://bob:4455/qzx@remote").display, hidden, "leading digits of a password parsed as a port");
	assert.equal(classifyDockerEndpoint("ssh://bob:4455?qzx@remote").display, hidden, "and again with a query");
	assert.equal(classifyDockerEndpoint("ssh://a@b@c").display, hidden, "two `@` means the userinfo boundary is not knowable");
	assert.equal(classifyDockerEndpoint("tcp://user:p@ss@10.1.2.3:2375").display, "tcp://(credentials not shown)");
	assert.equal(classifyDockerEndpoint("bob:pw@remote").display, "(credentials not shown)", "a username is not named as if it were a scheme");
	// A host IS shown whenever the rule can prove it is one, and that is WIDER than before on purpose. The old
	// comment claimed the CLI refuses to dial every withheld form; measured, it dials both of these.
	assert.equal(classifyDockerEndpoint("ssh://bob:hunter2@remote:22").display, "ssh://remote:22", "a password is not a reason to withhold the host it precedes");
	assert.deepEqual(classifyDockerEndpoint("tcp://bob:hunter2@127.0.0.1:2375"), { local: true, display: "tcp://127.0.0.1:2375" }, "and this one the CLI really dials");
	assert.equal(classifyDockerEndpoint("ssh://bob@[fe80::1%25en0]:22").display, "ssh://[fe80::1%25en0]:22", "an IPv6 zone id `URL` rejects, which the CLI runs as `ssh -- fe80::1%en0`");
	assert.equal(classifyDockerEndpoint("ssh://bob:@remote").display, "ssh://remote", "an empty password is no password");
	assert.equal(classifyDockerEndpoint("ssh://bob@remote:2222").display, "ssh://remote:2222");
	assert.equal(classifyDockerEndpoint("tcp://user@10.1.2.3:2375").display, "tcp://10.1.2.3:2375");
	// An `@` OUTSIDE the authority is withheld, not read as a host: which side of it is userinfo is exactly what
	// cannot be decided, and the previous rule decided it wrongly.
	assert.equal(classifyDockerEndpoint("ssh://bob@remote/p@x").display, hidden, "two `@`, one of them in the path");
	assert.equal(classifyDockerEndpoint("tcp://10.1.2.3:2375?@localhost").display, "tcp://(credentials not shown)");
	assert.deepEqual(classifyDockerEndpoint("tcp://127.0.0.1:2375#frag@10.1.2.3"), { local: true, display: "tcp://(credentials not shown)" }, "and `local` does not move with the display");
	// Paths: an `@` is a filename character there, and verbatim is right -- three call sites read this form AS
	// the socket path. One with an AUTHORITY is a userinfo position no socket needs, and both shapes below
	// leaked before #340: the first displayed verbatim, the second an INVENTED path that job-user.mjs stat'ed.
	assert.equal(classifyDockerEndpoint("unix:///run/user@1000/docker.sock").display, "unix:///run/user@1000/docker.sock", "an @ in a path is not userinfo");
	assert.equal(classifyDockerEndpoint("unix://bob:p/w@/x.sock").display, "unix://(credentials not shown)", "a unix URL with an authority is withheld, not passed through");
	assert.equal(classifyDockerEndpoint("unix://bob@/var/run/docker.sock").display, "unix://(credentials not shown)", "and never reduced to a path it does not name");
	assert.equal(classifyDockerEndpoint("tcp://10.1.2.3:2375").display, "tcp://10.1.2.3:2375", "no @, nothing touched");
	// The two missing regression bolts (#340): a no-`@` value with a PATH stays whole, and a local pipe with a
	// leading backslash stays local. Both behave correctly already; neither was pinned, so either could be
	// undone silently.
	assert.equal(classifyDockerEndpoint("tcp://10.1.2.3:2375/base").display, "tcp://10.1.2.3:2375/base", "no @ means the early return, path and all");
	assert.deepEqual(classifyDockerEndpoint("npipe://\\\\.\\pipe\\docker_engine"), { local: true, display: "npipe://\\\\.\\pipe\\docker_engine" }, "a leading-backslash pipe is local and untouched");
	// `\` is deliberately NOT an authority terminator, and this is what that costs if it becomes one: Go's
	// `url.Parse`, which the CLI uses, ends an authority at the first `/` only, so these are userinfo to it.
	// Adding `\` to the terminator set makes the authority read as EMPTY and the value pass through whole,
	// which displays the password. Measured; the docblock asserted it and nothing held it.
	assert.equal(classifyDockerEndpoint("npipe://\\\\host\\pipe:pw@x").display, "npipe://(credentials not shown)", "a backslash does not end an authority");
	assert.equal(classifyDockerEndpoint("unix://\\\\srv\\x@y").display, "unix://(credentials not shown)", "nor here");
});

test("no password body can put any of itself into the display (#340)", () => {
	// The belt to the table's braces, and the property IS the rule: the answer is the withheld token or the
	// host, never anything in between. Exhaustive over a hostile alphabet at lengths 1 to 3 rather than random,
	// so it is deterministic. A 600,000-value random fuzz of the same property leaked 120,712 times against the
	// `new URL` rule this replaced and zero against this one.
	const alphabet = [..."abz09:@/?#.%[]-_\\"];
	const bodies = [];
	for (const a of alphabet) {
		bodies.push(a);
		for (const b of alphabet) {
			bodies.push(a + b);
			for (const c of alphabet) bodies.push(a + b + c);
		}
	}
	for (const scheme of ["ssh", "tcp"]) {
		const ok = new Set([`${scheme}://(credentials not shown)`, `${scheme}://remote`]);
		for (const body of bodies) {
			const shown = classifyDockerEndpoint(`${scheme}://bob:${body}@remote`).display;
			assert.ok(ok.has(shown), `${scheme} ${JSON.stringify(body)} -> ${JSON.stringify(shown)}`);
		}
	}
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
	assert.deepEqual(classifyEndpointFailure({ error: Object.assign(new Error("Command failed: docker context inspect\nopen /x/meta.json: permission denied"), { code: 1 }) }), { reason: "exit-1", transient: false }, "the message, which carries stderr, is not read either");
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
	assert.equal(Object.hasOwn(exit, "stderr"), false, "stderr repeats an unparseable DOCKER_HOST with its credentials, and is not handed on as its own field");
});

// --- makeReaper's network half (issue #357) ----------------------------------------------------------
//
// The first direct tests this function has ever had: before #357 it was imported here and never called,
// so nothing pinned the `docker ps` filter, the `network ls` filter, `reaped_container`, `reaped_network`
// or the bare `catch {}` the sweep used to hide a leak behind.
//
// The fake MODELS THE DAEMON rather than replaying a script, because the behaviour under test is a
// conversation with it: `network rm` REJECTS while a network still has endpoints, exactly as docker does
// (measured on 27.4.0), and `network disconnect` empties one. A replayed script would pass whatever order
// the code used.
function fakeDockerExec({ containers = [], nets = {}, fail = {} } = {}) {
	const calls = [];
	const state = new Map(Object.entries(nets).map(([n, members]) => [n, [...members]]));
	// `promisify(execFile)` puts the CLI's stderr on the Error's own MESSAGE, not only on `.stderr`, and that
	// is the channel issue #339 is about: a fake that carried it only on `.stderr` made every test here blind
	// to the one line that logs `err.message`.
	const reject = (code, stderr) => Promise.reject(Object.assign(new Error(`Command failed: docker\n${stderr}`), { code, stdout: "", stderr }));
	const exec = async (_cmd, args) => {
		calls.push(args.join(" "));
		const key = args.slice(0, 2).join(" ");
		if (fail[key]) return reject(1, fail[key]);
		if (key === "ps --filter") return { stdout: containers.join("\n"), stderr: "" };
		if (key === "rm -f") return { stdout: "", stderr: "" };
		if (key === "network ls") return { stdout: [...state.keys()].join("\n"), stderr: "" };
		if (key === "network inspect") {
			const net = args.at(-1);
			if (!state.has(net)) return reject(1, `Error response from daemon: network ${net} not found`);
			if (!args.includes("--format")) return { stdout: "[]", stderr: "" };
			const members = state.get(net);
			return { stdout: JSON.stringify(Object.fromEntries(members.map((m, i) => [`id${i}`, { Name: m }]))), stderr: "" };
		}
		if (key === "network disconnect") {
			const [net, endpoint] = args.slice(-2);
			state.set(net, (state.get(net) ?? []).filter((m) => m !== endpoint));
			return { stdout: "", stderr: "" };
		}
		if (key === "network rm") {
			const net = args.at(-1);
			if (!state.has(net)) return reject(1, `Error response from daemon: network ${net} not found`);
			if ((state.get(net) ?? []).length > 0) return reject(1, `Error response from daemon: error while removing network: network ${net} has active endpoints`);
			state.delete(net);
			return { stdout: net, stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};
	return { exec, calls, state };
}

const reaperLog = () => {
	const lines = [];
	return { log: (event, fields) => lines.push([event, fields]), lines };
};

test("the boot reaper detaches what a dead job's network still holds, this worker's own proxy included, then removes it (#357)", async () => {
	// The measured case: kill -9 the worker mid-job with PI_EGRESS=1 and restart. The container is reaped,
	// but nothing detached the long-lived proxy, so `network rm` failed and the old `catch {}` ate it.
	const { exec, calls, state } = fakeDockerExec({ nets: { "pi-job-a-net": ["pi-dispatch-egress-proxy"] } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: true });
	assert.deepEqual(lines, [["reaped_network", { network: "pi-job-a-net", detached: ["pi-dispatch-egress-proxy"] }]]);
	assert.equal(state.has("pi-job-a-net"), false, "the network is gone");
	const net = calls.filter((c) => c.startsWith("network "));
	assert.deepEqual(net, [
		"network ls --filter name=pi-job- --format {{.Name}}",
		"network inspect --format {{json .Containers}} pi-job-a-net",
		"network disconnect -f pi-job-a-net pi-dispatch-egress-proxy",
		"network rm pi-job-a-net",
	], "inspect FIRST, then detach what it saw, then rm");
	assert.ok(!calls.some((c) => c.includes("network rm") && c.includes("-f")), "never `network rm -f`");
});

test("a job network a job container is still on is LEFT ALONE, and said (#357)", async () => {
	// Detaching here would sever a live job's only route out: it keeps running, spends its slot and dies at
	// its first turn. Worse than the network it would have cleaned up.
	const { exec, calls, state } = fakeDockerExec({ nets: { "pi-job-b-net": ["pi-job-b", "pi-dispatch-egress-proxy"] } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: true });
	assert.deepEqual(lines.map((l) => l[0]), ["network_not_reaped"]);
	assert.deepEqual(lines[0][1], { network: "pi-job-b-net", reason: "job-container-attached" });
	assert.ok(!calls.some((c) => c.startsWith("network disconnect")), "nothing is detached from a live job's network");
	assert.ok(state.has("pi-job-b-net"), "and the network stays");
});

test("a network that will not go is a line naming it, never silence (#357)", async () => {
	// The defect this closes: the failure had nowhere to go, so the network survived every later boot with
	// nothing in the log to say so.
	const { exec } = fakeDockerExec({ nets: { "pi-job-c-net": [] }, fail: { "network rm": "Cannot connect to the Docker daemon" } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: true });
	assert.deepEqual(lines, [["network_not_reaped", { network: "pi-job-c-net", reason: "rm-failed", detached: [] }]]);
});

test("a network the daemon says is not there is not a line at all (#357)", async () => {
	// The one silence this sweep allows, and only in the daemon's own words for a NETWORK.
	const { exec } = fakeDockerExec({ nets: { "pi-job-d-net": [] } });
	const { log, lines } = reaperLog();
	// `network ls` listed it, then it vanished before the inspect: the race a best-effort sweep must not shout about.
	const racing = async (cmd, args) => (args.slice(0, 2).join(" ") === "network inspect" ? Promise.reject(Object.assign(new Error("x"), { code: 1, stdout: "", stderr: "Error response from daemon: network pi-job-d-net not found" })) : exec(cmd, args));
	assert.deepEqual(await makeReaper({ log, exec: racing })(), { reaped: true });
	assert.deepEqual(lines, []);
});

test("a PER-NETWORK fault never flips the tri-state a scope claim is spent on (#357)", async () => {
	// `makeScopeClaimSweeper` may only delete a claim naming this host once the host has established it holds
	// no containers. An inspect, a disconnect or an rm that fails is not evidence about containers, so none of
	// them may reach the outer catch.
	const { exec } = fakeDockerExec({ containers: ["pi-job-e"], nets: { "pi-job-e-net": ["x"] }, fail: { "network inspect": "boom", "network disconnect": "boom", "network rm": "boom" } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: true }, "containers WERE enumerated");
	assert.ok(!lines.some((l) => l[0] === "reaper_skipped"), "a network fault is not a skipped reaper");
});

test("a failing `network ls` DOES still answer {reaped:false}, and that is deliberate (#357)", async () => {
	// The boundary of the test above, pinned so the claim beside `step` cannot quietly widen: the listing runs
	// on the THROWING exec, so a daemon that dies between the `ps` and the `network ls` leaves this host unable
	// to say it finished looking. Conservative in the money direction, and unchanged by #357.
	const { exec } = fakeDockerExec({ containers: ["pi-job-e"], nets: {}, fail: { "network ls": "Cannot connect to the Docker daemon" } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: false });
	assert.deepEqual(lines.map((l) => l[0]), ["reaped_container", "reaper_skipped"], "the containers it DID reap are still reported");
});

test("a docker ps that fails is {reaped:false} and one reaper_skipped (#357)", async () => {
	// The money-critical half, untested before now: unproven means unproven.
	const { exec } = fakeDockerExec({ fail: { "ps --filter": "daemon down" } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: false });
	assert.deepEqual(lines.map((l) => l[0]), ["reaper_skipped"]);
});

test("nothing the reaper logs about a network carries the CLI's own text (#339, #357)", async () => {
	// A docker error can repeat a DOCKER_HOST with credentials in it. The network lines carry object names and
	// a token from a closed set, never `err.message`. A guard rail rather than a behaviour pin.
	const { exec } = fakeDockerExec({ nets: { "pi-job-f-net": ["some-proxy"] }, fail: { "network rm": "Failed to initialize: parse \"ssh://bob:pa?ss@remote\"" } });
	const { log, lines } = reaperLog();
	await makeReaper({ log, exec })();
	const reasons = new Set(["unreadable", "job-container-attached", "rm-failed"]);
	for (const [event, fields] of lines) {
		// `reaper_skipped` is exempt from the CLOSED-TOKEN rule and only from that. Its reason is a fault's
		// own prose, deliberately, because at most of the twelve sites that share this treatment the message
		// IS the diagnosis. It is NOT exempt from the credential rule below, which is the one this issue is
		// about and which used to skip it with the token check (issue #339).
		if (event === "reaper_skipped") continue;
		for (const [key, value] of Object.entries(fields)) {
			const values = Array.isArray(value) ? value : [value];
			for (const v of values) assert.ok(key === "reason" ? reasons.has(v) : /^[A-Za-z0-9._-]+$/.test(String(v)), `${event}.${key} must be an object name or a closed token, got ${JSON.stringify(v)}`);
		}
	}
	for (const needle of ["ssh://", "bob", "pa?ss"]) assert.ok(!JSON.stringify(lines).includes(needle), `no line may carry ${needle}`);
});

test("a docker spawn that THROWS logs the CLI's words with the credentials scrubbed, not a token (#339)", async () => {
	// The line the exemption above used to hide. Both directions are pinned on purpose: the host and the
	// daemon's own sentence must SURVIVE, because at this site the message is usually the diagnosis, and the
	// credential must not.
	const { exec } = fakeDockerExec({ fail: { "ps --filter": 'unable to resolve docker endpoint: parse "ssh://bob:hunter2@remote:22": invalid port ":hunter2"' } });
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: false });
	assert.deepEqual(lines.map((l) => l[0]), ["reaper_skipped"]);
	const reason = lines[0][1].reason;
	assert.match(reason, /ssh:\/\/\[redacted\]@remote:22/, "the host survives: it is what an operator needs");
	assert.match(reason, /unable to resolve docker endpoint/, "and so does the daemon's own sentence");
	for (const needle of ["bob", "hunter2"]) assert.ok(!reason.includes(needle), `the credential must not: ${needle}`);
});

test("the sweep's namespace is the NAME, not the filter: a foreign network is never touched (#357)", async () => {
	// `docker network ls --filter name=pi-job-` is a SUBSTRING match. Measured on docker 27.4.0 by creating a
	// network called `my-pi-job-notes` and watching it come back in that listing. Before the anchor it would
	// have been inspected, had its endpoints DETACHED and then been removed, which is an operator's own object
	// destroyed by a sweep that was only ever meant to own `pi-job-<id>-net`. The container half has the same
	// hazard from the same filter and the same fix.
	const { exec, calls, state } = fakeDockerExec({
		containers: ["pi-job-mine", "my-pi-job-notes-runner"],
		// The third has the prefix in the MIDDLE, which is the other way `--filter name=` returns a stranger.
		// Our own shape plus a SUFFIX (`pi-job-mine-net-backup`) used to be a row here and is NOT one now: it
		// moved to the test below, where it is SWEPT, because the widening claims it.
		nets: { "pi-job-mine-net": ["pi-dispatch-egress-proxy"], "my-pi-job-notes": ["someone-elses-app"], "robtest-staging-pi-job-queue-net": ["their-worker"] },
	});
	const { log, lines } = reaperLog();
	await makeReaper({ log, exec })();
	const touched = calls.join(" | ");
	assert.ok(!touched.includes("my-pi-job-notes"), "a name that merely CONTAINS the prefix is not ours");
	assert.ok(!touched.includes("robtest-staging"), "nor one that contains it in the middle");
	assert.ok(state.has("my-pi-job-notes") && state.has("robtest-staging-pi-job-queue-net"), "every foreign network survives intact");
	assert.deepEqual(state.get("my-pi-job-notes"), ["someone-elses-app"], "and keep every endpoint they had");
	assert.deepEqual(lines, [["reaped_container", { name: "pi-job-mine" }], ["reaped_network", { network: "pi-job-mine-net", detached: ["pi-dispatch-egress-proxy"] }]], "only ours is swept");
});

// The agreement itself, over NAMES rather than over one sweep's log, because the defect #360 item 7 reports is
// that the two halves answered differently and either half alone looks correct. Every row is asserted through
// ONE predicate, so a future edit cannot reintroduce a second rule without deleting this table.
// The four sites that interpolate an endpoint into "resolves ..., which is not shown to be on this host" all
// funnel through this, so its table is where the shapes live rather than four behavioural tests over the same
// rule. Each row is a thing a real context store can hold: `docker context create` refuses a blank host and a
// raw ESC, but it ACCEPTS a C1 byte, and `docker context inspect` -- the command doctor actually runs -- does
// not re-validate what is already stored.
test("endpointShown never renders a gap, and never a byte that can redraw the line (#360)", () => {
	const U = (hex) => String.fromCodePoint(parseInt(hex, 16));
	assert.equal(endpointShown({ endpoint: "tcp://h:2375" }), "tcp://h:2375", "printable ASCII is untouched");
	assert.equal(endpointShown({ endpoint: "unix:///var/run/docker.sock" }), "unix:///var/run/docker.sock");
	assert.equal(endpointShown({ endpoint: "tcp://(credentials not shown)" }), "tcp://(credentials not shown)", "and so is the withheld form, which start.mjs's own pin depends on");
	assert.equal(endpointShown({ endpoint: "" }), "an empty endpoint");
	// Whitespace: the first version tested `=== ""`, so three spaces rendered as a gap.
	assert.equal(endpointShown({ endpoint: "   " }), "an empty endpoint");
	assert.equal(endpointShown({ endpoint: "\t\n " }), "an empty endpoint");
	for (const absent of [{ endpoint: null }, { endpoint: undefined }, {}, null, undefined]) assert.equal(endpointShown(absent), "an empty endpoint", JSON.stringify(absent));
	// QUOTED AND ESCAPED, NOT REMOVED, and these two rows are why. A second version STRIPPED the control
	// range, which forged and corrupted in turn: `docker context create` accepts a C1 byte, so a stored
	// loopback-with-a-C1 is classified NOT local and then printed as a clean loopback, a value the operator
	// never configured, in a sentence that then contradicts itself; and a unix socket really can live at a
	// path holding one, which stripping renames to a path that does not exist while every other consumer
	// reads the unstripped value as a real path.
	assert.equal(endpointShown({ endpoint: `tcp://127.0.0.1${U("85")}:2375` }), '"tcp://127.0.0.1\\u0085:2375"', "a C1 must not be erased into a valid loopback address");
	assert.equal(endpointShown({ endpoint: `unix:///tmp/pi${U("85")}probe.sock` }), '"unix:///tmp/pi\\u0085probe.sock"', "nor a socket path into one that does not exist");
	// A value that is ENTIRELY control bytes, which is the interaction the strip got wrong: check emptiness
	// before removing anything and this row renders a gap again.
	assert.equal(endpointShown({ endpoint: U("1") }), '"\\u0001"');
	// The whole class, not one range of it: an erase-line, a right-to-left override, a zero-width joiner and
	// a line separator all have to be visible, and only escaping makes them so.
	for (const [what, value] of [["CSI", `tcp://r:1${U("1b")}[2K${U("0d")}tcp://evil:1`], ["RLO", `tcp://a${U("202E")}b:1`], ["ZWJ", `tcp://a${U("200D")}b:1`], ["LS", `tcp://a${U("2028")}b:1`], ["NBSP", `tcp://a${U("A0")}b:1`]]) {
		const out = endpointShown({ endpoint: value });
		assert.match(out, /^"[\x20-\x7e]*"$/, `${what} renders as printable ASCII in quotes`);
		assert.doesNotMatch(out, /[^\x20-\x7e]/, what);
	}
	// LOSSLESS is the property that makes quoting the right answer rather than a prettier strip: what was
	// stored is always recoverable from what was printed.
	// The escaped form is itself valid JSON, so the recovery is one `JSON.parse` and needs no unescaper of
	// its own -- which is the point: an operator can do it, and so can whatever ingests the log.
	for (const value of [`tcp://127.0.0.1${U("85")}:2375`, `tcp://a${U("202E")}b:1`, `x${U("1b")}y`, `unix:///tmp/pi${U("85")}probe.sock`]) assert.equal(JSON.parse(endpointShown({ endpoint: value })), value, value);
});

test("both halves of the reaper give ONE answer to `what is ours` (#360)", () => {
	const ours = [
		jobContainerName("gh-1"),
		networkNameFor(jobContainerName("gh-1")),
		// The shapes a REAL job id can take, which is why no charset rule separates an operator's name from a
		// job's: `jobContainerName` does not sanitise, and BullMQ's ids are already `[A-Za-z0-9._-]`, so `_`
		// and `-` are both legal. (`sanitizeJobId` governs the SANDBOX namespace and is not in this path.)
		"pi-job-runner_default",
		"pi-job-runner-db-1",
		// WIDENED BY #360, and this is the row that can destroy an operator's object: our exact shape with
		// something appended used to survive the network half and its container never did.
		"pi-job-mine-net-backup",
		// The invariant the old `.*` was written for, now free: an empty job id would name the container
		// `pi-job-` and the network `pi-job--net`, and a stricter network half would reap the one and leak the
		// other forever. Not reachable today (`backend-registry.mjs` passes `job?.id`, absent renders
		// `undefined`), pinned because the asymmetry fails silently and permanently.
		JOB_NAME_PREFIX,
		`${JOB_NAME_PREFIX}-net`,
	];
	const theirs = ["my-pi-job-notes", "my-pi-job-notes-runner", "robtest-staging-pi-job-queue-net", "pi-sandbox-gh-1", "pi-sandbox-gh-1-net", "pi-dispatch-egress-proxy", "pi-job", "PI-JOB-mine", ""];
	for (const name of ours) assert.equal(isJobNamespace(name), true, name);
	for (const name of theirs) assert.equal(isJobNamespace(name), false, name);
	// A non-string is what a `.Containers` rendering as a number or `null` hands a caller, and `startsWith`
	// would throw on it: this predicate is also the guard, because the sweep's own catch would read a throw
	// here as a daemon fault and answer `{ reaped: false }`.
	for (const junk of [null, undefined, 0, {}, ["pi-job-x"]]) assert.equal(isJobNamespace(junk), false, String(junk));
});

// The destructive half of the widening, driven end to end rather than asserted on the predicate: the sweep
// really does remove `pi-job-mine-net-backup` now, and really does detach whatever was on it first. If this
// ever goes green while the row above still passes, the call site has stopped using the predicate.
test("a network under the prefix without the `-net` suffix is now swept, and that is the cost (#360)", async () => {
	const { exec, calls, state } = fakeDockerExec({
		nets: { "pi-job-mine-net-backup": ["their-worker"], "pi-job-runner_default": ["their-worker"] },
	});
	const { log, lines } = reaperLog();
	assert.deepEqual(await makeReaper({ log, exec })(), { reaped: true });
	assert.ok(calls.join(" | ").includes("pi-job-mine-net-backup"), "our own shape with a suffix IS ours");
	assert.deepEqual(lines, [
		["reaped_network", { network: "pi-job-mine-net-backup", detached: ["their-worker"] }],
		["reaped_network", { network: "pi-job-runner_default", detached: ["their-worker"] }],
	]);
	assert.ok(!state.has("pi-job-mine-net-backup") && !state.has("pi-job-runner_default"), "both are gone");
});
