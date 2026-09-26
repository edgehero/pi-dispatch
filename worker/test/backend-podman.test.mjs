import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ASSERTED, BACKENDS, ENFORCED, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_SERVICE_LOCAL, effectiveWord } from "../src/backends.mjs";
import { CONTAINER_HOME } from "../src/container-spec.mjs";

// backend-podman builds on run-container, which imports env-allowlist -> @earendil-works/pi-ai, so this skips below the
// node floor and runs in CI (PI_DISPATCH_REQUIRE_WORKER_TESTS=1 makes a skip a hard failure), as run-container's own
// tests do.
let mod;
let importError;
try {
	mod = await import("../src/backend-podman.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`backend-podman tests are REQUIRED here but the module could not import.\n${importError}`);
}
const skip = mod ? false : `backend-podman could not import (${importError?.message ?? "unknown"}); CI runs these`;

/** A `podman info --format json` body in the measured shape (rootless 5.8.1, Fedora 44), pretty-printed as podman does. */
function infoBody(over = {}) {
	const { host = {}, version = {} } = over;
	return JSON.stringify(
		{
			host: {
				cgroupVersion: "v2",
				cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
				serviceIsRemote: false,
				remoteSocket: { path: "/run/user/1234/podman/podman.sock", exists: false },
				security: { rootless: true, selinuxEnabled: true, seccompEnabled: true },
				...host,
			},
			store: { graphRoot: "/home/op/.local/share/containers/storage" },
			version: { Version: "5.8.1", ...version },
		},
		null,
		2,
	);
}
// An escape byte built at run time: a literal one in source survives a copy and paste and then does not.
const ESC = String.fromCharCode(27);
const INFO = () => ({ rootless: true, serviceIsRemote: false, selinux: true, cgroupVersion: "v2", controllers: ["cpuset", "cpu", "io", "memory", "pids"], version: "5.8.1" });
const answered = (over = {}) => ({ answered: true, info: { ...INFO(), ...over } });

/**
 * A fake host fs: `files` maps a path to its text, `dirs` a directory to its entries, `errors` a path to an errno code
 * every call on it throws. Everything else is ENOENT, which is what an unconfigured host looks like.
 */
function fakeFs({ files = {}, dirs = {}, errors = {} } = {}) {
	const fail = (path) => {
		const code = errors[path] ?? "ENOENT";
		throw Object.assign(new Error(`${code}: ${path}`), { code });
	};
	return {
		statSync(path) {
			if (errors[path] || !Object.hasOwn(files, path)) fail(path);
			return { size: Buffer.byteLength(files[path]) };
		},
		readFileSync(path) {
			if (errors[path] || !Object.hasOwn(files, path)) fail(path);
			return files[path];
		},
		readdirSync(path) {
			if (errors[path] || !Object.hasOwn(dirs, path)) fail(path);
			return dirs[path];
		},
	};
}
const HOME = "/home/op";
const USER_MOUNTS = `${HOME}/.config/containers/mounts.conf`;
const clean = () => fakeFs({ files: { [USER_MOUNTS]: "" } });
const observe = (read, fs = clean(), over = {}) => mod.observePodman({ read, fs, home: HOME, env: {}, euid: 1234, ...over });

test("parsePodmanInfo reads the measured shape and nothing else", { skip }, () => {
	assert.deepEqual(mod.parsePodmanInfo(infoBody()), INFO());
	// Pretty-printed, as `podman info --format json` prints it: one JSON document, not a line.
	assert.ok(infoBody().includes("\n"));
	for (const bad of ["", "not json", "[]", "null", "{}", JSON.stringify({ host: [] }), JSON.stringify({ host: "x" })]) {
		assert.equal(mod.parsePodmanInfo(bad), null, bad);
	}
	// Every field null when absent or the wrong type: a missing `rootless` is never read as rootless, nor a missing
	// `serviceIsRemote` as local.
	assert.deepEqual(mod.parsePodmanInfo(JSON.stringify({ host: {} })), { rootless: null, serviceIsRemote: null, selinux: null, cgroupVersion: null, controllers: null, version: null });
	const odd = mod.parsePodmanInfo(infoBody({ host: { serviceIsRemote: "false", security: { rootless: 1, selinuxEnabled: "true" }, cgroupVersion: `v2${ESC}[2J`, cgroupControllers: ["pids", 7, "memory\n", "cpu"] }, version: { Version: `5.8.1${ESC}]0;x` } }));
	assert.deepEqual(odd, { rootless: null, serviceIsRemote: null, selinux: null, cgroupVersion: null, controllers: ["pids", "cpu"], version: null });
});

test("makePodmanInfoReader asks `podman info --format json` and classifies each failure (#354)", { skip }, async () => {
	const asked = [];
	const reader = (result) => mod.makePodmanInfoReader({ run: async (args) => (asked.push(args), typeof result === "function" ? result() : result) });
	assert.deepEqual(await reader({ code: 0, stdout: infoBody(), stderr: "" })(), { answered: true, info: INFO() });
	assert.deepEqual(asked[0], ["info", "--format", "json"]);
	assert.deepEqual(await reader({ code: null, stdout: "", error: Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }) })(), { answered: false, reason: "podman-not-found", transient: false });
	assert.deepEqual(await reader({ code: 0, stdout: "{}", stderr: "" })(), { answered: false, reason: "unparseable", transient: false });
	assert.deepEqual(await reader({ code: 125, stdout: "", stderr: "Error: cannot connect" })(), { answered: false, reason: "exit-125", transient: true });
	assert.deepEqual(await reader({ code: null, stdout: "", error: { timedOut: true } })(), { answered: false, reason: "timeout", transient: true });
	assert.deepEqual(await reader({ code: null, stdout: "", error: { signal: "SIGKILL" } })(), { answered: false, reason: "signal-sigkill", transient: true });
	assert.deepEqual(await reader(() => {
		throw new Error("boom");
	})(), { answered: false, reason: "spawn-failed", transient: true });
	assert.equal(mod.PODMAN_INFO_TIMEOUT_MS, 15_000, "docker info's bound, reused");
});

test("cachedPodmanInfo keeps the first ANSWERED read, shares one in flight, and never keeps a failure", { skip }, async () => {
	let reads = 0;
	const answers = [{ answered: false, reason: "timeout", transient: true }, answered(), answered({ rootless: false })];
	const cached = mod.cachedPodmanInfo(async () => answers[reads++]);
	assert.equal((await cached()).answered, false);
	const [a, b] = await Promise.all([cached(), cached()]);
	assert.equal(a, b, "concurrent callers share one read");
	assert.equal(reads, 2);
	assert.equal((await cached()).info.rootless, true, "the answered read is kept");
	assert.equal(reads, 2);
	assert.equal(mod.cachedPodmanInfo(cached), cached, "wrapping twice is the same reader");
});

test("decidePodmanJobUser applies its rows IN ORDER (#354)", { skip }, () => {
	const decide = (over) => mod.decidePodmanJobUser({ platform: "linux", euid: 1234, egid: 1234, read: answered(), ...over });
	assert.deepEqual(decide({}), { mode: "worker", user: "1234:1234", relabel: true, cause: null, reason: null });
	// 1. the platform, before any read: even a perfect answer does not run on an unmeasured Podman machine.
	for (const platform of ["darwin", "win32", "freebsd"]) assert.equal(decide({ platform }).cause, "podman-platform", platform);
	// And before an unanswered read too: a Mac with no podman is refused for the platform, not retried or told to install.
	assert.equal(decide({ platform: "darwin", read: { answered: false, reason: "timeout", transient: true } }).cause, "podman-platform");
	assert.equal(decide({ platform: "darwin", read: { answered: false, reason: "podman-not-found", transient: false } }).cause, "podman-platform");
	// 2. an unanswered read.
	assert.deepEqual(decide({ read: { answered: false, reason: "timeout", transient: true } }), { mode: "unknown", user: null, relabel: false, cause: null, reason: "timeout" });
	assert.equal(decide({ read: undefined }).mode, "unknown");
	assert.equal(decide({ read: { answered: false, reason: "podman-not-found", transient: false } }).cause, "podman-not-found");
	assert.equal(decide({ read: { answered: false, reason: "unparseable", transient: false } }).cause, "podman-unreadable");
	// 3. remote BEFORE rootful: a remote rootful service is named for the remoteness, which is what the operator changes.
	assert.equal(decide({ read: answered({ serviceIsRemote: true, rootless: false }) }).cause, "podman-remote");
	assert.equal(decide({ read: answered({ serviceIsRemote: null }) }).cause, "podman-remote", "not saying it is local is not local");
	// 4. rootful, or not saying: measured, rootful keep-id is not refused and adds supplementary group 0.
	assert.equal(decide({ read: answered({ rootless: false }) }).cause, "podman-rootful");
	assert.equal(decide({ read: answered({ rootless: null }) }).cause, "podman-rootful");
	assert.equal(decide({ read: answered({ rootless: false }), euid: 0 }).cause, "podman-rootful", "rootful is named before root");
	// 5. the ids.
	assert.equal(decide({ euid: 0, egid: 0 }).cause, "worker-is-root");
	assert.equal(decide({ euid: undefined }).reason, "no-process-ids");
	assert.equal(decide({ egid: "1234" }).reason, "no-process-ids");
	// 6. relabel only where Podman reports SELinux on.
	assert.equal(decide({ read: answered({ selinux: false }) }).relabel, false);
	assert.equal(decide({ read: answered({ selinux: null }) }).relabel, false);
});

test("resolvePodmanImageUser always runs the worker's uid, needs anyUid unless it is 1001, and refuses gid 0", { skip }, () => {
	const worker = { mode: "worker", user: "1234:1234", relabel: true };
	assert.deepEqual(mod.resolvePodmanImageUser(worker, { capabilities: ["anyUid"], euid: 1234, egid: 1234 }), { user: "1234:1234", home: CONTAINER_HOME, relabel: true });
	assert.deepEqual(mod.resolvePodmanImageUser({ ...worker, relabel: false }, { capabilities: ["anyUid"], euid: 1234, egid: 1234 }).relabel, false);
	assert.deepEqual(mod.resolvePodmanImageUser(worker, { capabilities: [], euid: 1234, egid: 1234 }), { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" });
	assert.deepEqual(mod.resolvePodmanImageUser(worker, { capabilities: "anyUid", euid: 1234, egid: 1234 }).refused, "job-image-any-uid-unsupported");
	// uid 1001 is the image's own user: no anyUid needed, but still `--user` (keep-id without it cannot read /job).
	assert.deepEqual(mod.resolvePodmanImageUser({ ...worker, user: "1001:1001" }, { capabilities: [], euid: 1001, egid: 1001 }), { user: "1001:1001", home: CONTAINER_HOME, relabel: true });
	assert.deepEqual(mod.resolvePodmanImageUser({ ...worker, user: "1234:0" }, { capabilities: ["anyUid"], euid: 1234, egid: 0 }), { refused: "job-user-unmappable", cause: "root-group" });
	assert.deepEqual(mod.resolvePodmanImageUser({ mode: "unmappable", cause: "podman-rootful" }, {}), { refused: "job-user-unmappable", cause: "podman-rootful" });
	assert.deepEqual(mod.resolvePodmanImageUser({ mode: "unknown", reason: "timeout" }, {}), { unavailable: true, reason: "timeout" });
	assert.deepEqual(mod.resolvePodmanImageUser(undefined, {}), { unavailable: true, reason: "unknown" });
});

test("every podman cause has an operator text, and the boot set is the five facts no job gets past", { skip }, () => {
	assert.deepEqual([...mod.PODMAN_BOOT_REFUSING_CAUSES].sort(), ["podman-not-found", "podman-platform", "podman-remote", "podman-rootful", "worker-is-root"]);
	const reachable = ["podman-platform", "podman-not-found", "podman-unreadable", "podman-remote", "podman-rootful", "worker-is-root", "root-group", "any-uid-unsupported"];
	assert.deepEqual(Object.keys(mod.PODMAN_JOB_USER_FIX).sort(), [...reachable].sort(), "one text per cause this venue can produce, and no other");
	assert.ok(Object.isFrozen(mod.PODMAN_JOB_USER_FIX));
	for (const cause of reachable) {
		assert.ok(mod.PODMAN_JOB_USER_FIX[cause].length > 40, cause);
		assert.equal(mod.podmanJobUserRefusal(cause), `Refused: ${mod.PODMAN_JOB_USER_FIX[cause]} (issue #354).`);
	}
	assert.equal(mod.podmanJobUserRefusal({ cause: "podman-remote" }), mod.podmanJobUserRefusal("podman-remote"));
	assert.equal(mod.podmanJobUserRefusal("toString"), "Refused: the job user could not be decided (issue #354).");
});

test("observePodman credits a clean rootless host, and the table's words then hold (#354)", { skip }, () => {
	const o = observe(answered());
	assert.deepEqual(o.observations, { [PODMAN_BOUNDS_DELEGATED]: true, [PODMAN_ADDS_NO_MOUNTS]: true, [PODMAN_SERVICE_LOCAL]: true });
	assert.deepEqual(o.reasons, {});
	for (const property of ["isolation", "mountSet", "credentialTransit"]) assert.equal(effectiveWord(PODMAN_BACKEND, property, o.observations), ENFORCED, property);
	assert.match(o.evidence[PODMAN_ADDS_NO_MOUNTS], /mounts\.conf is empty/);
});

test("podmanBoundsDelegated needs rootless cgroup v2 with pids, memory and cpu delegated, and no cgroups key", { skip }, () => {
	const bounds = (read, fs) => observe(read, fs).observations[PODMAN_BOUNDS_DELEGATED];
	for (const missing of ["pids", "memory", "cpu"]) {
		const o = observe(answered({ controllers: INFO().controllers.filter((c) => c !== missing) }));
		assert.equal(o.observations[PODMAN_BOUNDS_DELEGATED], false, missing);
		assert.match(o.evidence[PODMAN_BOUNDS_DELEGATED], new RegExp(`the ${missing} cgroup controller is not delegated`));
	}
	assert.equal(bounds(answered({ controllers: ["io"] })), false);
	assert.equal(bounds(answered({ controllers: null })), false);
	assert.equal(bounds(answered({ cgroupVersion: "v1" })), false);
	assert.equal(bounds(answered({ cgroupVersion: null })), false);
	assert.equal(bounds(answered({ rootless: false })), false, "a rootful controller list is the whole tree, not a delegation");
	// A containers.conf that takes containers out of their cgroup: measured, the bounds then read back `max`.
	const conf = (text, path = "/etc/containers/containers.conf") => fakeFs({ files: { [USER_MOUNTS]: "", [path]: text } });
	assert.equal(bounds(answered(), conf('[containers]\ncgroups = "disabled"\n')), false);
	assert.equal(bounds(answered(), conf('[containers]\nCGROUPS="no-conmon"\n', `${HOME}/.config/containers/containers.conf`)), false);
	assert.equal(bounds(answered(), conf('containers.cgroups = "disabled"\n')), false);
	assert.equal(bounds(answered(), conf('# cgroups = "disabled"\ncgroupns = "private"\ncgroup_manager = "systemd"\n')), true, "a comment and the look-alike keys are not the key");
	assert.equal(effectiveWord(PODMAN_BACKEND, "isolation", { [PODMAN_BOUNDS_DELEGATED]: false }), ASSERTED);
});

test("podmanAddsNoMounts reads the mounts.conf that WINS: the user's when it exists, else /etc's", { skip }, () => {
	const mounts = (files, over) => observe(answered(), fakeFs({ files }), over);
	assert.equal(mounts({ [USER_MOUNTS]: "" }).observations[PODMAN_ADDS_NO_MOUNTS], true);
	assert.equal(mounts({ "/etc/containers/mounts.conf": "" }).observations[PODMAN_ADDS_NO_MOUNTS], true, "no user file: /etc's empty override wins");
	assert.equal(mounts({ [USER_MOUNTS]: "", "/etc/containers/mounts.conf": "/usr/share/rhel/secrets:/run/secrets\n" }).observations[PODMAN_ADDS_NO_MOUNTS], true, "the user's empty file overrides a non-empty /etc one (measured)");
	const userListed = mounts({ [USER_MOUNTS]: "/srv/x:/run/x\n", "/etc/containers/mounts.conf": "" });
	assert.equal(userListed.observations[PODMAN_ADDS_NO_MOUNTS], false, "and a non-empty user file wins over an empty /etc one");
	assert.match(userListed.evidence[PODMAN_ADDS_NO_MOUNTS], /\/home\/op\/\.config\/containers\/mounts\.conf is not empty/);
	const none = mounts({});
	assert.equal(none.observations[PODMAN_ADDS_NO_MOUNTS], false, "neither: /usr/share's /run/secrets default applies");
	assert.match(none.evidence[PODMAN_ADDS_NO_MOUNTS], /Podman mounts the default list/);
	assert.equal(observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { [USER_MOUNTS]: "EACCES" } })).observations[PODMAN_ADDS_NO_MOUNTS], false, "an unreadable user file is not a missing one");
	assert.equal(mounts({ [USER_MOUNTS]: "" }, { home: null }).observations[PODMAN_ADDS_NO_MOUNTS], false, "an unknown home withholds credit");
	assert.equal(observe(answered({ rootless: false })).observations[PODMAN_ADDS_NO_MOUNTS], false, "which file wins is the rootless rule");
});

test("podmanAddsNoMounts reads every containers.conf a rootless Podman reads, hooks and FIPS", { skip }, () => {
	const withConf = (path, text = "[containers]\nvolumes = [\"/srv:/srv\"]\n", dir = null) => {
		const files = { [USER_MOUNTS]: "", [path]: text };
		const dirs = dir ? { [dir]: [path.slice(dir.length + 1)] } : {};
		return observe(answered(), fakeFs({ files, dirs }));
	};
	for (const path of ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", `${HOME}/.config/containers/containers.conf`]) {
		assert.equal(withConf(path).observations[PODMAN_ADDS_NO_MOUNTS], false, path);
	}
	for (const dir of ["/etc/containers/containers.conf.d", "/usr/share/containers/containers.rootless.conf.d", "/etc/containers/containers.rootless.conf.d", "/etc/containers/containers.rootless.conf.d/1234", `${HOME}/.config/containers/containers.conf.d`]) {
		const o = withConf(`${dir}/10-x.conf`, "[containers]\nmounts = [\"type=bind,src=/,dst=/h\"]\n", dir);
		assert.equal(o.observations[PODMAN_ADDS_NO_MOUNTS], false, dir);
		assert.match(o.evidence[PODMAN_ADDS_NO_MOUNTS], /sets a volumes, mounts, devices or hooks_dir key/);
	}
	// XDG_CONFIG_HOME moves the user's containers.conf (Podman's GetConfigHome), but not its mounts.conf (built from HOME).
	const xdg = observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "", "/xdg/containers/containers.conf": "[containers]\ndevices = [\"/dev/kvm\"]\n" } }), { env: { XDG_CONFIG_HOME: "/xdg" } });
	assert.equal(xdg.observations[PODMAN_ADDS_NO_MOUNTS], false);
	// CONTAINERS_CONF replaces the list and CONTAINERS_CONF_OVERRIDE adds one; neither is chased, so neither is credited.
	for (const name of ["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE"]) {
		const o = observe(answered(), clean(), { env: { [name]: "/tmp/c.conf" } });
		assert.equal(o.observations[PODMAN_ADDS_NO_MOUNTS], false, name);
		assert.equal(o.observations[PODMAN_BOUNDS_DELEGATED], false, name);
		assert.match(o.evidence[PODMAN_ADDS_NO_MOUNTS], new RegExp(`${name} is set`));
	}
	assert.equal(observe(answered(), clean(), { euid: null }).observations[PODMAN_ADDS_NO_MOUNTS], false, "the per-uid drop-ins cannot be named without the uid");
	const hook = observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, dirs: { "/usr/share/containers/oci/hooks.d": ["nvidia.json"] } }));
	assert.equal(hook.observations[PODMAN_ADDS_NO_MOUNTS], false);
	assert.match(hook.evidence[PODMAN_ADDS_NO_MOUNTS], /OCI hook/);
	const fips = observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "", "/proc/sys/crypto/fips_enabled": "1\n" } }));
	assert.equal(fips.observations[PODMAN_ADDS_NO_MOUNTS], false);
	assert.equal(observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/containers.conf.d": "EACCES" } })).observations[PODMAN_ADDS_NO_MOUNTS], false, "a drop-in directory nobody could list withholds credit");
});

// --- issue #428: a containers.conf key that widens every job refuses the venue ------------------------------------

const WIDENING_KEYS = ["pasta_options", "network_cmd_options", "annotations"];
// Every file and drop-in directory `podmanConfFiles` names for uid 1234 and HOME /home/op: the vendor and /etc files and
// directories, the rootless drop-ins without and with the uid, and the user's own file and drop-in directory.
const CONF_FILES = ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", `${HOME}/.config/containers/containers.conf`];
const CONF_DIRS = [
	"/usr/share/containers/containers.conf.d",
	"/etc/containers/containers.conf.d",
	"/usr/share/containers/containers.rootless.conf.d",
	"/etc/containers/containers.rootless.conf.d",
	"/usr/share/containers/containers.rootless.conf.d/1234",
	"/etc/containers/containers.rootless.conf.d/1234",
	`${HOME}/.config/containers/containers.conf.d`,
];
const widening = (fs, over = {}) => mod.podmanConfWidening({ fs, home: HOME, env: {}, euid: 1234, ...over });
const confAt = (path, text, dir = null) => fakeFs({ files: { [path]: text }, dirs: dir ? { [dir]: [path.slice(dir.length + 1)] } : {} });
// What each key looks like where it was measured widening a job (M0, Fedora 44, Podman 5.8.1).
const MEASURED = {
	pasta_options: '[network]\npasta_options = ["--map-host-loopback", "169.254.1.2"]\n',
	network_cmd_options: '[engine]\nnetwork_cmd_options = ["allow_host_loopback=true"]\n',
	annotations: '[containers]\nannotations = ["run.oci.keep_original_groups=1"]\n',
};

test("podmanConfWidening refuses each widening key in every containers.conf a rootless Podman reads (#428)", { skip }, () => {
	for (const key of WIDENING_KEYS) {
		for (const path of CONF_FILES) {
			const found = widening(confAt(path, MEASURED[key]));
			assert.deepEqual([found?.cause, found?.key], ["podman-conf-widens-job", key], `${key} in ${path}`);
			assert.match(found.evidence, new RegExp(`^${path.replaceAll(".", "\\.")} sets ${key}, which`), `${key} in ${path}`);
		}
		for (const dir of CONF_DIRS) {
			const found = widening(confAt(`${dir}/99-test.conf`, MEASURED[key], dir));
			assert.equal(found?.key, key, `${key} in ${dir}`);
			assert.ok(found.evidence.startsWith(`${dir}/99-test.conf sets ${key}, which`), found.evidence);
		}
	}
	// XDG_CONFIG_HOME moves the user's own file and drop-ins, as Podman's GetConfigHome does.
	assert.equal(widening(confAt("/xdg/containers/containers.conf", MEASURED.pasta_options), { env: { XDG_CONFIG_HOME: "/xdg" } })?.key, "pasta_options");
	assert.equal(widening(confAt("/xdg/containers/containers.conf.d/1.conf", MEASURED.annotations, "/xdg/containers/containers.conf.d"), { env: { XDG_CONFIG_HOME: "/xdg" } })?.key, "annotations");
	// The first file in Podman's reading order is the one named, as for every other conf finding.
	const both = fakeFs({ files: { "/etc/containers/containers.conf": MEASURED.annotations, [`${HOME}/.config/containers/containers.conf`]: MEASURED.pasta_options } });
	assert.equal(widening(both).key, "annotations");
	// A clean host, and the measured Fedora default (every key commented out), pass.
	assert.equal(widening(fakeFs()), null);
	assert.equal(widening(confAt("/usr/share/containers/containers.conf", '[containers]\n#annotations = []\n[engine]\n#network_cmd_options = []\n[network]\n#pasta_options = []\n# pasta_options = ["--map-gw"]\n')), null);
});

test("podmanConfWidening matches every TOML spelling of a key and nothing that merely contains one (#428)", { skip }, () => {
	const at = (text) => widening(confAt(`${HOME}/.config/containers/containers.conf`, text))?.key ?? null;
	for (const [text, key] of [
		['[network]\nPASTA_OPTIONS = ["--map-gw"]\n', "pasta_options"],
		['[network]\nPasta_Options=["-T","6379"]\n', "pasta_options"],
		['[network]\n"pasta_options" = ["--map-gw"]\n', "pasta_options"],
		["[engine]\n'network_cmd_options' = ['allow_host_loopback=true']\n", "network_cmd_options"],
		['network.pasta_options = ["--map-gw"]\n', "pasta_options"],
		['NETWORK.PASTA_OPTIONS = ["--map-gw"]\n', "pasta_options"],
		['engine.network_cmd_options = ["allow_host_loopback=true"]\n', "network_cmd_options"],
		['network = { pasta_options = ["--map-gw"] }\n', "pasta_options"],
		['containers = {annotations=["run.oci.keep_original_groups=1"]}\n', "annotations"],
		['containers = { dns_options = ["A=1"], annotations = ["x=1"] }\n', "annotations"],
		// containers.conf's append syntax, an array element `{append=true}`, which Podman 5.8.1 honours: the key is set.
		['[network]\npasta_options = ["--map-gw", {append = true}]\n', "pasta_options"],
		['[network]\npasta_options=["-T","6379",{append=true}]\n', "pasta_options"],
		// A table value, which Podman 5.8.1 REJECTS (so it never widens a job); refused anyway, since presence is the rule.
		['[network]\npasta_options = {append = true, value = ["--map-gw"]}\n', "pasta_options"],
		// `env` in any table (issue #428, round 2): [engine] env moved which containers.conf Podman read (measured).
		['[engine]\nenv = ["CONTAINERS_CONF_OVERRIDE=/tmp/x.conf"]\n', "env"],
		['[containers]\nenv = ["A=1"]\n', "env"],
		['engine.env = []\n', "env"],
		['engine = { env = ["HOME=/tmp/h"] }\n', "env"],
		['[engine]\n"ENV" = []\n', "env"],
		['[network]\n   pasta_options   =   []\n', "pasta_options"],
		// Any value refuses, the empty one too: presence is the rule, since no argv takes any value back.
		["[containers]\nannotations = []\n", "annotations"],
		// A `#` inside a string earlier on the line is not a comment (MOUNT_KEY's measured rule).
		['[containers]\ndns_options = ["X=#"]\nannotations = ["a=b"]\n', "annotations"],
	]) assert.equal(at(text), key, text);
	for (const text of [
		'# pasta_options = ["--map-gw"]\n',
		'   #annotations = ["run.oci.keep_original_groups=1"]\n',
		'\t# network.pasta_options = ["--map-gw"]\n',
		"my_pasta_options_x = 1\n",
		"pasta_optionsx = 1\n",
		"pod_annotations = 1\n",
		"network_cmd_options_extra = 1\n",
		'default_rootless_network_cmd = "slirp4netns"\n',
		'network_cmd_path = "/usr/bin/slirp4netns"\n',
		'[containers]\ndns_options = ["annotations"]\n',
		// `env_host` is a real key, and pinned by --env-host=false, so it must NOT read as `env`; nor any other `env` suffix.
		"[containers]\nenv_host = true\n",
		'[engine]\nconmon_env_vars = ["A=1"]\n',
		"[engine]\nenvx = 1\n",
		"[containers]\n#env = []\n",
	]) assert.equal(at(text), null, text);
	// The stock Fedora 44 containers.conf's active lines and its commented env lines (read off the lab host): it passes.
	assert.equal(at('[containers]\n#env = [\n#  "PATH=/usr/local/sbin",\n#]\n#env_host = false\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n]\nlog_driver = "journald"\n[network]\n#pasta_options = []\n[engine]\n#env = []\nruntime = "crun"\n[engine.runtimes]\n'), null);
});

test("podmanConfWidening refuses what it cannot read whole, with no key and a determinate reason (#428)", { skip }, () => {
	const noKey = (found, pattern, label) => {
		assert.equal(found?.cause, "podman-conf-widens-job", label);
		assert.equal(found.key, null, label);
		assert.match(found.evidence, pattern, label);
	};
	// An escaped key TOML decodes to the name, which no pattern here sees through: refused, not decoded.
	noKey(widening(confAt(`${HOME}/.config/containers/containers.conf`, '[network]\n"pasta\\u005foptions" = ["--map-gw"]\n')), /has an escaped key/, "escaped");
	for (const name of ["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE"]) noKey(widening(fakeFs(), { env: { [name]: "/tmp/c.conf" } }), new RegExp(`^${name} is set`), name);
	noKey(widening(fakeFs({ files: { "/etc/containers/containers.conf": "" }, errors: { "/etc/containers/containers.conf": "EACCES" } })), /containers\.conf could not be read \(EACCES\)/, "unreadable file");
	noKey(widening(fakeFs({ errors: { "/etc/containers/containers.conf.d": "EACCES" } })), /containers\.conf\.d could not be read \(EACCES\)/, "unlistable directory");
	noKey(widening(fakeFs(), { home: null }), /home is not known/, "no home");
	noKey(widening(fakeFs(), { euid: undefined }), /uid is not known/, "no uid");
	// Issue #428, round 2: spellings the pattern cannot see through, each measured hiding a key Podman honoured.
	for (const [label, text] of [
		["long s", '[network]\n"pa\u017fta_options" = ["-T","6379"]\n'],
		["multi-line basic", 'containers = { dns_options = ["""\n# """], annotations = ["run.oci.keep_original_groups=1"] }\n'],
		["multi-line literal", "network = { default_subnet = '''\n#''', pasta_options = [\"-T\",\"6379\"] }\n"],
		["u2028", 'network = { default_subnet = "a\u2028# ", pasta_options = ["-T","6379"] }\n'],
		["u2029", 'network = { default_subnet = "a\u2029# ", pasta_options = ["-T","6379"] }\n'],
	]) noKey(widening(confAt(`${HOME}/.config/containers/containers.conf`, text)), /has a non-ASCII character or a multi-line string/, label);
	// A transient read is neither a key nor a refusal: it comes back `transient`, and its text says it will be retried.
	for (const code of ["EMFILE", "ENFILE", "EIO", "EAGAIN"]) {
		const file = widening(fakeFs({ files: { "/etc/containers/containers.conf": "" }, errors: { "/etc/containers/containers.conf": code } }));
		assert.deepEqual([file.key, file.transient], [null, true], code);
		assert.match(mod.podmanConfRefusal(file), /^Not read yet: .* could not be read \(\w+\); the read failed for a moment/, code);
		assert.equal(widening(fakeFs({ errors: { "/etc/containers/containers.conf.d": code } })).transient, true, `dir ${code}`);
	}
	for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
		assert.equal(widening(fakeFs({ files: { "/etc/containers/containers.conf": "" }, errors: { "/etc/containers/containers.conf": code } })).transient, undefined, code);
	}
});

test("the podman conf refusal names the file and key, says to remove it, and names the trade-off (#428)", { skip }, () => {
	const found = widening(confAt(`${HOME}/.config/containers/containers.conf`, MEASURED.pasta_options));
	assert.equal(
		mod.podmanConfRefusal(found),
		"Refused: /home/op/.config/containers/containers.conf sets pasta_options, which Podman hands to the pasta behind every job's network, where a host-loopback mapping (--map-host-loopback, --map-gw, -T) gives the job this host's 127.0.0.1 services; remove that key from that file, then restart this account's containers on a bridge network (the egress proxy among them), since the rootless network they share keeps the options it started with: the podman venue refuses any containers.conf this account's Podman reads that sets pasta_options, network_cmd_options, annotations or env, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers (a pasta MTU, say) goes on their own command line (--network=pasta:...) or Quadlet unit instead, not account-wide (issue #428).",
	);
	assert.equal(mod.podmanConfRefusal(found), `Refused: ${found.evidence}; ${mod.podmanConfFix(found)} (issue #428).`);
	for (const key of WIDENING_KEYS) assert.match(mod.podmanConfRefusal(widening(confAt("/etc/containers/containers.conf", MEASURED[key]))), new RegExp(`^Refused: /etc/containers/containers\\.conf sets ${key}, which .*; remove that key from that file`));
	const unread = widening(fakeFs(), { env: { CONTAINERS_CONF: "/x" } });
	assert.match(mod.podmanConfRefusal(unread), /^Refused: CONTAINERS_CONF is set, .*; the podman venue must read every containers\.conf .* unset the variable for the worker's account \(issue #428\)\.$/);
	assert.equal(mod.PODMAN_CONF_WIDENS_JOB, "podman-conf-widens-job");
	assert.ok(!Object.hasOwn(mod.PODMAN_JOB_USER_FIX, mod.PODMAN_CONF_WIDENS_JOB), "a venue refusal, not a job-user cause");
});

test("podmanServiceLocal holds only for serviceIsRemote false", { skip }, () => {
	assert.equal(observe(answered()).observations[PODMAN_SERVICE_LOCAL], true);
	assert.equal(observe(answered({ serviceIsRemote: true })).observations[PODMAN_SERVICE_LOCAL], false);
	assert.equal(observe(answered({ serviceIsRemote: null })).observations[PODMAN_SERVICE_LOCAL], false);
	assert.equal(effectiveWord(PODMAN_BACKEND, "credentialTransit", { [PODMAN_SERVICE_LOCAL]: false }), ASSERTED);
});

test("an unanswered read is null (retry) when transient and false (refuse) when determinate, never a credit", { skip }, () => {
	const transient = observe({ answered: false, reason: "timeout", transient: true });
	assert.deepEqual(transient.observations, { [PODMAN_BOUNDS_DELEGATED]: null, [PODMAN_ADDS_NO_MOUNTS]: null, [PODMAN_SERVICE_LOCAL]: null });
	assert.deepEqual(transient.reasons, { [PODMAN_BOUNDS_DELEGATED]: "timeout", [PODMAN_ADDS_NO_MOUNTS]: "timeout", [PODMAN_SERVICE_LOCAL]: "timeout" });
	assert.equal(observe(undefined).observations[PODMAN_SERVICE_LOCAL], null);
	const missing = observe({ answered: false, reason: "podman-not-found", transient: false });
	assert.deepEqual(missing.observations, { [PODMAN_BOUNDS_DELEGATED]: false, [PODMAN_ADDS_NO_MOUNTS]: false, [PODMAN_SERVICE_LOCAL]: false });
	assert.deepEqual(missing.reasons, {});
	assert.match(missing.evidence[PODMAN_SERVICE_LOCAL], /no podman CLI/);
	assert.match(observe({ answered: false, reason: "unparseable", transient: false }).evidence[PODMAN_BOUNDS_DELEGATED], /shape nothing here reads/);
	assert.equal(mod.podmanObservationKey(missing), "false|false|false");
});

/** A fake `podman` for every spawn the bundle makes: records argv, answers per subcommand, drives the run's exit. */
function fakePodman({ runExit = 0, abort = null, answers = {} } = {}) {
	const calls = [];
	const spawnFn = (cmd, args) => {
		calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		const key = args[0] === "run" ? "run" : args.slice(0, 2).join(" ");
		const answer = key === "run" ? { code: typeof runExit === "function" ? runExit() : runExit } : (answers[key] ?? answers[args[0]] ?? { code: 0, stdout: "" });
		queueMicrotask(() => {
			if (key === "run" && abort) abort();
			if (answer.stdout) child.stdout.emit("data", answer.stdout);
			child.emit("close", answer.code);
		});
		return child;
	};
	return { calls, spawnFn };
}
const JOB = { id: "j1", kind: "local", provider: "anthropic", model: "m", maxTurns: 5 };
const PREPARED = { workspace: "/host/folder", jobDir: "/host/jobs/j1" };
const bundle = (over = {}) => mod.makePodmanBackend({ image: "pi-job:x", hostEnv: { ANTHROPIC_API_KEY: "sk-real" }, readInfo: async () => answered(), platform: "linux", euid: 1234, egid: 1234, fs: clean(), home: HOME, env: {}, onOutput: () => {}, ...over });

test("makePodmanBackend is the table's podman venue, and refuses an option it does not know", { skip }, () => {
	const b = bundle({ spawnFn: fakePodman().spawnFn });
	assert.equal(b.name, "podman");
	assert.equal(b.declares, BACKENDS.podman.declares, "the table's own frozen words");
	assert.deepEqual(b.neverStartedExits, [125, 126, 127]);
	assert.equal(b.binds, true);
	assert.equal(b.namePrefix, "pi-job-");
	assert.equal(b.containerName("j1"), "pi-job-j1");
	for (const fn of ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap", "jobUserPreflight", "observationPreflight"]) assert.equal(typeof b[fn], "function", fn);
	assert.throws(() => bundle({ egresProxy: "x" }), /unknown option "egresProxy"/);
	assert.throws(() => bundle({ reap: true }), /reap must be a function/);
});

test("every spawn the podman bundle makes is `podman`, and the run is keep-id as the worker's uid (#354)", { skip }, async () => {
	const fake = fakePodman({ runExit: 2, answers: { "image inspect": { code: 0, stdout: "sha256:abc|1.0||anyUid\n" }, ps: { code: 0, stdout: "" }, "network ls": { code: 0, stdout: "" } } });
	const b = bundle({ spawnFn: fake.spawnFn, egress: true });
	const run = await b.runContainer({ job: JOB, prepared: PREPARED, name: "pi-job-j1", signal: new AbortController().signal, user: "1234:1234", home: CONTAINER_HOME, relabel: true });
	assert.equal(run.code, 2);
	const runArgv = fake.calls.find((c) => c[1] === "run");
	assert.equal(runArgv[0], "podman");
	assert.ok(runArgv.includes("--userns=keep-id") && runArgv.includes("--user=1234:1234"), runArgv.join(" "));
	assert.ok(runArgv.includes("--pull=never"));
	await b.imagePreflight({});
	await b.egressPreflight({});
	await b.stopContainer("pi-job-j1");
	assert.deepEqual((await b.reap()).reaped, true);
	assert.ok(fake.calls.length > 5);
	for (const call of fake.calls) assert.equal(call[0], "podman", call.join(" "));
	assert.ok(fake.calls.some((c) => c[1] === "stop" && c.includes("pi-job-j1")), "the stop goes to podman");
	assert.ok(fake.calls.some((c) => c[1] === "network" && c[2] === "create"), "the job network is podman's");
});

test("the podman reaper keeps the tri-state and enumerates podman's store", { skip }, async () => {
	const ok = fakePodman({ answers: { ps: { code: 0, stdout: "" }, "network ls": { code: 0, stdout: "" } } });
	assert.deepEqual(await mod.makePodmanReaper({ log: () => {}, spawnFn: ok.spawnFn })(), { reaped: true });
	assert.ok(ok.calls.every((c) => c[0] === "podman"));
	const broken = fakePodman({ answers: { ps: { code: 125, stdout: "" } } });
	assert.equal((await mod.makePodmanReaper({ log: () => {}, spawnFn: broken.spawnFn })()).reaped, false);
});

test("the podman observationPreflight judges the floor on podman's observations, as local's does (#354)", { skip }, async () => {
	const floor = { isolation: ENFORCED, credentialTransit: ENFORCED };
	assert.deepEqual(Object.keys(await bundle({ backendFloor: floor }).observationPreflight(JOB)), ["ok", "podman"]);
	const refused = await bundle({ backendFloor: floor, readInfo: async () => answered({ controllers: ["io"] }) }).observationPreflight(JOB);
	assert.equal(refused.refused, true);
	assert.deepEqual(refused.observations, [PODMAN_BOUNDS_DELEGATED]);
	assert.match(refused.message, /podman: isolation=enforced holds only while this worker's rootless Podman runs on cgroup v2/);
	assert.match(refused.message, /Delegate the cpu, memory and pids controllers/);
	assert.deepEqual(await bundle({ backendFloor: floor, readInfo: async () => ({ answered: false, reason: "timeout", transient: true }) }).observationPreflight(JOB), { unavailable: true, reason: "timeout" });
	// A refused identity is passed through to jobUserPreflight, which names the one fix, rather than refused here with a
	// floor fix that is not it. Every unmappable row, each of which misses a floored observation too.
	for (const [label, opts, cause] of [
		["remote", { readInfo: async () => answered({ serviceIsRemote: true }) }, "podman-remote"],
		["rootful", { readInfo: async () => answered({ rootless: false }) }, "podman-rootful"],
		["no podman", { readInfo: async () => ({ answered: false, reason: "podman-not-found", transient: false }) }, "podman-not-found"],
	]) {
		const b = bundle({ backendFloor: { ...floor, mountSet: ENFORCED }, ...opts });
		const observed = await b.observationPreflight(JOB);
		assert.equal(observed.ok, true, `${label}: not refused by the floor`);
		assert.deepEqual(await b.jobUserPreflight(JOB, { capabilities: ["anyUid"], observed }), { refused: "job-user-unmappable", cause }, label);
	}
	// No floor: nothing observed can refuse, and the read still rides along for the job user.
	const plain = await bundle({ readInfo: async () => answered({ controllers: [] }) }).observationPreflight(JOB);
	assert.equal(plain.ok, true);
	assert.equal(plain.podman.info.controllers.length, 0);
});

test("the podman observationPreflight hands a widening containers.conf back as a venue refusal, per job (#428)", { skip }, async () => {
	const path = `${HOME}/.config/containers/containers.conf`;
	const files = { [USER_MOUNTS]: "", [path]: MEASURED.pasta_options };
	const fs = fakeFs({ files });
	const floor = { isolation: ENFORCED, credentialTransit: ENFORCED, mountSet: ENFORCED };
	const b = bundle({ fs, backendFloor: floor });
	const observed = await b.observationPreflight(JOB);
	assert.equal(observed.ok, true);
	assert.equal(observed.refused, undefined, "not a floor refusal: it fires with no floor at all");
	assert.deepEqual(observed.podmanConfRefused, { reason: "podman-conf-widens-job", key: "pasta_options", message: mod.podmanConfRefusal(mod.podmanConfWidening({ fs, home: HOME, env: {}, euid: 1234 })) });
	assert.deepEqual((await bundle({ fs }).observationPreflight(JOB)).podmanConfRefused?.key, "pasta_options", "and with no floor");
	// Re-read per job: removing the key admits the next job with no restart.
	files[path] = "[network]\n";
	assert.deepEqual(Object.keys(await b.observationPreflight(JOB)), ["ok", "podman"]);
	// A refused identity names its own fix first; the conf is not judged behind it.
	files[path] = MEASURED.annotations;
	const rootful = await bundle({ fs, readInfo: async () => answered({ rootless: false }) }).observationPreflight(JOB);
	assert.equal(rootful.jobUserRefused?.cause, "podman-rootful");
	assert.equal(rootful.podmanConfRefused, undefined);
	// Determinate whatever the info read said: a transient read still refuses on the files, never retries.
	const late = await bundle({ fs, backendFloor: floor, readInfo: async () => ({ answered: false, reason: "timeout", transient: true }) }).observationPreflight(JOB);
	assert.equal(late.podmanConfRefused?.key, "annotations");
	assert.equal(late.unavailable, undefined);
	// A conf that could not be read for a moment rides the same field marked `transient`, for the processor to retry.
	const busy = await bundle({ fs: fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/containers.conf": "EMFILE" } }) }).observationPreflight(JOB);
	assert.deepEqual([busy.podmanConfRefused?.transient, busy.podmanConfRefused?.key], [true, null]);
});

test("the podman jobUserPreflight decides from the observed read, reads podman info once, and logs changes only", { skip }, async () => {
	let reads = 0;
	const logs = [];
	const b = bundle({ readInfo: async () => (reads++, answered()), log: (event, fields) => logs.push([event, fields]) });
	const observed = await b.observationPreflight(JOB);
	assert.deepEqual(await b.jobUserPreflight(JOB, { capabilities: ["anyUid"], observed }), { user: "1234:1234", home: CONTAINER_HOME, relabel: true });
	assert.deepEqual(await b.jobUserPreflight(JOB, { capabilities: ["anyUid"] }), { user: "1234:1234", home: CONTAINER_HOME, relabel: true });
	await b.observationPreflight(JOB);
	assert.equal(reads, 1, "one podman info for the worker's life once it answers");
	assert.deepEqual(logs.map(([e]) => e), ["podman_observed", "job_user"], "each said once while it does not change");
	assert.deepEqual(logs[1][1], { backend: "podman", mode: "worker", user: "1234:1234", cause: null, reason: null });
	assert.deepEqual(await b.jobUserPreflight(JOB, { capabilities: [] }), { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" });
	const rootful = bundle({ readInfo: async () => answered({ rootless: false }) });
	assert.deepEqual(await rootful.jobUserPreflight(JOB, { capabilities: ["anyUid"] }), { refused: "job-user-unmappable", cause: "podman-rootful" });
	const mac = bundle({ platform: "darwin" });
	assert.deepEqual(await mac.jobUserPreflight(JOB, { capabilities: ["anyUid"] }), { refused: "job-user-unmappable", cause: "podman-platform" });
	const late = bundle({ readInfo: async () => ({ answered: false, reason: "timeout", transient: true }) });
	assert.deepEqual(await late.jobUserPreflight(JOB, { capabilities: ["anyUid"] }), { unavailable: true, reason: "timeout" });
});

// Through the PROCESSOR, whose order is observation, image, job user: a refused identity must win over the image
// preflight, which asks the same Podman. Before it did, a missing podman under a floor was retried forever as
// "unavailable" and a rootful one without the image in its store was refused as `job-image-missing`.
test("through the processor, a refused podman identity is refused before the image preflight can misname it (#354)", { skip }, async () => {
	const { runJob, InfraRetry } = await import("../src/processor.mjs");
	const enoent = () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); };
	const noFiles = { statSync: enoent, readFileSync: enoent, readdirSync: enoent };
	// `image` inspect answers present (with anyUid) or absent; with no podman at all every spawn fails to launch.
	const podmanSpawn = (mode) => (_bin, args) => {
		const c = new EventEmitter();
		c.stdout = new EventEmitter();
		c.stdout.setEncoding = () => {};
		c.stderr = new EventEmitter();
		c.kill = () => {};
		queueMicrotask(() => {
			if (mode === "no-podman") return c.emit("error", Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }));
			if (args[0] === "image" && mode === "present") c.stdout.emit("data", "sha256:abc|1.0||anyUid\n");
			c.emit("close", args[0] === "image" && mode !== "present" ? 1 : 0);
		});
		return c;
	};
	const spawned = [];
	const run = async (readInfo, mode, backendFloor, fs = noFiles) => {
		const spawnFn = podmanSpawn(mode);
		const b = mod.makePodmanBackend({ image: "pi-job:x", readInfo, platform: "linux", euid: 1234, egid: 1234, fs, home: "/home/op", env: {}, backendFloor, log: () => {}, spawnFn: (bin, args, o) => (spawned.push(args), spawnFn(bin, args, o)) });
		let reserved = 0;
		const redis = { incr: async () => (reserved++, 1), decr: async () => 0, expire: async () => {}, get: async () => null };
		const deps = {
			redis, caps: { day: 10, week: null, month: null }, softHoldPct: null, blessedBackends: ["local", "podman"],
			mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => { throw new Error("the container ran"); }, collectChain: async () => ({}), cleanup: async () => {}, comment: async () => {}, log: () => {},
			observationPreflight: b.observationPreflight, jobUserPreflight: b.jobUserPreflight, imagePreflight: b.imagePreflight, egressPreflight: b.egressPreflight, now: new Date("2026-07-16T10:00:00Z"),
		};
		try {
			const res = await runJob({ kind: "local", backend: "podman", provider: "anthropic", model: "m", maxTurns: 5 }, deps);
			return { reason: res.reason, reserved };
		} catch (error) {
			return { threw: error instanceof InfraRetry ? "retry" : error.message, reserved };
		}
	};
	const notFound = async () => ({ answered: false, reason: "podman-not-found", transient: false });
	const floor = { mountSet: ENFORCED, credentialTransit: ENFORCED, isolation: ENFORCED };
	for (const [label, readInfo, mode, backendFloor] of [
		["no podman, floored", notFound, "no-podman", floor],
		["no podman, no floor", notFound, "no-podman", {}],
		["rootful, image absent from its store, floored", async () => answered({ rootless: false }), "absent", floor],
		["rootful, image absent, no floor", async () => answered({ rootless: false }), "absent", {}],
		["rootful, image present, floored", async () => answered({ rootless: false }), "present", floor],
		["remote, image absent, floored", async () => answered({ serviceIsRemote: true }), "absent", floor],
	]) assert.deepEqual(await run(readInfo, mode, backendFloor), { reason: "job-user-unmappable", reserved: 0 }, label);
	// A usable identity still meets its floor first, and an undecided read is still retried, never refused.
	assert.deepEqual(await run(async () => answered({ controllers: ["io"] }), "present", floor), { reason: "backend-floor-unobserved", reserved: 0 });
	assert.deepEqual(await run(async () => ({ answered: false, reason: "timeout", transient: true }), "present", floor), { threw: "retry", reserved: 0 });
	assert.deepEqual(await run(async () => answered(), "absent", {}), { reason: "job-image-missing", reserved: 0 }, "and a usable venue's missing image is the image's");
	// Issue #428: a widening containers.conf is refused as the venue's own answer, RETURNED (never a retry), before the
	// image preflight asks podman anything, with the image present and no floor, and with a floor and a read still due.
	const widened = fakeFs({ files: { [`${HOME}/.config/containers/containers.conf`]: MEASURED.network_cmd_options } });
	for (const [label, readInfo, backendFloor] of [
		["no floor", async () => answered(), {}],
		["floored", async () => answered(), floor],
		["floored, podman info not answered yet", async () => ({ answered: false, reason: "timeout", transient: true }), floor],
	]) {
		spawned.length = 0;
		assert.deepEqual(await run(readInfo, "present", backendFloor, widened), { reason: "podman-conf-widens-job", reserved: 0 }, label);
		assert.deepEqual(spawned, [], `${label}: no podman spawn, the image inspect included`);
	}
	// And the rootful identity still names its fix first on the same files.
	assert.deepEqual(await run(async () => answered({ rootless: false }), "present", floor, widened), { reason: "job-user-unmappable", reserved: 0 });
	// A conf read that failed for a moment is RETRIED (a throw), never a dropped job; one the account cannot read is refused.
	for (const [code, want] of [["EMFILE", { threw: "retry", reserved: 0 }], ["EIO", { threw: "retry", reserved: 0 }], ["EACCES", { reason: "podman-conf-widens-job", reserved: 0 }]]) {
		spawned.length = 0;
		assert.deepEqual(await run(async () => answered(), "present", {}, fakeFs({ files: { "/etc/containers/containers.conf": "" }, errors: { "/etc/containers/containers.conf": code } })), want, code);
		assert.deepEqual(spawned, [], `${code}: no podman spawn`);
	}
});
