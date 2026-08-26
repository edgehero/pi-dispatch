import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { mergeSecretProfiles, parseSecretProfiles, withinRoots } from "../src/secret-profiles.mjs";
import { MAX_SECRET_BYTES, makeSecretsResolver, secretsArmed } from "../src/secrets.mjs";

// A resolver is an operator-written script, so the seam under test is a spawn. `plan` maps a REFERENCE to
// what that script does with it: `{ code, out, err }`, or a `delay` that never closes (the timeout path).
function fakeSpawn(calls, plan) {
	return (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const child = new EventEmitter();
		child.kill = (sig) => calls.push({ killed: sig ?? "SIGTERM" });
		const out = new EventEmitter();
		const err = new EventEmitter();
		child.stdout = out;
		child.stderr = err;
		const step = plan[args[0]] ?? { code: 0, out: "value-for-" + args[0] };
		if (step.spawnThrow) throw new Error("ENOENT");
		queueMicrotask(() => {
			if (step.err !== undefined) err.emit("data", Buffer.from(step.err));
			if (step.out !== undefined) out.emit("data", Buffer.from(step.out));
			if (step.error) return child.emit("error", new Error("ENOENT"));
			if (step.hang) return; // never closes: the timeout must be what ends it
			child.emit("close", step.code ?? 0);
		});
		return child;
	};
}

const PROFILES = { default: "/opt/pi/resolve.sh" };
const resolver = (plan = {}, over = {}) => {
	const calls = [];
	const fn = makeSecretsResolver({
		envProfiles: PROFILES,
		spawnFn: fakeSpawn(calls, plan),
		realExecutablePath: (p) => p,
		hostEnv: { OP_SERVICE_ACCOUNT_TOKEN: "host-credential" },
		...over,
	});
	return { fn, calls };
};
const job = (secrets, over = {}) => ({ kind: "github", secrets, ...over });

// --- PI_SECRET_PROFILES parsing ---

test("parseSecretProfiles reads name:absolute-path pairs, and an unset value is simply off", () => {
	assert.deepEqual(parseSecretProfiles("prod:/opt/pi/a.sh,staging:/opt/pi/b.sh"), { prod: "/opt/pi/a.sh", staging: "/opt/pi/b.sh" });
	for (const empty of [undefined, null, "", "   "]) assert.deepEqual(parseSecretProfiles(empty), {});
});

test("each entry splits on its FIRST colon, so a Windows drive letter survives", () => {
	// config.mjs's delimitedList exists because a `:` list separator eats `C:\`. This is the same hazard
	// from the other side: here exactly one colon must be read as a separator and the rest must not.
	assert.deepEqual(parseSecretProfiles("prod:C:\\pi\\resolve.cmd"), { prod: "C:\\pi\\resolve.cmd" });
});

test("set-but-garbled fails LOUD -- a dropped entry is a profile the operator believes is wired", () => {
	for (const bad of ["noseparator", ":/opt/pi/a.sh", "prod:relative/path", "bad name:/opt/a.sh", "a,b"]) {
		assert.throws(() => parseSecretProfiles(bad), (e) => e.piDispatchConfig === true, `must refuse ${JSON.stringify(bad)}`);
	}
	assert.throws(() => parseSecretProfiles("prod:/a.sh,prod:/b.sh"), (e) => /twice/.test(e.message));
});

test("a name carrying a list separator is refused -- it could not round-trip its own declaration", () => {
	assert.throws(() => parseSecretProfiles("pro,d:/opt/a.sh"), (e) => e.piDispatchConfig === true);
});

// --- the union, and the refusal to pick a winner ---

test("env and overlay profiles union, and a name in BOTH refuses rather than picking", () => {
	assert.deepEqual(mergeSecretProfiles({ a: "/x" }, { b: "/y" }), { profiles: { a: "/x", b: "/y" } });
	// Not "env wins": runtime-settings documents overlay > env, and inverting it for one key would leave two
	// rules disagreeing. Not "overlay wins" either: the settings file defaults into the OS temp directory.
	assert.deepEqual(mergeSecretProfiles({ a: "/x" }, { a: "/y" }), { ambiguous: "a" });
});

// --- the roots bound ---

test("withinRoots is fail-closed and respects a separator boundary", () => {
	assert.equal(withinRoots("/opt/pi/a.sh", []), false, "empty roots must admit NOTHING");
	assert.equal(withinRoots("/opt/pi/a.sh", ["/opt/pi"]), true);
	assert.equal(withinRoots("/opt/pi-evil/a.sh", ["/opt/pi"]), false, "a prefix is not a parent directory");
	assert.equal(withinRoots("/opt/pi/../../etc/shadow", ["/opt/pi"]), false, "traversal must normalize away");
});

// --- profile selection ---

test("an unknown profile refuses, and there is NO fallback to the single declared one", () => {
	const { fn } = resolver();
	return fn(job({ A: "ref" }, { secretsProfile: "nope" })).then((r) => assert.equal(r.profileUnknown, "nope"));
});

test("absent secretsProfile selects `default`, and a deployment declaring none refuses", async () => {
	const { fn } = resolver();
	assert.deepEqual((await fn(job({ A: "ref" }))).secrets, { A: "value-for-ref" });
	const bare = makeSecretsResolver({ envProfiles: {}, spawnFn: () => assert.fail("must not spawn") });
	assert.equal((await bare(job({ A: "ref" }))).profileUnknown, "default");
});

test("an OVERLAY-declared profile must sit inside PI_SECRET_RESOLVER_ROOTS; an env-declared one need not", async () => {
	// The bound exists because the overlay is not the reviewed artifact triggers.json is, and its default
	// path is in a world-writable directory. PI_SECRET_PROFILES already lives beside the forge tokens.
	const outside = makeSecretsResolver({ envProfiles: {}, roots: ["/opt/pi"], realExecutablePath: (p) => p, spawnFn: () => assert.fail("must not spawn") });
	assert.equal((await outside(job({ A: "ref" }), { overlayProfiles: { default: "/tmp/evil.sh" } })).profileUnknown, "default");

	const inside = makeSecretsResolver({ envProfiles: {}, roots: ["/opt/pi"], realExecutablePath: (p) => p, spawnFn: fakeSpawn([], {}) });
	assert.deepEqual((await inside(job({ A: "ref" }), { overlayProfiles: { default: "/opt/pi/ok.sh" } })).secrets, { A: "value-for-ref" });

	// With roots unset (the default) the panel can declare NOTHING, and the env half still works.
	const closed = makeSecretsResolver({ envProfiles: {}, realExecutablePath: (p) => p, spawnFn: () => assert.fail("must not spawn") });
	assert.equal((await closed(job({ A: "ref" }), { overlayProfiles: { default: "/opt/pi/ok.sh" } })).profileUnknown, "default");
});

test("a resolver path that is absent or not executable refuses without spawning", async () => {
	const fn = makeSecretsResolver({ envProfiles: PROFILES, realExecutablePath: () => null, spawnFn: () => assert.fail("must not spawn") });
	assert.equal((await fn(job({ A: "ref" }))).profileUnknown, "default");
});

// --- the value itself ---

test("the reference is argv[1], never a shell string, and stdin is ignored", async () => {
	const { fn, calls } = resolver();
	await fn(job({ A: "op://ci-vault/stripe/api-key" }));
	assert.equal(calls[0].cmd, "/opt/pi/resolve.sh");
	assert.deepEqual(calls[0].args, ["op://ci-vault/stripe/api-key"]);
	assert.equal(calls[0].opts.shell, false, "a shell string would be an injection surface");
	assert.deepEqual(calls[0].opts.stdio, ["ignore", "pipe", "pipe"], "stdin ignored so a prompting resolver dies fast");
	assert.equal(calls[0].opts.env.OP_SERVICE_ACCOUNT_TOKEN, "host-credential", "the resolver must be able to authenticate");
});

test("exactly ONE trailing newline is stripped, and never more, and never a trim", async () => {
	const cases = [
		["plain\n", "plain"],
		["plain", "plain"],
		["plain\r\n", "plain"],
		["plain\n\n", "plain\n"],
		["-----BEGIN KEY-----\nbody\n-----END KEY-----\n", "-----BEGIN KEY-----\nbody\n-----END KEY-----"],
		["  padded  ", "  padded  "],
	];
	for (const [out, want] of cases) {
		const { fn } = resolver({ ref: { code: 0, out } });
		const r = await fn(job({ A: "ref" }));
		assert.equal(r.secrets.A, want, `${JSON.stringify(out)} must resolve to ${JSON.stringify(want)}`);
	}
});

test("stderr NEVER reaches the value, and is reported only as a byte count", async () => {
	// Merging the streams (what doctor's capture helper does) would splice a deprecation warning into the
	// credential, invisibly, until the container authenticates with a wrong string.
	const { fn } = resolver({ ref: { code: 0, out: "the-secret\n", err: "WARNING: `op` v1 is deprecated\n" } });
	const r = await fn(job({ A: "ref" }));
	assert.equal(r.secrets.A, "the-secret");
	assert.equal(/deprecated|WARNING/.test(r.secrets.A), false);
});

test("a value carrying a NUL is refused -- execve argv truncates at it, silently", async () => {
	const { fn } = resolver({ ref: { code: 0, out: "good" + "\u0000" + "TRUNCATED" } });
	const r = await fn(job({ A: "ref" }));
	assert.equal(r.unresolved, "A");
	assert.equal(r.failure, "nul");
});

test("interior newlines are KEPT -- it is an argv, not a shell string, and a PEM has them", async () => {
	const pem = "-----BEGIN-----\nline1\nline2\n-----END-----";
	const { fn } = resolver({ ref: { code: 0, out: pem + "\n" } });
	assert.equal((await fn(job({ A: "ref" }))).secrets.A, pem);
});

// --- the exit-code protocol (INT-RUNNER-EXIT-CODE-PROTOCOL, reused) ---

test("exit 2 is DETERMINATE: the reference is wrong, and the job must not retry", async () => {
	const { fn } = resolver({ ref: { code: 2, err: "no such item" } });
	const r = await fn(job({ A: "ref" }));
	assert.equal(r.unresolved, "A");
	assert.equal(r.failure, "exit");
	assert.equal(r.code, 2);
	assert.ok(r.stderrBytes > 0, "the count survives so an operator is told to run it by hand");
});

test("exit 1 is INDETERMINATE: the manager was unreachable, and the job must retry", async () => {
	// Folding this into the refusal above would permanently burn a delivery over a twenty-second vault
	// blip, and a webhook does not redeliver itself.
	const { fn } = resolver({ ref: { code: 1, err: "dial tcp: i/o timeout" } });
	const r = await fn(job({ A: "ref" }));
	assert.equal(r.unreachable, "A");
	assert.equal(r.code, 1);
});

test("an exit code we do not recognise is treated as INFRA, per decideRetry's own reasoning", async () => {
	for (const code of [3, 77, 126, 127]) {
		const { fn } = resolver({ ref: { code } });
		assert.equal((await fn(job({ A: "ref" }))).unreachable, "A", `exit ${code} must retry, not refuse`);
	}
});

test("exit 0 printing NOTHING is refused -- the silent-no-op class, not a success", async () => {
	for (const out of ["", "\n"]) {
		const { fn } = resolver({ ref: { code: 0, out } });
		const r = await fn(job({ A: "ref" }));
		assert.equal(r.unresolved, "A");
		assert.equal(r.failure, "empty");
	}
});

test("a spawn fault is INFRA, not a refusal -- the script may be there next attempt", async () => {
	for (const step of [{ error: true }, { spawnThrow: true }]) {
		const { fn } = resolver({ ref: step });
		assert.equal((await fn(job({ A: "ref" }))).unreachable, "A");
	}
});

test("an oversized value is KILLED and refused, never truncated", async () => {
	const { fn, calls } = resolver({ ref: { code: 0, out: "x".repeat(MAX_SECRET_BYTES + 1) } });
	const r = await fn(job({ A: "ref" }));
	assert.equal(r.unresolved, "A");
	assert.equal(r.failure, "overflow");
	assert.ok(calls.some((c) => c.killed), "the child must be stopped, not left writing");
});

test("a resolver that never answers times out as INFRA, and the child is signalled", async () => {
	const { fn, calls } = resolver({ ref: { hang: true } }, { timeoutMs: 15 });
	const r = await fn(job({ A: "ref" }));
	assert.equal(r.unreachable, "A");
	assert.equal(r.failure, "timeout");
	assert.ok(calls.some((c) => c.killed === "SIGTERM"), "SIGTERM first");
});

test("an abort mid-resolution stops the child rather than running the job's clock out", async () => {
	const ac = new AbortController();
	const { fn, calls } = resolver({ ref: { hang: true } }, { timeoutMs: 60_000 });
	const p = fn(job({ A: "ref" }), { signal: ac.signal });
	queueMicrotask(() => ac.abort());
	const r = await p;
	assert.equal(r.unreachable, "A");
	assert.equal(r.failure, "aborted");
	assert.ok(calls.some((c) => c.killed));
});

// --- the set as a whole ---

test("resolution is SEQUENTIAL in the operator's own order, and refuses the WHOLE job on one failure", async () => {
	// Sequential so a broken trigger blames the same variable every run, and so a refusal has not already
	// pulled every other live credential into memory for a job that will never start.
	const { fn, calls } = resolver({ two: { code: 2 } });
	const r = await fn(job({ A: "one", B: "two", C: "three" }));
	assert.equal(r.unresolved, "B", "the FIRST failure names itself, deterministically");
	assert.equal(r.secrets, undefined, "a partial set is never returned");
	assert.deepEqual(calls.filter((c) => c.args).map((c) => c.args[0]), ["one", "two"], "it stopped at the failure");
});

test("two names sharing one reference resolve ONCE, so they cannot straddle a rotation", async () => {
	const { fn, calls } = resolver();
	const r = await fn(job({ A: "same", B: "same" }));
	assert.equal(r.secrets.A, r.secrets.B);
	assert.equal(calls.filter((c) => c.args).length, 1, "one read, not two");
});

test("an unarmed job is not this module's business -- secretsArmed is what the gate asks", () => {
	assert.equal(secretsArmed({ kind: "github" }), false);
	assert.equal(secretsArmed({ secrets: {} }), false, "an empty map is not armed");
	assert.equal(secretsArmed({ secrets: { A: "x" } }), true);
	// A lone profile arms it too: it cannot reach a wired worker (parseTriggers refuses it), but this
	// predicate also guards the fail-closed default under wirings that never saw the validator.
	assert.equal(secretsArmed({ secretsProfile: "prod" }), true);
});
