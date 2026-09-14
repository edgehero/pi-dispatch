import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DAEMON_FACTS_ARGS,
	decideJobUser,
	JOB_USER_FIX,
	jobUserRefusal,
	makeDaemonFactsReader,
	makeJobUserResolver,
	parseDaemonFacts,
	resolveImageUser,
	socketFacts,
} from "../src/job-user.mjs";

// Issue #341. The fixtures are `docker info --format={{json .}}` bodies MEASURED in the Phase 0 labs, trimmed to the
// keys the parser reads (the full bodies carry proxy and storage fields that have no business in a test file).
const BODY = {
	desktop: { OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=unconfined", "name=cgroupns"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: true },
	dockerRootful: { OperatingSystem: "Alpine Linux v3.21 (containerized)", SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: true, ProductLicense: "Community Engine" },
	dockerRootless: { OperatingSystem: "Alpine Linux v3.21", SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"], PidsLimit: false, MemoryLimit: false, CpuCfsQuota: false },
	podmanCompatRootful: { OperatingSystem: "fedora", SecurityOptions: ["name=seccomp,profile=default"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: false, ProductLicense: "Apache-2.0" },
	podmanCompatRootless: { OperatingSystem: "fedora", SecurityOptions: ["name=seccomp,profile=default", "name=rootless"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: false, ProductLicense: "Apache-2.0" },
	shimRootful: { host: { os: "linux", serviceIsRemote: true, remoteSocket: { path: "unix:///run/podman/podman.sock", exists: true }, security: { rootless: false } } },
	shimRootless: { host: { os: "linux", serviceIsRemote: false, remoteSocket: { path: "/run/user/1234/podman/podman.sock", exists: true }, security: { rootless: true } } },
	dockerRemap: { OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=userns"], PidsLimit: true, MemoryLimit: true, ProductLicense: "Community Engine" },
};
const facts = (name) => parseDaemonFacts(JSON.stringify(BODY[name]));
const answered = (name) => ({ answered: true, facts: facts(name) });
const LOCAL = { local: true, context: "default", endpoint: "unix:///var/run/docker.sock", reason: null, transient: false };
const UNRESOLVED = { local: null, context: null, endpoint: null, reason: "unparseable", transient: false };
const linux = { platform: "linux", release: "6.8.0-45-generic", euid: 1234, egid: 1234 };

test("the facts read is one bounded `docker info --format={{json .}}`", () => {
	assert.deepEqual([...DAEMON_FACTS_ARGS], ["info", "--format={{json .}}"]);
});

test("parseDaemonFacts reads the Docker shape: OS, rootless and userns markers, pid and memory bounds, never CPU", () => {
	assert.deepEqual(facts("dockerRootful"), { shape: "docker", podman: false, os: "Alpine Linux v3.21 (containerized)", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null });
	assert.equal(facts("dockerRootless").rootless, true);
	assert.deepEqual(facts("dockerRootless").bounds, { pids: false, memory: false });
	assert.equal(facts("dockerRemap").userns, true);
	assert.ok(!("cpu" in facts("dockerRootful").bounds), "CPU is never read: Podman reports CpuCfsQuota:false while applying --cpus");
	// A marker is a whole comma-separated part, never a substring of another option.
	assert.equal(parseDaemonFacts(JSON.stringify({ OperatingSystem: "x", SecurityOptions: ["name=rootlessish", "profile=name=rootless"] })).rootless, false);
});

test("a Podman-served body gets no bounds, from ProductLicense alone or from Podman's own shape", () => {
	assert.equal(facts("podmanCompatRootful").podman, true);
	assert.equal(facts("podmanCompatRootful").bounds, null, "Podman hard-codes PidsLimit and derives MemoryLimit from the root controllers");
	assert.equal(facts("podmanCompatRootless").rootless, true);
	assert.deepEqual(facts("shimRootful"), { shape: "podman", podman: true, os: "linux", rootless: false, userns: false, bounds: null, serviceIsRemote: true, remoteSocketPath: "unix:///run/podman/podman.sock" });
	assert.equal(facts("shimRootless").remoteSocketPath, "/run/user/1234/podman/podman.sock");
	assert.equal(facts("desktop").podman, false);
	assert.equal(facts("dockerRootful").podman, false);
});

test("parseDaemonFacts scans from the last line, skips junk, and returns null for neither shape", () => {
	assert.deepEqual(parseDaemonFacts(`a warning line\n${JSON.stringify(BODY.dockerRootful)}\n`), facts("dockerRootful"));
	for (const junk of ["", "not json", "[]", "{}", '{"Name":"x"}', "null"]) assert.equal(parseDaemonFacts(junk), null, junk);
});

test("the reader: an unparseable clean exit is determinate, every failure to answer is transient and names no CLI text", async () => {
	const read = (result) => makeDaemonFactsReader({ run: async () => result })();
	assert.deepEqual(await read({ code: 0, stdout: JSON.stringify(BODY.dockerRootful), error: null }), { answered: true, facts: facts("dockerRootful") });
	assert.deepEqual(await read({ code: 0, stdout: "garbage", error: null }), { answered: false, reason: "unparseable", transient: false });
	assert.deepEqual(await read({ code: 1, stdout: "", error: { code: 1 } }), { answered: false, reason: "exit-1", transient: true });
	assert.deepEqual(await read({ code: null, stdout: "", error: { timedOut: true } }), { answered: false, reason: "timeout", transient: true });
	assert.deepEqual(await read({ code: null, stdout: "", error: { signal: "SIGKILL" } }), { answered: false, reason: "signal-sigkill", transient: true });
	assert.deepEqual(await read({ code: null, stdout: "", error: { code: "ENOENT" } }), { answered: false, reason: "docker-not-found", transient: true });
	const thrown = await makeDaemonFactsReader({ run: async () => { throw new Error("boom"); } })();
	assert.deepEqual(thrown, { answered: false, reason: "spawn-failed", transient: true });
});

test("socketFacts follows the link (stat, not lstat), takes either spelling, and turns any failure into no fact", () => {
	const seen = [];
	const stat = (p) => (seen.push(p), p === "/run/podman/podman.sock" || p === "/var/run/docker.sock" ? { uid: 0, gid: 2000 } : (() => { throw Object.assign(new Error("x"), { code: "EACCES" }); })());
	assert.deepEqual(socketFacts("unix:///run/podman/podman.sock", { stat }), { uid: 0, gid: 2000 });
	assert.deepEqual(socketFacts("/var/run/docker.sock", { stat }), { uid: 0, gid: 2000 });
	assert.deepEqual(seen, ["/run/podman/podman.sock", "/var/run/docker.sock"]);
	assert.equal(socketFacts("/run/user/1000/docker.sock", { stat }), null);
	for (const notUnix of [null, undefined, "tcp://127.0.0.1:2375", "npipe:////./pipe/docker_engine", "relative.sock"]) assert.equal(socketFacts(notUnix, { stat }), null, String(notUnix));
	assert.match(socketFacts.toString(), /stat = statSync/, "stat, never lstat: /var/run/docker.sock is a symlink on Docker Desktop");
});

test("macOS and Windows keep the image's own user: Docker Desktop maps ownership", () => {
	for (const platform of ["darwin", "win32"]) {
		const d = decideJobUser({ platform, euid: undefined, egid: undefined, endpoint: LOCAL, daemon: { answered: false, transient: true } });
		assert.deepEqual(d, { mode: "image", user: null, cause: "desktop-platform", reason: null }, platform);
	}
});

test("measured labs: each daemon's facts decide the mode the ground truth supports", () => {
	const rootSocket = { uid: 0, gid: 2375 };
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("dockerRootful"), socket: rootSocket }).mode, "worker");
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("dockerRootful"), socket: rootSocket }).user, "1234:1234");
	assert.deepEqual(decideJobUser({ ...linux, euid: 1000, egid: 1000, endpoint: LOCAL, daemon: answered("dockerRootless"), socket: { uid: 1000, gid: 102374 } }), { mode: "unmappable", user: null, cause: "rootless", reason: null });
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("podmanCompatRootful"), socket: { uid: 0, gid: 2000 } }).mode, "worker");
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("podmanCompatRootless"), socket: { uid: 1234, gid: 1234 } }).cause, "rootless");
	assert.equal(decideJobUser({ ...linux, endpoint: UNRESOLVED, daemon: answered("shimRootful"), socket: { uid: 0, gid: 2000 } }).mode, "worker", "the shim resolves no endpoint and must not InfraRetry every job");
	assert.equal(decideJobUser({ ...linux, endpoint: UNRESOLVED, daemon: answered("shimRootless"), socket: null }).cause, "rootless");
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("dockerRemap"), socket: rootSocket }).cause, "userns-remap");
});

test("Docker Desktop on Linux is refused unless the release is WSL, which falls through to the ordinary rows", () => {
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("desktop"), socket: { uid: 1234, gid: 1234 } }).cause, "desktop-linux-userns");
	const wsl = { ...linux, release: "5.15.153.1-microsoft-standard-WSL2" };
	assert.deepEqual(decideJobUser({ ...wsl, endpoint: LOCAL, daemon: answered("desktop"), socket: { uid: 0, gid: 1001 } }), { mode: "worker", user: "1234:1234", cause: null, reason: null });
});

test("an unresolved endpoint with a Docker-shaped body is unknown, and a remote Podman client is not this host's", () => {
	assert.deepEqual(decideJobUser({ ...linux, endpoint: UNRESOLVED, daemon: answered("dockerRootful"), socket: null }), { mode: "unknown", user: null, cause: null, reason: "endpoint-unresolved" });
	const remote = { answered: true, facts: { ...facts("shimRootful"), remoteSocketPath: "ssh://core@10.0.0.5:22/run/podman/podman.sock" } };
	assert.equal(decideJobUser({ ...linux, endpoint: UNRESOLVED, daemon: remote }).cause, "endpoint-not-local");
	assert.equal(decideJobUser({ ...linux, endpoint: { ...LOCAL, local: false }, daemon: answered("dockerRootful") }).cause, "endpoint-not-local");
});

test("no facts: transient is unknown, unparseable is unmappable runtime-unreadable", () => {
	assert.deepEqual(decideJobUser({ ...linux, endpoint: LOCAL, daemon: { answered: false, reason: "timeout", transient: true } }), { mode: "unknown", user: null, cause: null, reason: "timeout" });
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: { answered: false, reason: "unparseable", transient: false } }).cause, "runtime-unreadable");
});

test("the socket-owner row fires only for THIS worker's own socket, never another non-root owner, never for root", () => {
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("podmanCompatRootful"), socket: { uid: 1234, gid: 1234 } }).cause, "rootless", "old Podman compat carries no name=rootless");
	assert.equal(decideJobUser({ ...linux, endpoint: LOCAL, daemon: answered("dockerRootful"), socket: { uid: 4242, gid: 4242 } }).mode, "worker");
	assert.equal(decideJobUser({ ...linux, euid: 0, egid: 0, endpoint: LOCAL, daemon: answered("dockerRootful"), socket: { uid: 0, gid: 0 } }).cause, "worker-is-root");
});

test("undefined process ids never produce a user", () => {
	assert.equal(decideJobUser({ ...linux, euid: undefined, egid: undefined, endpoint: LOCAL, daemon: answered("dockerRootful") }).mode, "unknown");
});

test("resolveImageUser: uid 1001 first, with or without anyUid and whatever its group", () => {
	const worker = { mode: "worker", user: "1001:2375", cause: null, reason: null };
	for (const capabilities of [[], ["anyUid"]]) {
		assert.deepEqual(resolveImageUser(worker, { capabilities, euid: 1001, egid: 2375, socket: { uid: 0, gid: 2375 } }), { user: null, home: null }, JSON.stringify(capabilities));
	}
});

test("resolveImageUser: another uid needs anyUid, and only then do the group rows apply", () => {
	const worker = { mode: "worker", user: "1234:1234", cause: null, reason: null };
	assert.deepEqual(resolveImageUser(worker, { capabilities: ["replicas"], euid: 1234, egid: 1234 }), { refused: "job-image-any-uid-unsupported", cause: null });
	assert.deepEqual(resolveImageUser(worker, { capabilities: ["anyUid"], euid: 1234, egid: 1234, socket: { uid: 0, gid: 2375 } }), { user: "1234:1234", home: "/home/pi" });
	assert.deepEqual(resolveImageUser({ ...worker, user: "1234:0" }, { capabilities: ["anyUid"], euid: 1234, egid: 0 }), { refused: "job-user-unmappable", cause: "root-group" });
	assert.deepEqual(resolveImageUser({ ...worker, user: "1235:2375" }, { capabilities: ["anyUid"], euid: 1235, egid: 2375, socket: { uid: 0, gid: 2375 } }), { refused: "job-user-unmappable", cause: "docker-group" });
	assert.deepEqual(resolveImageUser({ ...worker, user: "1235:2375" }, { capabilities: ["anyUid"], euid: 1235, egid: 2375, socket: null }), { user: "1235:2375", home: "/home/pi" }, "no socket fact, no group row");
});

test("resolveImageUser passes the other modes through", () => {
	assert.deepEqual(resolveImageUser({ mode: "image" }, {}), { user: null, home: null });
	assert.deepEqual(resolveImageUser({ mode: "unmappable", cause: "rootless" }, {}), { refused: "job-user-unmappable", cause: "rootless" });
	assert.deepEqual(resolveImageUser({ mode: "unknown", reason: "timeout" }, {}), { unavailable: true, reason: "timeout" });
});

test("every cause has fixed text, and a refusal carries no CLI output", () => {
	assert.deepEqual(Object.keys(JOB_USER_FIX).sort(), ["desktop-linux-userns", "docker-group", "root-group", "rootless", "runtime-unreadable", "userns-remap", "worker-is-root"]);
	assert.match(jobUserRefusal("docker-group"), /log out and back in rather than `newgrp docker`/);
	assert.match(jobUserRefusal({ cause: "rootless" }), /^Refused: /);
});

test("the resolver caches a decision per key, never caches unknown, and shares one read between concurrent callers", async () => {
	let reads = 0;
	let answer = answered("dockerRootful");
	const resolve = makeJobUserResolver({ readFacts: async () => (reads++, answer), platform: "linux", euid: 1234, egid: 1234, stat: () => ({ uid: 0, gid: 2375 }) });
	const [a, b] = await Promise.all([resolve({ endpoint: LOCAL, key: "k1" }), resolve({ endpoint: LOCAL, key: "k1" })]);
	assert.equal(reads, 1);
	assert.equal(a, b);
	assert.equal(a.decision.mode, "worker");
	assert.deepEqual(a.socket, { uid: 0, gid: 2375 }, "the socket comes from the local endpoint's unix path");
	await resolve({ endpoint: LOCAL, key: "k1" });
	assert.equal(reads, 1, "same key, cached");
	answer = { answered: false, reason: "timeout", transient: true };
	assert.equal((await resolve({ endpoint: LOCAL, key: "k2" })).decision.mode, "unknown");
	assert.equal((await resolve({ endpoint: LOCAL, key: "k2" })).decision.mode, "unknown");
	assert.equal(reads, 3, "unknown is asked again every time");
});

test("the resolver never runs docker on macOS or Windows", async () => {
	let reads = 0;
	const resolve = makeJobUserResolver({ readFacts: async () => (reads++, answered("desktop")), platform: "darwin", euid: 501, egid: 20 });
	assert.equal((await resolve({ endpoint: LOCAL, key: "k" })).decision.mode, "image");
	assert.equal(reads, 0);
});
