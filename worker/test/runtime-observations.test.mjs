import assert from "node:assert/strict";
import { test } from "node:test";
import { DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "../src/backends.mjs";
import {
	ESCAPED_KEY,
	FIPS_ENABLED_PATH,
	MOUNT_KEY,
	MOUNT_KEY_SAYS,
	PODMAN_HOOKS_DIRS,
	confFilesIn,
	confKeyFinding,
	fipsFinding,
	hooksFinding,
	observeBounds,
	observeHost,
	observeRuntimeMounts,
	PODMAN_CONTAINERS_CONF_DIRS,
	PODMAN_CONTAINERS_CONF_FILES,
	PODMAN_MOUNTS_CONF,
	TRANSIENT_READ_ERRORS,
	UNREAD_SPELLING,
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
	// A clean docker info that parsed to no known shape is an ANSWER, as the job-user decision treats it: a floor refuses
	// it (exit 2) rather than restarting forever on it (exit 1).
	const unparseable = { answered: false, reason: "unparseable", transient: false };
	assert.deepEqual([observeBounds(unparseable).value, observeRuntimeMounts(unparseable, { fs: hostFs(), sameHost: true }).value], [false, false]);
	assert.match(observeBounds(unparseable).evidence, /answered in a shape nothing here reads \(unparseable\)/);
	const noDocker = { answered: false, reason: "docker-not-found", transient: true };
	assert.deepEqual([observeBounds(noDocker).value, observeRuntimeMounts(noDocker, { fs: hostFs(), sameHost: true }).value], [false, false], "no docker CLI at all is an answer, as the endpoint read treats it, never a restart loop");
	assert.match(observeBounds({ answered: false, reason: "daemon-unreachable" }).evidence, /\(daemon-unreachable\)/);
});

test("runtimeAddsNoMounts: Docker earns it; Podman only with an EMPTY override, no mount key anywhere, readable files and FIPS off (#345)", () => {
	const empty = { [PODMAN_MOUNTS_CONF]: "" };
	assert.equal(observeRuntimeMounts(docker(), { fs: hostFs(), sameHost: true }).value, true, "Docker adds no mounts.conf mounts");
	assert.equal(observeRuntimeMounts(docker(), { fs: hostFs(), sameHost: false }).value, true, "and the files are not needed to say so");
	assert.deepEqual(observeRuntimeMounts(podman(), { fs: hostFs(empty, { [PODMAN_HOOKS_DIRS[1]]: [] }), sameHost: true }), { value: true, evidence: `${PODMAN_MOUNTS_CONF} is empty, no containers.conf sets volumes, mounts, devices or hooks, and no OCI hook is installed` }, "an empty hooks.d, as stock Fedora ships it, changes nothing");
	const cases = [
		["no override (the stock Fedora host)", hostFs(), /does not exist, so Podman mounts the default list/],
		["an override with content", hostFs({ [PODMAN_MOUNTS_CONF]: "/usr/share/rhel/secrets:/run/secrets\n" }), /is not empty/],
		["a comment-only override is not the documented empty file", hostFs({ [PODMAN_MOUNTS_CONF]: "# nothing\n" }), /is not empty/],
		["an unreadable override", hostFs({ [PODMAN_MOUNTS_CONF]: { error: "EACCES" } }), /could not be read \(EACCES\)/],
		["volumes in the main file", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: "[containers]\nvolumes = [\"/srv:/srv\"]\n" }), /containers\.conf sets a volumes, mounts, devices or hooks_dir key/],
		["a quoted mounts key in the vendor file", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[0]]: "[containers]\n  \"mounts\" = []\n" }), /sets a volumes, mounts, devices or hooks_dir key/],
		["a key in the /etc drop-in directory", hostFs({ ...empty, [`${PODMAN_CONTAINERS_CONF_DIRS[0]}/50-site.conf`]: "volumes=[\"/a:/a\"]" }, { [PODMAN_CONTAINERS_CONF_DIRS[0]]: ["50-site.conf"] }), /50-site\.conf sets a volumes, mounts, devices or hooks_dir key/],
		// Issue #448: root's own conf is on the chain now too, as the rootful service reads it.
		["volumes in root's own conf", hostFs({ ...empty, "/root/.config/containers/containers.conf": "volumes = []\n" }), /^\/root\/\.config\/containers\/containers\.conf sets a volumes/],
		["FIPS on", hostFs({ ...empty, [FIPS_ENABLED_PATH]: "1\n" }), /FIPS mode is on/],
		["FIPS unreadable", hostFs({ ...empty, [FIPS_ENABLED_PATH]: { error: "EACCES" } }), /fips_enabled could not be read/],
		["a dotted key at the top level", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: 'containers.volumes = ["/etc/rhsm:/run/secrets:ro"]\n' }), /sets a volumes, mounts, devices or hooks_dir key/],
		["a key inside an inline table", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: 'containers = { volumes = ["/a:/a"] }\n' }), /sets a volumes, mounts, devices or hooks_dir key/],
		["a quoted dotted key", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: '"containers"."volumes" = ["/a:/a"]\n' }), /sets a volumes, mounts, devices or hooks_dir key/],
		["host devices for every container", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: '[containers]\ndevices = ["/dev/fuse"]\n' }), /devices or hooks_dir key/],
		["a hooks directory", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: '[engine]\nhooks_dir = ["/srv/hooks"]\n' }), /devices or hooks_dir key/],
		["an escaped key", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: '"volum\\u0065s" = ["/a:/a"]\n' }), /has an escaped key/],
		["an installed OCI hook", hostFs(empty, { [PODMAN_HOOKS_DIRS[1]]: ["oci-nvidia-hook.json"] }), /hooks\.d holds an OCI hook/],
		["a hook beside other files", hostFs(empty, { [PODMAN_HOOKS_DIRS[0]]: ["README", "x.json"] }), /hooks\.d holds an OCI hook/],
		["an unreadable hooks directory", hostFs(empty, { [PODMAN_HOOKS_DIRS[0]]: "EACCES" }), /hooks\.d could not be read/],
	];
	for (const [label, fs, evidence] of cases) {
		const got = observeRuntimeMounts(podman(), { fs, sameHost: true });
		assert.equal(got.value, false, label);
		assert.match(got.evidence, evidence, label);
	}
	// Gate round 1 of PR #473 (raw 70, 71): an unreadable part of the chain WITHHOLDS the credit, as it always did, the one
	// exception being root's own config home, which is named in the evidence and not judged.
	for (const [label, fs, evidence] of [
		["an unreadable drop-in file", hostFs({ ...empty, [`${PODMAN_CONTAINERS_CONF_DIRS[0]}/x.conf`]: { error: "EACCES" } }, { [PODMAN_CONTAINERS_CONF_DIRS[0]]: ["x.conf"] }), /x\.conf could not be read \(EACCES\)/],
		["an unreadable drop-in directory", hostFs(empty, { [PODMAN_CONTAINERS_CONF_DIRS[0]]: "EACCES" }), /containers\.conf\.d could not be read \(EACCES\)/],
		["an unreadable main file", hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: { error: "EACCES" } }), /containers\.conf could not be read \(EACCES\)/],
	]) {
		const got = observeRuntimeMounts(podman(), { fs, sameHost: true });
		assert.equal(got.value, false, label);
		assert.match(got.evidence, evidence, label);
	}
	const rootOwn = observeRuntimeMounts(podman(), { fs: hostFs({ ...empty, "/root/.config/containers/containers.conf": { error: "EACCES" } }), sameHost: true });
	assert.equal(rootOwn.value, true, "root's own conf unreadable");
	assert.ok(rootOwn.evidence.endsWith("; not read, so not judged: /root/.config/containers/containers.conf (EACCES)"), rootOwn.evidence);
	const commented = hostFs({ ...empty, [PODMAN_CONTAINERS_CONF_FILES[1]]: "[containers]\n# volumes = [\"/srv:/srv\"]\n", [FIPS_ENABLED_PATH]: "0\n", [`${PODMAN_CONTAINERS_CONF_DIRS[0]}/README`]: "volumes = []" }, { [PODMAN_CONTAINERS_CONF_DIRS[0]]: ["README"] });
	assert.equal(observeRuntimeMounts(podman(), { fs: commented, sameHost: true }).value, true, "a commented key, FIPS 0 and a non-.conf file in a drop-in dir change nothing");
	assert.ok(!commented.reads.includes(`${PODMAN_CONTAINERS_CONF_DIRS[0]}/README`), "only *.conf is read from a drop-in dir");
	const rootless = observeRuntimeMounts(podman({ rootless: true }), { fs: hostFs(empty), sameHost: true });
	assert.deepEqual([rootless.value, /rootless Podman, which reads the user's own mounts\.conf first/.test(rootless.evidence)], [false, true], "rootless Podman reads ~/.config first, which this check does not");
	const remote = observeRuntimeMounts(podman(), { fs: hostFs(empty), sameHost: false });
	assert.deepEqual([remote.value, /another machine/.test(remote.evidence)], [false, true], "a Podman whose files are not this host's gets no credit from this host's files");
	assert.equal(observeRuntimeMounts({ answered: false, reason: "timeout" }, { fs: hostFs(empty), sameHost: true }).value, null);
});

test("runtimeAddsNoMounts reads the rootful chain the widening check reads: the unit's CONTAINERS_CONF, and the running-service rule (#448)", () => {
	const at = (files, ctimes = {}) => {
		const fs = hostFs({ [PODMAN_MOUNTS_CONF]: "", "/etc/containers/containers.conf": "", ...files });
		return { ...fs, statSync: (p) => (ctimes[p] !== undefined ? { size: 0, ctimeMs: ctimes[p], mtimeMs: 0 } : { ...fs.statSync(p), ctimeMs: 0 }) };
	};
	const unit = (over = {}) => ({ read: true, loaded: true, running: false, startedAtMs: null, environment: {}, environmentFiles: [], unitPaths: [], modules: [], manager: { read: true, environment: {}, modules: [] }, listen: ["/run/podman/podman.sock"], ...over });
	const named = observeRuntimeMounts(podman(), { fs: at({ "/opt/c.conf": "devices = []\n" }), sameHost: true, unit: unit({ environment: { CONTAINERS_CONF_OVERRIDE: ["/opt/c.conf"] } }) });
	assert.deepEqual([named.value, named.evidence.startsWith("/opt/c.conf sets a volumes")], [false, true], named.evidence);
	// Measured for #448: a volumes key removed while the service ran was still mounted, so a running service older than
	// its chain earns no credit; an idle one, or the same change before it started, does. By change time (gate round 1).
	const running = unit({ running: true, startedAtMs: 5_000 });
	const C = "/etc/containers/containers.conf";
	const stale = observeRuntimeMounts(podman(), { fs: at({}, { [C]: 6_000 }), sameHost: true, unit: running, now: 1_000_000 });
	assert.equal(stale.value, false);
	assert.match(stale.evidence, /^\/etc\/containers\/containers\.conf changed after the running podman\.service started/);
	assert.equal(observeRuntimeMounts(podman(), { fs: at({}, { [C]: 6_000 }), sameHost: true, unit: unit(), now: 1_000_000 }).value, true, "idle");
	assert.equal(observeRuntimeMounts(podman(), { fs: at({}, { [C]: 4_000 }), sameHost: true, unit: running, now: 1_000_000 }).value, true, "older");
	assert.equal(observeRuntimeMounts(podman(), { fs: at({}, { "/etc/containers": 6_000 }), sameHost: true, unit: running, now: 1_000_000 }).value, true, "the directory is not watched");
	assert.match(observeRuntimeMounts(podman(), { fs: at({}, { [C]: 2_000_000 }), sameHost: true, unit: running, now: 1_000_000 }).evidence, /has a change time later than this host's clock/);
	// A chain file seen and then gone during one service start withholds it too (the deletion rule, shared memory).
	const memory = makeRootfulMemory();
	assert.equal(observeRuntimeMounts(podman(), { fs: at({}), sameHost: true, unit: running, now: 1_000_000, memory }).value, true);
	const fsGone = { ...hostFs({ [PODMAN_MOUNTS_CONF]: "" }), statSync: (p) => (p === PODMAN_MOUNTS_CONF ? { size: 0, ctimeMs: 0 } : (() => { throw Object.assign(new Error(p), { code: "ENOENT" }); })()) };
	assert.match(observeRuntimeMounts(podman(), { fs: fsGone, sameHost: true, unit: running, now: 1_000_000, memory }).evidence, /^\/etc\/containers\/containers\.conf was removed after the running podman\.service started/);
	// mounts.conf is read per container (measured), so it is not a watched path.
	assert.equal(observeRuntimeMounts(podman(), { fs: at({}, { [PODMAN_MOUNTS_CONF]: 6_000 }), sameHost: true, unit: running }).value, true, "mounts.conf itself is not watched");
	// A unit that did not answer is named, not a withheld credit; a stat that failed for a moment is the retry.
	const dark = observeRuntimeMounts(podman(), { fs: at({}), sameHost: true, unit: { read: false, reason: "timeout" } });
	assert.deepEqual([dark.value, dark.evidence.endsWith("; not read, so not judged: podman.service (timeout)")], [true, true], dark.evidence);
	const busy = observeRuntimeMounts(podman(), { fs: { ...at({}), statSync: (p) => (p === C ? (() => { throw Object.assign(new Error("x"), { code: "EIO" }); })() : at({}).statSync(p)) }, sameHost: true, unit: running });
	assert.deepEqual([busy.value, busy.reason], [null, "file-unread"]);
	// observeHost hands the unit through.
	const host = observeHost({ endpoint: { local: true, endpoint: "unix:///run/podman/podman.sock" }, daemon: podman(), fs: at({}, { [C]: 6_000 }), unit: running, now: 1_000_000 });
	assert.equal(host.observations[RUNTIME_ADDS_NO_MOUNTS], false);
});

test("the Podman files read are the documented ones, pinned literally (#345)", () => {
	assert.equal(PODMAN_MOUNTS_CONF, "/etc/containers/mounts.conf");
	assert.deepEqual([...PODMAN_CONTAINERS_CONF_FILES], ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
	// Gate round 1 of PR #473: only /etc's drop-ins are read (containers/common v0.67.0, measured on 5.8.1 and 4.9.3).
	assert.deepEqual([...PODMAN_CONTAINERS_CONF_DIRS], ["/etc/containers/containers.conf.d"]);
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

test("MOUNT_KEY finds a volumes or mounts key in every TOML spelling, and nothing in a comment or a longer key (#345)", () => {
	for (const text of ["volumes = []", '  "mounts" = []', "'volumes'=[]", "containers.volumes = []", "containers = { volumes = [] }", "[containers]\nmounts=[\"x\"]", 'annotations = ["volumes = x"]']) {
		assert.equal(MOUNT_KEY.test(text), true, JSON.stringify(text));
	}
	for (const text of ["# volumes = []", "  # mounts = []", "x_volumes = []", "devicevolumes = 1", "volumes_extra = 1", "[volumes]", "volumes"]) {
		assert.equal(MOUNT_KEY.test(text), false, JSON.stringify(text));
	}
	assert.equal(MOUNT_KEY.test('devices = ["/dev/fuse"]') && MOUNT_KEY.test("hooks_dir = []"), true);
	// Round 2, measured honoured by Podman 5.8.2: any letter case, and a `#` inside a string before the key.
	for (const text of ["[containers]\nVolumes = [\"/a:/b\"]", "CONTAINERS.VOLUMES = []", "[containers]\nDevices = [\"/dev/fuse\"]", 'containers = { env = ["X=#"], volumes = [] }', "containers={volumes=[]}", "Hooks_Dir = []"]) {
		assert.equal(MOUNT_KEY.test(text), true, JSON.stringify(text));
	}
	assert.equal(ESCAPED_KEY.test('containers = { env = ["X=#"], "volum\\u0065s" = [] }'), true, "an escaped key after a # inside a string");
	// The stock Fedora containers.conf comments every one of these keys out, so the documented override still earns credit.
	for (const text of ["#devices = []", "#mounts = []", "#volumes = []", "#hooks_dir = [", "#volumes = [\n#  \"/run/secrets:/run/secrets\",\n#]", "   #Volumes=[]"]) {
		assert.equal(MOUNT_KEY.test(text) || ESCAPED_KEY.test(text), false, JSON.stringify(text));
	}
	assert.equal(ESCAPED_KEY.test('"volum\\u0065s" = []'), true, "an escaped key is refused, not decoded");
	for (const text of ['label = "a\\b"', '# "x\\y" = 1', 'volumes = ["C:\\x"]']) assert.equal(ESCAPED_KEY.test(text), false, JSON.stringify(text));
	assert.deepEqual([...PODMAN_HOOKS_DIRS], ["/usr/share/containers/oci/hooks.d", "/etc/containers/oci/hooks.d"]);
});

test("the file helpers the podman venue shares read files by the rootful observation's rule (#354)", () => {
	// Exported so the rootless observation cannot drift from this one's reading: a drop-in directory is listed sorted and
	// `.conf` only, a directory that exists and cannot be listed withholds credit, a missing file is simply not read.
	const fs = hostFs({ "/a.conf": "x = 1\n", "/d/10-b.conf": '[containers]\nvolumes = ["/srv:/srv"]\n', "/d/05-a.conf": "" }, { "/d": ["10-b.conf", "readme", "05-a.conf"], "/locked": "EACCES" });
	assert.deepEqual(confFilesIn(fs, { files: ["/a.conf"], dirs: ["/missing", "/d"] }), { files: ["/a.conf", "/d/05-a.conf", "/d/10-b.conf"] });
	assert.deepEqual(confFilesIn(fs, { files: [], dirs: ["/locked"] }), { finding: { value: false, evidence: "/locked could not be read (EACCES)" } });
	assert.deepEqual(confKeyFinding(fs, ["/nope.conf", "/a.conf", "/d/05-a.conf", "/d/10-b.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: false, evidence: `/d/10-b.conf ${MOUNT_KEY_SAYS}` });
	assert.equal(confKeyFinding(fs, ["/a.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), null);
	// Issue #428: EIO is a moment, not the file, so it is NOT ANSWERED (`null`, retried); EACCES is the file's own
	// permissions and stays a withheld credit (`false`), the precedent.
	assert.deepEqual(confKeyFinding(hostFs({ "/e.conf": { error: "EIO" } }), ["/e.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: null, evidence: "/e.conf could not be read (EIO)", reason: "file-unread" });
	assert.deepEqual(confKeyFinding(hostFs({ "/e.conf": { error: "EACCES" } }), ["/e.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: false, evidence: "/e.conf could not be read (EACCES)" });
	assert.equal(fipsFinding(hostFs()), null, "no FIPS file is FIPS off");
	assert.equal(fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: "0\n" })), null);
	assert.equal(fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: "1\n" })).value, false);
	assert.equal(fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: { error: "EACCES" } })).value, false);
	assert.equal(hooksFinding(hostFs({}, { [PODMAN_HOOKS_DIRS[0]]: ["README"] })), null);
	assert.match(hooksFinding(hostFs({}, { [PODMAN_HOOKS_DIRS[1]]: ["x.json"] })).evidence, /holds an OCI hook/);
});

// Issue #428: three spellings Podman's TOML reads as a key and these patterns do not. Refused in the SHARED helper, so
// every conf key (MOUNT_KEY here, CGROUPS_KEY and WIDENING_KEY through the podman venue) withholds credit on them. Each
// fixture is built from escapes, never a literal non-ASCII byte in this file.
test("confKeyFinding withholds credit on a non-ASCII character or a multi-line string, which hide a key from the pattern (#428)", () => {
	const at = (text) => confKeyFinding(hostFs({ "/c.conf": text }), ["/c.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS });
	for (const [label, text] of [
		// Go's EqualFold folds U+017F LONG S to `s`; a JS /i regex does not, so `volume\u017f` is invisible to MOUNT_KEY.
		["long s", '[containers]\n"volume\u017f" = ["/:/host"]\n'],
		// A basic multi-line string whose content has a line starting `#`: the pattern skips that "comment" line and the
		// key after it, while TOML reads one inline table.
		["basic multi-line", 'containers = { env = ["""\n# """], volumes = ["/:/host"] }\n'],
		["literal multi-line", "containers = { env = [\'\'\'\n#\'\'\'], volumes = [\"/:/host\"] }\n"],
		// U+2028 and U+2029 are line breaks to a JS regex and ordinary characters to TOML.
		["u2028", 'containers = { env = ["a\u2028# "], volumes = ["/:/host"] }\n'],
		["u2029", 'containers = { env = ["a\u2029# "], volumes = ["/:/host"] }\n'],
		["a byte-order mark", '\ufeff[containers]\n'],
	]) {
		const found = at(text);
		assert.equal(found?.value, false, label);
		assert.match(found.evidence, /^\/c\.conf line \d+ has (a non-ASCII character|a multi-line string \(""" or '''\)), which this check does not decode$/, label);
	}
	// Round 2: the evidence names the FIRST offending line and which of the two it is, so the operator is sent to it.
	assert.deepEqual(at('[containers]\nlog_driver = "journald"\ntz = "caf\u00e9"\n'), { value: false, evidence: "/c.conf line 3 has a non-ASCII character, which this check does not decode", spelling: "non-ascii" });
	assert.deepEqual(at('[containers]\nlabel = """\nx\n"""\n'), { value: false, evidence: `/c.conf line 2 has a multi-line string (""" or '''), which this check does not decode`, spelling: "multi-line" });
	// Every U+0080 to U+00FF character is non-ASCII too, not only the measured ones (a Latin-1 byte read as UTF-8).
	for (let code = 0x80; code <= 0xff; code++) {
		assert.equal(at(`# ${String.fromCharCode(code)}\n`)?.spelling, "non-ascii", `U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
	}
	assert.equal(at("# \u007f\n"), null, "DEL is ASCII");
	// A line holding BOTH is named for its non-ASCII character, the rule `unreadSpelling` states.
	assert.equal(at(`label = """caf\u00e9\n"""\n`)?.spelling, "non-ascii");
	assert.match(at(`label = """caf\u00e9\n"""\n`).evidence, /line 1 has a non-ASCII character/);
	// A file that sets a real key AND has a non-ASCII comment is named for the KEY, which is the actionable fix.
	assert.deepEqual(at('# caf\u00e9\n[containers]\nvolumes = ["/:/host"]\n'), { value: false, evidence: `/c.conf ${MOUNT_KEY_SAYS}` });
	// A plain-ASCII file with a single-quoted string, a double-quoted one and a commented key still passes.
	assert.equal(at('[containers]\n# volumes = ["/:/host"]\nlog_driver = "journald"\ntz = \'local\'\n'), null);
	assert.ok(UNREAD_SPELLING.test("\u017f") && UNREAD_SPELLING.test('"""') && UNREAD_SPELLING.test("\'\'\'") && !UNREAD_SPELLING.test("~ \t\r\n"));
});

test("a conf read that fails for a moment is NOT ANSWERED (null), one that fails for a reason in the file withholds credit (#428)", () => {
	assert.deepEqual([...TRANSIENT_READ_ERRORS].sort(), ["EAGAIN", "EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE", "ENOMEM", "ESTALE", "ETIMEDOUT", "EWOULDBLOCK"]);
	for (const code of TRANSIENT_READ_ERRORS) {
		assert.deepEqual(confKeyFinding(hostFs({ "/c.conf": { error: code } }), ["/c.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: null, evidence: `/c.conf could not be read (${code})`, reason: "file-unread" }, `file ${code}`);
		assert.deepEqual(confFilesIn(hostFs({}, { "/d": code }), { dirs: ["/d"] }), { finding: { value: null, evidence: `/d could not be read (${code})`, reason: "file-unread" } }, `dir ${code}`);
	}
	for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EISDIR", "EXDEV_UNKNOWN"]) {
		assert.equal(confKeyFinding(hostFs({ "/c.conf": { error: code } }), ["/c.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }).value, false, `file ${code}`);
		assert.equal(confFilesIn(hostFs({}, { "/d": code }), { dirs: ["/d"] }).finding.value, false, `dir ${code}`);
	}
});

// Round 2 of the #428 review: the transient rule is the ONE rule for every file an observation reads, not only the conf
// chain. Each sibling read with EMFILE is not answered (null, reason file-unread); with EACCES it stays a refusal.
test("every host file an observation reads is not answered on a transient error, the siblings of the conf chain included (#428)", () => {
	const rootfulPodman = podman();
	const sameHost = { local: true, endpoint: "unix:///run/podman/podman.sock" };
	for (const [code, value] of [["EMFILE", null], ["EIO", null], ["EACCES", false]]) {
		const fips = fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: { error: code } }));
		assert.deepEqual(fips, value === null ? { value: null, evidence: `${FIPS_ENABLED_PATH} could not be read (${code})`, reason: "file-unread" } : { value: false, evidence: `${FIPS_ENABLED_PATH} could not be read (${code})` }, `fips ${code}`);
		assert.equal(hooksFinding(hostFs({}, { [PODMAN_HOOKS_DIRS[1]]: code })).value, value, `hooks ${code}`);
		const mounts = observeRuntimeMounts(rootfulPodman, { fs: hostFs({ [PODMAN_MOUNTS_CONF]: { error: code } }), sameHost: true });
		assert.equal(mounts.value, value, `mounts.conf ${code}`);
		const host = observeHost({ endpoint: sameHost, daemon: rootfulPodman, fs: hostFs({ [PODMAN_MOUNTS_CONF]: { error: code } }) });
		assert.equal(host.observations[RUNTIME_ADDS_NO_MOUNTS], value, `observeHost ${code}`);
		if (value === null) assert.equal(host.reasons[RUNTIME_ADDS_NO_MOUNTS], "file-unread", "the retry names a file, not the daemon");
	}
	assert.equal(observeRuntimeMounts(rootfulPodman, { fs: hostFs({ [PODMAN_MOUNTS_CONF]: "" }), sameHost: true }).value, true, "and a clean host still earns it");
});

// --- issue #448: rootful Podman's containers.conf keys that reach a `local` job ---------------------------------------

import { PODMAN_HARMLESS_KEYS, PODMAN_ROOTFUL_INERT_KEYS, PODMAN_ROOTFUL_WIDENING_KEYS, PODMAN_WIDENING_KEYS } from "../src/backends.mjs";
import {
	PODMAN_MANAGER_ENV_ARGS,
	PODMAN_SERVICE_SHOW_ARGS,
	PODMAN_SOCKET_SHOW_ARGS,
	confWidening,
	expandEnvironmentFilePattern,
	makePodmanServiceReader,
	makeRootfulMemory,
	moduleArgsIn,
	observeRootfulConf,
	parsePodmanServiceShow,
	parseShowEnvironment,
	parseSocketListen,
	parseUnitTimestamp,
	readRootfulService,
	realpathOrSelf,
	rootfulConfChain,
	rootfulConfFix,
	rootfulConfRefusal,
	rootfulConfResidual,
	rootfulConfRetries,
	rootfulConfWidening,
	rootfulPodmanHere,
	runtimesTableSet,
	splitUnitWords,
	stripStockBlocks,
	widenKeyPattern,
} from "../src/runtime-observations.mjs";

/**
 * A host of `{ path: text | { error } }` files and `{ dir: entries | errno }` directories, each path's CHANGE time from
 * `ctimes` (a string there is a stat errno), 0 otherwise.
 */
function rootfulFs(files = {}, dirs = {}, ctimes = {}) {
	const reads = [];
	const fail = (code, p) => {
		throw Object.assign(new Error(`${code}: ${p}`), { code });
	};
	return {
		reads,
		readFileSync: (p) => {
			reads.push(p);
			const got = files[p];
			if (got === undefined) fail("ENOENT", p);
			if (typeof got === "object") fail(got.error, p);
			return got;
		},
		readdirSync: (p) => {
			reads.push(p);
			if (dirs[p] === undefined) fail("ENOENT", p);
			if (typeof dirs[p] === "string") fail(dirs[p], p);
			return dirs[p];
		},
		statSync: (p) => {
			reads.push(p);
			if (typeof ctimes[p] === "string") fail(ctimes[p], p);
			if (ctimes[p] === undefined) {
				if (files[p] !== undefined) return { size: 0, ctimeMs: 0, mtimeMs: 0, isDirectory: () => false };
				// A directory that cannot be LISTED still stats, as on a real host (stat needs only its parent's search bit).
				if (Array.isArray(dirs[p]) || typeof dirs[p] === "string") return { size: 0, ctimeMs: 0, mtimeMs: 0, isDirectory: () => true };
				fail("ENOENT", p);
			}
			// An mtime set back far (cp -p, touch -d) never counts: only the change time does.
			return { size: 0, ctimeMs: ctimes[p], mtimeMs: 0 };
		},
	};
}
const SOCK = "/run/podman/podman.sock";
const UNIT = (over = {}) => ({ read: true, loaded: true, running: false, startedAtMs: null, environment: {}, environmentFiles: [], unitPaths: [], modules: [], manager: { read: true, environment: {}, modules: [] }, listen: [SOCK], ...over });
const RUNNING = (over = {}) => UNIT({ running: true, startedAtMs: 10_000, ...over });
const NOW = 1_000_000;
// Each key as it was measured reaching a rootful local job: M0 and M3 on Fedora 44 / Podman 5.8.1, `apparmor_profile` on
// Ubuntu 24.04 / 4.9.3 (M5), and from `label` on, gate round 1 of PR #473 (raw 72-74) and M6 (`cgroups`).
const ROOTFUL_MEASURED = {
	annotations: '[containers]\nannotations = ["run.oci.keep_original_groups=1"]\n',
	env: '[containers]\nenv = ["PD_X=1"]\n',
	helper_binaries_dir: '[engine]\nhelper_binaries_dir = ["/var/tmp/gx448/hb", "/usr/libexec/podman"]\n',
	default_sysctls: '[containers]\ndefault_sysctls = ["net.ipv4.ip_unprivileged_port_start=77"]\n',
	default_ulimits: '[containers]\ndefault_ulimits = ["nofile=333:333"]\n',
	userns: '[containers]\nuserns = "auto"\n',
	pidns: '[containers]\npidns = "host"\n',
	ipcns: '[containers]\nipcns = "host"\n',
	utsns: '[containers]\nutsns = "host"\n',
	cgroupns: '[containers]\ncgroupns = "host"\n',
	netns: '[containers]\nnetns = "host"\n',
	seccomp_profile: '[containers]\nseccomp_profile = "/var/tmp/gx448m/seccomp.json"\n',
	apparmor_profile: '[containers]\napparmor_profile = "unconfined"\n',
	init_path: '[containers]\ninit_path = "/var/tmp/gx448m/catatonit-marked"\n',
	dns_servers: '[containers]\ndns_servers = ["9.9.9.9"]\n',
	dns_options: '[containers]\ndns_options = ["ndots:7"]\n',
	dns_searches: '[containers]\ndns_searches = ["gx448.invalid"]\n',
	base_hosts_file: '[containers]\nbase_hosts_file = "/var/tmp/gx448m/hosts"\n',
	label: "[containers]\nlabel = false\n",
	cgroup_conf: '[containers]\ncgroup_conf = ["pids.max=max"]\n',
	host_containers_internal_ip: '[containers]\nhost_containers_internal_ip = "10.99.99.99"\n',
	runtimes: '[engine.runtimes]\ncrun = ["/opt/gx473/bin/crun-wrap"]\n',
	conmon_path: '[engine]\nconmon_path = ["/opt/gx473/bin/conmon-wrap"]\n',
	cgroups: '[containers]\ncgroups = "disabled"\n',
};
const ROOTFUL_INERT = {
	pasta_options: '[network]\npasta_options = ["--map-host-loopback", "169.254.1.2"]\n',
	network_cmd_options: '[engine]\nnetwork_cmd_options = ["allow_host_loopback=true"]\n',
	network_cmd_path: '[engine]\nnetwork_cmd_path = "/var/tmp/gx448/hb/slirp4netns"\n',
	default_capabilities: '[containers]\ndefault_capabilities = ["CHOWN", "NET_RAW", "SYS_ADMIN", "SYS_PTRACE"]\n',
	no_new_privileges: '[containers]\nno_new_privileges = false\n',
	init: '[containers]\ninit = false\n',
	oom_score_adj: '[containers]\noom_score_adj = 777\n',
	pids_limit: '[containers]\npids_limit = 77\n',
	shm_size: '[containers]\nshm_size = "7m"\n',
	privileged: '[containers]\nprivileged = true\n',
	env_host: "[containers]\nenv_host = true\n",
	umask: '[containers]\numask = "0000"\n',
	http_proxy: "[containers]\nhttp_proxy = true\n",
};
// Reached the job on both venues and hosts, and moved no boundary (M6, gate raw 73): documented, never refused.
const HARMLESS = { tz: '[containers]\ntz = "Asia/Tokyo"\n', no_hosts: "[containers]\nno_hosts = true\n" };

test("the rootful key lists decide every PODMAN_WIDENING_KEYS key and every measured key once, each with its row (#448)", () => {
	assert.deepEqual([...PODMAN_ROOTFUL_WIDENING_KEYS], Object.keys(ROOTFUL_MEASURED));
	assert.deepEqual([...PODMAN_ROOTFUL_INERT_KEYS], Object.keys(ROOTFUL_INERT));
	assert.deepEqual([...PODMAN_HARMLESS_KEYS], Object.keys(HARMLESS));
	const all = [...PODMAN_ROOTFUL_WIDENING_KEYS, ...PODMAN_ROOTFUL_INERT_KEYS, ...PODMAN_HARMLESS_KEYS];
	for (const key of PODMAN_WIDENING_KEYS) assert.ok(all.includes(key), key);
	assert.equal(new Set(all).size, all.length, "no key is decided twice");
	// A longer key that only starts like a refused one is not it: init_path is refused, init is inert, userns_size is neither.
	assert.equal(widenKeyPattern(PODMAN_ROOTFUL_WIDENING_KEYS).exec("[containers]\ninit = false\nuserns_size = 1\nnetns_x = 1\nlabel_users = []\ncgroups_x = 1\n"), null);
	for (const [key, text] of Object.entries(HARMLESS)) assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": text }), unit: UNIT(), now: NOW }).refusal, null, key);
});

test("the [engine.runtimes] table is refused when it sets a runtime, and the stock header alone is not (#448)", () => {
	for (const text of ['[engine.runtimes]\ncrun = ["/x"]\n', "[engine]\nruntimes.crun = []\n", "engine.runtimes.crun = []\n", '[ engine . "runtimes" ]\nx = 1\n', "[engine.runtimes.crun]\n", "[engine]\nruntimes = { crun = [] }\n", "[ENGINE.RUNTIMES]\nCRUN = []\n"]) {
		assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": text }), unit: UNIT(), now: NOW }).refusal?.key, "runtimes", text);
	}
	// Fedora 44's stock layout: the header, every entry commented, the next table.
	// The table is exactly [engine.runtimes]: a neighbour whose name only starts the same (`runtimes_flags`) is not it.
	for (const text of ["[engine.runtimes]\n#crun = [\n#  \"/usr/bin/crun\",\n#]\n[engine.runtimes_flags]\n", "[engine.runtimes_flags]\ncrun = [\"--x\"]\n", "[engine]\nruntime = \"crun\"\n[engine.runtimes]\n\n[engine.volume_plugins]\nx = 1\n"]) {
		assert.equal(runtimesTableSet(text), false, text);
		assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": text }), unit: UNIT(), now: NOW }).refusal, null, text);
	}
});

test("the vendor's own default_sysctls block is accepted exactly as it ships; any other value or spelling is refused (#448)", () => {
	const at = (text) => rootfulConfWidening({ fs: rootfulFs({ "/usr/share/containers/containers.conf": text }), unit: UNIT(), now: NOW }).refusal;
	assert.equal(at('[containers]\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n]\nlog_driver = "journald"\n'), null);
	assert.equal(at('[containers]\ndefault_sysctls = ["net.ipv4.ping_group_range=0 0"]\n'), null);
	for (const text of [
		'[containers]\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n  "net.ipv4.ip_unprivileged_port_start=0",\n]\n',
		'[containers]\ndefault_sysctls = ["net.ipv4.ping_group_range=0 2147483647"]\n',
		'[containers]\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n]\ncontainers.default_sysctls = ["kernel.x=1"]\n',
		"[containers]\ndefault_sysctls = ['net.ipv4.ping_group_range=0 0']\n",
	]) assert.equal(at(text)?.key, "default_sysctls", text);
	assert.equal(stripStockBlocks('a\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n]\nb').split("\n").length, 5, "line numbers are kept");
});

test("confWidening: the first file setting a key, named; an unreadable file refused unless the caller may leave it unread (#448)", () => {
	const says = { env: "sets env, which X", annotations: "sets annotations, which Y" };
	const fs = rootfulFs({ "/a.conf": "[containers]\n#env = []\n", "/b.conf": "ANNOTATIONS = []\n", "/c.conf": "env = []\n", "/locked.conf": { error: "EACCES" }, "/root/x.conf": { error: "EACCES" }, "/busy.conf": { error: "EMFILE" } });
	assert.deepEqual(confWidening(fs, ["/nope.conf", "/a.conf", "/b.conf", "/c.conf"], { keys: ["annotations", "env"], says }), { value: false, key: "annotations", evidence: "/b.conf sets annotations, which Y" });
	assert.equal(confWidening(fs, ["/a.conf"], { keys: ["env"], says }), null);
	assert.deepEqual(confWidening(fs, ["/locked.conf", "/c.conf"], { keys: ["env"], says }), { value: false, evidence: "/locked.conf could not be read (EACCES)", key: null });
	const unread = [];
	const nameable = (p) => p.startsWith("/root/");
	assert.equal(confWidening(fs, ["/root/x.conf", "/c.conf"], { keys: ["env"], says, unread, nameable }).key, "env", "a nameable path is collected, and the scan goes on");
	assert.deepEqual(unread, [{ path: "/root/x.conf", code: "EACCES" }]);
	assert.deepEqual(confWidening(fs, ["/locked.conf", "/c.conf"], { keys: ["env"], says, unread: [], nameable }), { value: false, evidence: "/locked.conf could not be read (EACCES)", key: null }, "any other unreadable path refuses");
	assert.equal(confWidening(fs, ["/busy.conf"], { keys: ["env"], says, unread: [] }).value, null, "a transient code is never collected: it is retried");
	assert.equal(confWidening(rootfulFs({ "/e.conf": '"en\\u0076" = []\n' }), ["/e.conf"], { keys: ["env"], says }).spelling, "escaped");
	assert.equal(widenKeyPattern(["env"]).exec("env_host = true\n"), null, "never a longer key");
	assert.equal(widenKeyPattern(["env"]).exec("engine.env = []\n")?.[1], "env");
});

test("systemctl show podman.service is parsed for the four variables, every --module, its unit files, state and start (#448)", () => {
	assert.deepEqual([...PODMAN_SERVICE_SHOW_ARGS.slice(0, 3)], ["show", "podman.service", "--timestamp=us+utc"]);
	assert.ok(PODMAN_SERVICE_SHOW_ARGS.includes("ExecStart"));
	// Fedora 44's stock unit, as measured, with a running service.
	const fedora = "LoadState=loaded\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/podman.service\nDropInPaths=/usr/lib/systemd/system/service.d/10-timeout-abort.conf\nExecMainStartTimestamp=Mon 2026-09-28 06:18:14.656913 UTC\nEnvironment=LOGGING=--log-level=info\nEnvironmentFiles=\nExecStart={ path=/usr/bin/podman ; argv[]=/usr/bin/podman $LOGGING system service ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n";
	assert.deepEqual(parsePodmanServiceShow(fedora), { loaded: true, running: true, startedAtMs: Date.UTC(2026, 8, 28, 6, 18, 14) + 656.913, environment: {}, environmentFiles: [], unitPaths: ["/usr/lib/systemd/system/podman.service", "/usr/lib/systemd/system/service.d/10-timeout-abort.conf"], modules: [] });
	// Gate round 1 (raw 72): --module through LOGGING, and one on the argv itself.
	const withModule = parsePodmanServiceShow('LoadState=loaded\nActiveState=inactive\nEnvironment="LOGGING=--log-level=info --module=/var/tmp/gx473/mod.conf" CONTAINERS_CONF=/etc/c.conf SECRET=x\nExecStart={ path=/usr/bin/podman ; argv[]=/usr/bin/podman $LOGGING --module rel.conf system service ; ignore_errors=no }\n');
	assert.deepEqual(withModule.modules, ["rel.conf", "/var/tmp/gx473/mod.conf"]);
	assert.deepEqual(withModule.environment, { CONTAINERS_CONF: ["/etc/c.conf"] }, "nothing else the unit carries is kept");
	const set = parsePodmanServiceShow('LoadState=loaded\nActiveState=inactive\nExecMainStartTimestamp=\nEnvironment=LOGGING=--log-level=info CONTAINERS_CONF=/etc/c.conf "CONTAINERS_CONF_OVERRIDE=/etc/o v.conf" HOME=/srv/root SECRET=x\nEnvironmentFiles=/etc/sysconfig/podman (ignore_errors=yes)\nEnvironmentFiles=/etc/podman.d/*.env (ignore_errors=no)\n');
	assert.deepEqual(set.environment, { CONTAINERS_CONF: ["/etc/c.conf"], CONTAINERS_CONF_OVERRIDE: ["/etc/o v.conf"], HOME: ["/srv/root"] });
	assert.deepEqual([set.running, set.startedAtMs, set.environmentFiles], [false, null, ["/etc/sysconfig/podman", "/etc/podman.d/*.env"]]);
	assert.equal(parsePodmanServiceShow("LoadState=not-found\nActiveState=inactive\n").loaded, false);
	assert.equal(parsePodmanServiceShow("nothing\n"), null);
	for (const state of ["active", "reloading", "deactivating", "activating", "refreshing"]) assert.equal(parsePodmanServiceShow(`LoadState=loaded\nActiveState=${state}\n`).running, true, state);
	for (const state of ["inactive", "failed", ""]) assert.equal(parsePodmanServiceShow(`LoadState=loaded\nActiveState=${state}\n`).running, false, state);
	assert.deepEqual(splitUnitWords('A=1 "B=two words" C=a\\"b'), ["A=1", "B=two words", 'C=a"b']);
	assert.deepEqual(moduleArgsIn(["--module", "a", "--module=b", "--modulex=c", "--module="]), ["a", "b"]);
	assert.equal(parseUnitTimestamp("Mon 2026-09-28 06:18:14 UTC"), Date.UTC(2026, 8, 28, 6, 18, 14));
	assert.equal(parseUnitTimestamp("n/a"), null);
	// The manager's environment and the socket's listeners.
	assert.deepEqual(parseShowEnvironment("LANG=C\nCONTAINERS_CONF_OVERRIDE=/var/tmp/o.conf\nXDG_CONFIG_HOME=$'/srv/it\\'s'\nLOGGING=--module=m.conf\n"), { environment: { CONTAINERS_CONF_OVERRIDE: ["/var/tmp/o.conf"], XDG_CONFIG_HOME: ["/srv/it's"] }, modules: ["m.conf"] });
	assert.deepEqual(parseSocketListen("Listen=/run/podman/podman.sock (Stream)\nListen=/run/alt.sock (Stream)\n"), ["/run/podman/podman.sock", "/run/alt.sock"]);
});

test("makePodmanServiceReader: three reads, each failing on its own, never a throw (#448)", async () => {
	const answers = {
		[PODMAN_SERVICE_SHOW_ARGS.join(" ")]: { code: 0, stdout: "LoadState=loaded\nActiveState=inactive\n", error: null },
		[PODMAN_MANAGER_ENV_ARGS.join(" ")]: { code: 0, stdout: "CONTAINERS_CONF=/m.conf\n", error: null },
		[PODMAN_SOCKET_SHOW_ARGS.join(" ")]: { code: 0, stdout: "Listen=/run/podman/podman.sock (Stream)\n", error: null },
	};
	const ok = await makePodmanServiceReader({ run: async (args) => answers[args.join(" ")] })();
	assert.deepEqual([ok.read, ok.loaded, ok.manager, ok.listen], [true, true, { read: true, environment: { CONTAINERS_CONF: ["/m.conf"] }, modules: [] }, ["/run/podman/podman.sock"]]);
	const partial = await makePodmanServiceReader({ run: async (args) => (args[0] === "show" && args[1] === "podman.service" ? answers[args.join(" ")] : { code: 1, stdout: "", error: { code: 1 } }) })();
	assert.deepEqual([partial.read, partial.manager, partial.listen], [true, { read: false, reason: "exit-1" }, { reason: "exit-1" }]);
	assert.deepEqual(await makePodmanServiceReader({ run: async () => ({ code: null, stdout: "", error: { code: "ENOENT" } }) })(), { read: false, reason: "systemctl-not-found" });
	assert.deepEqual(await makePodmanServiceReader({ run: async () => ({ code: null, stdout: "", error: { timedOut: true } }) })(), { read: false, reason: "timeout" });
	assert.deepEqual(await makePodmanServiceReader({ run: async () => ({ code: 0, stdout: "garbage", error: null }) })(), { read: false, reason: "unparseable" });
	assert.deepEqual(await makePodmanServiceReader({ run: async () => { throw new Error("spawn"); } })(), { read: false, reason: "spawn-failed" });
});

test("rootfulConfWidening refuses each measured key in every place of the service's chain, and no inert key anywhere (#448)", () => {
	// [label, place, fs extras, unit, env, facts]
	const places = [
		["the vendor file", "/usr/share/containers/containers.conf"],
		["the /etc file", "/etc/containers/containers.conf"],
		["a drop-in in /etc/containers/containers.conf.d", "/etc/containers/containers.conf.d/50-site.conf", { dirs: { "/etc/containers/containers.conf.d": ["50-site.conf", "README"] } }],
		["root's own file (passwd home)", "/root/.config/containers/containers.conf"],
		["root's own drop-in", "/root/.config/containers/containers.conf.d/9.conf", { dirs: { "/root/.config/containers/containers.conf.d": ["9.conf"] } }],
		["root's own file at a passwd home that is not /root", "/var/roothome/.config/containers/containers.conf", { files: { "/etc/passwd": "root:x:0:0:root:/var/roothome:/bin/bash\n" } }],
		["the unit's HOME", "/srv/r/.config/containers/containers.conf", {}, UNIT({ environment: { HOME: ["/srv/r"] } })],
		["the unit's XDG_CONFIG_HOME", "/cfg/containers/containers.conf", {}, UNIT({ environment: { XDG_CONFIG_HOME: ["/cfg"] } })],
		["the unit's CONTAINERS_CONF", "/opt/c.conf", {}, UNIT({ environment: { CONTAINERS_CONF: ["/opt/c.conf"] } })],
		["the unit's CONTAINERS_CONF_OVERRIDE", "/opt/o.conf", {}, UNIT({ environment: { CONTAINERS_CONF_OVERRIDE: ["/opt/o.conf"] } })],
		["an EnvironmentFile's CONTAINERS_CONF", "/opt/f.conf", { files: { "/etc/sysconfig/podman": '# x\nexport CONTAINERS_CONF="/opt/f.conf"\n' } }, UNIT({ environmentFiles: ["/etc/sysconfig/podman"] })],
		["a wildcard EnvironmentFile's CONTAINERS_CONF", "/opt/w.conf", { files: { "/etc/podman.d/b.env": "CONTAINERS_CONF_OVERRIDE=/opt/w.conf\n" }, dirs: { "/etc/podman.d": ["a.txt", "b.env"] } }, UNIT({ environmentFiles: ["/etc/podman.d/*.env"] })],
		["the manager's CONTAINERS_CONF_OVERRIDE", "/var/tmp/m.conf", {}, UNIT({ manager: { read: true, environment: { CONTAINERS_CONF_OVERRIDE: ["/var/tmp/m.conf"] }, modules: [] } })],
		["an absolute --module", "/var/tmp/gx473/mod.conf", {}, UNIT({ modules: ["/var/tmp/gx473/mod.conf"] })],
		["a relative --module under /etc", "/etc/containers/containers.conf.modules/m.conf", {}, UNIT({ modules: ["m.conf"] })],
		["a relative --module under /usr/share", "/usr/share/containers/containers.conf.modules/m.conf", {}, UNIT({ modules: ["m.conf"] })],
		["a --module from an EnvironmentFile", "/var/tmp/e.conf", { files: { "/etc/sysconfig/podman": 'LOGGING="--log-level=info --module=/var/tmp/e.conf"\n' } }, UNIT({ environmentFiles: ["/etc/sysconfig/podman"] })],
		["a --module from the manager", "/var/tmp/g.conf", {}, UNIT({ manager: { read: true, environment: {}, modules: ["/var/tmp/g.conf"] } })],
		["podman-docker's own CONTAINERS_CONF", "/w/c.conf", {}, UNIT(), { CONTAINERS_CONF: "/w/c.conf" }, { shape: "podman" }],
	];
	for (const [key, text] of Object.entries(ROOTFUL_MEASURED)) {
		for (const [label, path, extra = {}, unit = UNIT(), env = {}, facts = { shape: "docker" }] of places) {
			const fs = rootfulFs({ ...(extra.files ?? {}), [path]: text }, extra.dirs ?? {});
			const { refusal, unread } = rootfulConfWidening({ fs, unit, env, facts, now: NOW });
			assert.deepEqual([refusal?.cause, refusal?.key, refusal?.rootful], ["podman-conf-widens-job", key, true], `${key} in ${label}`);
			assert.ok(refusal.evidence.startsWith(`${path} sets `), refusal.evidence);
			assert.deepEqual(unread, [], label);
			assert.match(rootfulConfRefusal(refusal), /^Refused: .*; remove that key from that file, then sudo systemctl restart podman\.service .*\(issue #448\)\.$/);
		}
	}
	// Not on the chain, measured unread by Podman 5.8.1 and 4.9.3 (gate raw 30, M6): /usr/share's drop-ins and both rootful ones.
	for (const dir of ["/usr/share/containers/containers.conf.d", "/usr/share/containers/containers.rootful.conf.d", "/etc/containers/containers.rootful.conf.d"]) {
		assert.equal(rootfulConfWidening({ fs: rootfulFs({ [`${dir}/x.conf`]: ROOTFUL_MEASURED.env }, { [dir]: ["x.conf"] }), unit: UNIT(), now: NOW }).refusal, null, dir);
	}
	// The worker's own CONTAINERS_CONF is not the API service's: through the real docker CLI it is not read.
	assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/w/c.conf": ROOTFUL_MEASURED.env }), unit: UNIT(), env: { CONTAINERS_CONF: "/w/c.conf" }, facts: { shape: "docker" }, now: NOW }).refusal, null);
	for (const [key, text] of Object.entries(ROOTFUL_INERT)) {
		for (const [label, path, extra = {}, unit = UNIT(), env = {}, facts = { shape: "docker" }] of places) {
			const fs = rootfulFs({ ...(extra.files ?? {}), [path]: text }, extra.dirs ?? {});
			assert.equal(rootfulConfWidening({ fs, unit, env, facts, now: NOW }).refusal, null, `${key} in ${label} is measured inert`);
		}
	}
	const odd = rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": '"env\\u0020" = []\n' }), unit: UNIT(), now: NOW }).refusal;
	assert.deepEqual([odd?.key, odd?.spelling], [null, "escaped"]);
	assert.match(rootfulConfFix(odd), /^rewrite that key without a backslash escape/);
});

test("rootfulConfWidening names what it cannot read under root's own config home, and refuses any other unreadable part (#448)", () => {
	// Root's home (and a config home the unit names): named, never refused.
	const lockedRoot = rootfulFs({ "/root/.config/containers/containers.conf": { error: "EACCES" } }, { "/root/.config/containers/containers.conf.d": "EACCES" });
	const got = rootfulConfWidening({ fs: lockedRoot, unit: UNIT(), now: NOW });
	assert.equal(got.refusal, null, "root's home unreadable is never a refusal");
	assert.deepEqual(got.unread, [{ path: "/root/.config/containers/containers.conf", code: "EACCES" }, { path: "/root/.config/containers/containers.conf.d", code: "EACCES" }]);
	assert.match(rootfulConfResidual(got.unread), /^rootful Podman's service may also read \/root\/\.config\/containers\/containers\.conf \(EACCES\), \/root\/\.config\/containers\/containers\.conf\.d \(EACCES\), which this account cannot read/);
	assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/srv/h/.config/containers/containers.conf": { error: "EACCES" } }), unit: UNIT({ environment: { HOME: ["/srv/h"] } }), now: NOW }).refusal, null, "the unit's HOME is a config home too");
	// Gate round 1 (raw 70): a 0600 drop-in in /etc, an unreadable /etc file or drop-in directory, EnvironmentFile or module
	// all REFUSE, key null, naming the path.
	for (const [label, fs, unit, path] of [
		["a 0600 drop-in in /etc", rootfulFs({ "/etc/containers/containers.conf.d/zz.conf": { error: "EACCES" } }, { "/etc/containers/containers.conf.d": ["zz.conf"] }), UNIT(), "/etc/containers/containers.conf.d/zz.conf"],
		["the /etc file", rootfulFs({ "/etc/containers/containers.conf": { error: "EPERM" } }), UNIT(), "/etc/containers/containers.conf"],
		["the /etc drop-in directory", rootfulFs({}, { "/etc/containers/containers.conf.d": "EACCES" }), UNIT(), "/etc/containers/containers.conf.d"],
		["an EnvironmentFile", rootfulFs({ "/etc/sysconfig/podman": { error: "EACCES" } }), UNIT({ environmentFiles: ["/etc/sysconfig/podman"] }), "/etc/sysconfig/podman"],
		["a wildcard EnvironmentFile's directory", rootfulFs({}, { "/etc/podman.d": "EACCES" }), UNIT({ environmentFiles: ["/etc/podman.d/*.env"] }), "/etc/podman.d"],
		["a module", rootfulFs({ "/var/tmp/m.conf": { error: "EACCES" } }), UNIT({ modules: ["/var/tmp/m.conf"] }), "/var/tmp/m.conf"],
		["a CONTAINERS_CONF file", rootfulFs({ "/opt/c.conf": { error: "EACCES" } }), UNIT({ environment: { CONTAINERS_CONF: ["/opt/c.conf"] } }), "/opt/c.conf"],
	]) {
		const r = rootfulConfWidening({ fs, unit, now: NOW });
		assert.deepEqual([r.refusal?.key, r.refusal?.transient, rootfulConfRetries(r.refusal)], [null, undefined, false], label);
		assert.equal(r.refusal.evidence, `${path} could not be read (${label === "the /etc file" ? "EPERM" : "EACCES"})`, label);
		assert.match(rootfulConfFix(r.refusal), /^make that file readable by the worker's account/, label);
	}
	// systemctl that did not answer, a unit not loaded, a running one with no readable start, the manager unread: named.
	for (const [unit, path, code] of [[{ read: false, reason: "systemctl-not-found" }, "podman.service", "systemctl-not-found"], [UNIT({ loaded: false }), "podman.service", "not-loaded"], [UNIT({ running: true, startedAtMs: null }), "podman.service", "start-time-unread"], [UNIT({ manager: { read: false, reason: "timeout" } }), "the systemd manager environment", "timeout"]]) {
		const r = rootfulConfWidening({ fs: rootfulFs(), unit, now: NOW });
		assert.equal(r.refusal, null, code);
		assert.deepEqual(r.unread, [{ path, code }]);
	}
	// A read that failed for a moment, anywhere in the chain, is the retry: transient, never a determinate refusal.
	for (const fs of [rootfulFs({ "/etc/containers/containers.conf": { error: "EMFILE" } }), rootfulFs({}, { "/etc/containers/containers.conf.d": "EIO" }), rootfulFs({ "/etc/e": { error: "EAGAIN" } }), rootfulFs({ "/etc/containers/containers.conf": "" }, {}, { "/etc/containers/containers.conf": "ESTALE" })]) {
		const r = rootfulConfWidening({ fs, unit: RUNNING({ environmentFiles: ["/etc/e"] }), now: NOW });
		assert.deepEqual([r.refusal?.transient, r.refusal?.key], [true, null], JSON.stringify(r));
		assert.match(rootfulConfRefusal(r.refusal), /^Not read yet: .* could not be read \(E[A-Z]+\); the read failed for a moment/);
	}
});

test("the running service is judged by change time: a copy or touch that sets the mtime back is seen, a future one is the clock's (#448)", () => {
	const start = 10_000;
	for (const [label, path, extra = {}, unit = RUNNING()] of [
		["the /etc file", "/etc/containers/containers.conf", { files: { "/etc/containers/containers.conf": "[containers]\n" } }],
		["a drop-in directory (a drop-in added, removed or renamed)", "/etc/containers/containers.conf.d", { dirs: { "/etc/containers/containers.conf.d": [] } }],
		["a drop-in file", "/etc/containers/containers.conf.d/1.conf", { files: { "/etc/containers/containers.conf.d/1.conf": "" }, dirs: { "/etc/containers/containers.conf.d": ["1.conf"] } }],
		["root's own file", "/root/.config/containers/containers.conf", { files: { "/root/.config/containers/containers.conf": "" } }],
		["root's own drop-in directory", "/root/.config/containers/containers.conf.d", { dirs: { "/root/.config/containers/containers.conf.d": [] } }],
		["the unit's fragment", "/usr/lib/systemd/system/podman.service", {}, RUNNING({ unitPaths: ["/usr/lib/systemd/system/podman.service"] })],
		["a unit drop-in", "/etc/systemd/system/podman.service.d/env.conf", {}, RUNNING({ unitPaths: ["/etc/systemd/system/podman.service.d/env.conf"] })],
		["an EnvironmentFile", "/etc/sysconfig/podman", { files: { "/etc/sysconfig/podman": "X=1\n" } }, RUNNING({ environmentFiles: ["/etc/sysconfig/podman"] })],
		["a module file", "/var/tmp/mod.conf", { files: { "/var/tmp/mod.conf": "" } }, RUNNING({ modules: ["/var/tmp/mod.conf"] })],
		["the file CONTAINERS_CONF names", "/opt/c.conf", { files: { "/opt/c.conf": "" } }, RUNNING({ environment: { CONTAINERS_CONF: ["/opt/c.conf"] } })],
	]) {
		const newer = rootfulFs(extra.files ?? {}, extra.dirs ?? {}, { [path]: start + 1 });
		const r = rootfulConfWidening({ fs: newer, unit, now: NOW });
		assert.deepEqual([r.refusal?.restart, r.refusal?.key, rootfulConfRetries(r.refusal)], [true, null, true], label);
		assert.ok(r.refusal.evidence.startsWith(`${path} changed after the running podman.service started`), r.refusal.evidence);
		assert.match(rootfulConfRefusal(r.refusal), /^Not run yet: .*; sudo systemctl restart podman\.service while no local job runs.*each local job is held, never refused: it goes back to the queue and is checked again every minute without spending an attempt, and fails, with a comment naming this, only after an hour of holding/);
		assert.equal(rootfulConfWidening({ fs: newer, unit: { ...unit, running: false }, now: NOW }).refusal, null, `${label}, idle`);
		for (const at of [start, start - 1]) assert.equal(rootfulConfWidening({ fs: rootfulFs(extra.files ?? {}, extra.dirs ?? {}, { [path]: at }), unit, now: NOW }).refusal, null, `${label} at ${at}`);
	}
	// Gate round 1 (raw 40): a chain file's DIRECTORY is not watched, so an unrelated edit there refuses nothing.
	for (const dir of ["/etc/containers", "/usr/share/containers", "/root/.config/containers", "/opt"]) {
		assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": "", "/opt/c.conf": "" }, {}, { [dir]: start + 1 }), unit: RUNNING({ environment: { CONTAINERS_CONF: ["/opt/c.conf"] } }), now: NOW }).refusal, null, dir);
	}
	// A change time later than now is the clock's, with its own words, and a retry too.
	const skew = rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": "" }, {}, { "/etc/containers/containers.conf": NOW + 3_600_000 }), unit: RUNNING(), now: NOW });
	assert.deepEqual([skew.refusal?.skew, skew.refusal?.restart, rootfulConfRetries(skew.refusal)], [true, undefined, true]);
	assert.match(skew.refusal.evidence, /^\/etc\/containers\/containers\.conf has a change time later than this host's clock/);
	assert.match(rootfulConfFix(skew.refusal), /^fix this host's clock/);
	// A key refusal outranks the restart one.
	const both = rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": ROOTFUL_MEASURED.env }, {}, { "/etc/containers/containers.conf": start + 5 }), unit: RUNNING(), now: NOW });
	assert.deepEqual([both.refusal.key, both.refusal.restart], ["env", undefined]);
	// A watched path under root's home that cannot be stat'ed is named; anywhere else it refuses.
	const hidden = rootfulConfWidening({ fs: rootfulFs({ "/root/.config/containers/containers.conf": "" }, {}, { "/root/.config/containers/containers.conf": "EACCES" }), unit: RUNNING(), now: NOW });
	assert.deepEqual([hidden.refusal, hidden.unread], [null, [{ path: "/root/.config/containers/containers.conf", code: "EACCES" }]]);
	const blocked = rootfulConfWidening({ fs: rootfulFs({ "/etc/sysconfig/podman": "" }, {}, { "/etc/sysconfig/podman": "EACCES" }), unit: RUNNING({ environmentFiles: ["/etc/sysconfig/podman"] }), now: NOW });
	assert.equal(blocked.refusal?.evidence, "/etc/sysconfig/podman could not be read (EACCES)");
});

test("a chain file this worker saw during one service start and that is gone now is a deletion the service may still hold (#448)", () => {
	const memory = makeRootfulMemory();
	const unit = RUNNING();
	const present = rootfulFs({ "/etc/containers/containers.conf": "[containers]\n" });
	assert.equal(rootfulConfWidening({ fs: present, unit, now: NOW, memory }).refusal, null, "seen, unchanged");
	const gone = rootfulFs({});
	const r = rootfulConfWidening({ fs: gone, unit, now: NOW, memory });
	assert.deepEqual([r.refusal?.restart, rootfulConfRetries(r.refusal)], [true, true]);
	assert.match(r.refusal.evidence, /^\/etc\/containers\/containers\.conf was removed after the running podman\.service started/);
	assert.equal(rootfulConfWidening({ fs: present, unit, now: NOW, memory }).refusal?.restart, true, "sticky while the same service runs");
	assert.equal(rootfulConfWidening({ fs: gone, unit: RUNNING({ startedAtMs: 20_000 }), now: NOW, memory }).refusal, null, "a restart clears it");
	assert.equal(rootfulConfWidening({ fs: gone, unit: UNIT(), now: NOW, memory }).refusal, null, "an idle service holds nothing");
	// With no memory (doctor, one shot) a deletion cannot be seen: the documented residual.
	assert.equal(rootfulConfWidening({ fs: gone, unit, now: NOW }).refusal, null);
});

test("a file seen only while refused, unreadable, or by a mounts observation that returned early is still remembered, so its deletion holds the next job (#448)", () => {
	// Gate round 2 of PR #473 (raw 70, Ubuntu): job 1 refused for `env`, the file removed, job 2 ran while the service,
	// still up, applied `env`. Every early return now follows the memory's write.
	for (const [label, before, unitOver = {}, after = {}, beforeDirs = null] of [
		["refused for a key", { "/etc/containers/containers.conf": ROOTFUL_MEASURED.env }],
		["refused for a key in a drop-in", { "/etc/containers/containers.conf": "[containers]\n", "/etc/containers/containers.conf.d/zz.conf": ROOTFUL_MEASURED.label }],
		["unreadable", { "/etc/containers/containers.conf.d/zz.conf": { error: "EACCES" } }],
		["an unreadable environment file", { "/etc/sysconfig/podman.env": { error: "EACCES" } }, { environmentFiles: ["/etc/sysconfig/podman.env"] }],
		["an unlistable drop-in directory", {}, {}, {}, { "/etc/containers/containers.conf.d": "EACCES" }],
		["a readable environment file naming an override that stays", { "/etc/sysconfig/podman.env": "CONTAINERS_CONF_OVERRIDE=/var/tmp/o.conf\n", "/var/tmp/o.conf": ROOTFUL_MEASURED.env }, { environmentFiles: ["/etc/sysconfig/podman.env"] }, { "/var/tmp/o.conf": "[containers]\n" }],
	]) {
		const memory = makeRootfulMemory();
		const dirs = beforeDirs ?? (Object.keys(before).some((p) => p.startsWith("/etc/containers/containers.conf.d/")) ? { "/etc/containers/containers.conf.d": ["zz.conf"] } : {});
		const unit = RUNNING(unitOver);
		const first = rootfulConfWidening({ fs: rootfulFs(before, dirs), unit, now: NOW, memory });
		assert.ok(first.refusal && !first.refusal.restart, `${label}: refused first, not for the service`);
		const next = rootfulConfWidening({ fs: rootfulFs(after), unit, now: NOW, memory });
		assert.equal(next.refusal?.restart, true, `${label}: the next job is still held after the rm`);
		assert.match(next.refusal.evidence, /was removed after the running podman\.service started/, label);
	}
	// The mounts observation with no mounts.conf (stock Ubuntu) returned before it remembered anything.
	const unit = RUNNING();
	const memory = makeRootfulMemory();
	const daemon = { answered: true, facts: { podman: true, rootless: false } };
	const volumes = rootfulFs({ "/etc/containers/containers.conf": '[containers]\nvolumes = ["/srv:/srv"]\n' });
	assert.equal(observeRuntimeMounts(daemon, { fs: volumes, sameHost: true, unit, now: NOW, memory }).value, false);
	assert.equal(observeRuntimeMounts(daemon, { fs: rootfulFs({ "/etc/containers/mounts.conf": "" }), sameHost: true, unit, now: NOW, memory }).value, false, "the deletion withholds mountSet");
	assert.equal(rootfulConfWidening({ fs: rootfulFs({}), unit, now: NOW, memory }).refusal?.restart, true, "and holds the job");
	// Nothing is remembered from a stopped service, and a file seen then deleted while no service ran holds nothing.
	const idle = makeRootfulMemory();
	rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/containers.conf": ROOTFUL_MEASURED.env }), unit: UNIT(), now: NOW, memory: idle });
	assert.equal(rootfulConfWidening({ fs: rootfulFs({}), unit, now: NOW, memory: idle }).refusal, null);
	// A remembered file no longer in the chain but still on disk is not a deletion.
	const kept = makeRootfulMemory();
	rootfulConfWidening({ fs: rootfulFs({ "/var/tmp/o.conf": "[containers]\n" }), unit: RUNNING({ environment: { CONTAINERS_CONF_OVERRIDE: ["/var/tmp/o.conf"] } }), now: NOW, memory: kept });
	assert.equal(rootfulConfWidening({ fs: rootfulFs({ "/var/tmp/o.conf": "[containers]\n" }), unit, now: NOW, memory: kept }).refusal, null);
});

test("a --module that names no file is unjudgeable and refused; a directory named *.conf in a drop-in directory is skipped, as Podman skips it (#448)", () => {
	// Gate round 2 of PR #473: systemctl prints ExecStart's argv unquoted, so `--module /etc/a b.conf` reads as `/etc/a`.
	const parsed = parsePodmanServiceShow("LoadState=loaded\nActiveState=inactive\nExecStart={ path=/usr/bin/podman ; argv[]=/usr/bin/podman --module /etc/containers/a b.conf system service ; ignore_errors=no }\n");
	assert.deepEqual(parsed.modules, ["/etc/containers/a"]);
	const cut = rootfulConfWidening({ fs: rootfulFs({ "/etc/containers/a b.conf": ROOTFUL_MEASURED.env }), unit: UNIT({ modules: parsed.modules }), now: NOW });
	assert.deepEqual([cut.refusal?.key, cut.refusal?.module, rootfulConfRetries(cut.refusal)], [null, "/etc/containers/a", false]);
	assert.match(rootfulConfRefusal(cut.refusal), /^Refused: podman\.service passes --module \/etc\/containers\/a, which names no file here, so what it loads cannot be judged [^]*; give that module a path with no space/);
	const relative = rootfulConfWidening({ fs: rootfulFs({}), unit: UNIT({ modules: ["gone.conf"] }), now: NOW });
	assert.equal(relative.refusal?.module, "gone.conf", "a relative module found under neither module directory");
	const found = rootfulConfWidening({ fs: rootfulFs({ "/usr/share/containers/containers.conf.modules/m.conf": "[containers]\n" }), unit: UNIT({ modules: ["m.conf"] }), now: NOW });
	assert.equal(found.refusal, null, "a module that exists is judged as a file");
	const daemon = { answered: true, facts: { podman: true, rootless: false } };
	assert.equal(observeRuntimeMounts(daemon, { fs: rootfulFs({ "/etc/containers/mounts.conf": "" }), sameHost: true, unit: UNIT({ modules: ["gone.conf"] }), now: NOW }).value, false, "and withholds mountSet");
	// A directory named x.conf: skipped by the chain and by the native venue's confFilesIn, not refused with EISDIR.
	const withDir = rootfulFs({ "/etc/containers/containers.conf.d/a.conf": "[containers]\n" }, { "/etc/containers/containers.conf.d": ["a.conf", "x.conf"], "/etc/containers/containers.conf.d/x.conf": [] });
	assert.equal(rootfulConfWidening({ fs: withDir, unit: UNIT(), now: NOW }).refusal, null);
	assert.ok(!rootfulConfChain({ fs: withDir, unit: UNIT() }).files.includes("/etc/containers/containers.conf.d/x.conf"));
	assert.deepEqual(confFilesIn(withDir, { dirs: ["/etc/containers/containers.conf.d"] }).files, ["/etc/containers/containers.conf.d/a.conf"]);
});

test("rootfulConfChain reads the service's chain and watches no chain file's parent directory (#448)", () => {
	const chain = rootfulConfChain({ fs: rootfulFs({ "/etc/passwd": "root:x:0:0:root:/root:/bin/bash\n", "/etc/containers/containers.conf": "" }, { "/etc/containers/containers.conf.d": ["b.conf", "a.conf", "x.txt"] }), unit: UNIT({ environment: { CONTAINERS_CONF: ["rel.conf"] }, unitPaths: ["/u/podman.service"], environmentFiles: ["/e"], modules: ["m.conf"] }) });
	assert.deepEqual(chain.files, ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", "/root/.config/containers/containers.conf", "/etc/containers/containers.conf.modules/m.conf", "/usr/share/containers/containers.conf.modules/m.conf", "/rel.conf", "/etc/containers/containers.conf.d/a.conf", "/etc/containers/containers.conf.d/b.conf"]);
	for (const p of ["/etc/containers/containers.conf.d", "/u/podman.service", "/e"]) assert.ok(chain.watched.includes(p), p);
	for (const p of ["/etc/containers", "/usr/share/containers", "/root/.config/containers", "/", "/etc/containers/containers.rootful.conf.d", "/root/.config/containers/containers.conf.d"]) assert.ok(!chain.watched.includes(p), p);
	assert.equal(chain.nameable("/root/.config/containers/containers.conf"), true);
	assert.equal(chain.nameable("/etc/containers/containers.conf"), false);
	assert.equal(chain.nameable("/rootkit/x"), false, "a prefix of a config home is not under it");
});

test("expandEnvironmentFilePattern expands systemd's wildcards, as a shell would, hidden entries aside (#448)", () => {
	const fs = rootfulFs({}, { "/": ["etc"], "/etc": ["podman.d", "podman.x"], "/etc/podman.d": [".h.env", "a.env", "b.env", "c.txt", "d1.env"] });
	assert.deepEqual(expandEnvironmentFilePattern(fs, "/etc/podman.d/*.env"), { paths: ["/etc/podman.d/a.env", "/etc/podman.d/b.env", "/etc/podman.d/d1.env"] });
	assert.deepEqual(expandEnvironmentFilePattern(fs, "/etc/podman.d/?.env"), { paths: ["/etc/podman.d/a.env", "/etc/podman.d/b.env"] });
	assert.deepEqual(expandEnvironmentFilePattern(fs, "/etc/podman.d/[ab].env"), { paths: ["/etc/podman.d/a.env", "/etc/podman.d/b.env"] });
	assert.deepEqual(expandEnvironmentFilePattern(fs, "/etc/podman.*/a.env"), { paths: ["/etc/podman.d/a.env", "/etc/podman.x/a.env"] });
	assert.deepEqual(expandEnvironmentFilePattern(fs, "/etc/plain"), { paths: ["/etc/plain"] });
	assert.deepEqual(expandEnvironmentFilePattern(rootfulFs({}, { "/etc": "EACCES" }), "/etc/*.env"), { unreadable: { path: "/etc", code: "EACCES" } });
});

test("rootfulPodmanHere: rootful Podman on a unix socket of this host only; everything else reads and spawns nothing (#448)", async () => {
	const LOCAL = { local: true, endpoint: `unix://${SOCK}` };
	const pd = (over = {}) => podman({ os: "fedora", ...over });
	assert.equal(rootfulPodmanHere({ endpoint: LOCAL, daemon: pd() }), true);
	assert.equal(rootfulPodmanHere({ endpoint: LOCAL, daemon: pd({ rootless: null }) }), true, "an unknown rootless answer fails closed");
	assert.equal(rootfulPodmanHere({ endpoint: { local: null }, daemon: pd({ shape: "podman", remoteSocketPath: SOCK }) }), true, "podman-docker naming a unix socket");
	for (const [label, endpoint, daemon] of [
		["Docker", LOCAL, docker()],
		["rootless Podman", LOCAL, pd({ rootless: true })],
		["a remote endpoint", { local: false, endpoint: "tcp://10.0.0.9:2376" }, pd()],
		["an ssh endpoint", { local: false, endpoint: "ssh://h" }, pd()],
		["an unanswered daemon", LOCAL, { answered: false, reason: "timeout", transient: true }],
		["no daemon read", LOCAL, null],
	]) {
		assert.equal(rootfulPodmanHere({ endpoint, daemon }), false, label);
		const fs = rootfulFs();
		let asked = 0;
		assert.equal(await observeRootfulConf({ endpoint, daemon, fs, readService: async () => (asked++, UNIT()) }), null, label);
		assert.deepEqual([fs.reads, asked], [[], 0], `${label}: byte-unchanged, nothing read or spawned`);
	}
	const thrown = await observeRootfulConf({ endpoint: LOCAL, daemon: pd(), fs: rootfulFs(), readService: async () => { throw new Error("x"); } });
	assert.deepEqual(thrown, { refusal: null, unread: [{ path: "podman.service", code: "spawn-failed" }] });
});

test("podman.service is trusted only for the socket podman.socket listens on; another rootful service is named, its files still judged (#448)", async () => {
	const pd = podman({ os: "fedora" });
	const at = (path) => ({ local: true, endpoint: `unix://${path}` });
	const ownEnv = UNIT({ environment: { CONTAINERS_CONF_OVERRIDE: ["/var/tmp/o.conf"] } });
	assert.equal((await readRootfulService({ endpoint: at(SOCK), daemon: pd, readService: async () => ownEnv })).read, true);
	// Gate round 1 (raw 72): a second service on /run/gx473/alt.sock.
	const alt = await readRootfulService({ endpoint: at("/run/gx473/alt.sock"), daemon: pd, readService: async () => ownEnv });
	assert.equal(alt.read, false);
	assert.match(alt.reason, /^the worker's socket \/run\/gx473\/alt\.sock is not the one podman\.socket listens on \(\/run\/podman\/podman\.sock\)/);
	const judged = await observeRootfulConf({ endpoint: at("/run/gx473/alt.sock"), daemon: pd, fs: rootfulFs({ "/etc/containers/containers.conf": ROOTFUL_MEASURED.env, "/var/tmp/o.conf": ROOTFUL_MEASURED.label }), readService: async () => ownEnv, now: NOW });
	assert.equal(judged.refusal?.key, "env", "the shared files are still judged");
	const clean = await observeRootfulConf({ endpoint: at("/run/gx473/alt.sock"), daemon: pd, fs: rootfulFs({ "/var/tmp/o.conf": ROOTFUL_MEASURED.label }), readService: async () => ownEnv, now: NOW });
	assert.deepEqual([clean.refusal, clean.unread.map((u) => u.path)], [null, ["podman.service"]], "podman.service's own environment is not this service's");
	// Gate round 2 of PR #473: the /var/run spelling of the same socket is resolved, on both sides, before the compare.
	const viaVarRun = (p) => p.replace(/^\/var\/run\//, "/run/");
	assert.equal((await readRootfulService({ endpoint: at("/var/run/podman/podman.sock"), daemon: pd, readService: async () => ownEnv, realpath: viaVarRun })).read, true, "the worker's /var/run spelling");
	assert.equal((await readRootfulService({ endpoint: at(SOCK), daemon: pd, readService: async () => UNIT({ listen: ["/var/run/podman/podman.sock"] }), realpath: viaVarRun })).read, true, "podman.socket's /var/run spelling");
	assert.equal((await readRootfulService({ endpoint: at("/var/run/podman/podman.sock"), daemon: pd, readService: async () => ownEnv, realpath: (p) => p })).read, false, "without the resolve, the strings differ");
	assert.equal(realpathOrSelf("/nonexistent-gx473/podman.sock"), "/nonexistent-gx473/podman.sock", "a path that does not resolve is itself");
	const noListen = await readRootfulService({ endpoint: at(SOCK), daemon: pd, readService: async () => UNIT({ listen: { reason: "timeout" } }) });
	assert.match(noListen.reason, /^podman\.socket not read \(timeout\)/);
	assert.equal((await readRootfulService({ endpoint: { local: null }, daemon: podman({ shape: "podman", remoteSocketPath: `unix://${SOCK}` }), readService: async () => UNIT() })).read, true, "podman-docker's reported socket");
});
