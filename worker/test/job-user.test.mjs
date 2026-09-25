import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DAEMON_FACTS_ARGS,
	DAEMON_FACTS_TIMEOUT_MS,
	decideJobUser,
	JOB_USER_FIX,
	jobUserRefusal,
	makeDaemonFactsReader,
	makeJobUserResolver,
	parseDaemonFacts,
	relabelsPrivateMounts,
	resolveImageUser,
	socketFacts,
} from "../src/job-user.mjs";

// Issue #341. The fixtures are `docker info --format={{json .}}` bodies from the labs (Docker Desktop itself, and
// daemons nested in its LinuxKit VM), trimmed to the keys the parser reads: the full bodies carry proxy and storage fields that have no
// business in a test file. Where a key was not in the saved extract, the comment says where its value comes from.
const BODY = {
	// Measured: Docker Desktop 27.4.0 on macOS (raw body).
	desktop: { ServerVersion: "27.4.0", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=unconfined", "name=cgroupns"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: true },
	// Measured: rootful docker:27-dind (raw body).
	dockerRootful: { ServerVersion: "27.5.1", OperatingSystem: "Alpine Linux v3.21 (containerized)", SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: true, ProductLicense: "Community Engine" },
	// Measured: docker:27-dind-rootless, from the extract of the keys below (ProductLicense was not extracted).
	dockerRootless: { ServerVersion: "27.5.1", OperatingSystem: "Alpine Linux v3.21", SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"], PidsLimit: false, MemoryLimit: false, CpuCfsQuota: false },
	// Measured: rootful Podman 5.8.2 through its Docker API with the real docker CLI (raw body).
	podmanCompatRootful: { ServerVersion: "5.8.2", OperatingSystem: "fedora", SecurityOptions: ["name=seccomp,profile=default"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: false, ProductLicense: "Apache-2.0" },
	// Measured: rootless Podman 5.8.2 the same way, from the extract; ProductLicense was not extracted and is Podman's
	// hard-coded compat value (source), the same one the rootful raw body shows.
	podmanCompatRootless: { ServerVersion: "5.8.2", OperatingSystem: "fedora", SecurityOptions: ["name=seccomp,profile=default", "name=rootless"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: false, ProductLicense: "Apache-2.0" },
	// Measured: podman-docker, rootful and rootless (raw bodies).
	shimRootful: { host: { os: "linux", serviceIsRemote: true, remoteSocket: { path: "unix:///run/podman/podman.sock", exists: true }, security: { rootless: false } } },
	shimRootless: { host: { os: "linux", serviceIsRemote: false, remoteSocket: { path: "/run/user/1234/podman/podman.sock", exists: true }, security: { rootless: true } } },
	// Measured: docker:27-dind with --userns-remap=default (raw body); a 0700 dir was unreadable to every uid inside.
	dockerRemap: { ServerVersion: "27.5.1", OperatingSystem: "Alpine Linux v3.21 (containerized)", SecurityOptions: ["name=seccomp,profile=builtin", "name=userns", "name=cgroupns"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: true, ProductLicense: "Community Engine" },
	// Measured: the docker 27.5.1 CLI with no daemon behind its endpoint EXITS 0 under --format and prints this shape,
	// every server field empty and the dial error in ServerErrors (trimmed; the error names the socket path).
	daemonDown: { ID: "", ServerVersion: "", OperatingSystem: "", SecurityOptions: null, PidsLimit: false, MemoryLimit: false, ServerErrors: ["Cannot connect to the Docker daemon at unix:///nonexistent.sock. Is the docker daemon running?"], ClientInfo: { Version: "27.5.1" } },
};
const facts = (name) => parseDaemonFacts(JSON.stringify(BODY[name]))?.facts;
const answered = (name) => ({ answered: true, facts: facts(name) });
const LOCAL = { local: true, context: "default", endpoint: "unix:///var/run/docker.sock", reason: null, transient: false };
const UNRESOLVED = { local: null, context: null, endpoint: null, reason: "unparseable", transient: false };
const linux = { platform: "linux", release: "6.8.0-45-generic", euid: 1234, egid: 1234 };

test("the facts read is one bounded `docker info --format={{json .}}`", () => {
	assert.deepEqual([...DAEMON_FACTS_ARGS], ["info", "--format={{json .}}"]);
});

test("parseDaemonFacts reads the Docker shape: OS, rootless and userns markers, pid and memory bounds, never CPU", () => {
	assert.deepEqual(facts("dockerRootful"), { shape: "docker", podman: false, os: "Alpine Linux v3.21 (containerized)", rootless: false, selinux: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null, serverVersion: "27.5.1" });
	assert.equal(facts("dockerRootless").rootless, true);
	assert.deepEqual(facts("dockerRootless").bounds, { pids: false, memory: false });
	assert.equal(facts("dockerRemap").userns, true);
	assert.ok(!("cpu" in facts("dockerRootful").bounds), "CPU is never read: Podman reports CpuCfsQuota:false while applying --cpus");
	// A marker is a whole comma-separated part, never a substring of another option.
	assert.equal(parseDaemonFacts(JSON.stringify({ ServerVersion: "1", OperatingSystem: "x", SecurityOptions: ["name=rootlessish", "profile=name=rootless"] })).facts.rootless, false);
});

test("a Podman-served body gets no bounds, from ProductLicense alone or from Podman's own shape", () => {
	assert.equal(facts("podmanCompatRootful").podman, true);
	assert.equal(facts("podmanCompatRootful").bounds, null, "Podman hard-codes PidsLimit and derives MemoryLimit from the root controllers");
	assert.equal(facts("podmanCompatRootless").rootless, true);
	assert.deepEqual(facts("shimRootful"), { shape: "podman", podman: true, os: "linux", rootless: false, selinux: null, userns: false, bounds: null, serviceIsRemote: true, remoteSocketPath: "unix:///run/podman/podman.sock", serverVersion: null }, "the trimmed shim fixture carries no version");
	assert.equal(facts("shimRootless").remoteSocketPath, "/run/user/1234/podman/podman.sock");
	// Only a unix path is kept, because only a unix path is ever statted.
	for (const remote of ["ssh://core:hunter2@10.0.0.5:22/run/podman/podman.sock", "tcp://127.0.0.1:8080", "unix://relative", "run/podman.sock", ""]) {
		const body = { host: { ...BODY.shimRootful.host, remoteSocket: { path: remote } } };
		assert.equal(parseDaemonFacts(JSON.stringify(body)).facts.remoteSocketPath, null, remote);
	}
	assert.equal(facts("desktop").podman, false);
	assert.equal(facts("dockerRootful").podman, false);
});

// Issue #355. Measured through rootful Podman 5.8.1's compat API on an enforcing Fedora 44 host (SecurityOptions verbatim).
const PODMAN_SELINUX_OPTIONS = ["name=seccomp,profile=default", "name=selinux"];

test("parseDaemonFacts reads SELinux in the Docker shape: the measured name=selinux, its absence, and no substring", () => {
	const body = (SecurityOptions) => JSON.stringify({ ...BODY.podmanCompatRootful, ServerVersion: "5.8.1", SecurityOptions });
	assert.equal(parseDaemonFacts(body(PODMAN_SELINUX_OPTIONS)).facts.selinux, true);
	assert.equal(parseDaemonFacts(body(["name=seccomp,profile=default"])).facts.selinux, false, "no marker, measured on the SELinux-off lab");
	assert.equal(parseDaemonFacts(body(undefined)).facts.selinux, false, "a body with no SecurityOptions says nothing enables it");
	assert.equal(parseDaemonFacts(body(["name=selinuxish", "profile=name=selinux"])).facts.selinux, false, "a whole comma-separated part, never a substring");
	assert.equal(facts("dockerRootful").selinux, false);
});

test("parseDaemonFacts reads SELinux in Podman's own shape: selinuxEnabled true, false, or no fact at all", () => {
	const shim = (security) => parseDaemonFacts(JSON.stringify({ host: { ...BODY.shimRootful.host, security } })).facts.selinux;
	assert.equal(shim({ rootless: false, selinuxEnabled: true }), true);
	assert.equal(shim({ rootless: false, selinuxEnabled: false }), false);
	assert.equal(shim({ rootless: false }), null, "absent is not false");
	assert.equal(shim({ rootless: false, selinuxEnabled: "true" }), null, "a string is not a boolean");
});

test("relabelsPrivateMounts: Podman AND SELinux AND a local endpoint AND a Linux worker, nothing less", () => {
	const podmanSelinux = { podman: true, selinux: true };
	const local = { local: true };
	assert.equal(relabelsPrivateMounts(podmanSelinux, local, "linux"), true);
	assert.equal(relabelsPrivateMounts(parseDaemonFacts(JSON.stringify({ ...BODY.podmanCompatRootful, SecurityOptions: PODMAN_SELINUX_OPTIONS })).facts, LOCAL, "linux"), true, "the measured body");
	for (const [label, f, e, platform] of [
		["docker with selinux (out of scope)", { podman: false, selinux: true }, local, "linux"],
		["podman without selinux", { podman: true, selinux: false }, local, "linux"],
		["podman, selinux unknown", { podman: true, selinux: null }, local, "linux"],
		["a remote endpoint", podmanSelinux, { local: false }, "linux"],
		["an unresolved endpoint", podmanSelinux, { local: null }, "linux"],
		["no endpoint", podmanSelinux, undefined, "linux"],
		["no facts", null, local, "linux"],
		["a Podman machine on macOS", podmanSelinux, local, "darwin"],
		["a Podman machine on Windows", podmanSelinux, local, "win32"],
	]) {
		assert.equal(relabelsPrivateMounts(f, e, platform), false, label);
	}
});

test("parseDaemonFacts scans from the last line, skips junk, and returns null for neither shape", () => {
	assert.deepEqual(parseDaemonFacts(`a warning line\n${JSON.stringify(BODY.dockerRootful)}\n`), { facts: facts("dockerRootful") });
	for (const junk of ["", "not json", "[]", "{}", '{"Name":"x"}', "null"]) assert.equal(parseDaemonFacts(junk), null, junk);
	// A Docker shape needs a server version: without one no daemon described itself.
	assert.equal(parseDaemonFacts(JSON.stringify({ ...BODY.dockerRootful, ServerVersion: "" })), null);
	assert.equal(parseDaemonFacts(JSON.stringify({ ...BODY.dockerRootful, ServerVersion: undefined })), null);
});

test("no daemon is not a shape: the CLI's exit-0 body with ServerErrors is unreachable, never facts that decide worker", async () => {
	assert.deepEqual(parseDaemonFacts(JSON.stringify(BODY.daemonDown)), { unreachable: true });
	// ServerErrors wins even over a body that otherwise parses, and its text is never carried anywhere.
	assert.deepEqual(parseDaemonFacts(JSON.stringify({ ...BODY.dockerRootful, ServerErrors: ["x"] })), { unreachable: true });
	assert.deepEqual(parseDaemonFacts(JSON.stringify({ ...BODY.dockerRootful, ServerErrors: [] })), { facts: facts("dockerRootful") });
	const read = await makeDaemonFactsReader({ run: async () => ({ code: 0, stdout: JSON.stringify(BODY.daemonDown), error: null }) })();
	assert.deepEqual(read, { answered: false, reason: "daemon-unreachable", transient: true });
	assert.ok(!JSON.stringify(read).includes("Cannot connect"));
	assert.deepEqual(decideJobUser({ ...linux, endpoint: LOCAL, daemon: read, socket: { uid: 0, gid: 2375 } }), { mode: "unknown", user: null, cause: null, reason: "daemon-unreachable" });
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

test("the default stat is node's statSync, and the resolver's default is the same function", async () => {
	// Pinned against the module's source, because an import renamed as `lstatSync as statSync` would keep every
	// injected-seam test above green while reading a symlinked socket as the link's own owner.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/job-user.mjs", import.meta.url), "utf8");
	assert.match(source, /^import \{ statSync \} from "node:fs";$/m);
	assert.ok(!/lstat/i.test(source.replace(/\/\/.*$|^\s*\*.*$/gm, "")), "no lstat anywhere in the code");
	assert.match(makeJobUserResolver.toString(), /stat = statSync/);
	assert.match(makeJobUserResolver.toString(), /release = osRelease\(\)/, "the WSL row needs the real kernel release by default");
	assert.match(decideJobUser.toString(), /release = osRelease\(\)/);
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
	const remoteBody = { host: { ...BODY.shimRootful.host, remoteSocket: { path: "ssh://core@10.0.0.5:22/run/podman/podman.sock" } } };
	const remote = { answered: true, facts: parseDaemonFacts(JSON.stringify(remoteBody)).facts };
	assert.equal(decideJobUser({ ...linux, endpoint: UNRESOLVED, daemon: remote }).cause, "endpoint-not-local");
	// A remote client whose path IS a unix path is the rootful shim on this host (measured: serviceIsRemote true).
	assert.equal(decideJobUser({ ...linux, endpoint: UNRESOLVED, daemon: answered("shimRootful"), socket: { uid: 0, gid: 2000 } }).mode, "worker");
});

test("an endpoint observed not local is image mode BEFORE the daemon is asked, even when that read is transient", () => {
	const notLocal = { ...LOCAL, local: false, endpoint: "tcp://10.0.0.5:2376" };
	for (const daemon of [answered("dockerRootful"), answered("dockerRootless"), { answered: false, reason: "timeout", transient: true }, { answered: false, reason: "unparseable", transient: false }]) {
		assert.deepEqual(decideJobUser({ ...linux, endpoint: notLocal, daemon }), { mode: "image", user: null, cause: "endpoint-not-local", reason: null }, JSON.stringify(daemon));
	}
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
	assert.deepEqual(resolveImageUser(worker, { capabilities: ["replicas"], euid: 1234, egid: 1234 }), { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" });
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
	assert.deepEqual(Object.keys(JOB_USER_FIX).sort(), ["any-uid-unsupported", "desktop-linux-userns", "docker-group", "root-group", "rootless", "runtime-unreadable", "userns-remap", "worker-is-root"]);
	assert.match(jobUserRefusal("docker-group"), /log out and back in rather than `newgrp docker`/);
	assert.match(jobUserRefusal("any-uid-unsupported"), /does not declare `anyUid`/);
	// No text points at `docs/podman.md`. Written when that page did not exist yet; it does now (`dad1f1d`), and the
	// rule is kept for the reason it still holds: a fix an operator reads in a refusal has to be actionable where they
	// are standing, not a pointer to a page that then has to be found, and doctor's own fix strings are unconstrained.
	for (const [cause, text] of Object.entries(JOB_USER_FIX)) assert.ok(!/docs\/podman\.md/.test(text), cause);
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
	// runtime-unreadable describes an answer, not a daemon: never cached, so a recovered daemon is seen by the next job.
	answer = { answered: false, reason: "unparseable", transient: false };
	assert.equal((await resolve({ endpoint: LOCAL, key: "k3" })).decision.cause, "runtime-unreadable");
	answer = answered("dockerRootful");
	assert.equal((await resolve({ endpoint: LOCAL, key: "k3" })).decision.mode, "worker");
	assert.equal(reads, 5, "runtime-unreadable is asked again");
});

test("with no endpoint, the resolver takes the socket from Podman's own unix path, and a remote path yields no socket", async () => {
	const seen = [];
	const stat = (p) => (seen.push(p), { uid: 0, gid: 2000 });
	const resolve = makeJobUserResolver({ readFacts: async () => answered("shimRootful"), platform: "linux", release: "6.8.0", euid: 1234, egid: 2000, stat });
	const out = await resolve({ endpoint: UNRESOLVED, key: "shim" });
	assert.deepEqual(seen, ["/run/podman/podman.sock"]);
	assert.deepEqual(out.socket, { uid: 0, gid: 2000 });
	assert.equal(out.decision.mode, "worker");
	// The socket's gid then reaches the per-image docker-group row.
	assert.deepEqual(resolveImageUser(out.decision, { capabilities: ["anyUid"], euid: 1234, egid: 2000, socket: out.socket }), { refused: "job-user-unmappable", cause: "docker-group" });
	// A local endpoint's own path wins over whatever the body names.
	seen.length = 0;
	await makeJobUserResolver({ readFacts: async () => answered("shimRootful"), platform: "linux", release: "6.8.0", euid: 1234, egid: 1234, stat })({ endpoint: LOCAL, key: "k" });
	assert.deepEqual(seen, ["/var/run/docker.sock"]);
});

test("an endpoint observed on another machine still decides image before any fact, and the facts are read once for the runtime observations (#345)", async () => {
	let reads = 0;
	const resolve = makeJobUserResolver({ readFacts: async () => (reads++, answered("dockerRootful")), platform: "linux", release: "6.8.0", euid: 1234, egid: 1234, stat: () => ({ uid: 0, gid: 2375 }) });
	const out = await resolve({ endpoint: { ...LOCAL, local: false, endpoint: "tcp://10.0.0.5:2376" }, key: "remote" });
	assert.deepEqual(out.decision, { mode: "image", user: null, cause: "endpoint-not-local", reason: null }, "row 2 still decides, whatever the facts say");
	assert.equal(out.facts.shape, "docker", "and the same read carries the facts the bounds observation needs");
	await resolve({ endpoint: { ...LOCAL, local: false, endpoint: "tcp://10.0.0.5:2376" }, key: "remote" });
	assert.equal(reads, 1, "one read per endpoint state, cached");
});

test("the facts read is bounded longer than the endpoint read, because a busy host's `docker info` is the slow one", () => {
	assert.equal(DAEMON_FACTS_TIMEOUT_MS, 15_000);
	assert.match(makeDaemonFactsReader.toString(), /timeoutMs: DAEMON_FACTS_TIMEOUT_MS/);
});

test("on macOS and Windows the decision is still image, and the one facts read is kept only once it answered (#345)", async () => {
	for (const platform of ["darwin", "win32"]) {
		let reads = 0;
		let answer = { answered: false, reason: "daemon-unreachable", transient: true };
		const resolve = makeJobUserResolver({ readFacts: async () => (reads++, answer), platform, euid: 501, egid: 20 });
		const early = await resolve({ endpoint: LOCAL, key: "k" });
		assert.equal(early.decision.mode, "image", platform);
		assert.deepEqual([early.facts, early.daemon.reason], [null, "daemon-unreachable"]);
		answer = answered("desktop");
		const later = await resolve({ endpoint: LOCAL, key: "k" });
		assert.equal(reads, 2, `${platform}: a daemon still starting is asked again, so Docker Desktop is not left without its bounds facts`);
		assert.equal(later.facts.bounds.pids, true);
		await resolve({ endpoint: LOCAL, key: "k" });
		assert.equal(reads, 2, `${platform}: an answered read is cached`);
	}
});

test("the daemon's version is kept for display only, and only as a short run of version characters (#345)", () => {
	const docker = (ServerVersion) => parseDaemonFacts(JSON.stringify({ ServerVersion, OperatingSystem: "x", SecurityOptions: [] }))?.facts?.serverVersion;
	assert.equal(docker("27.5.1"), "27.5.1");
	assert.equal(docker("28.0.0-rc.1+dev"), "28.0.0-rc.1+dev");
	for (const bad of ["27.5.1 \u001b[2J", "a".repeat(41), "27.5.1\nx"]) assert.equal(docker(bad), null, JSON.stringify(bad));
	const shim = parseDaemonFacts(JSON.stringify({ host: { os: "linux", security: { rootless: false } }, version: { Version: "5.8.2" } }))?.facts;
	assert.equal(shim.serverVersion, "5.8.2");
});
