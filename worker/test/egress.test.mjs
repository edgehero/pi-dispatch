import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DEFAULT_EGRESS_PROXY, createJobNetwork, createJobNetworkWith, egressArmed, egressEnv, egressProxyUrl, makeEgressPreflight, networkAbsentInDaemonWords, networkEndpoints, networkExists, networkNameFor, removeJobNetwork, removeJobNetworkWith, removeNetworkOrSay } from "../src/egress.mjs";

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

test("the With forms run the job path's exact sequence over any runner, and a runner that throws is a failed step (#344)", async () => {
	// The same sequence through the spawn wrapper and through a bare runner: doctor --live's peers get a job's network,
	// not a second copy of how one is built.
	const viaSpawn = [];
	await createJobNetwork(fakeSpawn(viaSpawn, { "network create": 0, "network connect": 0 }), { network: "n", proxy: "p" });
	await removeJobNetwork(fakeSpawn(viaSpawn, { "network disconnect": 0, "network rm": 0 }), { network: "n", proxy: "p" });
	const viaRunner = [];
	const runner = async (args) => (viaRunner.push(args), { code: 0 });
	assert.equal(await createJobNetworkWith(runner, { network: "n", proxy: "p" }), true);
	assert.equal(await removeJobNetworkWith(runner, { network: "n", proxy: "p" }), true);
	assert.deepEqual(viaRunner, viaSpawn.map((c) => c.args));
	assert.deepEqual(viaRunner[3], ["network", "rm", "n"], "removed without -f, so a network something else is on stays");

	const rolledBack = [];
	assert.equal(await createJobNetworkWith(async (a) => (rolledBack.push(a), { code: a[1] === "connect" ? 1 : 0 }), { network: "n", proxy: "p" }), false);
	assert.deepEqual(rolledBack.map((a) => a[1]), ["create", "connect", "disconnect", "rm"], "a network the proxy could not join is torn down");

	const throwing = async () => {
		throw new Error("spawn EMFILE");
	};
	assert.equal(await createJobNetworkWith(throwing, { network: "n", proxy: "p" }), false);
	assert.equal(await removeJobNetworkWith(throwing, { network: "n", proxy: "p" }), false);
	assert.equal(await removeJobNetworkWith(async (a) => ({ code: a[1] === "rm" ? 1 : 0 }), { network: "n", proxy: "p" }), false, "a network that would not go says so");
});

// --- the shared network-removal rule (issues #357, #352) ---------------------------------------------

test("a network is 'not there' ONLY in the daemon's own words, and only on a non-zero exit (#352)", () => {
	// The three mutants #352 recorded as surviving `dropNetwork`'s own tests. They survived because every
	// fixture there happened to be non-zero, stderr-only and lower case, so each mutation was equivalent
	// under the wording measured on Docker 27.5.1 and Podman 5.8.2. Each gets its own case here.
	const absent = networkAbsentInDaemonWords;
	// (1) the code !== 0 guard. A successful inspect whose OUTPUT happens to carry the words is not absence:
	// a container named `network-x-not-found` would otherwise delete its own network from the record.
	assert.equal(absent({ code: 0, stdout: "network pi-job-x-net not found", stderr: "" }), false, "exit 0 is never absence");
	// (2) stdout only. Docker puts it on stderr, but a runtime that answers on stdout must read the same.
	assert.equal(absent({ code: 1, stdout: "network pi-job-x-net not found", stderr: "" }), true);
	// (3) case. Nothing measured answers in title case; nothing should have to.
	assert.equal(absent({ code: 1, stdout: "", stderr: "Error: Network pi-job-x-net Not Found" }), true);
	// Both daemons' measured wording, which is the rule's whole reason for existing.
	assert.equal(absent({ code: 1, stdout: "", stderr: "Error response from daemon: network pi-job-x-net not found" }), true, "docker");
	assert.equal(absent({ code: 1, stdout: "", stderr: "Error: unable to find network with name or ID pi-job-x-net: network not found" }), true, "podman");
	// NOT absence: no answer at all, and the CLI talking about ITSELF rather than about a network.
	assert.equal(absent({ code: null, stdout: "", stderr: "" }), false, "a timeout is no answer");
	assert.equal(absent(undefined), false);
	assert.equal(absent({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }), false);
	assert.equal(absent({ code: 1, stdout: "", stderr: 'context "foo" not found' }), false, "the CLI's own context, not a network");
});

test("removeNetworkOrSay detaches what the CALLER names, never -f, and says what stayed (#357)", async () => {
	const calls = [];
	const run = async (args) => {
		calls.push(args.join(" "));
		if (args[1] === "rm") return { code: 1, stdout: "", stderr: "has active endpoints" };
		if (args[1] === "inspect") return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const out = await removeNetworkOrSay(run, { network: "n", detach: ["p1", "p2"] });
	assert.deepEqual(out, { removed: false, absent: false, detached: ["p1", "p2"], command: "docker network rm n" });
	assert.deepEqual(calls, ["network disconnect -f n p1", "network disconnect -f n p2", "network rm n", "network inspect n"]);
	assert.ok(!calls.some((c) => c === "network rm -f n"), "never `network rm -f`: it would pull a network out from under a live endpoint");
});

test("removeNetworkOrSay is silent when the daemon says the network is gone (#357)", async () => {
	const run = async (args) => (args[1] === "rm" ? { code: 1, stdout: "", stderr: "network n not found" } : { code: 1, stdout: "", stderr: "Error response from daemon: network n not found" });
	assert.deepEqual(await removeNetworkOrSay(run, { network: "n" }), { removed: true, absent: true, detached: [], command: null });
});

test("networkEndpoints reads the Name field, and an unreadable answer is not an empty one (#357)", async () => {
	// "no endpoints" and "could not ask" must not arrive as the same empty array: the first lets a sweep
	// remove, the second must not.
	const ok = await networkEndpoints(async () => ({ code: 0, stdout: '{"id0":{"Name":"pi-job-a"},"id1":{"Name":"pi-dispatch-egress-proxy"}}', stderr: "" }), "n");
	assert.deepEqual(ok, { ok: true, absent: false, names: ["pi-job-a", "pi-dispatch-egress-proxy"] });
	const empty = await networkEndpoints(async () => ({ code: 0, stdout: "{}", stderr: "" }), "n");
	assert.deepEqual(empty, { ok: true, absent: false, names: [] });
	const torn = await networkEndpoints(async () => ({ code: 0, stdout: "{not json", stderr: "" }), "n");
	assert.equal(torn.ok, false, "a torn answer is not an empty network");
	const gone = await networkEndpoints(async () => ({ code: 1, stdout: "", stderr: "network n not found" }), "n");
	assert.deepEqual(gone, { ok: false, names: [], absent: true });
	const down = await networkEndpoints(async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }), "n");
	assert.deepEqual(down, { ok: false, names: [], absent: false });
});

test("no answer is never absence, and a non-object endpoint map fails CLOSED (#357)", () => {
	// Two mutants that survived the first pass, each a hole rather than an equivalent change.
	// (1) a result with NO `code` at all must not fall through to the regex: a runner that answers a shape
	// this rule cannot read has told us nothing, and nothing is not "the network is gone".
	assert.equal(networkAbsentInDaemonWords({ stdout: "network pi-job-x-net not found" }), false, "no code is no answer");
	assert.equal(networkAbsentInDaemonWords({ code: "1", stdout: "network pi-job-x-net not found" }), false, "a non-numeric code is no answer either");
});

test("a .Containers that is not an object is NOT an empty network (#357)", async () => {
	// `JSON.parse("null")` is `null`, and reading that as "no endpoints" makes every caller's attached-guard
	// vacuous rather than cautious. Netavark's rendering is unmeasured, so this is the direction to be wrong in.
	assert.deepEqual(await networkEndpoints(async () => ({ code: 0, stdout: "null", stderr: "" }), "n"), { ok: false, names: [], absent: false });
	assert.deepEqual(await networkEndpoints(async () => ({ code: 0, stdout: "[]", stderr: "" }), "n"), { ok: true, absent: false, names: [] }, "an ARRAY is still an object, and an empty one really is empty");
	assert.deepEqual(await networkEndpoints(async () => ({ code: 0, stdout: '"nope"', stderr: "" }), "n"), { ok: false, names: [], absent: false });
});

test("`detached` names what actually happened, never what was attempted (#357)", async () => {
	// It is printed to an operator and logged. A list of attempts would name something still attached as
	// something this sweep removed.
	const run = async (args) => {
		if (args[1] === "disconnect") return { code: args.at(-1) === "stuck" ? 1 : 0, stdout: "", stderr: "" };
		if (args[1] === "rm") return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const out = await removeNetworkOrSay(run, { network: "n", detach: ["went", "stuck"] });
	assert.deepEqual(out.detached, ["went"], "the one that did not detach is not claimed");
});

// --- issue #354: the runtime binary seam, and Podman's answers -------------------------------------------------------

test("bin names every spawn of the job-path network helpers and the egress preflight, and defaults to docker (#354)", async () => {
	for (const [seam, want] of [[{ bin: "podman" }, "podman"], [{}, "docker"]]) {
		const calls = [];
		const spawnFn = fakeSpawn(calls, { network: 0, inspect: 1, info: 0 });
		assert.equal(await createJobNetwork(spawnFn, { network: "pi-job-1-net", ...seam }), true);
		await removeJobNetwork(spawnFn, { network: "pi-job-1-net", ...seam });
		assert.equal(await networkExists(spawnFn, "pi-job-1-net", seam), true);
		assert.deepEqual(await makeEgressPreflight({ armed: true, spawnFn, ...seam })(), { proxyMissing: DEFAULT_EGRESS_PROXY });
		assert.equal(calls.length, 7, "create, connect, disconnect, rm, inspect, and the preflight's inspect and info");
		assert.deepEqual([...new Set(calls.map((c) => c.cmd))], [want], JSON.stringify(seam));
	}
	// networkExists keeps its two-argument call shape for every existing caller.
	const calls = [];
	await networkExists(fakeSpawn(calls, { network: 0 }), "n");
	assert.equal(calls[0].cmd, "docker");
});

test("removeNetworkOrSay spells the operator's command with the venue's binary (#354)", async () => {
	const run = async (args) => (args[1] === "rm" ? { code: 1, stdout: "", stderr: "has active endpoints" } : { code: 1, stdout: "", stderr: "Cannot connect" });
	assert.equal((await removeNetworkOrSay(run, { network: "n", bin: "podman" })).command, "podman network rm n");
	assert.equal((await removeNetworkOrSay(run, { network: "n" })).command, "docker network rm n");
});

test("networkEndpoints reads Podman's lowercase name, and a member with neither key is UNREADABLE, never absent (#354)", async () => {
	const answer = (stdout) => networkEndpoints(async () => ({ code: 0, stdout, stderr: "" }), "n");
	// Measured on Podman 5.8.1: `{{json .Containers}}` renders each member with a lowercase `name`.
	assert.deepEqual(await answer('{"c0ffee":{"name":"pi-job-a","interfaces":{}},"beef":{"name":"pi-dispatch-egress-proxy"}}'), { ok: true, absent: false, names: ["pi-job-a", "pi-dispatch-egress-proxy"] });
	assert.deepEqual(await answer('{"a":{"Name":"docker-member"},"b":{"name":"podman-member"}}'), { ok: true, absent: false, names: ["docker-member", "podman-member"] });
	assert.deepEqual(await answer('{"a":{"Name":"both","name":"lower"}}'), { ok: true, absent: false, names: ["both"] }, "docker's key first");
	assert.deepEqual(await answer("{}"), { ok: true, absent: false, names: [] }, "Podman's empty network is still empty");
	// A member this parser cannot name is still a member. Filtering it out would hand every caller an empty list, and
	// an empty list is the licence to detach and remove.
	for (const body of ['{"a":{}}', '{"a":{"Name":""}}', '{"a":{"name":""}}', '{"a":{"Name":7}}', '{"a":null}', '{"a":{"Name":"x"},"b":{"id":"y"}}', '{"a":"pi-job-a"}']) {
		assert.deepEqual(await answer(body), { ok: false, names: [], absent: false }, body);
	}
	// The one case where a non-string under `Name` still names the member: Podman's key beside it.
	assert.deepEqual(await answer('{"a":{"Name":null,"name":"x"}}'), { ok: true, absent: false, names: ["x"] });
});

test("Podman's 'is not connected to network' disconnect wording is NOT the network being gone (#354)", () => {
	// Measured on Podman 5.8.1: disconnecting a container from an EXISTING network it is not on exits 125 ending in
	// `network not found`. The network is there, so reading this as absence would skip or misreport its removal.
	const wording = "Error: container pi-dispatch-egress-proxy is not connected to network pi-job-x-net: network not found";
	assert.equal(networkAbsentInDaemonWords({ code: 125, stdout: "", stderr: wording }), false);
	assert.equal(networkAbsentInDaemonWords({ code: 125, stdout: wording, stderr: "" }), false, "on either stream");
	assert.equal(networkAbsentInDaemonWords({ code: 125, stdout: "", stderr: wording.toUpperCase() }), false, "in any case, like the rule it excludes from");
	// Podman's measured wordings for a network that really is absent still read as absent.
	assert.equal(networkAbsentInDaemonWords({ code: 125, stdout: "", stderr: "Error: unable to find network with name or ID pi-job-x-net: network not found" }), true, "inspect");
	assert.equal(networkAbsentInDaemonWords({ code: 1, stdout: "", stderr: "Error: unable to find network with name or ID pi-job-x-net: network not found" }), true, "rm");
});

// Issue #428: the proxy rules' address deny. Its ORDER is the property, twice over: before every allow, or a listed
// name resolving to the host's loopback is let through; and with `allowed` BEFORE `to_host_local` in the line, or squid
// resolves every name a job asks for, listed or not (`dst` resolves, and squid stops at the first ACL that fails), a
// DNS channel out of an egress-armed job (measured with debug_options 78,3). Read off the shipped file, the worker's
// mirror being pinned byte-identical elsewhere (publish.test.mjs).
test("the proxy denies a listed name resolving to this host's loopback or link-local, first, and resolves no unlisted name (#428)", async () => {
	const { readFileSync } = await import("node:fs");
	const conf = readFileSync(new URL("../../deploy/egress-proxy.conf", import.meta.url), "utf8");
	const lines = conf.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
	const access = lines.filter((line) => line.startsWith("http_access "));
	assert.equal(access[0], "http_access deny allowed to_host_local", "the address deny is the FIRST rule, `allowed` before `to_host_local`");
	assert.equal(access.filter((line) => /\bto_host_local\b/.test(line)).length, 1, "and the only rule naming it");
	const firstAllow = access.findIndex((line) => line.startsWith("http_access allow "));
	assert.ok(firstAllow > 0, "an allow follows it");
	assert.equal(access.at(-1), "http_access deny all");
	const acl = lines.filter((line) => /^acl to_host_local\s/.test(line));
	assert.equal(acl.length, 1, "one definition");
	const listed = acl[0].split(/\s+/).slice(3);
	assert.equal(acl[0].split(/\s+/)[2], "dst");
	assert.deepEqual(listed.sort(), ["0.0.0.0/32", "10.0.2.2/32", "127.0.0.0/8", "169.254.0.0/16", "::/128", "::1", "fe80::/10"].sort());
	// The ACL is defined before the line that uses it (squid refuses an unknown ACL name at parse).
	assert.ok(lines.indexOf(acl[0]) < lines.indexOf(access[0]));
});
