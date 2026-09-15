import assert from "node:assert/strict";
import { test } from "node:test";
import { DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "../src/backends.mjs";
import {
	FIPS_ENABLED_PATH,
	observeBounds,
	observeHost,
	observeRuntimeMounts,
	PODMAN_CONTAINERS_CONF_DIRS,
	PODMAN_CONTAINERS_CONF_FILES,
	PODMAN_MOUNTS_CONF,
	podmanOnThisHost,
	runtimeObservationKey,
} from "../src/runtime-observations.mjs";

const docker = (over = {}) => ({ answered: true, facts: { shape: "docker", podman: false, os: "Ubuntu 24.04", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null, ...over } });
const podman = (over = {}) => docker({ podman: true, bounds: null, ...over });
const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

/** A host filesystem of `{ path: string | { error } }` files and `{ dir: [entries] }` directories; everything else is absent. */
function hostFs(files = {}, dirs = {}) {
	const reads = [];
	const at = (path) => {
		const got = files[path];
		if (got === undefined) throw enoent(path);
		if (typeof got === "object") throw Object.assign(new Error(got.error), { code: got.error });
		return got;
	};
	return {
		reads,
		readFileSync: (path) => (reads.push(path), at(path)),
		statSync: (path) => ({ size: Buffer.byteLength(at(path)) }),
		readdirSync: (dir) => {
			if (dirs[dir] === undefined) throw enoent(dir);
			if (typeof dirs[dir] === "string") throw Object.assign(new Error(dirs[dir]), { code: dirs[dir] });
			return dirs[dir];
		},
	};
}

test("daemonAppliesBounds: credit only for a rootful, non-Podman daemon reporting both bounds; an unread daemon is unanswered (#345)", () => {
	assert.deepEqual(observeBounds(docker()), { value: true, evidence: "the daemon reports PidsLimit and MemoryLimit" });
	for (const [label, read, evidence] of [
		["rootless", docker({ rootless: true }), /rootless/],
		["Podman", podman(), /Podman, whose Docker API reports PidsLimit and MemoryLimit whether or not/],
		["Podman even when both booleans are true", podman({ bounds: { pids: true, memory: true } }), /Podman/],
		["no pids bound", docker({ bounds: { pids: false, memory: true } }), /reports PidsLimit false/],
		["neither bound", docker({ bounds: { pids: false, memory: false } }), /reports PidsLimit and MemoryLimit false/],
	]) {
		const got = observeBounds(read);
		assert.equal(got.value, false, label);
		assert.match(got.evidence, evidence, label);
	}
	for (const read of [{ answered: false, reason: "timeout", transient: true }, null, undefined, { answered: true, facts: null }]) {
		assert.equal(observeBounds(read).value, null, JSON.stringify(read));
	}
	assert.match(observeBounds({ answered: false, reason: "daemon-unreachable" }).evidence, /\(daemon-unreachable\)/);
});

test("runtimeAddsNoMounts: Docker earns it; Podman only with an EMPTY override, no mount key anywhere, readable files and FIPS off (#345)", () => {
	const empty = { [PODMAN_MOUNTS_CONF]: "" };
	assert.equal(observeRuntimeMounts(docker(), { fs: hostFs(), sameHost: true }).value, true, "Docker adds no mounts.conf mounts");
	assert.equal(observeRuntimeMounts(docker(), { fs: hostFs(), sameHost: false }).value, true, "and the files are not needed to say so");
	assert.deepEqual(observeRuntimeMounts(podman(), { fs: hostFs(empty), sameHost: true }), { value: true, evidence: `${PODMAN_MOUNTS_CONF} is empty and no containers.conf sets volumes or mounts` });
	const cases = [
		["no override (the stock Fedora host)", hostFs(), /does not exist, so Podman mounts the default list/],
		["an override with content", hostFs({ [PODMAN_MOUNTS_CONF]: "/usr/share/rhel/secrets:/run/secrets\n" }), /is not empty/],
		["a comment-only override is not the documented empty file", hostFs({ [PODMAN_MOUNTS_CONF]: "# nothing\n" }), /is not empty/],
		["an unreadable override", hostFs({ [PODMAN_MOUNTS_CONF]: { error: "EACCES" } }), /could not be read \(EACCES\)/],
		["volumes in the main file", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: "[containers]\nvolumes = [\"/srv:/srv\"]\n" }), /containers\.conf sets a volumes or mounts key/],
		["a quoted mounts key in the vendor file", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[0]]: "[containers]\n  \"mounts\" = []\n" }), /sets a volumes or mounts key/],
		["a key in a rootful drop-in", hostFs({ ...empty, [`${PODMAN_CONTAINERS_CONF_DIRS[3]}/50-site.conf`]: "volumes=[\"/a:/a\"]" }, { [PODMAN_CONTAINERS_CONF_DIRS[3]]: ["50-site.conf"] }), /50-site\.conf sets a volumes or mounts key/],
		["an unreadable drop-in file", hostFs({ ...empty, [`${PODMAN_CONTAINERS_CONF_DIRS[1]}/x.conf`]: { error: "EACCES" } }, { [PODMAN_CONTAINERS_CONF_DIRS[1]]: ["x.conf"] }), /x\.conf could not be read/],
		["an unreadable drop-in directory", hostFs(empty, { [PODMAN_CONTAINERS_CONF_DIRS[0]]: "EACCES" }), /containers\.conf\.d could not be read/],
		["an unreadable main file", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: { error: "EACCES" } }), /containers\.conf could not be read/],
		["FIPS on", hostFs({ ...empty, [FIPS_ENABLED_PATH]: "1\n" }), /FIPS mode is on/],
		["FIPS unreadable", hostFs({ ...empty, [FIPS_ENABLED_PATH]: { error: "EACCES" } }), /fips_enabled could not be read/],
	];
	for (const [label, fs, evidence] of cases) {
		const got = observeRuntimeMounts(podman(), { fs, sameHost: true });
		assert.equal(got.value, false, label);
		assert.match(got.evidence, evidence, label);
	}
	const commented = hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: "[containers]\n# volumes = [\"/srv:/srv\"]\n", [FIPS_ENABLED_PATH]: "0\n", [`${PODMAN_CONTAINERS_CONF_DIRS[1]}/README`]: "volumes = []" }, { [PODMAN_CONTAINERS_CONF_DIRS[1]]: ["README"] });
	assert.equal(observeRuntimeMounts(podman(), { fs: commented, sameHost: true }).value, true, "a commented key, FIPS 0 and a non-.conf file in a drop-in dir change nothing");
	assert.ok(!commented.reads.includes(`${PODMAN_CONTAINERS_CONF_DIRS[1]}/README`), "only *.conf is read from a drop-in dir");
	const remote = observeRuntimeMounts(podman(), { fs: hostFs(empty), sameHost: false });
	assert.deepEqual([remote.value, /another machine/.test(remote.evidence)], [false, true], "a Podman whose files are not this host's gets no credit from this host's files");
	assert.equal(observeRuntimeMounts({ answered: false, reason: "timeout" }, { fs: hostFs(empty), sameHost: true }).value, null);
});

test("the Podman files read are the documented ones, pinned literally (#345)", () => {
	assert.equal(PODMAN_MOUNTS_CONF, "/etc/containers/mounts.conf");
	assert.deepEqual([...PODMAN_CONTAINERS_CONF_FILES], ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
	assert.deepEqual([...PODMAN_CONTAINERS_CONF_DIRS], ["/usr/share/containers/containers.conf.d", "/etc/containers/containers.conf.d", "/usr/share/containers/containers.rootful.conf.d", "/etc/containers/containers.rootful.conf.d"]);
	assert.equal(FIPS_ENABLED_PATH, "/proc/sys/crypto/fips_enabled");
});

test("podmanOnThisHost reads the socket's form: a local unix endpoint, or podman-docker naming a unix socket even when it calls the service remote (#345)", () => {
	assert.equal(podmanOnThisHost({ endpoint: { local: true, endpoint: "unix:///run/podman/podman.sock" }, facts: podman().facts }), true);
	assert.equal(podmanOnThisHost({ endpoint: { local: true, endpoint: "tcp://127.0.0.1:2375" }, facts: podman().facts }), false, "a loopback TCP port could be anything");
	assert.equal(podmanOnThisHost({ endpoint: { local: false, endpoint: "ssh://build" }, facts: podman().facts }), false);
	assert.equal(podmanOnThisHost({ endpoint: { local: null }, facts: { shape: "podman", serviceIsRemote: true, remoteSocketPath: "unix:///run/podman/podman.sock" } }), true, "measured: the rootful shim says serviceIsRemote true for the local service");
	assert.equal(podmanOnThisHost({ endpoint: { local: null }, facts: { shape: "podman", serviceIsRemote: true, remoteSocketPath: null } }), false, "a tcp service keeps no path");
});

test("observeHost gives every observation the table names, with evidence and the reason an unanswered one was not answered (#345)", () => {
	const fs = hostFs({ [PODMAN_MOUNTS_CONF]: "" });
	const local = { local: true, endpoint: "unix:///var/run/docker.sock" };
	const held = observeHost({ endpoint: local, daemon: docker(), fs });
	assert.deepEqual(held.observations, { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: true, [RUNTIME_ADDS_NO_MOUNTS]: true });
	assert.deepEqual(held.reasons, {});
	assert.deepEqual(Object.keys(held.evidence).sort(), [DAEMON_APPLIES_BOUNDS, RUNTIME_ADDS_NO_MOUNTS].sort());
	const down = observeHost({ endpoint: { local: null, transient: true, reason: "timeout" }, daemon: { answered: false, reason: "daemon-unreachable", transient: true }, fs });
	assert.deepEqual(down.observations, { [DOCKER_ENDPOINT_LOCAL]: null, [DAEMON_APPLIES_BOUNDS]: null, [RUNTIME_ADDS_NO_MOUNTS]: null });
	assert.deepEqual(down.reasons, { [DOCKER_ENDPOINT_LOCAL]: "timeout", [DAEMON_APPLIES_BOUNDS]: "daemon-unreachable", [RUNTIME_ADDS_NO_MOUNTS]: "daemon-unreachable" });
	assert.equal(observeHost({ endpoint: { local: null, transient: false, reason: "unparseable" }, daemon: docker(), fs }).observations[DOCKER_ENDPOINT_LOCAL], false, "a determinate endpoint failure is an answer");
	assert.equal(observeHost({ endpoint: { local: false }, daemon: docker(), fs }).observations[DOCKER_ENDPOINT_LOCAL], false);
	const shim = observeHost({ endpoint: { local: null, transient: false }, daemon: { answered: true, facts: { shape: "podman", podman: true, rootless: false, bounds: null, serviceIsRemote: true, remoteSocketPath: "unix:///run/podman/podman.sock" } }, fs });
	assert.deepEqual([shim.observations[DAEMON_APPLIES_BOUNDS], shim.observations[RUNTIME_ADDS_NO_MOUNTS]], [false, true], "the shim's own files are this host's");
	assert.equal(runtimeObservationKey(held), "true|true");
	assert.equal(runtimeObservationKey(down), "null|null");
});
