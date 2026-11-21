// Issue #978: the canary's leftover sweep finds its probe containers by NAME, in every state, and removes those of a pid
// that is dead (or our own), before any network; the in-image gh probe's step does the same for its own containers. Driven over a fake daemon that answers the way the real CLI
// does, line for line: `ps --format {{.Names}}\t{{.State}}` rows, a `network inspect` member map that lists RUNNING
// members only (a `created` one is absent from it and its network's `rm` succeeds around it, measured on docker 27.4.0
// under #337), a plain `rm` that refuses a running container, and an `rm -f` of a missing name that exits 0 (measured
// on Docker 28.0.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CANARY_LINES, CANARY_PROBE_LIST_PREFIXES, GH_PROBE_LIST_PREFIXES, GH_PROBE_PREFIX, egressCanaryProbeArgs, probeListArgs, runEgressCanary, sweepStaleCanaryNetworks, sweepStaleGhProbes } from "../src/doctor.mjs";
import { podmanArgsFromSpec } from "../src/docker-run.mjs";
import { EGRESS_CANARY_PROBE_PREFIX } from "../src/egress.mjs";

const NET = "pi-dispatch-egress-doctor-4242";
const PROXY = "pi-dispatch-egress-proxy";
const ENGINE_FACTS = JSON.stringify({ ServerVersion: "28.0.4", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"], PidsLimit: true, MemoryLimit: true });
const LISTED_STATES = new Set(["running", "paused"]);

/**
 * A daemon holding `networks` (names) and `containers` (`{ name, state, networks, listedAs, row }`): `listedAs` is what the
 * listing says when the container moved on before the removal reached it, `row` a listing line written out whole (a
 * shape the parser must refuse), and `refuse` the names whose removal the daemon refuses whatever the flag. Podman's
 * members come from `ps -a --filter network=`, which is not modelled here (these podman cases hold no network).
 */
function daemon({ networks = [], containers = [], refuse = [] } = {}) {
	const nets = new Set(networks);
	const ctrs = new Map(containers.map((c) => [c.name, { networks: [], ...c }]));
	const calls = [];
	const filterValues = (args, key) => args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith(`${key}=`) ? [a.slice(key.length + 1)] : []));
	const answer = (code, stdout = "", stderr = "") => ({ code, stdout, stderr, ended: "close" });
	const run = async (args) => {
		calls.push(args.join(" "));
		const [verb, sub] = args;
		if (verb === "network" && sub === "ls") {
			const [value] = filterValues(args, "name");
			return answer(0, [...nets].filter((n) => n.includes(value)).map((n) => `${n}\n`).join(""));
		}
		if (verb === "ps") {
			// The name filter is a SUBSTRING match, and one key given twice is OR (docker and podman alike).
			const values = filterValues(args, "name");
			return answer(0, [...ctrs.values()].filter((c) => values.some((v) => c.name.includes(v))).map((c) => `${c.row ?? `${c.name}\t${c.listedAs ?? c.state}`}\n`).join(""));
		}
		if (verb === "network" && sub === "inspect") {
			const net = args.at(-1);
			if (!nets.has(net)) return answer(1, "", `Error response from daemon: network ${net} not found\n`);
			const members = Object.fromEntries([...ctrs.values()].filter((c) => c.networks.includes(net) && LISTED_STATES.has(c.state)).map((c, i) => [`${String(i + 1).repeat(12)}`, { Name: c.name, EndpointID: "e".repeat(64), MacAddress: "02:42:ac:12:00:02", IPv4Address: "172.18.0.2/16", IPv6Address: "" }]));
			return answer(0, `${JSON.stringify(members)}\n`);
		}
		if (verb === "info") return answer(0, `${ENGINE_FACTS}\n`);
		if (verb === "rm") {
			const name = args.at(-1);
			const force = args[1] === "-f";
			const c = ctrs.get(name);
			if (!c) return force ? answer(0) : answer(1, "", `Error response from daemon: No such container: ${name}\n`);
			if (refuse.includes(name)) return answer(1, "", `Error response from daemon: removal of container ${name} is already in progress\n`);
			if (!force && LISTED_STATES.has(c.state)) return answer(1, "", `Error response from daemon: cannot remove container "/${name}": container is running: stop the container before removing or force remove\n`);
			ctrs.delete(name);
			return answer(0, `${name}\n`);
		}
		if (verb === "network" && sub === "disconnect") {
			const c = ctrs.get(args.at(-1));
			if (c) c.networks = c.networks.filter((n) => n !== args.at(-2));
			return answer(0);
		}
		if (verb === "network" && sub === "rm") {
			const net = args.at(-1);
			if ([...ctrs.values()].some((c) => c.networks.includes(net) && LISTED_STATES.has(c.state))) return answer(1, "", `Error response from daemon: error while removing network: network ${net} id 0123456789ab has active endpoints\n`);
			nets.delete(net);
			return answer(0, `${net}\n`);
		}
		return answer(99, "", "unmodelled");
	};
	return { run, calls, has: (name) => ctrs.has(name), hasNetwork: (name) => nets.has(name) };
}

const owned = { local: true };
const tableLine = (check) => `${check.canary.params.bin ? `${check.canary.params.bin}: ` : ""}Egress canary: ${CANARY_LINES[check.canary.shape].label(check.canary.params)}`;
/** Podman's CLI over the same daemon model: its `rm -f` carries `--time=0`, which the model reads as docker's `rm -f`. */
const asPodman = (d) => async (args) => {
	if (args[0] === "rm" && args[1] === "-f") assert.deepEqual(args.slice(0, 3), ["rm", "-f", "--time=0"]);
	return d.run(args[0] === "rm" && args[2] === "--time=0" ? ["rm", "-f", args[3]] : args);
};

test("each probe listing is every state, by its own name prefix, in ps --format fields both runtimes document (#978)", () => {
	assert.deepEqual(probeListArgs(CANARY_PROBE_LIST_PREFIXES), ["ps", "-a", "--filter", `name=${EGRESS_CANARY_PROBE_PREFIX}`, "--format", "{{.Names}}\t{{.State}}"]);
	assert.deepEqual(probeListArgs(GH_PROBE_LIST_PREFIXES), ["ps", "-a", "--filter", "name=pi-dispatch-gh-probe-", "--format", "{{.Names}}\t{{.State}}"]);
	assert.equal(GH_PROBE_PREFIX, "pi-dispatch-gh-probe-");
});

test("a dead doctor's probe left created, whose network is gone, is removed by name with a plain rm; the gh probe is its own step's (#978)", async () => {
	const d = daemon({ containers: [{ name: "pi-dispatch-egress-probe-provider-4242", state: "created", networks: [NET] }, { name: "pi-dispatch-gh-probe-4242", state: "created" }] });
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(d.calls.filter((c) => c.startsWith("rm ")), ["rm pi-dispatch-egress-probe-provider-4242"], "never started, so a plain rm, never -f");
	assert.equal(d.has("pi-dispatch-egress-probe-provider-4242"), false);
	assert.equal(d.has("pi-dispatch-gh-probe-4242"), true, "the canary does not list what it did not make");
	assert.deepEqual(checks.map((c) => c.label), ["Egress canary: removed pi-dispatch-egress-probe-provider-4242, left by an EARLIER doctor run"]);
	assert.deepEqual(checks.map((c) => [c.ok, c.canary.shape]), [[true, "probesRemoved"]]);
	assert.equal(checks[0].label, tableLine(checks[0]), "built from the table");
});

test("a dead doctor's created probe on its network goes first, by name, and then the network (#978)", async () => {
	// The shape a doctor killed between create and start leaves: the proxy running on the network, a probe that never
	// started (absent from docker's member map), and one that ran. Before issue #978 the network's `rm` succeeded around
	// the created one and stranded it for good.
	const d = daemon({
		networks: [NET],
		containers: [
			{ name: PROXY, state: "running", networks: ["pi-dispatch-egress-out", NET] },
			{ name: "pi-dispatch-egress-probe-provider-4242", state: "created", networks: [NET] },
			{ name: "pi-dispatch-egress-probe-unlisted-4242", state: "running", networks: [NET] },
		],
	});
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(d.calls, [
		"network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
		"ps -a --filter name=pi-dispatch-egress-probe- --format {{.Names}}\t{{.State}}",
		"rm pi-dispatch-egress-probe-provider-4242",
		"rm -f pi-dispatch-egress-probe-unlisted-4242",
		`network inspect --format {{json .Containers}} ${NET}`,
		"info --format={{json .}}",
		`network disconnect -f ${NET} ${PROXY}`,
		`network rm ${NET}`,
	]);
	assert.equal(d.has("pi-dispatch-egress-probe-provider-4242"), false, "the probe that never started is gone");
	assert.equal(d.has("pi-dispatch-egress-probe-unlisted-4242"), false);
	assert.equal(d.hasNetwork(NET), false, "and then its network");
	assert.equal(d.has(PROXY), true, "the shared proxy is only detached");
	assert.deepEqual(checks.map((c) => c.label), [`Egress canary: removed ${NET} (after removing pi-dispatch-egress-probe-provider-4242, pi-dispatch-egress-probe-unlisted-4242 and detaching ${PROXY}), left by an EARLIER doctor run`]);
	assert.equal(checks[0].label, tableLine(checks[0]));
});

test("only a name this file builds, for a pid that is dead or our own, is touched; a live pid's probe and a look-alike are left (#978)", async () => {
	const ours = 77;
	const alive = new Set([ours, 4243]);
	const removedNames = ["pi-dispatch-egress-probe-provider-4242", "pi-dispatch-egress-probe-unlisted-77", "pi-dispatch-egress-probe-endpoint-models-ollama-1-4242"];
	const leftNames = [
		"pi-dispatch-egress-probe-provider-4243", // a live doctor's
		"pi-dispatch-egress-probe-provider-0", // pid 0 is the process group to kill(0), so it always reads alive
		"pi-dispatch-egress-probe-provider-04242", // doctor writes a pid with no leading zero, so this is not a name it built
		"pi-dispatch-egress-probe-bogus-4242", // a slug outside the closed set
		"pi-dispatch-egress-probe-provider-4242-extra",
		"my-pi-dispatch-egress-probe-provider-4242",
		"pi-dispatch-gh-probe-4242", // the gh probe's step's, not the canary's
	];
	const d = daemon({ containers: [...removedNames, ...leftNames].map((name) => ({ name, state: "created" })) });
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: ours, isAlive: (p) => p === 0 || alive.has(p), endpoint: owned });
	assert.deepEqual(d.calls.filter((c) => c.startsWith("rm ")).sort(), removedNames.map((n) => `rm ${n}`).sort());
	for (const name of leftNames) assert.equal(d.has(name), true, `${name} is not ours to remove`);
	// One line per pid, in the listing's order: our own pid's leftover is one an earlier process under this number left.
	assert.deepEqual(checks.map((c) => c.label), [
		"Egress canary: removed pi-dispatch-egress-probe-provider-4242, pi-dispatch-egress-probe-endpoint-models-ollama-1-4242, left by an EARLIER doctor run",
		"Egress canary: removed pi-dispatch-egress-probe-unlisted-77, left by an EARLIER doctor run",
	]);
});

test("a listing line that is not a name, a tab and one lowercase state word is left alone, whatever name it carries (#978)", async () => {
	const d = daemon({
		containers: [
			{ name: "pi-dispatch-egress-probe-provider-4242", state: "created", row: "pi-dispatch-egress-probe-provider-4242" },
			{ name: "pi-dispatch-egress-probe-unlisted-4242", state: "exited", row: "pi-dispatch-egress-probe-unlisted-4242\tExited (0) 3 minutes ago" },
			{ name: "pi-dispatch-egress-probe-plainhttp-4242", state: "created", row: "pi-dispatch-egress-probe-plainhttp-4242\tcreated\textra" },
		],
	});
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(d.calls.filter((c) => c.startsWith("rm")), [], "a rendering this parser was not measured against decides nothing");
	assert.deepEqual(checks, []);
	const gh = daemon({ containers: [{ name: "pi-dispatch-gh-probe-4242", state: "created", row: "pi-dispatch-gh-probe-4242" }, { name: "pi-dispatch-gh-probe-4243", state: "exited", row: "pi-dispatch-gh-probe-4243\tExited" }] });
	assert.deepEqual(await sweepStaleGhProbes({ run: gh.run, pid: 1, isAlive: () => false }), { checks: [], stuck: [] });
	assert.deepEqual(gh.calls.filter((c) => c.startsWith("rm")), []);
});

test("a remote endpoint lists no probe and removes nothing: its networks are named, as before (#978)", async () => {
	const d = daemon({ networks: [NET], containers: [{ name: "pi-dispatch-egress-probe-provider-4242", state: "created", networks: [NET] }, { name: "pi-dispatch-egress-probe-unlisted-4242", state: "exited" }] });
	const endpoint = { local: false, endpoint: "tcp://build.example.invalid:2376", display: "tcp://build.example.invalid:2376" };
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint });
	assert.deepEqual(d.calls, ["network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}"], "the network listing only");
	assert.equal(d.has("pi-dispatch-egress-probe-provider-4242"), true);
	assert.equal(d.has("pi-dispatch-egress-probe-unlisted-4242"), true);
	assert.deepEqual(checks.map((c) => c.canary.shape), ["foreign"]);
	// An endpoint nothing resolved is not shown local either.
	const unknown = daemon({ containers: [{ name: "pi-dispatch-egress-probe-unlisted-4242", state: "exited" }] });
	assert.deepEqual(await sweepStaleCanaryNetworks({ run: unknown.run, pid: 1, isAlive: () => false, endpoint: { local: null, reason: "not resolved" } }), []);
	assert.deepEqual(unknown.calls, ["network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}"]);
});

test("a running probe takes rm -f, a stopped one a plain rm, and one that started after the listing is refused and keeps its network (#978)", async () => {
	const d = daemon({
		networks: [NET],
		containers: [
			{ name: "pi-dispatch-egress-probe-provider-4242", state: "running", networks: [NET] },
			{ name: "pi-dispatch-egress-probe-unlisted-4242", state: "exited", networks: [NET] },
			// Listed as never started, running by the time the removal reaches it: a plain rm refuses, so it is not killed.
			{ name: "pi-dispatch-egress-probe-plainhttp-4242", state: "running", listedAs: "created", networks: [NET] },
		],
	});
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(d.calls.filter((c) => c.startsWith("rm ")), ["rm -f pi-dispatch-egress-probe-provider-4242", "rm pi-dispatch-egress-probe-unlisted-4242", "rm pi-dispatch-egress-probe-plainhttp-4242"], "and the refused one is not tried again in the network pass");
	assert.equal(d.has("pi-dispatch-egress-probe-plainhttp-4242"), true);
	assert.equal(d.hasNetwork(NET), true);
	assert.deepEqual(checks.map((c) => [c.ok, c.warn === true, c.label]), [
		[false, true, `Egress canary: ${NET} is kept, because the probe pi-dispatch-egress-probe-plainhttp-4242 on it could not be removed: docker rm -f pi-dispatch-egress-probe-plainhttp-4242`],
		[true, false, "Egress canary: removed pi-dispatch-egress-probe-provider-4242, pi-dispatch-egress-probe-unlisted-4242, left by an EARLIER doctor run"],
	]);
	for (const c of checks) assert.equal(c.label, tableLine(c));
});

test("a probe off any network that will not go is named with the command (#978)", async () => {
	const d = daemon({ containers: [{ name: "pi-dispatch-egress-probe-unlisted-4242", state: "exited" }], refuse: ["pi-dispatch-egress-probe-unlisted-4242"] });
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(checks.map((c) => [c.ok, c.warn === true, c.label]), [[false, true, "Egress canary: pi-dispatch-egress-probe-unlisted-4242, left by an EARLIER doctor run, could not be removed: docker rm -f pi-dispatch-egress-probe-unlisted-4242"]]);
	assert.equal(checks[0].label, tableLine(checks[0]));
	assert.match(checks[0].fix, /the next pi-dispatch doctor on this host tries again/);
});

test("a probe on a network that would not go keeps the network, and is not tried twice in one pass (#978)", async () => {
	const d = daemon({ networks: [NET], containers: [{ name: "pi-dispatch-egress-probe-provider-4242", state: "running", networks: [NET] }] });
	// Every removal ends at its bound, as on a daemon too slow to answer (`liveRunVia`'s timeout answer).
	const removals = [];
	const wedged = async (args) => {
		if (args[0] !== "rm") return d.run(args);
		removals.push(args.join(" "));
		return { code: null, stdout: "", stderr: "", ended: "timeout" };
	};
	const checks = await sweepStaleCanaryNetworks({ run: wedged, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(removals, ["rm -f pi-dispatch-egress-probe-provider-4242"], "one try per pass: each can cost the whole bound");
	assert.deepEqual(checks.map((c) => c.label), [`Egress canary: ${NET} is kept, because the probe pi-dispatch-egress-probe-provider-4242 on it could not be removed: docker rm -f pi-dispatch-egress-probe-provider-4242`]);
	assert.equal(d.hasNetwork(NET), true);
});

test("a probe listing that fails is said, and the network pass still runs as it did (#978)", async () => {
	const d = daemon({ networks: [NET], containers: [{ name: PROXY, state: "running", networks: [NET] }, { name: "pi-dispatch-egress-probe-unlisted-4242", state: "running", networks: [NET] }] });
	const failing = async (args) => (args[0] === "ps" ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n", ended: "close" } : d.run(args));
	const checks = await sweepStaleCanaryNetworks({ run: failing, pid: 1, isAlive: () => false, endpoint: owned });
	assert.deepEqual(checks.map((c) => c.label), [
		"Egress canary: probe containers from an EARLIER doctor run could not be listed: docker ps -a --filter name=pi-dispatch-egress-probe-",
		`Egress canary: removed ${NET} (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching ${PROXY}), left by an EARLIER doctor run`,
	]);
	assert.equal(checks[0].warn, true);
	assert.equal(d.hasNetwork(NET), false);
});

test("on podman created, initialized and stopped take a plain rm, and a running probe podman's rm -f --time=0 (#978)", async () => {
	// libpod prints its `configured` state as `created` and its runtime-created state as `initialized`
	// (define/containerstate.go at 4.9.3 and on main); `stopped` is exited and not yet cleaned up.
	const d = daemon({ containers: [{ name: "pi-dispatch-egress-probe-provider-4242", state: "initialized" }, { name: "pi-dispatch-egress-probe-unlisted-4242", state: "stopped" }, { name: "pi-dispatch-egress-probe-plainhttp-4242", state: "created" }, { name: "pi-dispatch-egress-probe-endpoint-models-hci-4242", state: "running" }] });
	const checks = await sweepStaleCanaryNetworks({ run: asPodman(d), pid: 1, isAlive: () => false, endpoint: owned, bin: "podman" });
	assert.deepEqual(d.calls.filter((c) => c.startsWith("rm ")), ["rm pi-dispatch-egress-probe-provider-4242", "rm pi-dispatch-egress-probe-unlisted-4242", "rm pi-dispatch-egress-probe-plainhttp-4242", "rm -f pi-dispatch-egress-probe-endpoint-models-hci-4242"]);
	assert.deepEqual(checks.map((c) => c.label), ["podman: Egress canary: removed pi-dispatch-egress-probe-provider-4242, pi-dispatch-egress-probe-unlisted-4242, pi-dispatch-egress-probe-plainhttp-4242, pi-dispatch-egress-probe-endpoint-models-hci-4242, left by an EARLIER doctor run"]);
});

// --- the in-image gh probe's own step --------------------------------------------------------------------------------

test("the gh probe's step removes its dead or own pid's leftovers by name, and leaves a live one and every look-alike (#978)", async () => {
	const ours = 77;
	const d = daemon({
		containers: [
			{ name: "pi-dispatch-gh-probe-4242", state: "created" },
			{ name: "pi-dispatch-gh-probe-4244", state: "running" },
			{ name: "pi-dispatch-gh-probe-77", state: "exited" }, // an earlier process under our own number
			{ name: "pi-dispatch-gh-probe-4243", state: "created" }, // a live doctor's
			{ name: "pi-dispatch-gh-probe-099990", state: "created" }, // a leading zero: not a name doctor builds
			{ name: "pi-dispatch-gh-probe-4242x", state: "created" },
			{ name: "pi-dispatch-gh-probe-x-4242", state: "created" }, // text between the prefix and the pid
			{ name: "my-pi-dispatch-gh-probe-4242", state: "created" },
			{ name: "pi-dispatch-gh-probe-0", state: "created" },
			{ name: "pi-dispatch-egress-probe-provider-4242", state: "created" }, // the canary's
		],
	});
	const { checks, stuck } = await sweepStaleGhProbes({ run: d.run, pid: ours, isAlive: (p) => p === 0 || p === ours || p === 4243 });
	assert.deepEqual(d.calls[0], "ps -a --filter name=pi-dispatch-gh-probe- --format {{.Names}}\t{{.State}}");
	assert.deepEqual(d.calls.slice(1), ["rm pi-dispatch-gh-probe-4242", "rm -f pi-dispatch-gh-probe-4244", "rm pi-dispatch-gh-probe-77"]);
	for (const name of ["pi-dispatch-gh-probe-4243", "pi-dispatch-gh-probe-099990", "pi-dispatch-gh-probe-4242x", "pi-dispatch-gh-probe-x-4242", "my-pi-dispatch-gh-probe-4242", "pi-dispatch-gh-probe-0", "pi-dispatch-egress-probe-provider-4242"]) assert.equal(d.has(name), true, name);
	assert.deepEqual(checks, [{ ok: true, label: "in-image gh auth: removed pi-dispatch-gh-probe-4242, pi-dispatch-gh-probe-4244, pi-dispatch-gh-probe-77, left by an EARLIER doctor run" }]);
	assert.deepEqual(stuck, []);
});

test("the gh probe's step says a leftover that will not go and a listing that failed, in its runtime's words (#978)", async () => {
	const d = daemon({ containers: [{ name: "pi-dispatch-gh-probe-4242", state: "created" }], refuse: ["pi-dispatch-gh-probe-4242"] });
	const stuck = await sweepStaleGhProbes({ run: asPodman(d), bin: "podman", pid: 1, isAlive: () => false, where: "podman: " });
	assert.deepEqual(stuck.checks.map((c) => [c.ok, c.warn, c.label]), [[false, true, "podman: in-image gh auth: pi-dispatch-gh-probe-4242, left by an EARLIER doctor run, could not be removed: podman rm -f pi-dispatch-gh-probe-4242"]]);
	assert.deepEqual(stuck.stuck, ["pi-dispatch-gh-probe-4242"], "named back, so the step can tell its own name is held");
	const failing = async () => ({ code: null, stdout: "" });
	const unlisted = await sweepStaleGhProbes({ run: failing, pid: 1, isAlive: () => false });
	assert.deepEqual(unlisted.checks.map((c) => [c.ok, c.warn, c.label]), [[false, true, "in-image gh auth: probes from an EARLIER doctor run could not be listed: docker ps -a --filter name=pi-dispatch-gh-probe-"]]);
	assert.deepEqual(unlisted.stuck, []);
	const running = daemon({ containers: [{ name: "pi-dispatch-gh-probe-4242", state: "running" }] });
	assert.deepEqual((await sweepStaleGhProbes({ run: asPodman(running), bin: "podman", pid: 1, isAlive: () => false, where: "podman: " })).checks.map((c) => c.label), ["podman: in-image gh auth: removed pi-dispatch-gh-probe-4242, left by an EARLIER doctor run"]);
});

// --- the probes' label and the hint an unproved canary gives -----------------------------------------------------------

test("the podman probe's label goes right before the image, and a builder that ends on anything else is refused (#978)", () => {
	const at = { bin: "podman", slug: "provider", pid: 1, network: "pi-dispatch-egress-doctor-1", proxy: PROXY, image: "pi-job:latest", url: "https://api.anthropic.com/v1/messages", user: "1234:1234" };
	const args = egressCanaryProbeArgs(at);
	const image = args.indexOf("pi-job:latest");
	assert.deepEqual(args.slice(image - 1, image + 2), ["--label=pi.dispatch.helper=egress-probe", "pi-job:latest", "-e"]);
	// The splice reads the builder's last token as the image; a builder that ever ends otherwise must fail here, never put
	// the label among the program's arguments.
	assert.throws(() => egressCanaryProbeArgs({ ...at, podmanArgs: (spec) => [...podmanArgsFromSpec(spec), "--extra"] }), /the podman builder's argv does not end with the image/);
	assert.deepEqual(egressCanaryProbeArgs({ ...at, podmanArgs: podmanArgsFromSpec }), args);
});

test("a canary that could not start names both leftover listings in its fix, in its runtime's words (#978)", async () => {
	for (const bin of ["docker", "podman"]) {
		const run = async (args) => (args[0] === "network" && args[1] === "create" ? { code: 1, stdout: "", stderr: "Error response from daemon: something\n", ended: "close" } : { code: 0, stdout: "", stderr: "", ended: "close" });
		const { checks } = await runEgressCanary({ run, bin, proxy: PROXY, image: "pi-job:latest", pid: 1, user: "1234:1234", gate: async () => null });
		const unproved = checks.find((c) => /could not be created/.test(c.label));
		assert.match(unproved.fix, new RegExp(`\`${bin} network ls --filter name=pi-dispatch-egress-doctor-\` lists any leftover blocking it, and \`${bin} ps -a --filter name=pi-dispatch-egress-probe-\` any leftover probe$`));
	}
});
