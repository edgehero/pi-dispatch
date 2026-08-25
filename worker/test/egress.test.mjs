import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
	createJobNetwork,
	DEFAULT_EGRESS_PROXY,
	egressArmed,
	egressEnv,
	egressProxyUrl,
	makeEgressPreflight,
	networkNameFor,
	removeJobNetwork,
} from "../src/egress.mjs";

// No skip guard, deliberately: like image-preflight.mjs this module imports nothing but
// node:child_process, and it decides whether a budget slot is spent. A money gate must not have
// skippable tests.

/**
 * A fake `docker` recording each argv. `plan` is keyed on a space-joined prefix of the args, longest
 * match wins, so "network create" and "network connect" can be planned apart. A missing key means "not
 * launchable" (error event), which is how a docker that is not on PATH behaves.
 */
function fakeSpawn(calls, plan, stdout = "") {
	return (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const child = new EventEmitter();
		if (opts?.stdio?.[1] === "pipe") {
			const out = new EventEmitter();
			out.setEncoding = () => {};
			child.stdout = out;
			queueMicrotask(() => out.emit("data", stdout));
		}
		const key = [args.slice(0, 2).join(" "), args[0]].find((k) => k in plan);
		const code = key === undefined ? undefined : plan[key];
		queueMicrotask(() => (code === undefined ? child.emit("error", new Error("ENOENT")) : child.emit("close", code)));
		return child;
	};
}

test("the network name is DERIVED from the container name, so both namespaces keep one rule", () => {
	assert.equal(networkNameFor("pi-job-gh-12345"), "pi-job-gh-12345-net");
	assert.equal(networkNameFor("pi-job-gh-12345-r2"), "pi-job-gh-12345-r2-net", "a replica keeps its own network");
	// The boot reaper filters `pi-job-` and docker matches it as a SUBSTRING. That one filter must sweep a
	// crashed worker's job networks and must NEVER touch a sandbox an operator is sitting in -- the exact
	// rule the container names already follow. Asserted rather than commented, because it is a substring
	// relationship and those are easy to break by renaming one side.
	assert.ok(networkNameFor("pi-job-gh-1").includes("pi-job-"), "a job network is inside the reaper's filter");
	assert.ok(!networkNameFor("pi-sandbox-gh-1").includes("pi-job-"), "a sandbox network is outside it");
});

test("egressEnv is EMPTY when unarmed, so the container env is byte-identical to one built before this feature", () => {
	assert.deepEqual(egressEnv({ armed: false }), {});
	assert.deepEqual(egressEnv({ armed: false, proxy: "whatever" }), {}, "and a proxy name alone arms nothing");
});

test("egressEnv carries NODE_USE_ENV_PROXY, which is the variable the hand-written recipe omits", () => {
	const env = egressEnv({ armed: true });
	assert.equal(env.HTTPS_PROXY, egressProxyUrl(DEFAULT_EGRESS_PROXY));
	assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY, "both, because clients disagree about which they read");
	assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
	// The one that matters. Without it the two proxy variables steer git/gh/npm/Chromium and NOT the
	// runner's own provider call: the Anthropic SDK resolves globalThis.fetch and nothing installs a
	// proxy-aware dispatcher unless this flag is set. Behind an --internal network that is not a leak, it
	// is an outage -- every job dies at its first turn -- which is why it rides the CLOSED map rather than
	// PI_FORWARD_ENV, where an operator could arm the policy and forget it.
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("the proxy is reached BY NAME: a user-defined network resolves it, unlike docker's default bridge", () => {
	assert.equal(egressProxyUrl("my-proxy"), "http://my-proxy:3128");
	assert.equal(egressEnv({ armed: true, proxy: "my-proxy" }).HTTPS_PROXY, "http://my-proxy:3128");
});

test("an UNARMED preflight admits everything and spawns NOTHING", async () => {
	const calls = [];
	const preflight = makeEgressPreflight({ armed: false, spawnFn: fakeSpawn(calls, { inspect: 1, info: 0 }) });
	assert.deepEqual(await preflight({}), { ok: true });
	// A deployment with no egress policy must pay nothing at all for the feature existing.
	assert.equal(calls.length, 0, "no docker is consulted when there is no policy to check");
});

test("a running proxy is admitted, and costs exactly ONE spawn", async () => {
	const calls = [];
	const preflight = makeEgressPreflight({ armed: true, spawnFn: fakeSpawn(calls, { inspect: 0, info: 0 }, "true\n") });
	assert.deepEqual(await preflight({}), { ok: true, proxy: DEFAULT_EGRESS_PROXY });
	// The `docker info` disambiguation runs ONLY on the failure path: every job pays this gate, so the
	// happy path must not pay for the diagnosis of a case it is not in.
	assert.equal(calls.length, 1, "the happy path does not probe the daemon a second time");
	assert.deepEqual(calls[0].args, ["inspect", "--format={{.State.Running}}", DEFAULT_EGRESS_PROXY]);
});

test("a proxy the daemon knows but has STOPPED is policy, not infra", async () => {
	const preflight = makeEgressPreflight({ armed: true, spawnFn: fakeSpawn([], { inspect: 0, info: 0 }, "false\n") });
	assert.deepEqual(await preflight({}), { proxyStopped: DEFAULT_EGRESS_PROXY });
});

test("a proxy the daemon does not have is POLICY -- disambiguated positively, never by stderr text", async () => {
	const calls = [];
	const preflight = makeEgressPreflight({ armed: true, spawnFn: fakeSpawn(calls, { inspect: 1, info: 0 }) });
	assert.deepEqual(await preflight({}), { proxyMissing: DEFAULT_EGRESS_PROXY });
	assert.equal(calls.length, 2, "the failure path asks the daemon whether it is alive");
	assert.deepEqual(calls[1].args, ["info"]);
});

test("a daemon that does not answer is INFRA, so a blip never becomes a permanent refusal", async () => {
	// The whole reason the disambiguation is positive. If this returned `proxyMissing` a transient daemon
	// restart would refuse the job determinately and never retry it -- work dropped on a blip.
	const down = makeEgressPreflight({ armed: true, spawnFn: fakeSpawn([], { inspect: 1, info: 1 }) });
	assert.deepEqual(await down({}), { unavailable: DEFAULT_EGRESS_PROXY });
	const gone = makeEgressPreflight({ armed: true, spawnFn: fakeSpawn([], {}) }); // docker not on PATH at all
	assert.deepEqual(await gone({}), { unavailable: DEFAULT_EGRESS_PROXY });
});

test("a proxy whose inspect returns junk is treated as NOT running, which is the safe direction", async () => {
	const preflight = makeEgressPreflight({ armed: true, spawnFn: fakeSpawn([], { inspect: 0, info: 0 }, "<no value>\n") });
	assert.deepEqual(await preflight({}), { proxyStopped: DEFAULT_EGRESS_PROXY });
});

test("createJobNetwork passes --internal at CREATE time, so there is no window with a route out", async () => {
	const calls = [];
	const ok = await createJobNetwork(fakeSpawn(calls, { "network create": 0, "network connect": 0 }), { network: "pi-job-x-net" });
	assert.equal(ok, true);
	assert.deepEqual(calls[0].args, ["network", "create", "--internal", "pi-job-x-net"]);
	assert.deepEqual(calls[1].args, ["network", "connect", "pi-job-x-net", DEFAULT_EGRESS_PROXY]);
});

test("a network the proxy could not join is TORN DOWN, never left half-built", async () => {
	const calls = [];
	// A half-built policy that still admits a job is worse than one that refuses it: the container would
	// start on a network with no way out and burn its slot proving it.
	const ok = await createJobNetwork(fakeSpawn(calls, { "network create": 0, "network connect": 1 }), { network: "pi-job-x-net" });
	assert.equal(ok, false);
	const subcommands = calls.map((c) => c.args.slice(0, 2).join(" "));
	assert.ok(subcommands.includes("network rm"), `the orphan is removed; saw ${subcommands.join(", ")}`);
});

test("a network that could not be created reports failure without attempting to connect", async () => {
	const calls = [];
	assert.equal(await createJobNetwork(fakeSpawn(calls, { "network create": 1 }), { network: "pi-job-x-net" }), false);
	assert.equal(calls.length, 1, "nothing is attached to a network that does not exist");
});

test("removeJobNetwork detaches before removing, and never throws on a failing teardown", async () => {
	const calls = [];
	// It runs in a `finally` after the container has already exited. Its code is the job's answer, and a
	// teardown fault must not rewrite it.
	await removeJobNetwork(fakeSpawn(calls, { "network disconnect": 1, "network rm": 1 }), { network: "pi-job-x-net" });
	assert.deepEqual(
		calls.map((c) => c.args.slice(0, 2).join(" ")),
		["network disconnect", "network rm"],
		"a network with a member still attached cannot be removed, so the order is load-bearing",
	);
});

test("the posture is BOUNDED by default, and only an explicit 0 opens it", () => {
	// The polarity is the decision, not a detail. A control that ships off is a control nobody enabled,
	// which is the state OQ-004 spent a year in: a disclosure with a dead end at the end of it.
	assert.equal(egressArmed({}), true, "a deployment that says nothing is bounded");
	assert.equal(egressArmed({ PI_EGRESS: "" }), true);
	assert.equal(egressArmed({ PI_EGRESS: "1" }), true);
	assert.equal(egressArmed({ PI_EGRESS: "0" }), false, "only an explicit opt-out opens it");
	// A typo must never produce the OPEN posture silently. An operator who believes they are bounded and is
	// not is worse off than one who knows they are not, because the belief displaces the credential bound
	// that is actually holding.
	for (const bad of ["true", "on", "yes", "2"]) {
		assert.throws(() => egressArmed({ PI_EGRESS: bad }), /must be exactly/, `${bad} must not be guessed`);
	}
});

test("a deployment that UPGRADES and does nothing is refused, never silently opened", async () => {
	// The upgrade path, pinned. With no proxy on the host the preflight refuses -- loudly, for free, and
	// naming the fix -- rather than falling back to open egress. The fallback is the tempting option and it
	// is the one this project refuses: a security control that quietly disables itself is exactly the
	// "believed on while off" failure the whole feature exists to remove. Reversible in one line.
	const preflight = makeEgressPreflight({ armed: egressArmed({}), spawnFn: fakeSpawn([], { inspect: 1, info: 0 }) });
	assert.deepEqual(await preflight({}), { proxyMissing: DEFAULT_EGRESS_PROXY });
});
