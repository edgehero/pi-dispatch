import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINT_GIT_MIN, checkpointStoreChecks, parseGitVersion } from "../src/doctor.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Doctor's checkpoint-store group (issue #645). Nothing for a deployment with no store configured; otherwise the store's
// path, ownership and mode, the temp-dir warning, git's version and whether each venue can freeze a job. Never a ✗: no
// job writes a checkpoint yet, so these lines may only advise.
const posix = process.platform !== "win32";
const uid = process.geteuid?.();
const labels = (checks) => checks.map((c) => `${c.ok ? "ok" : c.warn ? "warn" : "fail"} ${c.label}`);
const GIT = "git version 2.43.0\n";

test("git's version is parsed from every spelling git prints, and 2.32 is the floor", () => {
	assert.deepEqual(parseGitVersion("git version 2.43.0\n"), [2, 43]);
	assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-146)\n"), [2, 39]);
	assert.deepEqual(parseGitVersion("git version 2.45.1.windows.1"), [2, 45]);
	assert.equal(parseGitVersion("command not found"), null);
	assert.equal(parseGitVersion(null), null);
	assert.deepEqual([...CHECKPOINT_GIT_MIN], [2, 32]);
});

test("a private directory of this account's, git 2.43 and a local venue: every line ok", { skip: !posix }, () => {
	const dir = join(tempDir("pd-ckpt-"), ".checkpoints");
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	const checks = checkpointStoreChecks({ dir, uid, gitVersion: GIT });
	assert.deepEqual(labels(checks), [
		`ok checkpoint store ${dir} (the default inside PI_SESSIONS_DIR) is a private directory of this account's`,
		"ok checkpoint store: git 2.43 (2.32 or newer)",
		"ok checkpoint store: local can freeze a job while its workspace is read (docker pause, the cgroup freezer)",
	]);
});

test("a wrong mode, a wrong owner, a link and a file are each a warning naming what to run", { skip: !posix }, () => {
	const root = tempDir("pd-ckpt-");
	const loose = join(root, "loose");
	mkdirSync(loose);
	chmodSync(loose, 0o755);
	const [modeLine] = checkpointStoreChecks({ dir: loose, explicit: true, uid, gitVersion: GIT });
	assert.equal(modeLine.warn, true);
	assert.match(modeLine.label, /\(PI_CHECKPOINTS_DIR\) is mode 0755, not 0700/);
	assert.match(modeLine.fix, /chmod 700/);

	chmodSync(loose, 0o700);
	const [ownerLine] = checkpointStoreChecks({ dir: loose, uid: uid + 1, gitVersion: GIT });
	assert.match(ownerLine.label, new RegExp(`owned by uid ${uid}, not this account \\(uid ${uid + 1}\\)`));
	assert.match(ownerLine.fix, /chown/);

	const link = join(root, "link");
	symlinkSync(loose, link);
	const linkChecks = checkpointStoreChecks({ dir: link, uid, gitVersion: GIT });
	assert.match(linkChecks[0].label, /is a symbolic link/, "judged by lstat: a link is never followed to a directory that would pass");
	assert.equal(linkChecks[0].warn, true);
	assert.equal(linkChecks.some((c) => !c.ok && !c.warn), false, "a link is a warning too, never a ✗");

	const file = join(root, "file");
	writeFileSync(file, "");
	assert.match(checkpointStoreChecks({ dir: file, uid, gitVersion: GIT })[0].label, /is not a directory/);
	assert.equal(checkpointStoreChecks({ dir: file, uid, gitVersion: GIT }).some((c) => !c.ok && !c.warn), false, "never a ✗");
});

test("the mode must be EXACTLY 0700: any group or other bit, or a missing owner bit, is a warning", () => {
	const dirWith = (mode) => ({ lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40000 | mode }) });
	const verdict = (mode) => checkpointStoreChecks({ dir: "/srv/ckpt", uid: 1000, gitVersion: GIT, fs: dirWith(mode) })[0];
	assert.equal(verdict(0o700).ok, true);
	for (const mode of [0o750, 0o701, 0o710, 0o707, 0o600, 0o500, 0o777]) {
		const v = verdict(mode);
		assert.equal(v.warn, true, mode.toString(8));
		assert.match(v.label, new RegExp(`mode 0${mode.toString(8)}, not 0700`), mode.toString(8));
	}
	// No uid (Windows): the mode bits mean nothing there and are not judged.
	assert.equal(checkpointStoreChecks({ dir: "/srv/ckpt", uid: undefined, gitVersion: GIT, fs: dirWith(0o777) })[0].ok, true);
});

test("git's MAJOR version is judged as well as its minor", () => {
	const fs = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700 }) };
	const gitLine = (v) => checkpointStoreChecks({ dir: "/srv/ckpt", uid: 1000, gitVersion: `git version ${v}\n`, fs }).find((c) => /checkpoint store: (`git|git )/.test(c.label));
	for (const v of ["1.99.9", "2.31.8", "2.0.0", "1.33.0"]) assert.equal(gitLine(v).warn, true, v);
	for (const v of ["2.32.0", "2.43.0", "3.0.0", "3.1.2"]) assert.equal(gitLine(v).ok, true, v);
});

test("an absent store is fine where it can be created, and a warning where it cannot", () => {
	const enoent = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	const dirStat = { isDirectory: () => true };
	const creatable = checkpointStoreChecks({
		dir: "/srv/pi-sessions/.checkpoints",
		uid: 1000,
		gitVersion: GIT,
		fs: { lstatSync: enoent, statSync: (p) => (p === "/srv" ? dirStat : enoent()), accessSync: () => {} },
	});
	assert.equal(creatable[0].ok, true);
	assert.match(creatable[0].label, /does not exist yet: it is created with mode 0700 inside \/srv when a durable run first writes one/);

	const locked = checkpointStoreChecks({
		dir: "/srv/pi-sessions/.checkpoints",
		uid: 1000,
		gitVersion: GIT,
		fs: { lstatSync: enoent, statSync: () => dirStat, accessSync: enoent },
	});
	assert.equal(locked[0].warn, true);
	assert.match(locked[0].label, /cannot be created: \/srv\/pi-sessions is not writable by this account/);

	const fileAbove = checkpointStoreChecks({
		dir: "/srv/pi-sessions/.checkpoints",
		uid: 1000,
		gitVersion: GIT,
		fs: { lstatSync: enoent, statSync: (p) => (p === "/srv/pi-sessions" ? { isDirectory: () => false } : dirStat), accessSync: () => {} },
	});
	assert.equal(fileAbove[0].warn, true);
	assert.match(fileAbove[0].label, /cannot be created: \/srv\/pi-sessions above it is not a directory/, "a file where a parent should be is named, not called a missing directory");

	const nothingAbove = checkpointStoreChecks({ dir: "/srv/x/.checkpoints", uid: 1000, gitVersion: GIT, fs: { lstatSync: enoent, statSync: enoent, accessSync: () => {} } });
	assert.match(nothingAbove[0].label, /no directory above it exists/);

	const unreadable = checkpointStoreChecks({ dir: "/x", uid: 1000, gitVersion: GIT, fs: { lstatSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } } });
	assert.match(unreadable[0].label, /could not be read \(EACCES\)/);
});

test("under the OS temp dir, an old git and an unanswered git are warnings", () => {
	const fs = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700 }) };
	const temp = checkpointStoreChecks({ dir: "/tmp/ckpt", uid: 1000, gitVersion: GIT, fs, underTemp: () => true });
	assert.ok(temp.some((c) => c.warn && /under the OS temp dir, which the OS sweeps/.test(c.label)));
	const old = checkpointStoreChecks({ dir: "/srv/ckpt", uid: 1000, gitVersion: "git version 2.31.8\n", fs });
	assert.ok(old.some((c) => c.warn && /git 2\.31 is older than 2\.32, which ignores GIT_CONFIG_GLOBAL/.test(c.label)));
	const silent = checkpointStoreChecks({ dir: "/srv/ckpt", uid: 1000, gitVersion: null, fs });
	assert.ok(silent.some((c) => c.warn && /`git --version` did not answer/.test(c.label)));
	assert.equal([...temp, ...old, ...silent].some((c) => !c.ok && !c.warn), false, "never a ✗");
});

test("whether each venue can freeze a job is a fact line, from podman info's cgroup version on podman", () => {
	const fs = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700 }) };
	const venue = (podmanRead) => checkpointStoreChecks({ dir: "/srv/ckpt", uid: 1000, gitVersion: GIT, fs, venues: ["local", "podman"], podmanRead }).slice(-2);
	const v2 = venue({ answered: true, info: { cgroupVersion: "v2" } });
	assert.deepEqual(labels(v2), ["ok checkpoint store: local can freeze a job while its workspace is read (docker pause, the cgroup freezer)", "ok checkpoint store: podman can freeze a job while its workspace is read (podman pause, cgroup v2)"]);
	const [, v1] = venue({ answered: true, info: { cgroupVersion: "v1" } });
	assert.equal(v1.ok, true, "a fact, not a warning: nothing but another host clears it");
	// What a venue that cannot freeze actually gets: checkpoints at EXIT only, after the container is gone, and so no
	// recovery from a worker crash. Never a read of a workspace the job is still writing.
	assert.match(v1.label, /podman cannot freeze a job here \(rootless Podman on cgroup v1\), so its jobs get exit checkpoints only, taken once the container is gone, and are not recovered from a worker crash mid-run/);
	assert.match(venue(null)[1].label, /whether podman can freeze a job is not known .*exit checkpoints only/);
	const absent = checkpointStoreChecks({ dir: "/srv/ckpt", uid: 1000, gitVersion: GIT, fs, venues: ["nope"] }).at(-1);
	assert.match(absent.label, /nope declares no freeze, so its jobs get exit checkpoints only/);
	for (const c of [v1, ...venue(null), absent]) assert.doesNotMatch(c.label, /read while the job runs/);
});

test("a store that collides with the session store is a ✗, the one hard failure in the group (#645)", () => {
	const fs = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700 }) };
	const same = checkpointStoreChecks({ dir: "/srv/s", explicit: true, sessionsDir: "/srv/s", uid: 1000, gitVersion: GIT, fs });
	const fail = same.filter((c) => !c.ok && !c.warn);
	assert.equal(fail.length, 1);
	assert.match(fail[0].label, /collide: they are the same directory, so the session reaper and the checkpoint sweep would delete each other's folders/);
	assert.match(fail[0].fix, /unset PI_CHECKPOINTS_DIR .* or point it at a directory outside PI_SESSIONS_DIR/);
	const keyed = checkpointStoreChecks({ dir: "/srv/s/0123456789abcdef0123456789abcdef", explicit: true, sessionsDir: "/srv/s", uid: 1000, gitVersion: GIT, fs });
	assert.ok(keyed.some((c) => !c.ok && !c.warn && /inside a session key's directory/.test(c.label)));
	const fine = checkpointStoreChecks({ dir: "/srv/s/.checkpoints", sessionsDir: "/srv/s", uid: 1000, gitVersion: GIT, fs });
	assert.equal(fine.some((c) => !c.ok && !c.warn), false, "the default layout does not collide");
});

test("collectChecks prints the group only where a store is configured, and asks git once (#645)", async () => {
	const calls = [];
	let gitExit = 0;
	const spawn = (cmd, args) => {
		calls.push(cmd === "git" ? `git ${args.at(-1)}` : [cmd, ...args].join(" "));
		const handlers = {};
		const stream = { handlers: {}, on(ev, cb) { this.handlers[ev] = cb; return this; } };
		const child = { stdout: { ...stream, handlers: {} }, stderr: { ...stream, handlers: {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => {
			if (cmd === "git" && args.at(-1) === "--version") {
				child.stdout.handlers.data?.(GIT);
				handlers.close?.(gitExit);
			} else handlers.close?.(1);
		});
		return child;
	};
	const cwd = tempDir("pd-ckpt-doctor-");
	const seams = { cwd, spawn, probeValkey: async () => false, fileExists: () => false, nodeVersion: "22.19.0", checkpointUid: uid };
	const base = { PI_LOGS_DIR: join(cwd, "logs") };

	const none = await collectChecks(base, seams);
	assert.equal(none.some((c) => /checkpoint store/.test(c.label)), false, "no store configured: not a word about one");
	assert.equal(calls.includes("git --version"), false);

	const sessions = join(cwd, "sessions");
	const withStore = await collectChecks({ ...base, PI_SESSIONS_DIR: sessions }, seams);
	const lines = withStore.filter((c) => /checkpoint store/.test(c.label));
	assert.ok(lines.some((c) => c.label.startsWith(`checkpoint store ${join(sessions, ".checkpoints")} (the default inside PI_SESSIONS_DIR)`)), labels(lines).join("\n"));
	assert.ok(lines.some((c) => c.label === "checkpoint store: git 2.43 (2.32 or newer)"));
	assert.equal(calls.filter((c) => c === "git --version").length, 1);
	assert.equal(lines.some((c) => !c.ok && !c.warn), false, "never a ✗");

	const explicit = await collectChecks({ ...base, PI_CHECKPOINTS_DIR: join(cwd, "ckpt") }, seams);
	assert.ok(explicit.some((c) => c.label.startsWith(`checkpoint store ${join(cwd, "ckpt")} (PI_CHECKPOINTS_DIR)`)), "PI_CHECKPOINTS_DIR alone configures it");

	// A git that PRINTS a version and exits non-zero did not answer: its output is not trusted without its exit code.
	gitExit = 1;
	const failedGit = await collectChecks({ ...base, PI_SESSIONS_DIR: sessions }, seams);
	assert.ok(failedGit.some((c) => c.warn && /`git --version` did not answer/.test(c.label)));
	assert.equal(failedGit.some((c) => /checkpoint store: git 2\.43/.test(c.label)), false);
});
