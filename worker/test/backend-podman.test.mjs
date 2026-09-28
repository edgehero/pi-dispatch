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
				cgroupManager: "systemd",
				cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
				serviceIsRemote: false,
				remoteSocket: { path: "/run/user/1234/podman/podman.sock", exists: false },
				security: { rootless: true, selinuxEnabled: true, seccompEnabled: true },
				...host,
			},
			store: { graphRoot: "/home/op/.local/share/containers/storage", runRoot: "/run/user/1234/containers" },
			version: { Version: "5.8.1", ...version },
		},
		null,
		2,
	);
}
// An escape byte built at run time: a literal one in source survives a copy and paste and then does not.
const ESC = String.fromCharCode(27);
const INFO = () => ({ rootless: true, serviceIsRemote: false, selinux: true, cgroupVersion: "v2", cgroupManager: "systemd", controllers: ["cpuset", "cpu", "io", "memory", "pids"], version: "5.8.1", graphRoot: "/home/op/.local/share/containers/storage", runRoot: "/run/user/1234/containers" });
const answered = (over = {}) => ({ answered: true, info: { ...INFO(), ...over } });

/**
 * A fake host fs: `files` maps a path to its text, `dirs` a directory to its entries, `errors` a path to an errno code
 * every call on it throws. Everything else is ENOENT, which is what an unconfigured host looks like.
 */
function fakeFs({ files = {}, dirs = {}, errors = {} } = {}) {
	// The account's running user manager with the controllers delegated, as on the measured host, unless a test says
	// otherwise: `[USER_MANAGER]: null` is an account with none running (issue #453). Added to the caller's own object,
	// since a test may edit `files` after this and expect the change read.
	if (!Object.hasOwn(files, USER_MANAGER)) files[USER_MANAGER] = DELEGATED;
	const has = (path) => Object.hasOwn(files, path) && files[path] !== null;
	const fail = (path) => {
		const code = errors[path] ?? "ENOENT";
		throw Object.assign(new Error(`${code}: ${path}`), { code });
	};
	return {
		statSync(path) {
			if (errors[path] || !has(path)) fail(path);
			return { size: Buffer.byteLength(files[path]) };
		},
		readFileSync(path) {
			if (errors[path] || !has(path)) fail(path);
			return files[path];
		},
		readdirSync(path) {
			if (errors[path] || !Object.hasOwn(dirs, path)) fail(path);
			return dirs[path];
		},
	};
}
const HOME = "/home/op";
// user@1234.service's cgroup, whose controllers file is the fact podmanBoundsDelegated reads (issue #453).
const USER_MANAGER = "/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/cgroup.controllers";
const DELEGATED = "cpuset cpu io memory pids\n";
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
	assert.deepEqual(mod.parsePodmanInfo(JSON.stringify({ host: {} })), { rootless: null, serviceIsRemote: null, selinux: null, cgroupVersion: null, cgroupManager: null, controllers: null, version: null, graphRoot: null, runRoot: null });
	const odd = mod.parsePodmanInfo(infoBody({ host: { serviceIsRemote: "false", security: { rootless: 1, selinuxEnabled: "true" }, cgroupVersion: `v2${ESC}[2J`, cgroupManager: `systemd${ESC}[2J`, cgroupControllers: ["pids", 7, "memory\n", "cpu"] }, version: { Version: `5.8.1${ESC}]0;x` } }));
	assert.deepEqual(odd, { rootless: null, serviceIsRemote: null, selinux: null, cgroupVersion: null, cgroupManager: null, controllers: ["pids", "cpu"], version: null, graphRoot: "/home/op/.local/share/containers/storage", runRoot: "/run/user/1234/containers" });
	// The store is a path or nothing: a relative one, a non-string or one carrying a control byte is no fact.
	for (const graphRoot of ["relative/path", 7, `/home/op${ESC}[2J`, ""]) assert.equal(mod.parsePodmanInfo(JSON.stringify({ host: {}, store: { graphRoot } })).graphRoot, null, JSON.stringify(graphRoot));
	// And so is its runtime state (issue #450), under which Podman 5 records the rootless network helper.
	for (const runRoot of ["relative/path", 7, `/run/user/1234${ESC}[2J`, ""]) assert.equal(mod.parsePodmanInfo(JSON.stringify({ host: {}, store: { runRoot } })).runRoot, null, JSON.stringify(runRoot));
	assert.equal(mod.parsePodmanInfo(JSON.stringify({ host: {}, store: { runRoot: "/tmp/gx469b-rt/containers" } })).runRoot, "/tmp/gx469b-rt/containers", "a runRoot outside /run/user is Podman's all the same");
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
	const manager = (text) => fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: text } });
	for (const missing of ["pids", "memory", "cpu"]) {
		const o = observe(answered(), manager(`${["cpuset", "cpu", "io", "memory", "pids"].filter((c) => c !== missing).join(" ")}\n`));
		assert.equal(o.observations[PODMAN_BOUNDS_DELEGATED], false, missing);
		assert.equal(o.evidence[PODMAN_BOUNDS_DELEGATED], `the ${missing} cgroup controller is not delegated to this account's systemd user manager (user@1234.service), so a job cannot have that bound: measured for cpu, Podman 5.8.1 refuses to start a container carrying --cpus (exit 126, "controller \`cpu\` is not available")`);
	}
	assert.equal(bounds(answered(), manager("io\n")), false);
	assert.equal(bounds(answered(), manager("")), false);
	assert.equal(bounds(answered({ cgroupVersion: "v1" })), false);
	assert.equal(bounds(answered({ cgroupVersion: null })), false);
	assert.equal(observe(answered(), clean(), { euid: null }).observations[PODMAN_BOUNDS_DELEGATED], false, "no uid, no user manager to read");
	// A user manager's cgroup that could not be read for a moment is a retry, and one the account cannot read is refused.
	const busy = observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { [USER_MANAGER]: "EMFILE" } }));
	assert.equal(busy.observations[PODMAN_BOUNDS_DELEGATED], null);
	assert.equal(busy.reasons[PODMAN_BOUNDS_DELEGATED], "file-unread");
	assert.equal(observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { [USER_MANAGER]: "EACCES" } })).observations[PODMAN_BOUNDS_DELEGATED], false);
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
	for (const path of ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", "/etc/containers/containers.rootless.conf", `${HOME}/.config/containers/containers.conf`]) {
		assert.equal(withConf(path).observations[PODMAN_ADDS_NO_MOUNTS], false, path);
	}
	for (const dir of ["/etc/containers/containers.conf.d", "/etc/containers/containers.rootless.conf.d", "/etc/containers/containers.rootless.conf.d/1234", `${HOME}/.config/containers/containers.conf.d`]) {
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

// Issue #448 (ledger L1): env joined this list and MEASURED below, so the every-file test covers it as it covers the rest;
// it was left out of both while its rows lived only in the spelling test.
const WIDENING_KEYS = ["pasta_options", "network_cmd_options", "annotations", "env", "helper_binaries_dir", "network_cmd_path", "default_sysctls", "default_ulimits", "seccomp_profile", "init_path", "dns_servers", "dns_options", "dns_searches", "base_hosts_file", "oom_score_adj", "privileged", "label", "cgroup_conf", "host_containers_internal_ip", "runtimes", "conmon_path", "cgroups", "umask"];
test("PODMAN_WIDENING_KEYS is the refused key list, and every key has a measured widening row here (#450, #448)", { skip }, async () => {
	const { PODMAN_WIDENING_KEYS } = await import("../src/backends.mjs");
	assert.deepEqual(PODMAN_WIDENING_KEYS, WIDENING_KEYS);
	assert.deepEqual(Object.keys(MEASURED), WIDENING_KEYS, "one measured row per key, in the list's order");
});
// Every file and drop-in directory `podmanConfFiles` names for uid 1234 and HOME /home/op: the vendor and /etc files and
// directories, the rootless drop-ins without and with the uid, and the user's own file and drop-in directory.
// Gate round 1 of PR #473 (raw 31, M6): Podman 5.8.1 read /etc/containers/containers.rootless.conf, and neither Podman read
// /usr/share's containers.conf.d or containers.rootless.conf.d (containers/common v0.67.0 `systemConfigs`).
const CONF_FILES = ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", "/etc/containers/containers.rootless.conf", `${HOME}/.config/containers/containers.conf`];
const CONF_DIRS = ["/etc/containers/containers.conf.d", "/etc/containers/containers.rootless.conf.d", "/etc/containers/containers.rootless.conf.d/1234", `${HOME}/.config/containers/containers.conf.d`];
test("the rootless chain is the one Podman measured reading: no /usr/share drop-ins, and containers.rootless.conf (#448)", { skip }, async () => {
	assert.deepEqual([...mod.PODMAN_ROOTLESS_CONF_FILES], ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", "/etc/containers/containers.rootless.conf"]);
	assert.deepEqual([...mod.PODMAN_ROOTLESS_CONF_DIRS], ["/etc/containers/containers.conf.d", "/etc/containers/containers.rootless.conf.d"]);
	for (const dir of ["/usr/share/containers/containers.conf.d", "/usr/share/containers/containers.rootless.conf.d", "/usr/share/containers/containers.rootless.conf.d/1234"]) {
		assert.equal(widening(confAt(`${dir}/x.conf`, '[containers]\nenv = ["X=1"]\n', dir)), null, dir);
	}
});
const widening = (fs, over = {}) => mod.podmanConfWidening({ fs, home: HOME, env: {}, euid: 1234, runRoot: "/run/user/1234/containers", ...over });
const confAt = (path, text, dir = null) => fakeFs({ files: { [path]: text }, dirs: dir ? { [dir]: [path.slice(dir.length + 1)] } : {} });
// What each key looks like where it was measured widening a job (M0, Fedora 44, Podman 5.8.1).
const MEASURED = {
	pasta_options: '[network]\npasta_options = ["--map-host-loopback", "169.254.1.2"]\n',
	network_cmd_options: '[engine]\nnetwork_cmd_options = ["allow_host_loopback=true"]\n',
	annotations: '[containers]\nannotations = ["run.oci.keep_original_groups=1"]\n',
	// Issue #428: pasta then got --map-host-loopback from the file this named.
	env: '[engine]\nenv = ["CONTAINERS_CONF_OVERRIDE=/tmp/x.conf"]\n',
	// Issue #450, gate round 1 (fedora-38): this ran the rootless network as `podpasta`. network_cmd_path was not measured.
	helper_binaries_dir: '[engine]\nhelper_binaries_dir = ["/home/gx469b/hb", "/usr/libexec/podman", "/usr/bin"]\n',
	network_cmd_path: '[engine]\nnetwork_cmd_path = "/home/gx469b/hb/slirp4netns"\n',
	// Issue #448 (round-446/pr448/m5, rootless 5.8.1 and 4.9.3 alike), each as it was measured reaching the job.
	default_sysctls: '[containers]\ndefault_sysctls = ["net.ipv4.ip_unprivileged_port_start=77"]\n',
	default_ulimits: '[containers]\ndefault_ulimits = ["nofile=333:333"]\n',
	seccomp_profile: '[containers]\nseccomp_profile = "/home/gx448r/aux/seccomp.json"\n',
	init_path: '[containers]\ninit_path = "/home/gx448r/aux/catatonit-marked"\n',
	dns_servers: '[containers]\ndns_servers = ["9.9.9.9"]\n',
	dns_options: '[containers]\ndns_options = ["ndots:7"]\n',
	dns_searches: '[containers]\ndns_searches = ["gx448.invalid"]\n',
	base_hosts_file: '[containers]\nbase_hosts_file = "/home/gx448r/aux/hosts"\n',
	oom_score_adj: '[containers]\noom_score_adj = 777\n',
	privileged: '[containers]\nprivileged = true\n',
	// Gate round 1 of PR #473 (raw 74, rootless on both hosts) and M6 (`cgroups`, `umask`).
	label: "[containers]\nlabel = false\n",
	cgroup_conf: '[containers]\ncgroup_conf = ["pids.max=max"]\n',
	host_containers_internal_ip: '[containers]\nhost_containers_internal_ip = "10.99.99.99"\n',
	runtimes: '[engine.runtimes]\ncrun = ["/home/gx473b/crun-wrap"]\n',
	conmon_path: '[engine]\nconmon_path = ["/home/gx473b/conmon-wrap"]\n',
	cgroups: '[containers]\ncgroups = "disabled"\n',
	umask: '[containers]\numask = "0000"\n',
};

// Issue #448: what was measured INERT for this venue's argv (round-446/pr448/m5), each exactly as it was set there.
const ROOTLESS_INERT = {
	userns: '[containers]\nuserns = "auto"\n',
	pidns: '[containers]\npidns = "host"\n',
	ipcns: '[containers]\nipcns = "host"\n',
	utsns: '[containers]\nutsns = "host"\n',
	cgroupns: '[containers]\ncgroupns = "host"\n',
	netns: '[containers]\nnetns = "host"\n',
	apparmor_profile: '[containers]\napparmor_profile = "unconfined"\n',
	default_capabilities: '[containers]\ndefault_capabilities = ["CHOWN", "NET_RAW", "SYS_ADMIN", "SYS_PTRACE"]\n',
	no_new_privileges: '[containers]\nno_new_privileges = false\n',
	init: '[containers]\ninit = false\n',
	pids_limit: '[containers]\npids_limit = 77\n',
	shm_size: '[containers]\nshm_size = "7m"\n',
	env_host: "[containers]\nenv_host = true\n",
	http_proxy: "[containers]\nhttp_proxy = true\n",
};

test("the podman venue's inert keys are documented and not refused, and the vendor's own default_sysctls block is accepted (#448)", { skip }, async () => {
	const { PODMAN_ROOTLESS_INERT_KEYS } = await import("../src/backends.mjs");
	assert.deepEqual([...PODMAN_ROOTLESS_INERT_KEYS], Object.keys(ROOTLESS_INERT));
	for (const [key, text] of Object.entries(ROOTLESS_INERT)) assert.equal(widening(confAt(`${HOME}/.config/containers/containers.conf`, text))?.key ?? null, null, key);
	// Fedora 44's and Ubuntu 24.04's stock vendor file, as shipped: accepted; any other value or a second sysctl: refused.
	assert.equal(widening(confAt("/usr/share/containers/containers.conf", '[containers]\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n]\nlog_driver = "journald"\n')), null);
	assert.equal(widening(confAt("/usr/share/containers/containers.conf", '[containers]\ndefault_sysctls = [\n  "net.ipv4.ping_group_range=0 0",\n  "net.ipv4.ip_unprivileged_port_start=0",\n]\n'))?.key, "default_sysctls");
});

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
		['containers = { label_users = ["A=1"], annotations = ["x=1"] }\n', "annotations"],
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
		// Issue #450: either one swaps the program behind every job's network; the stock files carry both commented out.
		['[engine]\nhelper_binaries_dir = ["/usr/libexec/podman"]\n', "helper_binaries_dir"],
		['engine.network_cmd_path = "/usr/bin/slirp4netns"\n', "network_cmd_path"],
		['[engine]\nHELPER_BINARIES_DIR=[]\n', "helper_binaries_dir"],
		// Any value refuses, the empty one too: presence is the rule, since no argv takes any value back.
		["[containers]\nannotations = []\n", "annotations"],
		// A `#` inside a string earlier on the line is not a comment (MOUNT_KEY's measured rule).
		['[containers]\nlabel_users = ["X=#"]\nannotations = ["a=b"]\n', "annotations"],
	]) assert.equal(at(text), key, text);
	for (const text of [
		'# pasta_options = ["--map-gw"]\n',
		'   #annotations = ["run.oci.keep_original_groups=1"]\n',
		'\t# network.pasta_options = ["--map-gw"]\n',
		"my_pasta_options_x = 1\n",
		"pasta_optionsx = 1\n",
		"pod_annotations = 1\n",
		"network_cmd_options_extra = 1\n",
		"#helper_binaries_dir = [\n",
		"# the helper_binaries_dir option. It is recommended to just install catatonit\n",
		'#network_cmd_path = ""\n',
		"network_cmd_paths = 1\n",
		'default_rootless_network_cmd = "slirp4netns"\n',
		'[containers]\nlabel_users = ["annotations"]\n',
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
		["multi-line basic", 'containers = { label_users = ["""\n# """], annotations = ["run.oci.keep_original_groups=1"] }\n'],
		["multi-line literal", "network = { default_subnet = '''\n#''', pasta_options = [\"-T\",\"6379\"] }\n"],
		["u2028", 'network = { default_subnet = "a\u2028# ", pasta_options = ["-T","6379"] }\n'],
		["u2029", 'network = { default_subnet = "a\u2029# ", pasta_options = ["-T","6379"] }\n'],
	]) {
		const found = widening(confAt(`${HOME}/.config/containers/containers.conf`, text));
		noKey(found, /line \d has (a non-ASCII character|a multi-line string)/, label);
		// The remedy names the spelling and nothing else: no "make it readable", no "unset the variable".
		assert.match(mod.podmanConfFix(found), /^rewrite that line in plain ASCII with no """ or ''' multi-line string: /, label);
		assert.doesNotMatch(mod.podmanConfFix(found), /readable|unset the variable/, label);
	}
	const escapedFix = mod.podmanConfFix(widening(confAt(`${HOME}/.config/containers/containers.conf`, '[network]\n"pasta\\u005foptions" = []\n')));
	assert.match(escapedFix, /^rewrite that key without a backslash escape: /);
	// A transient read is neither a key nor a refusal: it comes back `transient`, and its text says it will be retried.
	for (const code of ["EMFILE", "ENFILE", "EIO", "EAGAIN"]) {
		const file = widening(fakeFs({ files: { "/etc/containers/containers.conf": "" }, errors: { "/etc/containers/containers.conf": code } }));
		assert.deepEqual([file.key, file.transient], [null, true], code);
		assert.match(mod.podmanConfRefusal(file), /^Not read yet: .* could not be read \(\w+\); the read failed for a moment, not for a reason in the file; a job refused this way is retried once \(the queue's second attempt\)/, code);
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
		"Refused: /home/op/.config/containers/containers.conf sets pasta_options, which Podman hands to the pasta behind every job's network, where a host-loopback mapping (--map-host-loopback, --map-gw, -T) gives the job this host's 127.0.0.1 services; remove that key from that file, then stop every running container of this account that is on a bridge network, all of them at once, then start them again, since the rootless network they share lives until the last of them stops and a container started meanwhile joins it as it is: with this project's units, systemctl --user stop pi-dispatch-worker.service pi-dispatch-egress-proxy.service pi-dispatch-netns-keeper.service pi-dispatch-valkey.service, then podman stop any other container `podman ps` still lists, then systemctl --user start pi-dispatch-valkey.service pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service pi-dispatch-worker.service (a worker installed at system scope is stopped and started with sudo systemctl stop and start pi-dispatch-worker.service instead; for containers started by hand, podman stop them all, then podman start them). Stop the keeper with systemctl, not podman stop: its unit starts it again a second later, and it then rejoins the network as it is while any other bridge container still runs. A unit this account does not have is reported as not loaded, and the others still stop and start. The podman venue refuses any containers.conf this account's Podman reads that sets pasta_options, network_cmd_options, annotations, env, helper_binaries_dir, network_cmd_path, default_sysctls, default_ulimits, seccomp_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, oom_score_adj, privileged, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path, cgroups or umask, whatever the value, because no flag on a job's command line takes it back, and it refuses a rootless network still running with such an option after the key is gone. A setting you need for your own containers (a pasta MTU, say) goes on their own command line (--network=pasta:...) or Quadlet unit instead, not account-wide (issue #428).",
	);
	assert.equal(mod.podmanConfRefusal(found), `Refused: ${found.evidence}; ${mod.podmanConfFix(found)} (issue #428).`);
	for (const key of WIDENING_KEYS) assert.match(mod.podmanConfRefusal(widening(confAt("/etc/containers/containers.conf", MEASURED[key]))), new RegExp(`^Refused: /etc/containers/containers\\.conf sets ${key}, which .*; remove that key from that file`));
	const unread = widening(fakeFs(), { env: { CONTAINERS_CONF: "/x" } });
	assert.match(mod.podmanConfRefusal(unread), /^Refused: CONTAINERS_CONF is set, .*; the podman venue must read every containers\.conf .* make that file or directory readable by the worker's account, or unset the variable for it \(issue #428\)\.$/);
	assert.equal(mod.PODMAN_CONF_WIDENS_JOB, "podman-conf-widens-job");
	assert.ok(!Object.hasOwn(mod.PODMAN_JOB_USER_FIX, mod.PODMAN_CONF_WIDENS_JOB), "a venue refusal, not a job-user cause");
});

// Issue #450: the live rootless network. Every argv below is copied verbatim from a measured /proc/<pid>/cmdline
// (round-446 M0-b and pr450: Fedora 44, Podman 5.8.1, uid 1235; Ubuntu 24.04, Podman 4.9.3, uid 1234), and only the rows
// that say so edit one. The helper is found from Podman's own record (gate round 1 of PR #469), never by its name.
const F_RUNROOT = "/run/user/1235/containers";
const F_NETNS = `${F_RUNROOT}/networks/rootless-netns/rootless-netns`;
const F_PID = `${F_RUNROOT}/networks/rootless-netns/rootless-netns-conn.pid`;
const F_BASE = ["/usr/sbin/pasta", "--config-net", "--pid", F_PID, "--dns-forward", "169.254.1.1", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw", "--quiet", "--netns", F_NETNS, "--map-guest-addr", "169.254.1.2"];
// The measured widened shapes: the conf option lands right after --config-net, and Podman drops its own counterpart.
const F_ADDED = (...opts) => [F_BASE[0], F_BASE[1], ...opts, ...F_BASE.slice(2)];
const F_WITHOUT = (argv, ...drop) => argv.filter((_, i) => !drop.includes(i));
const F_MHL = F_ADDED("--map-host-loopback", "169.254.1.2");
const F_MHL_EQ = F_ADDED("--map-host-loopback=169.254.1.2");
const F_MAPGW = F_BASE.filter((t) => t !== "--no-map-gw");
const F_T6379 = F_WITHOUT(F_ADDED("-T", "6379"), 12, 13);
const F_TCPNS = F_WITHOUT(F_ADDED("--tcp-ns", "6379"), 12, 13);
// 5.8.1 with `default_rootless_network_cmd = "slirp4netns"` (gate469 fedora-48): the same record, a slirp4netns helper.
const F_SLIRP5_WIDE = ["/usr/bin/slirp4netns", "--mtu=65520", "--enable-sandbox", "--enable-seccomp", "--enable-ipv6", "-c", "-r", "3", "--netns-type=path", F_NETNS, "tap0"];
const F_PER_PASTA = ["/usr/sbin/pasta", "--config-net", "--dns-forward", "169.254.1.1", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw", "--quiet", "--netns", "/run/user/1235/netns/netns-d7543bd6-5345-d135-a8e8-c28a851e1c50", "--map-guest-addr", "169.254.1.2"];
const F_PER_SLIRP = ["/usr/sbin/slirp4netns", "--disable-host-loopback", "--mtu=65520", "--enable-sandbox", "--enable-seccomp", "--enable-ipv6", "-c", "-r", "3", "-e", "4", "--netns-type=path", "/run/user/1235/netns/netns-3fcb7f41-d4c6-702c-a04d-0ba9bbc3521e", "tap0"];
const U_BASE = ["/usr/bin/slirp4netns", "--disable-host-loopback", "--mtu=65520", "--enable-sandbox", "--enable-seccomp", "--enable-ipv6", "-c", "-r", "3", "--netns-type=path", "/run/user/1234/netns/rootless-netns-95a67c32c4d4ea4d7b39", "tap0"];
const U_WIDE = U_BASE.filter((t) => t !== "--disable-host-loopback");
const U_PER_WIDE = ["/usr/bin/slirp4netns", "--mtu=65520", "--enable-sandbox", "--enable-seccomp", "--enable-ipv6", "-c", "-r", "3", "-e", "4", "--netns-type=path", "/run/user/1234/netns/netns-3fe2802e-f15d-84c7-754d-47167dbc0bc0", "tap0"];
const U_PER_PASTA = ["/usr/bin/pasta", "--config-net", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw", "--netns", "/run/user/1234/netns/netns-378ea648-5636-723c-670d-bfc56de25c87"];
/**
 * A /proc tree: `procs` maps a pid to `{ name, uid, argv, nspid, start }` (status, stat and cmdline as the kernel writes
 * them; `start` is field 22 of stat, in ticks after `BTIME`, 10 s after boot unless given; `nspid`
 * defaults to the pid alone, the worker's own pid namespace, and two fields is a process in a namespace below it, as a
 * job's and 5.8.1's pasta were measured), or to an errno a read of that pid's status throws. `cmdlineErrors` maps a pid
 * to one its cmdline read throws; `files` adds host files (Podman's pid file); `errors` a path to an errno.
 */
function procFs(procs, { cmdlineErrors = {}, procError = null, files: extra = {}, errors: extraErrors = {}, mtimes = {} } = {}) {
	const files = { "/proc/stat": `cpu  1 2 3 4\nbtime ${BTIME}\nprocesses 99\n` };
	const errors = { ...extraErrors };
	for (const [pid, p] of Object.entries(procs)) {
		if (typeof p === "string") errors[`/proc/${pid}/status`] = p;
		else {
			files[`/proc/${pid}/status`] = `Name:\t${p.name}\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${pid}\nNgid:\t0\nPid:\t${pid}\nPPid:\t1\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\nGid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n${p.nspid === null ? "" : `NSpid:\t${p.nspid ?? pid}\n`}`;
			files[`/proc/${pid}/cmdline`] = `${p.argv.join("\0")}\0`;
			// The comm field in parentheses may hold spaces and parentheses itself; field 22 is counted after it.
			files[`/proc/${pid}/stat`] = `${pid} (${p.name} (x)) S 1 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${p.start ?? 1000} 1 1 18446744073709551615\n`;
		}
		if (cmdlineErrors[pid]) errors[`/proc/${pid}/cmdline`] = cmdlineErrors[pid];
	}
	if (procError) errors["/proc"] = procError;
	const fs = fakeFs({ files: { ...files, ...extra }, errors, dirs: { "/proc": ["self", "thread-self", ...Object.keys(procs)] } });
	return { ...fs, statSync: (path) => (Object.hasOwn(mtimes, path) && !errors[path] ? { ...fs.statSync(path), mtimeMs: mtimes[path] } : fs.statSync(path)) };
}
// Boot at this epoch second; Podman's record written a minute after boot, and each process started 10 s after boot.
const BTIME = 1_790_000_000;
const RECORD_MTIME = (BTIME + 60) * 1000;
const helper = (uid, argv, { name = argv[0].split("/").pop(), nspid } = {}) => ({ name, uid, argv, nspid });
// A 5.x helper as measured: PID 1 of a pid namespace of its own, recorded by Podman's pid file.
const pasta5 = (pid, argv, uid = 1235) => ({ [pid]: helper(uid, argv, { nspid: `${pid}\t1` }) });
const recorded = (pid, file = F_PID) => ({ files: { [file]: `${pid}\n` }, mtimes: { [file]: RECORD_MTIME } });
const live = (procs, euid, over = {}) => mod.podmanNetnsWidening({ fs: procFs(procs, over), euid, runRoot: Object.hasOwn(over, "runRoot") ? over.runRoot : `/run/user/${euid}/containers` });

test("5.x: the helper is the process Podman's pid file names, and each measured widening refuses (#450)", { skip }, () => {
	// The narrow argv passes, beside a container's own pasta and slirp4netns and a rootlessport, all of this uid.
	const quiet = { ...pasta5(10, F_BASE), 11: helper(1235, F_PER_PASTA), 12: helper(1235, F_PER_SLIRP), 13: helper(1235, ["rootlessport"]) };
	assert.equal(live(quiet, 1235, recorded(10)), null);
	assert.deepEqual(mod.observeRootlessNetns({ fs: procFs(quiet, recorded(10)), euid: 1235, runRoot: F_RUNROOT }), { helpers: [{ pid: 10, kind: "pasta", widened: [] }] });
	for (const [label, argv, says] of [
		["--map-host-loopback 169.254.1.2", F_MHL, /still carries --map-host-loopback, which maps this host's 127\.0\.0\.1 into it:/],
		["--map-host-loopback=169.254.1.2", F_MHL_EQ, /still carries --map-host-loopback/],
		["--map-gw (shows as --no-map-gw missing)", F_MAPGW, /still lacks Podman's own --no-map-gw, which a --map-gw option removes, so its gateway address is this host:/],
		["-T 6379 (and -T none dropped)", F_T6379, /still carries a -T other than none, which forwards to this host's loopback TCP ports:/],
		["--tcp-ns 6379 (and -T none dropped)", F_TCPNS, /still carries a -T other than none/],
	]) {
		const found = live({ ...pasta5(10, argv), 11: helper(1235, F_PER_PASTA) }, 1235, recorded(10));
		assert.deepEqual([found?.cause, found?.key, found?.live, found?.transient], ["podman-conf-widens-job", "pasta_options", true, undefined], label);
		assert.match(found.evidence, /^this account's running rootless network \(pasta, pid 10\), which every container on a bridge network shares, the egress proxy's among them, still /, label);
		assert.match(found.evidence, says, label);
		assert.match(found.evidence, /: it keeps the options it started with, whatever containers\.conf says now$/, label);
	}
	// Spellings not measured but taken by pasta's getopt_long, and a missing -T or -U, which pasta then defaults open.
	for (const [label, argv] of [
		["--map-h prefix", F_ADDED("--map-h", "169.254.1.2")],
		["--tcp-n=6379 prefix", F_WITHOUT(F_ADDED("--tcp-n=6379"), 11, 12)],
		["-T6379 attached", F_WITHOUT(F_ADDED("-T6379"), 11, 12)],
		["-qT 6379 cluster", F_ADDED("-qT", "6379")],
		["-T auto", F_ADDED("-T", "auto")],
		["-U 5353", F_ADDED("-U", "5353")],
		["--udp-ns 5353", F_ADDED("--udp-ns", "5353")],
		["-T none missing", F_WITHOUT(F_BASE, 10, 11)],
		["-U none missing", F_WITHOUT(F_BASE, 12, 13)],
		["-T with no value", [...F_WITHOUT(F_BASE, 10, 11), "-T"]],
	]) assert.equal(live(pasta5(10, argv), 1235, recorded(10))?.key, "pasta_options", label);
	for (const [label, argv] of [
		["-Tnone", F_WITHOUT(F_ADDED("-Tnone"), 11, 12)],
		["--tcp-ns=none", F_WITHOUT(F_ADDED("--tcp-ns=none"), 11, 12)],
		["--udp-ns none", F_WITHOUT(F_ADDED("--udp-ns", "none"), 14, 15)],
	]) assert.equal(live(pasta5(10, argv), 1235, recorded(10)), null, label);
	// Named by either half of the record: the pid file alone, or the network alone in its `=` form.
	assert.equal(live(pasta5(10, F_MAPGW.filter((t) => t !== F_NETNS && t !== "--netns")), 1235, recorded(10))?.key, "pasta_options", "--pid only");
	const netnsEq = F_MAPGW.filter((t) => t !== F_PID && t !== "--pid").map((t) => (t === "--netns" ? `--netns=${F_NETNS}` : t)).filter((t) => t !== F_NETNS);
	assert.equal(live(pasta5(10, netnsEq), 1235, recorded(10))?.key, "pasta_options", "--netns= only");
	// D3: never by name. A helper Podman ran from another helper_binaries_dir keeps Podman's argv (gate469 fedora-38).
	assert.equal(live(pasta5(10, ["/home/gx469b/hb/podpasta", ...F_MHL.slice(1)]), 1235, recorded(10))?.key, "pasta_options", "renamed pasta");
	// 5.x's slirp4netns rootless network, by the same record, judged by slirp4netns's rule (gate469 fedora-48).
	const slirp5 = live({ 10: helper(1235, F_SLIRP5_WIDE) }, 1235, recorded(10));
	assert.deepEqual([slirp5?.key, /\(slirp4netns, pid 10\)/.test(slirp5?.evidence)], ["network_cmd_options", true]);
	// D2: a runRoot outside /run/user (XDG_RUNTIME_DIR moved, gate469 fedora-37c) is Podman's record all the same.
	const moved = "/tmp/gx469b-rt/containers";
	const movedArgv = F_MHL.map((t) => t.replace(F_RUNROOT, moved));
	assert.equal(live(pasta5(10, movedArgv), 1235, { runRoot: moved, ...recorded(10, `${moved}/networks/rootless-netns/rootless-netns-conn.pid`) })?.key, "pasta_options");
});

test("5.x: the pid file is Podman's only word, and what it cannot say refuses (#450)", { skip }, () => {
	// No record is no helper: Podman removes the file when the last bridge container stops (measured), and a helper
	// running with it gone left Podman unable to start a job at all (TUNSETIFF, gate469 fedora-39).
	assert.equal(live(pasta5(10, F_MHL), 1235), null, "no pid file");
	// A record whose pid is gone (a killed helper leaves it, gate469 fedora-36), another uid's, or a process whose argv
	// names neither half of the record (the kernel has handed the pid on), is no helper.
	assert.equal(live({}, 1235, recorded(10)), null, "stale");
	assert.equal(live({ 10: "ENOENT" }, 1235, recorded(10)), null, "gone mid-read");
	assert.equal(live(pasta5(10, F_MHL, 1236), 1235, recorded(10)), null, "another uid's");
	assert.equal(live({ 10: helper(1235, ["sleep", "1000"]) }, 1235, recorded(10)), null, "recycled");
	assert.equal(live(pasta5(10, F_MHL.map((t) => t.replace("/1235/", "/1236/"))), 1235, recorded(10)), null, "another record's helper");
	// What decides it and cannot be read refuses, naming it; a read failing for a moment is the retry.
	const refuses = (found, evidence, label) => {
		assert.deepEqual([found?.cause, found?.key, found?.live, found?.transient], ["podman-conf-widens-job", null, true, undefined], label);
		assert.equal(found.evidence, evidence, label);
	};
	for (const code of ["EACCES", "ENOTDIR", "EISDIR"]) refuses(live(pasta5(10, F_BASE), 1235, { errors: { [F_PID]: code }, files: { [F_PID]: "10" } }), `${F_PID} could not be read (${code}), so whether this account's running rootless network still carries an option that widens a job is not known`, code);
	refuses(live(pasta5(10, F_BASE), 1235, { files: { [F_PID]: "ten\n" } }), `${F_PID} holds no pid, so which process is this account's running rootless network is not known`, "no pid");
	refuses(live(pasta5(10, F_BASE), 1235, { ...recorded(10), cmdlineErrors: { 10: "EACCES" } }), "/proc/10/cmdline could not be read (EACCES), so whether this account's running rootless network still carries an option that widens a job is not known", "argv denied");
	for (const runRoot of [null, "relative/containers", ""]) refuses(live(pasta5(10, F_MHL), 1235, { runRoot, ...recorded(10) }), "podman info reports no store.runRoot, so where Podman records this account's running rootless network is not known", String(runRoot));
	assert.match(mod.podmanConfFix(live(pasta5(10, F_BASE), 1235, { runRoot: null })), /^the podman venue reads \/proc to find this account's rootless network/);
	for (const over of [{ errors: { [F_PID]: "EMFILE" }, files: { [F_PID]: "10" } }, { ...recorded(10), cmdlineErrors: { 10: "EIO" } }, { ...recorded(10), errors: { "/proc/10/status": "EAGAIN" } }]) {
		const busy = live(pasta5(10, F_BASE), 1235, over);
		assert.deepEqual([busy?.key, busy?.transient], [null, true], JSON.stringify(over));
		assert.match(mod.podmanConfRefusal(busy), /^Not read yet: .* could not be read \(E\w+\), .*; the read failed for a moment/);
	}
	// A read that has not answered is not judged here: that same read leaves the job user undecided, which retries.
	assert.equal(live(pasta5(10, F_MHL), 1235, { runRoot: undefined, ...recorded(10) }), null);
});

test("D1: a job's own process cannot stand in for the helper, whatever it names (#450)", { skip }, () => {
	// A job runs as this uid under keep-id, in a pid namespace of its own (two NSpid fields, measured).
	const job = (argv) => helper(1235, argv, { name: "pasta", nspid: "40\t1" });
	// The gate's fakes: a `--pid` path that cannot be read as a file (ENOTDIR, EACCES), or that names Podman's own record.
	for (const [label, argv, over] of [
		["ENOTDIR pid path", ["/bin/sh", "/tmp/pasta", "--netns", "/x/rootless-netns", "--pid", "/run/user/1235/bus/rootless-netns-conn.pid"], { errors: { "/run/user/1235/bus/rootless-netns-conn.pid": "ENOTDIR" } }],
		["EACCES pid path", ["/bin/sh", "/tmp/pasta", "--netns", "/x/rootless-netns", "--pid", "/run/user/1235/x/rootless-netns-conn.pid"], { errors: { "/run/user/1235/x/rootless-netns-conn.pid": "EACCES" }, files: { "/run/user/1235/x/rootless-netns-conn.pid": "40" } }],
		["names the real record", ["/bin/sh", "/tmp/pasta", "--pid", F_PID, "--netns", F_NETNS], {}],
		["4.x-shaped", ["/bin/sh", "/tmp/slirp4netns", "--netns-type=path", "/run/user/1235/netns/rootless-netns-0123abcd", "tap0"], {}],
	]) {
		assert.equal(live({ 40: job(argv) }, 1235, over), null, `${label}, alone`);
		assert.equal(live({ ...pasta5(10, F_BASE), 40: job(argv) }, 1235, { ...over, files: { ...over.files, [F_PID]: "10" }, mtimes: { [F_PID]: RECORD_MTIME } }), null, `${label}, beside the real narrow helper`);
	}
	// And the real helper is still found and judged with the job's process beside it.
	assert.equal(live({ ...pasta5(10, F_MHL), 40: job(F_MHL) }, 1235, recorded(10))?.evidence.includes("(pasta, pid 10)"), true);
});

test("5.x: a recorded pid is the helper only if it started by the record's mtime, or is shaped as no job's process is (#450)", { skip }, () => {
	// Gate round 2 of PR #469 (fedora-42b): pasta crashed, its pid file stayed, and the kernel handed the pid to a job's
	// process whose argv named the record. It started after the record was written, and it is no PID 1: not the helper.
	const late = (BTIME + 120) * 100 - BTIME * 100; // 120 s after boot, a minute after the record
	const recycled = { 10: helper(1235, ["sh", "-c", `sleep 3; : ${F_PID}`], { name: "sh", nspid: "10\t587" }) };
	recycled[10].start = late;
	assert.equal(live(recycled, 1235, recorded(10)), null, "a recycled pid");
	const recycledWide = { 10: { ...helper(1235, F_MHL, { nspid: "10\t587" }), start: late } };
	assert.equal(live(recycledWide, 1235, recorded(10)), null, "a recycled pid carrying a widening argv");
	// Within the tolerance (btime rounding, a tick, NTP slew) it is still the writer; just past it, it is not.
	const at = (ms) => ({ 10: { ...helper(1235, F_MHL, { nspid: "10\t587" }), start: Math.round(((RECORD_MTIME + ms) / 1000 - BTIME) * 100) } });
	assert.equal(live(at(mod.RECORD_START_TOLERANCE_MS), 1235, recorded(10))?.key, "pasta_options", "at the tolerance");
	assert.equal(live(at(mod.RECORD_START_TOLERANCE_MS + 10), 1235, recorded(10)), null, "one tick past it");
	assert.deepEqual([mod.PROC_USER_HZ, mod.RECORD_START_TOLERANCE_MS], [100, 2000]);
	// A wall-clock step moves btime and not the file: the real helper then reads as started late, and is still judged,
	// by its shape: 5.8.1's pasta is PID 1 of its own namespace, its slirp4netns shares the worker's (both measured).
	assert.equal(live({ 10: { ...helper(1235, F_MHL, { nspid: "10\t1" }), start: late } }, 1235, recorded(10))?.key, "pasta_options", "pasta after a clock step");
	assert.equal(live({ 10: { ...helper(1235, F_SLIRP5_WIDE, { nspid: "10" }), start: late } }, 1235, recorded(10))?.key, "network_cmd_options", "slirp4netns after a clock step");
	// Gate round 3: a job can make a pid namespace of its own (`unshare -Urpf`, measured on both Podmans) and be PID 1
	// there, which is two levels below the worker's: three fields ending in 1, not trusted, whatever its argv names.
	// Exactly two ending in 1 (5.8.1's pasta) and exactly one (the worker's own) are.
	for (const [nspid, trusted] of [["10\t1", true], ["10", true], ["10\t587\t1", false], ["10\t2\t1", false], ["10\t5\t3\t1", false], ["10\t2", false]]) {
		const got = live({ 10: { ...helper(1235, F_MHL, { nspid }), start: late } }, 1235, recorded(10));
		assert.equal(got?.key ?? null, trusted ? "pasta_options" : null, `NSpid ${JSON.stringify(nspid)} after the record`);
	}
	// What decides it and cannot be read refuses, named; a process gone before its stat is read is no helper.
	const refusing = (over, evidence, label) => assert.equal(live(pasta5(10, F_MHL), 1235, over)?.evidence, evidence, label);
	refusing({ files: { [F_PID]: "10" } }, `${F_PID} gives no modification time, so whether the recorded process is the one Podman's record was written for is not known`, "no mtime");
	refusing({ ...recorded(10), errors: { "/proc/10/stat": "EACCES" } }, "/proc/10/stat could not be read (EACCES), so whether this account's running rootless network still carries an option that widens a job is not known", "stat denied");
	refusing({ ...recorded(10), files: { [F_PID]: "10", "/proc/10/stat": "10 (pasta) S 1\n" } }, "/proc/10/stat gives no start time, so whether the recorded process is the one Podman's record was written for is not known", "short stat");
	refusing({ ...recorded(10), files: { [F_PID]: "10", "/proc/stat": "cpu 1\n" } }, "/proc/stat gives no boot time, so whether the recorded process is the one Podman's record was written for is not known", "no btime");
	refusing({ ...recorded(10), errors: { "/proc/stat": "EPERM" } }, "/proc/stat could not be read (EPERM), so whether this account's running rootless network still carries an option that widens a job is not known", "/proc/stat denied");
	assert.equal(live(pasta5(10, F_MHL), 1235, { ...recorded(10), errors: { "/proc/10/stat": "ESRCH" } }), null, "gone before its stat");
	assert.equal(live(pasta5(10, F_MHL), 1235, { ...recorded(10), errors: { "/proc/10/stat": "EMFILE" } })?.transient, true, "a moment's failure retries");
});

test("4.x: slirp4netns is found by its argv among the worker's own pid namespace, when Podman keeps no 5.x record (#450)", { skip }, () => {
	assert.equal(live({ 20: helper(1234, U_BASE), 21: helper(1234, U_PER_PASTA) }, 1234), null);
	assert.deepEqual(mod.observeRootlessNetns({ fs: procFs({ 20: helper(1234, U_BASE) }), euid: 1234, runRoot: "/run/user/1234/containers" }), { helpers: [{ pid: 20, kind: "slirp4netns", widened: [] }] });
	const found = live({ 20: helper(1234, U_WIDE) }, 1234);
	assert.deepEqual([found?.key, found?.live], ["network_cmd_options", true]);
	assert.match(found.evidence, /^this account's running rootless network \(slirp4netns, pid 20\), .* still lacks Podman's own --disable-host-loopback, which allow_host_loopback=true removes, so 10\.0\.2\.2 there is this host's 127\.0\.0\.1:/);
	assert.deepEqual(mod.rootlessNetnsWidening("slirp4netns", U_BASE), []);
	// Found by argv, never by name: a renamed slirp4netns, and the split `--netns-type path` spelling.
	assert.equal(live({ 20: helper(1234, ["/opt/hb/myslirp", ...U_WIDE.slice(1)]) }, 1234)?.key, "network_cmd_options", "renamed");
	assert.equal(live({ 20: helper(1234, U_WIDE.flatMap((t) => (t === "--netns-type=path" ? ["--netns-type", "path"] : [t]))) }, 1234)?.key, "network_cmd_options", "split");
	for (const [label, euid, procs] of [
		// A container's own helper (netns-<uuid>) serves one container, and is where docs/podman.md sends a setting an
		// operator needs for their own.
		["a container's own slirp4netns, widened (measured)", 1234, { 20: helper(1234, U_BASE), 21: helper(1234, U_PER_WIDE) }],
		["another account's widened helper", 1234, { 20: helper(1236, U_WIDE) }],
		["outside the worker's pid namespace", 1234, { 20: helper(1234, U_WIDE, { nspid: "20\t1" }) }],
		["no NSpid line at all", 1234, { 20: helper(1234, U_WIDE, { nspid: null }) }],
		["the rootless path without --netns-type (nsenter, say)", 1234, { 20: helper(1234, ["nsenter", "--net=/run/user/1234/netns/rootless-netns-95a67c32c4d4ea4d7b39"]) }],
		["conmon of a container named pasta", 1234, { 30: helper(1234, ["/usr/bin/conmon", "--api-version", "1", "-n", "pasta", "-p", "/run/user/1234/netns/rootless-netns-95a67c32c4d4ea4d7b39"]) }],
		["nothing running", 1234, {}],
	]) assert.equal(live(procs, euid), null, label);
	// The scan's own reads: a process gone or another account's under hidepid is skipped; a /proc that exists and
	// cannot be listed, or this uid's own-namespace process whose argv cannot be read, refuses; a moment's failure retries.
	assert.equal(live({ 5: "ENOENT", 6: "ESRCH", 7: "EACCES", 8: "EPERM", 20: helper(1234, U_WIDE) }, 1234)?.key, "network_cmd_options");
	assert.equal(live({ 20: helper(1234, U_WIDE) }, 1234, { cmdlineErrors: { 20: "ESRCH" } }), null);
	assert.equal(live({ 20: helper(1234, U_BASE) }, 1234, { cmdlineErrors: { 20: "EACCES" } })?.evidence, "/proc/20/cmdline could not be read (EACCES), so whether this account's running rootless network still carries an option that widens a job is not known");
	assert.equal(live({ 20: helper(1234, U_BASE, { nspid: "20\t1" }) }, 1234, { cmdlineErrors: { 20: "EACCES" } }), null, "a job's argv is never read");
	assert.equal(live({}, 1234, { procError: "EACCES" })?.evidence, "/proc could not be read (EACCES), so whether this account's running rootless network still carries an option that widens a job is not known");
	assert.equal(live({}, 1234, { procError: "ENOENT" }), null);
	for (const over of [{ procError: "EMFILE" }, { cmdlineErrors: { 20: "EIO" } }]) assert.deepEqual([live({ 20: helper(1234, U_BASE) }, 1234, over)?.transient], [true], JSON.stringify(over));
	assert.equal(live({ 5: "EMFILE", 20: helper(1234, U_BASE) }, 1234)?.transient, true, "a status read failing for a moment");
});

test("a widened live network is the podman venue's conf refusal, after the conf chain and with the reset to run (#450)", { skip }, () => {
	const fs = procFs({ 10: helper(1234, U_WIDE) });
	const found = widening(fs);
	assert.deepEqual([found?.cause, found?.key, found?.live], ["podman-conf-widens-job", "network_cmd_options", true]);
	const text = mod.podmanConfRefusal(found);
	assert.ok(text.startsWith(`Refused: ${found.evidence}; stop every running container of this account that is on a bridge network, all of them at once, then start them again`), text);
	// The reset names every unit this project ships a bridge container in, the keeper among them, stopped before started,
	// and a worker installed at system scope.
	assert.match(text, /systemctl --user stop pi-dispatch-worker\.service pi-dispatch-egress-proxy\.service pi-dispatch-netns-keeper\.service pi-dispatch-valkey\.service, then podman stop any other container `podman ps` still lists, then systemctl --user start pi-dispatch-valkey\.service pi-dispatch-netns-keeper\.service pi-dispatch-egress-proxy\.service pi-dispatch-worker\.service \(a worker installed at system scope is stopped and started with sudo systemctl stop and start pi-dispatch-worker\.service instead;/);
	// At boot the worker exits 2 and stays down, so the text says the start brings it back, and only a running one admits.
	assert.match(text, /Stop the keeper with systemctl, not podman stop: its unit starts it again a second later, and it then rejoins the network as it is while any other bridge container still runs\. A unit this account does not have is reported as not loaded, and the others still stop and start\. A worker this stopped at boot exits 2 and stays down until that start brings it back; a running one reads this network again before every podman job and admits the next once it no longer carries the option \(issue #450\)\.$/);
	assert.doesNotMatch(text, /remove that key/, "there is no key in a file to remove");
	// A key in a file is named first: its fix is the one that comes first.
	const both = procFs({ 10: helper(1234, U_WIDE) }, { files: { [`${HOME}/.config/containers/containers.conf`]: MEASURED.annotations } });
	assert.deepEqual([widening(both).key, widening(both).live], ["annotations", undefined]);
	// The pre-spend judgement hands it back as a conf refusal marked live, from runRoot in the same info read.
	const judged = mod.judgePodmanVenue({ read: answered(), platform: "linux", euid: 1234, egid: 1234, fs, home: HOME, env: {} });
	assert.deepEqual(judged.podmanConfRefused, { reason: "podman-conf-widens-job", key: "network_cmd_options", message: text, live: true });
	// An answered read reporting no runRoot refuses; one that has not answered leaves it to the undecided job user.
	assert.equal(mod.judgePodmanVenue({ read: answered({ runRoot: null }), platform: "linux", euid: 1234, egid: 1234, fs: procFs({}), home: HOME, env: {} }).podmanConfRefused?.key, null);
	assert.equal(mod.judgePodmanVenue({ read: answered({ runRoot: null }), platform: "linux", euid: 1234, egid: 1234, fs: procFs({}), home: HOME, env: {} }).podmanConfRefused?.reason, "podman-conf-widens-job");
	// Narrow, the venue is clean again with no restart of the worker: the next judgement admits.
	assert.equal(mod.judgePodmanVenue({ read: answered(), platform: "linux", euid: 1234, egid: 1234, fs: procFs({ 10: helper(1234, U_BASE) }), home: HOME, env: {} }).podmanConfRefused, undefined);
});

// Round 2 of the #428 review: the podman observations' sibling file reads follow the transient rule too, and a null
// they produce carries a reason naming a file, so the per-job retry says which file instead of blaming the runtime.
test("a podman observation's host file read failing for a moment is not answered, and the retry names the file (#428)", { skip }, async () => {
	const mountsFailing = (code) => fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { [USER_MOUNTS]: code } });
	const hooksFailing = (code) => fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/oci/hooks.d": code } });
	const fipsFailing = (code) => fakeFs({ files: { [USER_MOUNTS]: "", "/proc/sys/crypto/fips_enabled": "0" }, errors: { "/proc/sys/crypto/fips_enabled": code } });
	for (const [label, fs] of [["user mounts.conf", mountsFailing], ["hooks dir", hooksFailing], ["fips file", fipsFailing]]) {
		const busy = observe(answered(), fs("EMFILE"));
		assert.equal(busy.observations[PODMAN_ADDS_NO_MOUNTS], null, `${label} EMFILE`);
		assert.equal(busy.reasons[PODMAN_ADDS_NO_MOUNTS], "file-unread", label);
		assert.equal(observe(answered(), fs("EACCES")).observations[PODMAN_ADDS_NO_MOUNTS], false, `${label} EACCES`);
	}
	// The bounds observation reads the same chain (for a cgroups key); its transient null carries the same reason.
	const chainBusy = observe(answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/containers.conf": "EMFILE" } }));
	assert.equal(chainBusy.observations[PODMAN_BOUNDS_DELEGATED], null);
	assert.equal(chainBusy.reasons[PODMAN_BOUNDS_DELEGATED], "file-unread");
	// Through the bundle: a floor naming mountSet is retried with the file named, never refused, never "unknown".
	const out = await bundle({ fs: mountsFailing("EMFILE"), backendFloor: { mountSet: ENFORCED } }).observationPreflight(JOB);
	assert.deepEqual(out, { unavailable: true, reason: "file-unread", message: `${USER_MOUNTS} could not be read (EMFILE)` });
	assert.deepEqual(mod.unavailableFor({ reasons: { x: "timeout" }, evidence: { x: "e" } }, "x"), { unavailable: true, reason: "timeout" }, "a daemon read keeps its own words");
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

test("the podman reaper detaches nothing RUNNING from a leftover job network on 4.x while the keeper does not hold (#452 with #458, gate round 2)", { skip }, async () => {
	const reapWith = async ({ keeper, members = "pi-dispatch-egress-proxy\trunning\n" }) => {
		const calls = [];
		const lines = [];
		const exec = async (_bin, args) => {
			calls.push(args.join(" "));
			const k = args.slice(0, 2).join(" ");
			if (k === "ps --filter") return { stdout: "", stderr: "" };
			if (k === "network ls") return { stdout: "pi-job-a-net\n", stderr: "" };
			if (k === "ps -a") return { stdout: members, stderr: "" };
			if (k === "network exists") return { stdout: "", stderr: "" };
			// The runtime from `podman info --format json`, as the venue's preflight reads it.
			if (args.join(" ") === "info --format json") return { stdout: `${JSON.stringify({ host: { security: { rootless: true } }, version: { Version: "4.9.3" } })}\n`, stderr: "" };
			if (args[0] === "inspect") return keeper ? { stdout: "running|bridge|pi-dispatch-netns-keeper,\n", stderr: "" } : Promise.reject(Object.assign(new Error("Command failed: podman"), { code: 125, stdout: "", stderr: "no such container" }));
			if (k === "network disconnect" || k === "network rm") return { stdout: "", stderr: "" };
			throw Object.assign(new Error(`unmodelled: ${args.join(" ")}`), { code: 99 });
		};
		const out = await mod.makePodmanReaper({ log: (e, f) => lines.push([e, f]), exec })();
		return { out, calls, lines };
	};
	const blocked = await reapWith({ keeper: false });
	assert.deepEqual(blocked.out, { reaped: true }, "the tri-state is about containers, and this is a network");
	assert.deepEqual(blocked.lines, [["network_not_reaped", { network: "pi-job-a-net", reason: "keeper-not-holding" }]]);
	assert.ok(!blocked.calls.some((c) => c.startsWith("network disconnect") || c.startsWith("network rm")), blocked.calls.join(" | "));
	const held = await reapWith({ keeper: true });
	assert.deepEqual(held.lines, [["reaped_network", { network: "pi-job-a-net", detached: ["pi-dispatch-egress-proxy"] }]]);
	// Y5 (gate round 2): a leftover with NO members on 4.9.3 without a keeper is reaped, and neither the runtime nor the
	// keeper is read, since nothing is detached; nor for a STOPPED proxy, which is not in the namespace.
	for (const members of ["", "pi-dispatch-egress-proxy\texited\n"]) {
		const bare = await reapWith({ keeper: false, members });
		assert.equal(bare.lines[0]?.[0], "reaped_network", JSON.stringify(members));
		assert.ok(!bare.calls.some((c) => c.startsWith("info") || c.startsWith("inspect")), bare.calls.join(" | "));
	}
});

test("the podman reaper keeps the tri-state and enumerates podman's store", { skip }, async () => {
	const ok = fakePodman({ answers: { ps: { code: 0, stdout: "" }, "network ls": { code: 0, stdout: "" } } });
	assert.deepEqual(await mod.makePodmanReaper({ log: () => {}, spawnFn: ok.spawnFn })(), { reaped: true });
	assert.ok(ok.calls.every((c) => c[0] === "podman"));
	const broken = fakePodman({ answers: { ps: { code: 125, stdout: "" } } });
	assert.equal((await mod.makePodmanReaper({ log: () => {}, spawnFn: broken.spawnFn })()).reaped, false);
});

// Issue #453, measured on Fedora 44 with rootless Podman 5.8.1 (round-446 M0-e with buildPodmanRunArgs' own argv, and
// the gate-456 adversary's L rows), raw files named per row: whether a job's bounds were APPLIED, against what
// `podman info` said (the cgroup manager and its caller-cgroup controller list), whether the account's user@<uid>.service
// cgroup existed with the controllers, and the caller's own cgroup (/proc/self/cgroup). The uids of the measured
// accounts (1236, 1238) are written as this suite's 1234; the other users' scopes are kept as measured. `credited` is
// what the observation must answer: never credit where the bounds were not applied, and one measured-applied row (E3c)
// deliberately not credited, since nothing this process can read tells it apart from L1-L3.
const ALL5 = ["cpuset", "cpu", "io", "memory", "pids"];
const OWN_UNIT = "0::/user.slice/user-1234.slice/user@1234.service/app.slice/run-p412811-i412812.service\n";
const ROB_SESSION = "0::/user.slice/user-501.slice/session-5.scope\n";
const M0E_ROWS = [
	// [case, podman info cgroupManager, podman info cgroupControllers, user@1234.service controllers (null: not running), /proc/self/cgroup, applied, credited]
	["E1: linger off, sudo -iu, no user manager: systemd fell back to cgroupfs (raw-M0e-E1-sudo-nolinger.txt, raw-M0e-E1r-E3d-nolinger.txt)", "cgroupfs", ALL5, null, ROB_SESSION, false, false],
	["E1b: linger off, plain ssh, whose pam_systemd session started the manager (raw-M0e-E1b-ssh-nolinger.txt)", "systemd", ALL5, DELEGATED, "0::/user.slice/user-1234.slice/session-114.scope\n", true, true],
	["E2a: linger on, a user unit without Delegate=, whose own cgroup lists memory pids, cpu applied anyway (raw-M0e-E2a-userunit-linger.txt, raw-M0e-controllers.txt)", "systemd", ["memory", "pids"], DELEGATED, OWN_UNIT, true, true],
	["E2c: linger on, sudo -iu with no environment (raw-M0e-E2c-sudo-linger.txt)", "systemd", ALL5, DELEGATED, ROB_SESSION, true, true],
	["E2d: linger on, sudo with XDG_RUNTIME_DIR only (raw-M0e-E2d-sudo-xdg-linger.txt)", "systemd", ALL5, DELEGATED, ROB_SESSION, true, true],
	["E3a: explicit cgroupfs, a user unit with Delegate=yes (raw-M0e-E3a-cgroupfs-delegate.txt)", "cgroupfs", ALL5, DELEGATED, "0::/user.slice/user-1234.slice/user@1234.service/app.slice/run-p421802-i421803.service\n", true, true],
	["E3b: explicit cgroupfs, a user unit without Delegate= (raw-M0e-E3b-cgroupfs-nodelegate.txt)", "cgroupfs", ["memory", "pids"], DELEGATED, "0::/user.slice/user-1234.slice/user@1234.service/app.slice/run-p422479-i422480.service\n", true, true],
	["E3c: explicit cgroupfs, linger on, sudo -iu from another user's session, bus reachable: applied, NOT credited (raw-M0e-E3c-cgroupfs-sudo.txt)", "cgroupfs", ALL5, DELEGATED, ROB_SESSION, true, false],
	["E3d: explicit cgroupfs, linger off, sudo -iu (raw-M0e-E1r-E3d-nolinger.txt)", "cgroupfs", ALL5, null, ROB_SESSION, false, false],
	["the same user unit with a Delegate=yes sibling running, its own list flipped to all five (raw-M0e-controllers-sibling.txt)", "systemd", ALL5, DELEGATED, OWN_UNIT, true, true],
	["L1: linger on, user manager running, no user bus socket, sudo -iu: systemd fell back to cgroupfs (gate456-adv raw-L1-L2.txt)", "cgroupfs", ALL5, DELEGATED, ROB_SESSION, false, false],
	["L2: linger on, DBUS_SESSION_BUS_ADDRESS pointing at no bus: systemd fell back to cgroupfs (gate456-adv raw-L1-L2.txt)", "cgroupfs", ALL5, DELEGATED, ROB_SESSION, false, false],
	["L3: a system unit with User= and no user bus: cgroupfs, the container in the unit's root-owned cgroup, memory.max max (gate456-adv raw-L1-L2.txt)", "cgroupfs", ALL5, DELEGATED, "0::/system.slice/adv4-l3.service\n", false, false],
];
const NOT_APPLIED = {
	"no-user-manager": "no systemd user manager is running for this account (/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/cgroup.controllers does not exist), so Podman leaves a job's pids, memory and cpu bounds unapplied, whichever cgroup manager it uses: with linger off the manager runs only while the account has a login session, and a `sudo -iu` shell starts none (measured). On a host without systemd managing cgroups under user.slice this path never exists, and the venue gives no credit there",
	"user-manager-unreachable": "Podman is using the cgroupfs cgroup manager, not systemd, and this worker is not running inside the account's user manager (user@1234.service), so whether a job's pids, memory and cpu bounds are applied is not observed from here. Measured: where a configured systemd manager fell back to cgroupfs because Podman could not reach the user manager over D-Bus (no user bus socket, a DBUS_SESSION_BUS_ADDRESS pointing nowhere), the container landed in the worker's own cgroup unbounded; an explicit cgroupfs with the bus reachable had its bounds applied, and nothing read here tells the two apart",
};

test("podmanBoundsDelegated credits only where the bounds were measured applied: the user manager, and Podman reaching it or the worker inside it (#453)", { skip }, () => {
	for (const [label, cgroupManager, controllers, userManager, self, applied, credited] of M0E_ROWS) {
		assert.ok(!credited || applied, `${label}: the table itself never credits an unapplied row`);
		const o = observe(answered({ cgroupManager, controllers }), fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: userManager, "/proc/self/cgroup": self } }));
		assert.equal(o.observations[PODMAN_BOUNDS_DELEGATED], credited, label);
		assert.deepEqual(o.reasons, {}, `${label}: determinate, never a retry`);
		const cause = credited ? undefined : userManager === null ? "no-user-manager" : "user-manager-unreachable";
		assert.equal(o.boundsCause, cause, label);
		assert.equal(
			o.evidence[PODMAN_BOUNDS_DELEGATED],
			credited
				? `rootless Podman on cgroup v2, with this account's systemd user manager (user@1234.service) running and the pids, memory and cpu controllers delegated to it, ${cgroupManager === "systemd" ? "Podman using the systemd cgroup manager" : "this worker running inside that manager"}, and no containers.conf sets cgroups`
				: NOT_APPLIED[cause],
			label,
		);
		assert.deepEqual(o.boundsControllers, credited ? ALL5 : undefined, `${label}: the manager's list, not podman info's`);
	}
	assert.equal(mod.podmanUserManagerControllersPath(1234), USER_MANAGER);
	// A podman info that names no manager needs the worker inside the manager, as cgroupfs does.
	const unnamed = (self) => observe(answered({ cgroupManager: null }), fakeFs({ files: { [USER_MOUNTS]: "", "/proc/self/cgroup": self } })).observations[PODMAN_BOUNDS_DELEGATED];
	assert.equal(unnamed(ROB_SESSION), false);
	assert.equal(unnamed(OWN_UNIT), true);
	// A /proc/self/cgroup read that failed for a moment is a retry, never a determinate refusal.
	const busy = observe(answered({ cgroupManager: "cgroupfs" }), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/proc/self/cgroup": "EMFILE" } }));
	assert.equal(busy.observations[PODMAN_BOUNDS_DELEGATED], null);
	assert.equal(busy.reasons[PODMAN_BOUNDS_DELEGATED], "file-unread");
	// Another account's user manager does not count: the prefix is this uid's own.
	assert.equal(observe(answered({ cgroupManager: "cgroupfs" }), fakeFs({ files: { [USER_MOUNTS]: "", "/proc/self/cgroup": "0::/user.slice/user-12345.slice/user@12345.service/app.slice/x.service\n" } })).observations[PODMAN_BOUNDS_DELEGATED], false);
});

test("the podman observationPreflight judges the floor on podman's observations, as local's does (#354)", { skip }, async () => {
	const floor = { isolation: ENFORCED, credentialTransit: ENFORCED };
	assert.deepEqual(Object.keys(await bundle({ backendFloor: floor }).observationPreflight(JOB)), ["ok", "podman"]);
	const refused = await bundle({ backendFloor: floor, fs: fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: "io\n" } }) }).observationPreflight(JOB);
	assert.equal(refused.refused, true);
	assert.deepEqual(refused.observations, [PODMAN_BOUNDS_DELEGATED]);
	assert.match(refused.message, /podman: isolation=enforced holds only while this worker's rootless Podman runs on cgroup v2/);
	assert.match(refused.message, /delegate the cpu, memory and pids controllers/);
	// Issue #453: an account with no systemd user manager running, `podman info` still listing every controller: refused
	// per job under the floor, the missing manager named, and the fix keeping one running first.
	const noManager = fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: null } });
	const noSession = await bundle({ backendFloor: floor, fs: noManager }).observationPreflight(JOB);
	assert.equal(noSession.refused, true);
	assert.deepEqual(noSession.observations, [PODMAN_BOUNDS_DELEGATED]);
	assert.match(noSession.message, /no systemd user manager is running for this account \(\/sys\/fs\/cgroup\/user\.slice\/user-1234\.slice\/user@1234\.service\/cgroup\.controllers does not exist\)/);
	assert.match(noSession.message, /Turn on linger for the worker account \(`loginctl enable-linger <account>`, which keeps its systemd user manager running with no one logged in\)/);
	assert.deepEqual(Object.keys(await bundle({ fs: noManager }).observationPreflight(JOB)), ["ok", "podman"], "without the floor a job still runs");
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
	assert.deepEqual([busy.podmanConfRefused?.transient, busy.podmanConfRefused?.key, busy.podmanConfRefused?.evidence], [true, null, "/etc/containers/containers.conf could not be read (EMFILE)"]);
});

test("the podman jobUserPreflight decides from the observed read, reads podman info once, and logs changes only", { skip }, async () => {
	let reads = 0;
	const logs = [];
	const b = bundle({ readInfo: async () => (reads++, answered()), log: (event, fields) => logs.push([event, fields]) });
	const observed = await b.observationPreflight(JOB);
	// `store` (issue #429): the container store the run lives in rides beside the user, so the retained run records it.
	const STORE = "/home/op/.local/share/containers/storage";
	assert.deepEqual(await b.jobUserPreflight(JOB, { capabilities: ["anyUid"], observed }), { user: "1234:1234", home: CONTAINER_HOME, relabel: true, store: STORE });
	assert.deepEqual(await b.jobUserPreflight(JOB, { capabilities: ["anyUid"] }), { user: "1234:1234", home: CONTAINER_HOME, relabel: true, store: STORE });
	const unstored = bundle({ readInfo: async () => answered({ graphRoot: null }) });
	assert.deepEqual(await unstored.jobUserPreflight(JOB, { capabilities: ["anyUid"] }), { user: "1234:1234", home: CONTAINER_HOME, relabel: true }, "no store reported, none carried");
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
	assert.deepEqual(await run(async () => answered(), "present", floor, fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: "io\n" } })), { reason: "backend-floor-unobserved", reserved: 0 });
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
	// Issue #450: a clean conf chain with this account's rootless network still running widened is refused the same
	// way, pre-spend and with no spawn, and a scan that failed for a moment is the retry.
	spawned.length = 0;
	assert.deepEqual(await run(async () => answered(), "present", {}, procFs({ 10: helper(1234, U_WIDE) })), { reason: "podman-conf-widens-job", reserved: 0 }, "live");
	assert.deepEqual(spawned, [], "live: no podman spawn");
	assert.deepEqual(await run(async () => answered(), "present", {}, procFs({ 10: helper(1234, U_BASE) }, { cmdlineErrors: { 10: "EMFILE" } })), { threw: "retry", reserved: 0 }, "live, busy");
	// A conf read that failed for a moment is RETRIED (a throw), never a dropped job; one the account cannot read is refused.
	for (const [code, want] of [["EMFILE", { threw: "retry", reserved: 0 }], ["EIO", { threw: "retry", reserved: 0 }], ["EACCES", { reason: "podman-conf-widens-job", reserved: 0 }]]) {
		spawned.length = 0;
		assert.deepEqual(await run(async () => answered(), "present", {}, fakeFs({ files: { "/etc/containers/containers.conf": "" }, errors: { "/etc/containers/containers.conf": code } })), want, code);
		assert.deepEqual(spawned, [], `${code}: no podman spawn`);
	}
});

test("the bundle's observationPreflight answers exactly what judgePodmanVenue answers, the sandbox's judge (#429)", { skip }, async () => {
	// A sandbox on this venue is refused through `judgePodmanVenue`, and a job through the bundle: the same answer for
	// the same inputs is what "refused for what a job is refused for" means, so it is asked across every arm.
	const floor = { isolation: ENFORCED, credentialTransit: ENFORCED, mountSet: ENFORCED };
	const conf = `${HOME}/.config/containers/containers.conf`;
	const cases = [
		["clean", answered(), clean(), floor],
		["rootful", answered({ rootless: false }), clean(), floor],
		["widened", answered(), fakeFs({ files: { [USER_MOUNTS]: "", [conf]: MEASURED.annotations } }), floor],
		["undelegated", answered(), fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: "cpu\n" } }), floor],
		["no user manager", answered(), fakeFs({ files: { [USER_MOUNTS]: "", [USER_MANAGER]: null } }), floor],
		["unanswered", { answered: false, reason: "timeout", transient: true }, clean(), floor],
		["no floor", answered({ controllers: [] }), clean(), {}],
		// #428's transient rules, which the extraction must carry: a conf chain that could not be read just now rides
		// `podmanConfRefused.transient` with its evidence, and a mounts file that could not be read is `file-unread`
		// with the file named.
		["conf busy", answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/containers.conf": "EMFILE" } }), floor],
		["mounts busy", answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { [USER_MOUNTS]: "EIO" } }), { mountSet: ENFORCED }],
		["conf unreadable for good", answered(), fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/containers.conf": "EACCES" } }), floor],
	];
	for (const [label, read, fs, backendFloor] of cases) {
		const job = await bundle({ readInfo: async () => read, fs, backendFloor }).observationPreflight(JOB);
		const judged = mod.judgePodmanVenue({ read, platform: "linux", euid: 1234, egid: 1234, fs, home: HOME, env: {}, backendFloor });
		assert.deepEqual(judged, job, label);
	}
	const busy = mod.judgePodmanVenue({ read: answered(), platform: "linux", euid: 1234, egid: 1234, fs: fakeFs({ files: { [USER_MOUNTS]: "" }, errors: { "/etc/containers/containers.conf": "EMFILE" } }), home: HOME, env: {} });
	assert.equal(busy.podmanConfRefused?.transient, true, "the transient arm is really exercised above");
});

// Issue #458, gate B: the worker's own pre-spend read of the rootless network keeper. On Podman 4.x (or an unreported
// version) a proxy that is up but a keeper that does not hold is an INFRA retry before anything is spent, with the
// sentence that names the keeper and its start command; on 5.x the keeper is never read. Read on every armed job.
test("keeperPreflight: on Podman 4.x a keeper that does not hold is { unavailable, keeper }; 5.x and egress off read nothing (#458)", { skip }, async () => {
	// On an injected clock (PR #463 round 2): the keeper started at 1,000 s, the proxy at 1,010 s, and it is now 2,000 s.
	const NOW = 2_000_000;
	const OK = { ok: true, proxy: "pi-dispatch-egress-proxy" };
	const KEEPER = (state = "running|bridge|pi-dispatch-netns-keeper,", started = 1_000_000) => ({ code: 0, stdout: `${state}|${started}\n` });
	const run = async ({ version = "4.9.3", answered = true, keeper = KEEPER(), proxyStarted = { code: 0, stdout: "1010000\n" }, armed = true, proxyResult = OK, now = NOW } = {}) => {
		const reads = [];
		const pre = mod.keeperPreflight(async () => proxyResult, {
			armed,
			proxy: "pi-dispatch-egress-proxy",
			info: async () => (answered ? { answered: true, info: { version } } : { answered: false, reason: "timeout", transient: true }),
			readKeeper: async (args) => (reads.push(args), args.at(-1) === "pi-dispatch-netns-keeper" ? keeper : proxyStarted),
			now: () => now,
		});
		return { result: await pre({}), reads };
	};
	const held = await run();
	assert.deepEqual(held.result, OK, "a keeper that holds admits the job");
	assert.deepEqual(held.reads, [
		["inspect", "--format={{.State.Status}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}|{{.State.StartedAt.UnixMilli}}", "pi-dispatch-netns-keeper"],
		["inspect", "--format={{.State.StartedAt.UnixMilli}}", "pi-dispatch-egress-proxy"],
	]);
	const startIt = /Start it as the worker's account|start it as the worker's account/;
	for (const [label, keeper, words] of [
		["absent", { code: 125, stdout: "" }, /is not under this account's Podman/],
		["exited", KEEPER("exited|bridge|pi-dispatch-netns-keeper,"), /is exited under this account's Podman/],
		["off its bridge", KEEPER("running|none|none,"), /is running on the none network mode/],
		["crash loop", KEEPER(undefined, NOW - 2_000), /has been running for only 2 s/],
	]) {
		const { result } = await run({ keeper });
		assert.equal(result.unavailable, "pi-dispatch-egress-proxy", label);
		assert.match(result.keeper, words, label);
		assert.match(result.keeper, /on Podman 4\.9\.3 a job network's teardown would then cut the egress proxy's route out \(issue #458\), so this job is retried rather than started\. To fix it, start it as the worker's account: systemctl --user reset-failed pi-dispatch-netns-keeper-network\.service pi-dispatch-netns-keeper\.service; systemctl --user restart /, label);
		assert.match(result.keeper, startIt, label);
		// PR #463 round 3: the proxy has been up 990 s, so the keeper once started will be after it: both steps, now.
		assert.match(result.keeper, /, then restart the egress proxy once no job is running: systemctl --user restart pi-dispatch-egress-proxy\.service \(podman restart pi-dispatch-egress-proxy for one started by hand\), since the proxy has been up since before it$/, label);
		// And the boot line's own sentence, with no job in it.
		assert.match(result.keeperAtBoot, /, so every egress job is retried rather than started until this is fixed\. To fix it, start it as the worker's account/, label);
		assert.doesNotMatch(result.keeperAtBoot, /this job/, label);
	}
	// A proxy up for less than the grace: one step, the keeper's own start.
	const fresh = await run({ keeper: { code: 125, stdout: "" }, proxyStarted: { code: 0, stdout: `${NOW - 10_000}\n` } });
	assert.match(fresh.result.keeper, /To fix it, start it as the worker's account: systemctl --user reset-failed pi-dispatch-netns-keeper-network\.service pi-dispatch-netns-keeper\.service; systemctl --user restart pi-dispatch-netns-keeper-network\.service pi-dispatch-netns-keeper\.service$/);
	// Started more than the grace (15 s, PR #463 round 3) after the proxy: the damage nothing shows, so the remedy is
	// the PROXY's restart.
	const late = await run({ keeper: KEEPER(undefined, 1_010_000 + 15_001) });
	assert.match(late.result.keeper, /^the rootless network keeper pi-dispatch-netns-keeper started 15 s after the egress proxy did, so it was down while the proxy ran, and a job teardown in that gap would have cut the proxy's route out for good, which nothing can see from outside \(Podman 4\.9\.3, issue #458\), so this job is retried rather than started\. To fix it, restart the egress proxy once no job is running: systemctl --user restart pi-dispatch-egress-proxy\.service/);
	const within = await run({ keeper: KEEPER(undefined, 1_010_000 + 15_000) });
	assert.deepEqual(within.result, OK, "within the grace of the proxy: a start of both together");
	const unreadProxy = await run({ keeper: KEEPER(undefined, 1_900_000), proxyStarted: { code: 125, stdout: "" } });
	assert.deepEqual(unreadProxy.result, OK, "an unread proxy start is not held against the keeper");
	const unreported = await run({ answered: false, keeper: { code: 125, stdout: "" } });
	assert.match(unreported.result.keeper, /on a Podman of unreported version/, "an unread version is no evidence of 5.x");
	for (const version of ["5.0.0", "5.8.1"]) {
		const five = await run({ version, keeper: { code: 125, stdout: "" } });
		assert.deepEqual(five.result, OK, version);
		assert.deepEqual(five.reads, [], `${version}: the keeper is not read`);
	}
	const off = await run({ armed: false, proxyResult: { ok: true }, keeper: { code: 125, stdout: "" } });
	assert.deepEqual(off.result, { ok: true });
	assert.deepEqual(off.reads, []);
	// A proxy refusal is the proxy's to report: the keeper is not read under it.
	const missing = await run({ proxyResult: { proxyMissing: "pi-dispatch-egress-proxy" }, keeper: { code: 125, stdout: "" } });
	assert.deepEqual(missing.result, { proxyMissing: "pi-dispatch-egress-proxy" });
	assert.deepEqual(missing.reads, []);
	// Nothing cached across jobs: the keeper and the proxy's start are read again on every call.
	const reads = [];
	const pre = mod.keeperPreflight(async () => OK, { armed: true, info: async () => ({ answered: true, info: { version: "4.9.3" } }), readKeeper: async (args) => (reads.push(args), args.at(-1) === "pi-dispatch-netns-keeper" ? KEEPER() : { code: 0, stdout: "1010000\n" }), now: () => NOW });
	await pre({});
	await pre({});
	assert.equal(reads.length, 4);
});

test("keeperPreflight carries `young` for a keeper whose only fault is its age, and the judge's own words (#476)", { skip }, async () => {
	const NOW = 2_000_000;
	const pre = (keeper, proxyStarted = `${NOW - 607}\n`) => mod.keeperPreflight(async () => ({ ok: true, proxy: "pi-dispatch-egress-proxy" }), { armed: true, info: async () => ({ answered: true, info: { version: "4.9.3" } }), readKeeper: async (args) => (args.at(-1) === "pi-dispatch-netns-keeper" ? keeper : { code: 0, stdout: proxyStarted }), now: () => NOW })({});
	const young = await pre({ code: 0, stdout: `running|bridge|pi-dispatch-netns-keeper,|${NOW - 600}\n` });
	assert.equal(young.unavailable, "pi-dispatch-egress-proxy", "still not admitted by the preflight itself");
	assert.deepEqual(young.young, { startedMs: NOW - 600, ageMs: 600, waitMs: 3_400 });
	assert.match(young.problem, /^has been running for only 0\.6 s/);
	const gone = await pre({ code: 125, stdout: "" });
	assert.deepEqual([gone.young, gone.problem], [undefined, "is not under this account's Podman"]);
	// Young but out of order against the proxy: no `young`, since waiting cannot fix its start.
	const late = await pre({ code: 0, stdout: `running|bridge|pi-dispatch-netns-keeper,|${NOW - 600}\n` }, `${NOW - 600 - 15_001}\n`);
	assert.equal(late.young, undefined);
});

test("the podman bundle's egress preflight reads the keeper through podman on 4.x (#458)", { skip }, async () => {
	// Every inspect answers `running`: the proxy's `.State.Status` (#453) admits, and the keeper's read gets a bare word.
	const fake = fakePodman({ answers: { inspect: { code: 0, stdout: "running\n" } } });
	const b = bundle({ spawnFn: fake.spawnFn, egress: true, readInfo: async () => ({ answered: true, info: { version: "4.9.3", rootless: true, serviceIsRemote: false } }) });
	const result = await b.egressPreflight({});
	assert.ok(fake.calls.some((c) => c[0] === "podman" && c[1] === "inspect" && c.at(-1) === "pi-dispatch-netns-keeper"), fake.calls.map((c) => c.join(" ")).join("\n"));
	// A bare `running` carries no network mode, networks or start: not holding, so retried, and said.
	assert.equal(result.unavailable, "pi-dispatch-egress-proxy");
	assert.match(result.keeper, /^the rootless network keeper pi-dispatch-netns-keeper is running on the unreported network mode, not on its pi-dispatch-netns-keeper bridge network, so it holds nothing open, and on Podman 4\.9\.3 /);
	// The proxy is read first (issue #453's `.State.Status`), then the keeper: the order the preflight gates in.
	const inspects = fake.calls.filter((c) => c[0] === "podman" && c[1] === "inspect").map((c) => c.at(-1));
	assert.deepEqual(inspects.slice(0, 2), ["pi-dispatch-egress-proxy", "pi-dispatch-netns-keeper"]);
	assert.ok(fake.calls.some((c) => c[0] === "podman" && c[1] === "inspect" && c.includes("--format={{.State.StartedAt.UnixMilli}}") && c.at(-1) === "pi-dispatch-egress-proxy"), "the proxy's start, through podman");
});

test("the podman venue's job teardown uses the `podman info` it admitted jobs on, and nothing before one answered (#452 gate round 4)", { skip }, async () => {
	let made = null;
	const b = mod.makePodmanBackend({ image: "pi-job:x", readInfo: async () => answered(), platform: "linux", euid: 1234, egid: 1234, fs: clean(), home: HOME, env: {}, onOutput: () => {}, log: () => {}, makeRunContainer: (o) => ((made = o), async () => ({ code: 0 })) });
	assert.equal(typeof made.teardownRuntime, "function");
	assert.equal(made.teardownRuntime(), undefined, "no answered read yet: the gate reads for itself");
	await b.observationPreflight({ id: "j", kind: "local" });
	const rt = made.teardownRuntime();
	assert.equal(rt.podman, true);
	assert.ok("version" in rt && "rootless" in rt);
	assert.equal(typeof made.log, "function");
});

test("the remedy resets the rootless network only for the keys that shape it; a per-container key runs the next job once gone (#448)", { skip }, async () => {
	const { PODMAN_NETWORK_HELPER_KEYS } = await import("../src/backends.mjs");
	assert.deepEqual([...PODMAN_NETWORK_HELPER_KEYS], ["pasta_options", "network_cmd_options", "env", "helper_binaries_dir", "network_cmd_path"]);
	for (const key of ["pasta_options", "network_cmd_options", "env", "helper_binaries_dir", "network_cmd_path"]) {
		const fix = mod.podmanConfFix({ cause: "podman-conf-widens-job", key });
		assert.ok(fix.includes(mod.ROOTLESS_NETNS_RESET), key);
	}
	for (const key of WIDENING_KEYS.filter((k) => !["pasta_options", "network_cmd_options", "env", "helper_binaries_dir", "network_cmd_path"].includes(k))) {
		const fix = mod.podmanConfFix({ cause: "podman-conf-widens-job", key });
		assert.ok(!fix.includes(mod.ROOTLESS_NETNS_RESET), key);
		assert.match(fix, /^remove that key from that file; the next podman job runs once it is gone/, key);
	}
});
