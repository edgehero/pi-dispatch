import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeContainerActivity } from "../src/container-activity.mjs";
import { makeSweepFollowUps } from "../src/retention-sweep.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { isSandboxTombstone, listSandboxes, makeSandboxReaper as realMakeSandboxReaper, pinSandbox, readManifest, retainJobDir, sandboxDeadline, sandboxEntryName, sandboxExpiry, sandboxTombstoneAge, SANDBOX_MANIFEST, SANDBOX_PASS_BUDGET_MS, SANDBOX_PASS_MAX_REAPS, SANDBOX_PASS_MAX_REAPS_BUSY, SANDBOX_REST_MAX_MS, SANDBOX_REST_MIN_BUSY_MS, SANDBOX_REST_MIN_MS, SANDBOX_REST_POLL_MS, SANDBOX_START_WAIT_MAX_MS, SANDBOX_TOMBSTONE_PREFIX, SANDBOX_TOMBSTONE_RELOG_MS, SANDBOX_TOMBSTONE_STUCK_MS } from "../src/sandbox-store.mjs";
// Issue #978: these tests pin each entry's own outcome and lines. The pass's rests get a sleep that returns at once,
// and its one summary line (`sandbox_reaper_pass`, pinned by its own tests below) is left out of what they read.
const withoutPassLine = (log) => (log ? (event, fields) => event === "sandbox_reaper_pass" || log(event, fields) : log);
const makeSandboxReaper = (options) => realMakeSandboxReaper({ ...options, sleep: options.sleep ?? (async () => {}), log: withoutPassLine(options.log), ...(options.fs && !options.remove ? { remove: async (path, opts) => options.fs.rmSync(path, opts) } : {}) });


const HOUR = 3600000;
const DAY = 86400000;

/**
 * A fake fs recording every mutation, so retention can be asserted without a disk. Paths are plain
 * strings keyed into one map; `files` holds written contents and `dirs` the removed/renamed history.
 */
function fakeFs({ files = {}, failOn = null, owners = {}, as = { uid: 1234, gid: 1234 } } = {}) {
	const calls = { removed: [], renamed: [], made: [], chowned: [], chmodded: [] };
	// `owners` maps a path to `{ uid, gid, mode }`; a path this fake creates is owned by `as` with mode 0644 (a umask).
	const meta = { ...owners };
	return {
		calls,
		files,
		meta,
		lstatSync(p) {
			if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			const m = meta[p] ?? { uid: as.uid, gid: as.gid, mode: 0o600 };
			return { isDirectory: () => files[p] === "<dir>", uid: m.uid, gid: m.gid, mode: 0o100000 | m.mode };
		},
		chownSync(p, uid, gid) {
			if (failOn === "chown" || (as.uid !== 0 && uid !== as.uid)) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
			calls.chowned.push([p, uid, gid]);
			meta[p] = { ...(meta[p] ?? { mode: 0o644 }), uid, gid };
		},
		chmodSync(p, mode) {
			calls.chmodded.push([p, mode]);
			meta[p] = { ...(meta[p] ?? { uid: as.uid, gid: as.gid }), mode };
		},
		mkdirSync(p, opts) {
			calls.made.push({ p, mode: opts?.mode });
		},
		readdirSync(p) {
			if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			return files[p] === "<dir>" ? Object.keys(files).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p.length + 1)) : [];
		},
		readFileSync(p) {
			if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			return files[p];
		},
		renameSync(from, to) {
			if (failOn === "rename") throw new Error("EXDEV: cross-device link");
			calls.renamed.push([from, to]);
			// A rename carries what it names: a directory's marker (as the retention rename always was here), or a
			// file's CONTENT, which is how the pin's atomic manifest rewrite lands (issue #429), and since issue #446 the
			// whole SUBTREE under it, which is how the sweep's tombstone moves a retained run, manifest and all.
			const moved = Object.keys(files).filter((k) => k === from || k.startsWith(`${from}/`));
			if (!moved.includes(from)) files[to] = "<dir>";
			for (const k of moved) {
				const next = `${to}${k.slice(from.length)}`;
				files[next] = files[k];
				if (meta[k]) meta[next] = meta[k];
				delete meta[k];
				delete files[k];
			}
		},
		// Removes an EMPTY directory only, as `rmdir(2)` does (gate round 1: how a tombstone is restored over a runtime's
		// auto-created bind source).
		rmdirSync(p) {
			if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			if (files[p] !== "<dir>") throw Object.assign(new Error(`ENOTDIR: ${p}`), { code: "ENOTDIR" });
			if (Object.keys(files).some((k) => k.startsWith(`${p}/`))) throw Object.assign(new Error(`ENOTEMPTY: ${p}`), { code: "ENOTEMPTY" });
			calls.rmdired = [...(calls.rmdired ?? []), p];
			delete files[p];
		},
		rmSync(p) {
			calls.removed.push(p);
			for (const k of Object.keys(files)) if (k === p || k.startsWith(`${p}/`)) delete files[k];
		},
		writeFileSync(p, body, opts) {
			if (failOn === "write") throw new Error("ENOSPC");
			if (opts?.flag === "wx" && p in files) throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
			files[p] = body;
			if (!(p in meta)) meta[p] = { uid: as.uid, gid: as.gid, mode: 0o644 };
			calls.made.push({ p, mode: opts?.mode });
		},
	};
}

const prepared = (over = {}) => ({
	jobDir: "/jobs/job-xyz",
	workspace: "/jobs/job-xyz/workspace",
	sandbox: { jobId: "gh-1", kind: "github", image: "pi-job:latest", backend: "local" },
	...over,
});

// Issue #464, gate round 1: a sandbox dir absent at boot is a name another account can create first (a recursive mkdir
// takes an existing directory silently), so the owner is asked again at every retention, and a run is deleted rather
// than kept where another account could swap it.
test("retention refuses a sandbox dir another account owns: the run is deleted, not renamed into it, and the failure is logged", () => {
	const base = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	const logged = [];
	const fs = { ...base, statSync: (p) => ({ uid: p === "/sbx" ? 1270 : 1234 }) };
	assert.equal(retainJobDir(prepared(), { sandboxDir: "/sbx", fs, euid: 1234, log: (e, d) => logged.push([e, d]) }), null);
	assert.deepEqual(base.calls.renamed, [], "never renamed into another account's directory");
	assert.ok(base.calls.removed.includes("/jobs/job-xyz"), "the run is deleted, as when retention is off");
	assert.deepEqual(logged, [["sandbox_retain_failed", { jobId: "gh-1", reason: "/sbx is owned by uid 1270, not by this account (uid 1234)" }]]);
	const mine = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	assert.equal(retainJobDir(prepared(), { sandboxDir: "/sbx", fs: { ...mine, statSync: () => ({ uid: 1234 }) }, euid: 1234 }).jobId, "gh-1", "this account's: kept as ever");
});

test("retention renames the per-job dir and records a manifest", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	const manifest = retainJobDir(prepared(), { sandboxDir: "/sbx", fs, now: () => Date.parse("2026-08-01T10:00:00Z") });

	assert.deepEqual(fs.calls.renamed, [["/jobs/job-xyz", "/sbx/gh-1"]], "renamed, never copied");
	assert.equal(manifest.jobId, "gh-1");
	assert.equal(manifest.image, "pi-job:latest");
	assert.equal(manifest.createdAt, "2026-08-01T10:00:00.000Z");
	assert.equal(manifest.keepUntil, null, "a fresh retention is never pinned");
	assert.equal(manifest.backend, "local", "the venue the job resolved to, which the sandbox refuses by (#277)");
	assert.equal(JSON.parse(fs.files["/sbx/gh-1/manifest.json"]).backend, "local", "and it is on disk, not only returned");
	// The forge workspace lived inside jobDir, so its recorded path must follow the rename.
	assert.equal(manifest.workspace, "/sbx/gh-1/workspace");
	assert.equal(fs.calls.made.find((m) => m.p === "/sbx/gh-1/manifest.json")?.mode, 0o600);
	assert.equal(fs.calls.made.find((m) => m.p === "/sbx")?.mode, 0o700, "the retention root is not world-readable");
});

test("a local job's workspace is the operator's own folder and is recorded verbatim", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	const manifest = retainJobDir(prepared({ workspace: "/home/rob/project", sandbox: { jobId: "local-1", kind: "local", image: "pi-job:latest" } }), {
		sandboxDir: "/sbx",
		fs,
	});
	assert.equal(manifest.workspace, "/home/rob/project", "a path outside jobDir was never ours to move");
});

test("retention records only a validated host base commit for canary replay (#717)", () => {
	for (const sha of ["a".repeat(40), "b".repeat(64), "bad", undefined]) {
		const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
		const manifest = retainJobDir(prepared({ sha }), { sandboxDir: "/sbx", fs, now: () => 1_000 });
		assert.equal(manifest.baseSha, typeof sha === "string" && [40, 64].includes(sha.length) ? sha : undefined);
		assert.equal(JSON.parse(fs.files["/sbx/gh-1/manifest.json"]).baseSha, manifest.baseSha);
	}
});

test("a forge job's artifacts are deleted before the rename: they live in their own store, under their own retention (issue #920)", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>", "/jobs/job-xyz/artifacts/after.png": "png" } });
	retainJobDir(prepared(), { sandboxDir: "/sbx", fs });
	assert.ok(fs.calls.removed.includes("/jobs/job-xyz/artifacts"));
	assert.ok(!Object.keys(fs.files).some((k) => k.includes("artifacts")), "no second copy survives into the retained tree");
});

test("a canary's candidate is deleted before the rename: reopening a retained run loads neither it nor the overlay (issue #796)", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>", "/jobs/job-xyz/canary/a--1.0.0--aaaaaaaa/index.js": "third-party code" } });
	retainJobDir(prepared(), { sandboxDir: "/sbx", fs });
	assert.ok(fs.calls.removed.includes("/jobs/job-xyz/canary"));
	assert.ok(!Object.keys(fs.files).some((k) => k.includes("canary")), "it does not survive into the retained tree");
});

test("the per-job transcript copy is deleted BEFORE the rename, never carried along", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>", "/jobs/job-xyz/session/current.jsonl": "{}" } });
	retainJobDir(prepared(), { sandboxDir: "/sbx", fs });

	assert.equal(fs.calls.removed[0], "/jobs/job-xyz/session", "the session copy goes first, before anything can move it");
	assert.ok(!Object.keys(fs.files).some((k) => k.includes("session")), "no transcript survives into the retained tree");
	// Ordering is the assertion: a delete after the rename would target a path that no longer exists.
	assert.ok(fs.calls.removed.indexOf("/jobs/job-xyz/session") < 0 || fs.calls.renamed.length === 1);
});

test("a retry reuses the job id, and the latest attempt wins", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>", "/sbx/gh-1": "<dir>", "/sbx/gh-1/manifest.json": "{\"jobId\":\"gh-1\"}" } });
	retainJobDir(prepared(), { sandboxDir: "/sbx", fs });
	assert.ok(fs.calls.removed.includes("/sbx/gh-1"), "the previous attempt's directory is cleared before the rename");
	assert.deepEqual(fs.calls.renamed, [["/jobs/job-xyz", "/sbx/gh-1"]]);
});

test("any retention failure falls back to deleting the job dir -- retention never leaves debris", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" }, failOn: "rename" });
	const logged = [];
	const manifest = retainJobDir(prepared(), { sandboxDir: "/sbx", fs, log: (e, d) => logged.push([e, d]) });

	assert.equal(manifest, null, "a null tells the caller nothing was retained");
	assert.ok(fs.calls.removed.includes("/jobs/job-xyz"), "the job dir is removed, exactly as cleanup would have");
	assert.equal(logged.at(-1)?.[0], "sandbox_retain_failed");
});

test("no sandbox stamp and no sandboxDir both mean: delete, as before", () => {
	for (const [opts, why] of [
		[{ sandboxDir: null }, "retention unconfigured"],
		[{ sandboxDir: "/sbx" }, "an unwired prepare stamped nothing"],
	]) {
		const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
		const p = why === "retention unconfigured" ? prepared() : prepared({ sandbox: undefined });
		assert.equal(retainJobDir(p, { ...opts, fs }), null);
		assert.ok(fs.calls.removed.includes("/jobs/job-xyz"), why);
		assert.equal(fs.calls.renamed.length, 0);
	}
});

test("readManifest and listSandboxes are filename-keyed, and skip what cannot be read", () => {
	const fs = fakeFs({
		files: {
			"/sbx": "<dir>",
			"/sbx/gh-1": "<dir>",
			"/sbx/gh-1/manifest.json": JSON.stringify({ jobId: "gh-1", createdAt: "2026-08-01T00:00:00Z" }),
			"/sbx/gh-2": "<dir>",
			"/sbx/gh-2/manifest.json": "{ not json",
			"/sbx/gh-3": "<dir>",
			"/sbx/gh-3/manifest.json": JSON.stringify({ jobId: "gh-3", createdAt: "2026-08-02T00:00:00Z" }),
		},
	});
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "gh-1", fs }).dir, "/sbx/gh-1");
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "nope", fs }), null);

	const rows = listSandboxes({ sandboxDir: "/sbx", fs });
	assert.deepEqual(rows.map((r) => r.jobId), ["gh-3", "gh-1"], "newest first; the unparseable one is skipped");
	assert.deepEqual(listSandboxes({ sandboxDir: null, fs }), []);
});

test("a stamp with no venue records null, never a guessed local, and a pin keeps the venue (#277)", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	const manifest = retainJobDir(prepared({ sandbox: { jobId: "gh-1", kind: "github", image: "pi-job:latest" } }), { sandboxDir: "/sbx", fs, now: () => Date.parse("2026-08-01T10:00:00Z") });
	assert.ok("backend" in manifest, "the key is written, so the manifest is not mistaken for a pre-#277 one");
	assert.equal(manifest.backend, null);

	const pinFs = fakeFs({ files: { "/sbx/gh-2/manifest.json": JSON.stringify({ jobId: "gh-2", backend: "far", createdAt: "2026-08-01T00:00:00Z" }) } });
	const at = Date.parse("2026-08-01T12:00:00Z");
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-2", pinDays: 7, fs: pinFs, now: () => at }).pinned, true);
	assert.equal(JSON.parse(pinFs.files["/sbx/gh-2/manifest.json"]).backend, "far", "a pin must not turn a far run into an unkeyed, local-reading one");
	// And the other direction: a manifest from before the key existed stays keyless through a pin, because a
	// pin that wrote `backend: null` into it would make an old local run unopenable.
	const oldFs = fakeFs({ files: { "/sbx/gh-3/manifest.json": JSON.stringify({ jobId: "gh-3", createdAt: "2026-08-01T00:00:00Z" }) } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-3", pinDays: 7, fs: oldFs, now: () => at }).pinned, true);
	assert.equal(Object.hasOwn(JSON.parse(oldFs.files["/sbx/gh-3/manifest.json"]), "backend"), false);
});

test("the job user the run had is written to the manifest, null when nothing decided one, and a pin keeps it (#341)", () => {
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	const stamped = retainJobDir(prepared({ sandbox: { jobId: "gh-1", kind: "github", image: "pi-job:latest", backend: "local", jobUser: { user: "1234:1234", home: "/home/pi" } } }), { sandboxDir: "/sbx", fs, now: () => Date.parse("2026-08-01T10:00:00Z") });
	assert.deepEqual(stamped.jobUser, { user: "1234:1234", home: "/home/pi" });
	assert.deepEqual(JSON.parse(fs.files["/sbx/gh-1/manifest.json"]).jobUser, { user: "1234:1234", home: "/home/pi" }, "on disk, where the sandbox reads it");

	// Issue #429: a podman run's container store is recorded, and only when known.
	const podman = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	assert.equal(retainJobDir(prepared({ sandbox: { jobId: "gh-4", kind: "github", image: "pi-job:latest", backend: "podman", podmanStore: "/home/op/.local/share/containers/storage" } }), { sandboxDir: "/sbx", fs: podman, now: () => Date.parse("2026-08-01T10:00:00Z") }).podmanStore, "/home/op/.local/share/containers/storage");
	assert.equal(Object.hasOwn(stamped, "podmanStore"), false, "every other manifest keeps its shape");
	// Issue #596: the run's size is recorded too, and only when known, so a sandbox reopens the run at it.
	const sized = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	retainJobDir(prepared({ sandbox: { jobId: "gh-5", kind: "github", image: "pi-job:latest", backend: "local", size: { memMiB: 1536, cpuCenti: 50, source: "project" } } }), { sandboxDir: "/sbx", fs: sized, now: () => Date.parse("2026-08-01T10:00:00Z") });
	assert.deepEqual(JSON.parse(sized.files["/sbx/gh-5/manifest.json"]).size, { memMiB: 1536, cpuCenti: 50, source: "project" });
	assert.equal(Object.hasOwn(stamped, "size"), false, "a run with no size keeps the manifest's old shape");

	const bare = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	assert.equal(retainJobDir(prepared(), { sandboxDir: "/sbx", fs: bare }).jobUser, null, "no decision is null, which the sandbox reads as 'decide from this shell'");

	const pinFs = fakeFs({ files: { "/sbx/gh-2/manifest.json": JSON.stringify({ jobId: "gh-2", backend: "local", jobUser: { user: "1234:1234", home: "/home/pi" }, createdAt: "2026-08-01T00:00:00Z" }) } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-2", pinDays: 7, fs: pinFs, now: () => Date.parse("2026-08-01T12:00:00Z") }).pinned, true);
	assert.deepEqual(JSON.parse(pinFs.files["/sbx/gh-2/manifest.json"]).jobUser, { user: "1234:1234", home: "/home/pi" });
});

test("a pin is a TIMESTAMP, never a boolean -- there is no keep-forever", () => {
	const fs = fakeFs({ files: { "/sbx/gh-1/manifest.json": JSON.stringify({ jobId: "gh-1", createdAt: "2026-08-01T00:00:00Z" }) } });
	const at = Date.parse("2026-08-01T12:00:00Z");
	const result = pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs, now: () => at });

	assert.equal(result.pinned, true);
	assert.equal(result.keepUntil, new Date(at + 7 * DAY).toISOString());
	const written = JSON.parse(fs.files["/sbx/gh-1/manifest.json"]);
	assert.equal(written.keepUntil, result.keepUntil);
	assert.equal(written.jobId, "gh-1", "the rest of the manifest survives the rewrite");
	assert.equal(written.dir, undefined, "the derived dir is not persisted back into the file");

	// `now` passed here too, though this arm returns before reading it: a dated fixture beside a subject
	// on the default clock is the pairing issue #293 flags, and "it happens not to matter today" is how a
	// fuse gets written.
	assert.deepEqual(pinSandbox({ sandboxDir: "/sbx", jobId: "gone", fs, pinDays: 7, now: () => at }), { pinned: false, reason: "absent" });
});

/**
 * The retained directories a pass DELETED, by the name they had: the sweep deletes a tombstone it renamed the run to
 * (issue #446), so each removed path is mapped back through the renames.
 */
function swept(fs) {
	const origin = new Map(fs.calls.renamed.map(([from, to]) => [to, from]));
	return fs.calls.removed.map((p) => origin.get(p) ?? p);
}

/** Make the delete of `dir`, under whatever name the sweep gives it, fail with `message`. */
function failDelete(fs, dir, message = "EPERM: operation not permitted", code = "EPERM") {
	fs.rmSync = (p) => {
		const origin = new Map(fs.calls.renamed.map(([from, to]) => [to, from]));
		if ((origin.get(p) ?? p) === dir) throw Object.assign(new Error(message), { code });
		fs.calls.removed.push(p);
		for (const k of Object.keys(fs.files)) if (k === p || k.startsWith(`${p}/`)) delete fs.files[k];
	};
}

/** A retention root holding `entries`, each `{ createdAt?, keepUntil? }` or the string "<bad>". */
function sandboxDirWith(entries) {
	const files = { "/sbx": "<dir>" };
	for (const [id, body] of Object.entries(entries)) {
		files[`/sbx/${id}`] = "<dir>";
		if (body !== "<bad>") files[`/sbx/${id}/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: id, ...body });
	}
	return fakeFs({ files });
}

test("the sweep expires on the manifest's createdAt, not on mtime a live sandbox would move", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({
		old: { createdAt: new Date(at - 30 * HOUR).toISOString() },
		fresh: { createdAt: new Date(at - 2 * HOUR).toISOString() },
	});
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, log: (e, d) => logged.push([e, d]) })();

	assert.deepEqual(swept(fs), ["/sbx/old"]);
	assert.deepEqual(logged, [["reaped_sandbox", { entry: "old", reason: "window" }]]);
});

test("a pin outlives the base window, and expires on its own deadline", async () => {
	const at = Date.parse("2026-08-10T00:00:00Z");
	const fs = sandboxDirWith({
		pinned: { createdAt: new Date(at - 200 * HOUR).toISOString(), keepUntil: new Date(at + DAY).toISOString() },
		lapsed: { createdAt: new Date(at - 200 * HOUR).toISOString(), keepUntil: new Date(at - DAY).toISOString() },
	});
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at })();
	assert.deepEqual(swept(fs), ["/sbx/lapsed"], "a live pin survives; a lapsed one does not linger");
});

test("retention off sweeps everything unpinned, and needs no special case to do it", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({
		recent: { createdAt: new Date(at - 60000).toISOString() },
		pinned: { createdAt: new Date(at - 60000).toISOString(), keepUntil: new Date(at + DAY).toISOString() },
	});
	// 0 is the feature being OFF -- the opposite of the log/session sentinels, where 0 is keep-forever.
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 0, fs, now: () => at })();
	assert.deepEqual(swept(fs), ["/sbx/recent"], "turning retention off also cleans up what it retained");
});

test("a directory whose sandbox is RUNNING is never swept out from under the operator", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({
		"gh-1": { createdAt: new Date(at - 99 * HOUR).toISOString() },
		"gh-2": { createdAt: new Date(at - 99 * HOUR).toISOString() },
	});
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, listRunning: async () => ["gh-1"] })();
	assert.deepEqual(swept(fs), ["/sbx/gh-2"], "the live one stays, however old it is");
});

test("the sweep's fault line carries the daemon's words with credentials scrubbed (#339)", async () => {
	// `listRunning` is a `promisify(execFile)` docker spawn in production, so its rejection message repeats an
	// unparseable DOCKER_HOST with whatever is in it. Both directions pinned: the fs/daemon diagnosis survives,
	// the credential does not.
	const logged = [];
	const reap = makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs: fakeFs({ files: {} }),
		now: () => AT,
		listRunning: async () => {
			throw new Error('Command failed: docker ps\nCannot connect to the Docker daemon at tcp://bob:hunter2@10.0.0.5:2375. Is the docker daemon running?');
		},
		log: (event, fields) => logged.push([event, fields]),
	});
	await reap();
	assert.equal(logged.length, 1);
	assert.equal(logged[0][0], "sandbox_reaper_skipped");
	const reason = logged[0][1].reason;
	assert.match(reason, /tcp:\/\/\[redacted\]@10\.0\.0\.5:2375/, "the host survives");
	assert.match(reason, /Is the docker daemon running\?/, "and so does the daemon's own sentence");
	for (const needle of ["bob", "hunter2"]) assert.ok(!reason.includes(needle), needle);
});

test("a directory that could not be MOVED ASIDE names its network, end to end (#363, redefined by #446)", async () => {
	// THE PRODUCER HALF, which nothing held: deleting `blocked.add(name)` or dropping `blocked` from the
	// `sweepNetworks` call left the whole worker suite green while the feature was disconnected in production.
	// The sweeper's own test hands it a hand-built set, which cannot see either. Since #446 the directory is renamed to
	// a tombstone before it is deleted, so what leaves a directory under its own name is a RENAME that fails.
	const at = Date.now();
	const fs = sandboxDirWith({ a: { createdAt: "2020-01-01T00:00:00Z" } });
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (from === "/sbx/a") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		rename(from, to);
	};
	const handed = [];
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => at,
		listRunning: async () => [],
		sweepNetworks: async (arg) => (handed.push(arg), { swept: [], notes: [], failed: null }),
		log: (e, d) => logged.push([e, d]),
	})();

	assert.equal(handed.length, 1, "the network sweep still runs");
	assert.deepEqual([...(handed[0].blocked ?? [])], ["a"], "and is told which directory would not go");
	assert.ok("/sbx/a/manifest.json" in fs.files, "held under its own name, whole");
	// OQ-007's one grep: the hold is in the family, with a fixed token.
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: "a", reason: "rename-failed", code: "EACCES" }]]);
});

test("a tombstone whose delete fails STAYS one: its id leaves keep, and each pass retries it with a rate-limited line (#446)", async () => {
	// The ordinary #363 shape, root-owned files in a retained clone under a non-root worker, renames fine (the rename
	// needs only the root) and fails the delete. The run is already unopenable, which is intended; what must not happen
	// is its id staying in `keep` forever (its network never reaped) or a line on every tick.
	let at = AT;
	const fs = sandboxDirWith({ a: { createdAt: hoursAgo(50) } });
	failDelete(fs, "/sbx/a", "EACCES: permission denied", "EACCES");
	const handed = [];
	const logged = [];
	const reap = makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => at,
		pid: 77,
		listRunning: async () => [],
		sweepNetworks: async (arg) => {
			for (const name of arg.retained()) arg.keep.add(name);
			handed.push({ keep: [...arg.keep].sort(), blocked: [...arg.blocked] });
			return { swept: [], notes: [] };
		},
		log: (e, d) => logged.push([e, d]),
	});
	await reap();
	const tomb = `.reap-77-${AT}-0`;
	assert.ok(`/sbx/${tomb}/manifest.json` in fs.files, "the tree is still there, as a tombstone");
	assert.ok(!("/sbx/a" in fs.files), "and no longer under the run's own name, so nothing can open or pin it");
	assert.deepEqual(handed[0], { keep: ["a"], blocked: [] }, "this pass keeps the id it started with, and it is NOT blocked");
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: "a", reason: "tombstone-stuck", tombstone: tomb, code: "EACCES" }]]);

	// The next pass, an hour on: the delete is retried and still fails, silently (said an hour ago); the id is gone from
	// `keep`, so its network is a candidate again.
	logged.length = 0;
	at = AT + HOUR;
	await reap();
	assert.deepEqual(handed[1], { keep: [], blocked: [] }, "the tombstone is in neither the listing nor the fresh read");
	assert.deepEqual(logged, [], "rate-limited: one line per tombstone per day");
	// A day after the first line, it is said again.
	at = AT + DAY;
	await reap();
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: tomb, reason: "tombstone-stuck", code: "EACCES" }]]);
	// And once the operator has cleared the cause, the next pass removes it.
	logged.length = 0;
	fs.rmSync = (p) => {
		fs.calls.removed.push(p);
		for (const k of Object.keys(fs.files)) if (k === p || k.startsWith(`${p}/`)) delete fs.files[k];
	};
	at = AT + DAY + HOUR;
	await reap();
	assert.deepEqual(logged, [["reaped_sandbox", { entry: tomb, reason: "tombstone" }]]);
	assert.deepEqual(Object.keys(fs.files), ["/sbx"]);
});

test("a directory that VANISHED is not reported as one that could not be removed (#363)", async () => {
	// `blocked` means "a removal was attempted and failed". A directory gone between the listing and the lstat
	// is a different thing, and the note it would produce asserts the opposite of what happened: that the
	// directory stays on disk, so its network is never a candidate again. It does not stay, and it is.
	const at = Date.now();
	const fs = sandboxDirWith({ a: { createdAt: "2020-01-01T00:00:00Z" } });
	fs.lstatSync = () => {
		throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
	};
	const handed = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => at,
		listRunning: async () => [],
		sweepNetworks: async (arg) => (handed.push(arg), { swept: [], notes: [], failed: null }),
	})();
	assert.deepEqual([...(handed[0].blocked ?? [])], [], "a vanished directory is not blocked");
});

test("a docker lookup that FAILS skips the whole sweep rather than sweeping blind", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({ ancient: { createdAt: "2020-01-01T00:00:00Z" } });
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => at,
		listRunning: async () => {
			throw new Error("daemon down");
		},
		log: (e, d) => logged.push([e, d]),
	})();

	assert.deepEqual(swept(fs), [], "a directory kept one boot too long is the cheaper mistake");
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { reason: "daemon down" }]]);
});

test("an entry with no usable manifest is reaped -- it can never be resurrected", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({ bad: "<bad>", undated: {} });
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, log: (e, d) => logged.push([e, d]) })();

	assert.deepEqual(swept(fs).sort(), ["/sbx/bad", "/sbx/undated"]);
	assert.deepEqual(logged.map((l) => l[1].reason).sort(), ["no-created-at", "no-manifest"]);
});

test("a symlinked entry is refused by lstat rather than followed onto the host", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({ real: { createdAt: new Date(at - 99 * HOUR).toISOString() } });
	fs.files["/sbx/link"] = "<symlink>"; // lstatSync reports isDirectory() false, as it would for a link
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at })();
	assert.ok(fs.calls.removed.includes("/sbx/link"), "a non-directory entry is removed, never descended into");
});

test("the sweep NEVER throws: a missing root, an unreadable entry, an unlink failure", async () => {
	const at = Date.now();
	await makeSandboxReaper({ sandboxDir: "/nope", retentionHours: 24, fs: fakeFs({ files: {} }), now: () => at })();

	const fs = sandboxDirWith({ a: { createdAt: "2020-01-01T00:00:00Z" }, b: { createdAt: "2020-01-01T00:00:00Z" } });
	failDelete(fs, "/sbx/a", "EPERM");
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(swept(fs), ["/sbx/b"], "one bad entry cannot abort the rest of the sweep");
	assert.ok(logged.some(([e, d]) => e === "sandbox_reaper_skipped" && d.entry === "a"));

	// And with no root configured at all it is simply inert.
	await makeSandboxReaper({ sandboxDir: null, retentionHours: 24, now: () => at })();
});

// --- the session networks the reaper now sweeps (issue #337) -----------------------------------------

const AT = Date.parse("2026-08-02T00:00:00Z");
const hoursAgo = (h) => new Date(AT - h * HOUR).toISOString();

test("the network sweep is keyed on the listing the pass STARTED with, not on what survived it (#337)", async () => {
	// Issue #277 withdrew removing a session network at OPEN time because two opens race. This sweep is a
	// different mechanism, and this is the pin that keeps it one: an entry this pass EXPIRES must still be in
	// `keep`, or an open that passed `resolveSandbox` while the directory existed loses its network between
	// `createJobNetwork` and `launch` -- the same harm, reached the long way round.
	const seen = [];
	const fs = sandboxDirWith({ old: { createdAt: hoursAgo(50) }, fresh: { createdAt: hoursAgo(1) } });
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		listRunning: async () => [],
		sweepNetworks: async (arg) => {
			seen.push({ running: [...arg.running].sort(), keep: [...arg.keep].sort() });
			return { swept: [], notes: [] };
		},
	})();
	assert.deepEqual(swept(fs), ["/sbx/old"], "the expired directory is still removed");
	assert.deepEqual(seen, [{ running: [], keep: ["fresh", "old"] }], "and its id is STILL in keep");
});

test("a run RETAINED while the pass was running is kept too, not just one it started with (#337)", async () => {
	// The other end of the same race, and the pre-pass listing alone does not close it. `retainJobDir` creates
	// a retained directory at job END, in this process, and this pass awaits docker and yields per tree -- so a
	// job can finish, and an operator can open the run they just watched finish, while the pass is still going.
	// That id is in neither the old listing nor `running`, because the container is not up yet, and the network
	// `createJobNetwork` just made would be swept out from under the launch. So the keep set is the UNION of
	// the listing this pass began with and a fresh one read immediately before the sweep.
	const fs = sandboxDirWith({ old: { createdAt: hoursAgo(50) }, fresh: { createdAt: hoursAgo(1) } });
	const rmSync = fs.rmSync;
	fs.rmSync = (path) => {
		rmSync(path);
		fs.files["/sbx/justfinished"] = "<dir>"; // a job ended mid-pass
	};
	const seen = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		listRunning: async () => [],
		// The real sweeper calls `retained()` itself, after its own candidate listing, and unions what it
		// returns into `keep`. This fake stands in for exactly that.
		sweepNetworks: async (arg) => {
			for (const name of arg.retained()) arg.keep.add(name);
			seen.push([...arg.keep].sort());
			return { swept: [], notes: [] };
		},
	})();
	assert.deepEqual(seen, [["fresh", "justfinished", "old"]], "both halves: the expired id AND the one that landed mid-pass");
});

test("a sandbox root that does not EXIST still sweeps networks, rather than never firing (#337)", async () => {
	// The host most likely to be holding orphaned `pi-sandbox-` networks is the one whose sandbox root was
	// never created or was removed by hand, and skipping there would mean the sweep never fires on it at all.
	// Safe as well as useful: with no root, `resolveSandbox` refuses EVERY run, so no open can be in flight.
	const fs = fakeFs({ files: {} });
	const seen = [];
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		log: (e, d) => logged.push([e, d]),
		listRunning: async () => [],
		sweepNetworks: async (arg) => {
			seen.push([...arg.retained()]);
			return { swept: [], notes: [] };
		},
	})();
	assert.deepEqual(seen, [[]], "an absent root is an EMPTY listing, not a failed one");
	assert.deepEqual(logged, [], "and nothing is reported as skipped, because nothing was");
	assert.deepEqual(swept(fs), []);
});

test("a re-read that FAILS is one skipped line, and nothing is swept on half the evidence (#337)", async () => {
	// Not ENOENT: a permission wall or an I/O fault is a read that failed, and the fresh half of the keep set
	// is what protects a run retained mid-pass. The sweeper lets that throw leave it; the reaper turns it into
	// its family's one line.
	const fs = sandboxDirWith({ fresh: { createdAt: hoursAgo(1) } });
	const readdirSync = fs.readdirSync;
	let reads = 0;
	fs.readdirSync = (path) => {
		if (++reads > 1) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		return readdirSync(path);
	};
	let swept = 0;
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		log: (e, d) => logged.push([e, d]),
		listRunning: async () => [],
		sweepNetworks: async (arg) => {
			for (const name of arg.retained()) arg.keep.add(name);
			swept++;
			return { swept: [], notes: [] };
		},
	})();
	assert.equal(swept, 0, "the throw leaves the sweeper before anything is removed");
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { reason: "EACCES: permission denied" }]]);
});

test("a RUNNING sandbox reaches the network sweep through both sets (#337)", async () => {
	const seen = [];
	const fs = sandboxDirWith({ live: { createdAt: hoursAgo(50) } });
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		listRunning: async () => ["live"],
		sweepNetworks: async (arg) => {
			seen.push({ running: [...arg.running], keep: [...arg.keep] });
			return { swept: [], notes: [] };
		},
	})();
	assert.deepEqual(seen, [{ running: ["live"], keep: ["live"] }], "a shell an operator is in is protected twice over");
});

test("a docker lookup that FAILS skips the network sweep too, not just the directories (#337)", async () => {
	let called = false;
	const fs = sandboxDirWith({ old: { createdAt: hoursAgo(50) } });
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		listRunning: async () => {
			throw new Error("daemon down");
		},
		sweepNetworks: async () => {
			called = true;
			return { swept: [], notes: [] };
		},
	})();
	assert.equal(called, false, "without an answer nothing can be called unclaimed");
});

test("a throwing network sweep is one log line, never a rejection out of the reaper (#337)", async () => {
	const fs = sandboxDirWith({});
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		log: (e, d) => logged.push([e, d]),
		listRunning: async () => [],
		sweepNetworks: async () => {
			throw new Error("boom");
		},
	})();
	// The FAULT keeps the family name, on OQ-007's property that one grep covers boot and every tick; only
	// the per-network verdicts get new names.
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { reason: "boom" }]]);
});

test("the sweep's verdicts are logged under their own names (#337)", async () => {
	const fs = sandboxDirWith({});
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		log: (e, d) => logged.push([e, d]),
		listRunning: async () => [],
		sweepNetworks: async () => ({ swept: [{ network: "pi-sandbox-a-net", detached: ["p"] }], notes: [{ network: "pi-sandbox-b-net", reason: "sandbox-attached" }] }),
	})();
	assert.deepEqual(logged, [
		["reaped_sandbox_network", { network: "pi-sandbox-a-net", detached: ["p"] }],
		["sandbox_network_not_reaped", { network: "pi-sandbox-b-net", reason: "sandbox-attached" }],
	]);
});

test("a listing that did not answer is the sweep's FAULT, not a verdict about a network (#337)", async () => {
	// The sweeper cannot throw (its runner never does), so the case a `network ls` failure has to reach is
	// this one: `failed` rather than a note. A note would read as "one network was not reaped" about a look
	// that saw none, and it would put a fault outside the `sandbox_reaper_skipped` grep OQ-007 names.
	const fs = sandboxDirWith({});
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		log: (e, d) => logged.push([e, d]),
		listRunning: async () => [],
		sweepNetworks: async () => ({ swept: [], notes: [], failed: "network-list-failed" }),
	})();
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { reason: "network-list-failed" }]]);
});

test("a pin rewrites the manifest ATOMICALLY: a temp file renamed over it, never a truncate in place (#429 review)", () => {
	// A reader between a truncate and the write saw a manifest that did not parse, and the retention sweep read that
	// as "no manifest, delete it" under an open shell. So the manifest path is only ever written by a rename.
	const fs = fakeFs({ files: { "/sbx/gh-1/manifest.json": JSON.stringify({ jobId: "gh-1", backend: "podman", createdAt: "2026-08-01T00:00:00Z" }) } });
	const writes = [];
	const write = fs.writeFileSync;
	fs.writeFileSync = (p, body, opts) => (writes.push(p), write(p, body, opts));
	const at = Date.parse("2026-08-01T12:00:00Z");
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs, now: () => at }).pinned, true);
	assert.ok(writes.length === 1 && writes[0] !== "/sbx/gh-1/manifest.json" && writes[0].startsWith("/sbx/gh-1/."), `written beside it, never over it: ${writes}`);
	assert.deepEqual(fs.calls.renamed.at(-1), [writes[0], "/sbx/gh-1/manifest.json"]);
	assert.equal(JSON.parse(fs.files["/sbx/gh-1/manifest.json"]).keepUntil, new Date(at + 7 * DAY).toISOString());
	assert.ok(!(writes[0] in fs.files), "no temp file is left");
	// A rename that fails leaves the old manifest whole and removes the temp file.
	const failing = fakeFs({ failOn: "rename", files: { "/sbx/gh-2/manifest.json": JSON.stringify({ jobId: "gh-2", createdAt: "2026-08-01T00:00:00Z" }) } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-2", pinDays: 7, fs: failing, now: () => at }).pinned, false);
	assert.equal(JSON.parse(failing.files["/sbx/gh-2/manifest.json"]).keepUntil, undefined);
	assert.deepEqual(Object.keys(failing.files).filter((k) => k.includes(".tmp")), []);
});

test("each network-listing failure is logged with its runtime, and a bare `failed` keeps its old line (#429 review)", async () => {
	const at = Date.parse("2026-08-01T12:00:00Z");
	const run = async (outcome) => {
		const logs = [];
		await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs: fakeFs({ files: { "/sbx": "<dir>" } }), now: () => at, log: (e, f) => logs.push([e, f]), sweepNetworks: async () => outcome })();
		return logs.filter(([e]) => e === "sandbox_reaper_skipped").map(([, f]) => f);
	};
	assert.deepEqual(await run({ swept: [], notes: [], failed: "network-list-failed", failures: [{ reason: "network-list-failed", runtime: "docker" }, { reason: "network-list-failed", runtime: "podman" }] }), [
		{ reason: "network-list-failed", runtime: "docker" },
		{ reason: "network-list-failed", runtime: "podman" },
	]);
	assert.deepEqual(await run({ swept: [], notes: [], failed: "network-list-failed" }), [{ reason: "network-list-failed" }]);
});

test("a pin keeps the manifest's OWNER and MODE, even as root, and refuses rather than hand it to another account (#429 review round 3)", () => {
	// Reproduced: `sudo -E pi-dispatch sandbox --pin` renamed a root-owned temp file over the worker's manifest, the
	// worker could not read it, and its sweep deleted the run as manifest-less once the shell exited.
	const at = Date.parse("2026-08-01T12:00:00Z");
	const path = "/sbx/gh-1/manifest.json";
	const body = JSON.stringify({ jobId: "gh-1", backend: "podman", createdAt: "2026-08-01T00:00:00Z" });
	const worker = { uid: 1234, gid: 1234, mode: 0o600 };

	const root = fakeFs({ files: { [path]: body }, owners: { [path]: worker }, as: { uid: 0, gid: 0 } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: root, now: () => at, euid: 0 }).pinned, true);
	assert.deepEqual(root.meta[path], worker, "sudo's pin leaves the worker's own 0600 manifest");
	assert.equal(root.calls.chowned.length, 1);

	const own = fakeFs({ files: { [path]: body }, owners: { [path]: worker }, as: { uid: 1234, gid: 1234 } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: own, now: () => at, euid: 1234 }).pinned, true);
	assert.deepEqual(own.meta[path], worker, "the worker's own pin: mode 0600, owner unchanged");
	// Whatever the mode is, it is kept (M12): an operator who made a manifest 0640 for a group still has 0640.
	const shared = { uid: 1234, gid: 1234, mode: 0o640 };
	const group = fakeFs({ files: { [path]: body }, owners: { [path]: shared }, as: { uid: 1234, gid: 1234 } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: group, now: () => at, euid: 1234 }).pinned, true);
	assert.deepEqual(group.meta[path], shared);
	const rootGroup = fakeFs({ files: { [path]: body }, owners: { [path]: shared }, as: { uid: 0, gid: 0 } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: rootGroup, now: () => at, euid: 0 }).pinned, true);
	assert.deepEqual(rootGroup.meta[path], shared);

	// Another unprivileged account cannot keep the owner, so the pin is refused and the manifest untouched.
	const other = fakeFs({ files: { [path]: body }, owners: { [path]: worker }, as: { uid: 1300, gid: 1300 } });
	const refused = pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: other, now: () => at, euid: 1300 });
	assert.equal(refused.pinned, false);
	assert.deepEqual(other.meta[path], worker);
	assert.equal(JSON.parse(other.files[path]).keepUntil, undefined);
	assert.deepEqual(Object.keys(other.files).filter((k) => k.includes(".tmp")), [], "no temp file is left");

	// A temp path that already exists is never written through (`wx`).
	const planted = fakeFs({ files: { [path]: body, [`/sbx/gh-1/.manifest.json.${process.pid}.${at}.tmp`]: "planted" }, owners: { [path]: worker } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: planted, now: () => at, euid: 1234 }).pinned, false);
	assert.equal(planted.files[`/sbx/gh-1/.manifest.json.${process.pid}.${at}.tmp`], "planted", "the planted file is not removed either");
});

// --- issue #446: the deadline in the manifest, and the tombstone ------------------------------------------------

test("the tombstone constants are pinned by literal (#446)", () => {
	assert.deepEqual({ SANDBOX_TOMBSTONE_PREFIX, SANDBOX_TOMBSTONE_STUCK_MS, SANDBOX_TOMBSTONE_RELOG_MS }, { SANDBOX_TOMBSTONE_PREFIX: ".reap-", SANDBOX_TOMBSTONE_STUCK_MS: 600000, SANDBOX_TOMBSTONE_RELOG_MS: 86400000 });
	assert.equal(sandboxTombstoneAge(".reap-12-1000-0", 61000), 60000);
	assert.equal(sandboxTombstoneAge(".reap-by-hand", 61000), null, "a name this module did not write has no age");
});

test("retention writes the worker's deadline into the manifest, and null when the caller does not say (#446)", () => {
	const at = Date.parse("2026-08-01T10:00:00Z");
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	const manifest = retainJobDir(prepared(), { sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at });
	assert.equal(manifest.retainUntil, "2026-08-02T10:00:00.000Z");
	assert.equal(JSON.parse(fs.files["/sbx/gh-1/manifest.json"]).retainUntil, "2026-08-02T10:00:00.000Z", "on disk, where every opener reads it");
	const bare = fakeFs({ files: { "/jobs/job-xyz": "<dir>" } });
	assert.equal(retainJobDir(prepared(), { sandboxDir: "/sbx", fs: bare, now: () => at }).retainUntil, null);
	// A pin keeps it: the pin wins while it lasts, and the key is still the run's own record.
	const pin = fakeFs({ files: { "/sbx/gh-1/manifest.json": fs.files["/sbx/gh-1/manifest.json"] } });
	assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: pin, now: () => at }).pinned, true);
	assert.equal(JSON.parse(pin.files["/sbx/gh-1/manifest.json"]).retainUntil, "2026-08-02T10:00:00.000Z");
});

test("sandboxDeadline: the pin, else the EARLIER of retainUntil and createdAt plus the reader's window (#446)", () => {
	const created = "2026-08-01T00:00:00.000Z";
	const c = Date.parse(created);
	assert.deepEqual(sandboxDeadline({ createdAt: created, retainUntil: "2026-08-01T06:00:00.000Z", keepUntil: "2026-08-09T00:00:00.000Z" }, 24), { until: Date.parse("2026-08-09T00:00:00.000Z"), source: "pin" }, "a pin wins over everything");
	assert.deepEqual(sandboxDeadline({ createdAt: created, retainUntil: "2026-08-01T06:00:00.000Z", keepUntil: null }, 24), { until: c + 6 * HOUR, source: "retain" }, "the worker's written deadline, not this reader's longer 24h");
	assert.deepEqual(sandboxDeadline({ createdAt: created, retainUntil: "2026-08-02T00:00:00.000Z" }, 6), { until: c + 6 * HOUR, source: "window" }, "a window SHORTER than the one it was retained with applies");
	assert.deepEqual(sandboxDeadline({ createdAt: created, retainUntil: "2026-08-02T00:00:00.000Z" }, 0), { until: c, source: "window" }, "and 0 ends it at once");
	assert.deepEqual(sandboxDeadline({ createdAt: created, retainUntil: "2026-08-02T00:00:00.000Z" }, 24), { until: c + 24 * HOUR, source: "window" }, "equal: the window's own edge");
	assert.deepEqual(sandboxDeadline({ createdAt: created, keepUntil: "garbage" }, 24), { until: c + 24 * HOUR, source: "window" }, "an old manifest, and an unparseable pin is no pin");
	// A number is not a deadline: `Date.parse(5)` reads it as a YEAR (gate round 1), so only a string counts.
	for (const odd of [5, 0, 1e20, {}, null]) assert.deepEqual(sandboxDeadline({ createdAt: created, retainUntil: odd }, 24), { until: c + 24 * HOUR, source: "window" }, JSON.stringify(odd));
	assert.deepEqual(sandboxDeadline({}, 24), { until: null, source: "no-created-at" });
	// The adapter answers what the sweep answers, on readManifest's shape.
	assert.deepEqual(sandboxExpiry({ createdAt: created, retainUntil: "2026-08-01T06:00:00.000Z" }, { at: c + 6 * HOUR, retentionHours: 24 }), { expired: true, reason: "window" });
	assert.deepEqual(sandboxExpiry({ createdAt: created }, { at: c + 24 * HOUR, retentionHours: 24 }), { expired: false }, "the fallback window keeps its old edge");
	assert.deepEqual(sandboxExpiry(null, { at: c, retentionHours: 24 }), { expired: true, reason: "no-manifest" });
});

test("the sweep ends a run at the earlier of its recorded deadline and the worker's CURRENT window (#446)", async () => {
	// Both directions. A worker whose window was LOWERED after retention sweeps on the lower one (shortening applies,
	// the promise docs/sandbox.md makes); a run whose recorded deadline is earlier than this worker's window goes on the
	// recorded one; a pin keeps a run whatever either says.
	const fs = sandboxDirWith({
		recorded: { createdAt: hoursAgo(7), retainUntil: hoursAgo(1) },
		lowered: { createdAt: hoursAgo(10), retainUntil: new Date(AT + 14 * HOUR).toISOString() },
		within: { createdAt: hoursAgo(2), retainUntil: new Date(AT + 22 * HOUR).toISOString() },
		pinned: { createdAt: hoursAgo(10), retainUntil: hoursAgo(1), keepUntil: new Date(AT + HOUR).toISOString() },
		old: { createdAt: hoursAgo(70) },
	});
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 6, fs, now: () => AT })();
	assert.deepEqual(swept(fs).sort(), ["/sbx/lowered", "/sbx/old", "/sbx/recorded"]);
});

test("retention OFF still clears what an earlier setting retained, recorded deadlines and all, and keeps a pin (#446)", async () => {
	const fs = sandboxDirWith({
		fresh: { createdAt: hoursAgo(1), retainUntil: new Date(AT + 23 * HOUR).toISOString() },
		pinned: { createdAt: hoursAgo(1), retainUntil: new Date(AT + 23 * HOUR).toISOString(), keepUntil: new Date(AT + DAY).toISOString() },
	});
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 0, fs, now: () => AT })();
	assert.deepEqual(swept(fs), ["/sbx/fresh"]);
});

test("a young tombstone ANOTHER process named is left for it; an old one, and this process's own, are cleared (#446)", async () => {
	// One worker per retention root is the supported shape; this only keeps a second one from deleting a tombstone the
	// first is about to rename back.
	const fs = sandboxDirWith({});
	const young = `.reap-900-${AT - 60_000}-0`;
	const old = `.reap-900-${AT - SANDBOX_TOMBSTONE_STUCK_MS}-0`;
	const mine = `.reap-77-${AT - 1000}-0`;
	// Gate round 1: only while that process is ALIVE. A worker restarted after a crash has a new pid, and the tombstone
	// its predecessor left seconds ago is a plain leftover to clear now.
	const dead = `.reap-901-${AT - 5_000}-0`;
	for (const n of [young, old, mine, dead, ".reap-by-hand"]) fs.files[`/sbx/${n}`] = "<dir>";
	const logged = [];
	const asked = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pid: 77, pidAlive: (p) => (asked.push(p), p === 900), log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(Object.keys(fs.files).sort(), ["/sbx", `/sbx/${young}`]);
	assert.deepEqual(logged.filter(([e]) => e === "reaped_sandbox").map(([, d]) => d.entry).sort(), [".reap-by-hand", dead, mine, old].sort());
	assert.deepEqual(logged.filter(([e]) => e === "sandbox_reaper_skipped"), [["sandbox_reaper_skipped", { entry: young, reason: "tombstone-foreign" }]], "the skip is said");
	assert.deepEqual(asked.sort(), [900, 901], "liveness is asked only of young foreign tombstones");
});

test("the sweep renames a run to a tombstone WITHOUT its id, then deletes the tombstone; a 250-byte id is no different (#446)", async () => {
	const long = "x".repeat(250);
	const fs = sandboxDirWith({ [long]: { createdAt: hoursAgo(50) } });
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pid: 4242, log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(fs.calls.renamed, [[`/sbx/${long}`, `/sbx/.reap-4242-${AT}-0`]], "one rename, to a name that never carries the id (ENAMETOOLONG otherwise)");
	assert.deepEqual(fs.calls.removed, [`/sbx/.reap-4242-${AT}-0`], "and only the tombstone is deleted");
	assert.deepEqual(logged, [["reaped_sandbox", { entry: long, reason: "window" }]]);
	assert.deepEqual(Object.keys(fs.files), ["/sbx"]);
});

test("a pin landing between the fresh read and the rename is seen through the tombstone, and the run is put back (#446)", async () => {
	const fs = sandboxDirWith({ a: { createdAt: hoursAgo(50), keepUntil: null } });
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		// The operator's pin, from another process, after the sweep's fresh read and before its rename.
		if (from === "/sbx/a" && isSandboxTombstone(to.split("/").at(-1))) assert.equal(pinSandbox({ sandboxDir: "/sbx", jobId: "a", pinDays: 7, fs, now: () => AT }).pinned, true);
		rename(from, to);
	};
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(swept(fs), [], "nothing deleted");
	assert.equal(JSON.parse(fs.files["/sbx/a/manifest.json"]).keepUntil, new Date(AT + 7 * DAY).toISOString(), "the run is back under its own name, pinned");
	assert.deepEqual(Object.keys(fs.files).filter((k) => k.includes(".reap-")), [], "no tombstone left");
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: "a", reason: "manifest-changed" }]]);
});

test("a changed tombstone whose name a runtime took with an EMPTY directory is still restored, never left to be deleted (#446, gate round 1)", async () => {
	// Reproduced with a real filesystem: the name taken by a runtime's auto-created, empty bind source left a PINNED run as
	// a tombstone, and the next pass's leftover sweep deleted it. An empty directory is the one thing displaced.
	const fs = sandboxDirWith({ a: { createdAt: hoursAgo(50) } });
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		const tomb = from === "/sbx/a" && isSandboxTombstone(to.split("/").at(-1));
		if (tomb) pinSandbox({ sandboxDir: "/sbx", jobId: "a", pinDays: 7, fs, now: () => AT });
		rename(from, to);
		if (tomb) fs.files["/sbx/a"] = "<dir>";
	};
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pid: 9, log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: "a", reason: "manifest-changed" }]]);
	assert.deepEqual(fs.calls.rmdired, ["/sbx/a"], "the empty directory, and only it, was removed");
	assert.equal(JSON.parse(fs.files["/sbx/a/manifest.json"]).keepUntil, new Date(AT + 7 * DAY).toISOString(), "the pinned run is back");
	assert.deepEqual(Object.keys(fs.files).filter((k) => k.includes(".reap-")), []);
});

test("a changed tombstone whose name holds anything but an empty directory is held, and no pass deletes it while pinned (#446, gate round 1)", async () => {
	const fs = sandboxDirWith({ a: { createdAt: hoursAgo(50) } });
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		const tomb = from === "/sbx/a" && isSandboxTombstone(to.split("/").at(-1));
		if (tomb) pinSandbox({ sandboxDir: "/sbx", jobId: "a", pinDays: 7, fs, now: () => AT });
		rename(from, to);
		if (tomb) fs.files["/sbx/a"] = "<dir>";
		if (tomb) fs.files["/sbx/a/someone-elses"] = "x";
	};
	const logged = [];
	const reap = makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pid: 9, log: (e, d) => logged.push([e, d]) });
	await reap();
	const tomb = `.reap-9-${AT}-0`;
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: "a", reason: "manifest-changed", restored: false }]]);
	assert.ok(`/sbx/${tomb}/manifest.json` in fs.files, "held as a tombstone");
	assert.equal(fs.files["/sbx/a/someone-elses"], "x", "and what took the name is untouched");
	// The next passes: the tombstone holds a LIVE pin, so it is never deleted as a leftover; once the name is free it
	// goes back under it.
	logged.length = 0;
	fs.files["/sbx/a/manifest.json"] = JSON.stringify({ jobId: "a", createdAt: hoursAgo(1) });
	await reap();
	assert.ok(`/sbx/${tomb}/manifest.json` in fs.files, "not deleted while pinned");
	assert.deepEqual(logged.filter(([, d]) => d.entry === tomb), [["sandbox_reaper_skipped", { entry: tomb, reason: "tombstone-pinned", restored: false }]]);
	for (const k of Object.keys(fs.files)) if (k.startsWith("/sbx/a")) delete fs.files[k];
	logged.length = 0;
	await reap();
	assert.deepEqual(logged.filter(([, d]) => d.entry === tomb), [["sandbox_reaper_skipped", { entry: tomb, reason: "tombstone-pinned", restored: true }]]);
	assert.equal(JSON.parse(fs.files["/sbx/a/manifest.json"]).keepUntil, new Date(AT + 7 * DAY).toISOString());
});

test("a pinned tombstone held by a manifest-less directory at its name is restored in the SAME pass that deletes that directory (PR #457's final check)", async () => {
	// The leftover sweep runs before the main loop, so the name was still taken when it tried; the main loop then deletes
	// the manifest-less directory (`no-manifest`), and the run used to wait a whole pass as a tombstone for the next sweep.
	const fs = sandboxDirWith({});
	fs.files["/sbx/.reap-1-2-3"] = "<dir>";
	fs.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "a", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	fs.files["/sbx/a"] = "<dir>";
	fs.files["/sbx/a/left-behind"] = "x";
	const logged = [];
	const seen = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pidAlive: () => false, log: (e, d) => logged.push([e, d]), sweepNetworks: async ({ retained }) => (seen.push(retained()), { swept: [], notes: [] }) })();
	assert.equal(JSON.parse(fs.files["/sbx/a/manifest.json"]).keepUntil, new Date(AT + DAY).toISOString(), "the pinned run is back under its name");
	assert.ok(!("/sbx/a/left-behind" in fs.files), "what held the name had no manifest, and was deleted");
	assert.deepEqual(Object.keys(fs.files).filter((k) => k.includes(".reap-")), [], "no tombstone left for a later pass");
	assert.deepEqual(
		logged.filter(([, d]) => d.entry === ".reap-1-2-3"),
		[
			["sandbox_reaper_skipped", { entry: ".reap-1-2-3", reason: "tombstone-pinned", restored: false }],
			["sandbox_reaper_skipped", { entry: ".reap-1-2-3", reason: "tombstone-pinned", restored: true }],
		],
	);
	assert.deepEqual(seen, [["a"]], "restored before the network sweep, whose fresh listing sees the run");
	// A name held by a run that is NOT deleted this pass stays held, said once, and the retry deletes nothing.
	const kept = sandboxDirWith({ a: { createdAt: hoursAgo(1) } });
	kept.files["/sbx/.reap-1-2-3"] = "<dir>";
	kept.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "a", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	const keptLog = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs: kept, now: () => AT, pidAlive: () => false, log: (e, d) => keptLog.push([e, d]) })();
	assert.ok("/sbx/.reap-1-2-3/manifest.json" in kept.files, "held, never deleted while pinned");
	assert.deepEqual(keptLog, [["sandbox_reaper_skipped", { entry: ".reap-1-2-3", reason: "tombstone-pinned", restored: false }]]);
});

test("a crash-left tombstone holding a live pin is restored under its run's escaped name, never deleted (#446, gate round 1)", async () => {
	const fs = sandboxDirWith({});
	fs.files["/sbx/.reap-1-2-3"] = "<dir>";
	fs.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: ".x", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pidAlive: () => false, log: (e, d) => logged.push([e, d]) })();
	assert.ok("/sbx/_.x/manifest.json" in fs.files);
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: ".reap-1-2-3", reason: "tombstone-pinned", restored: true }]]);
	// A tombstone whose manifest cannot be read FOR A MOMENT is held: deleting on an unknown cannot be undone.
	const flaky = sandboxDirWith({});
	flaky.files["/sbx/.reap-1-2-3"] = "<dir>";
	flaky.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "z", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	const read = flaky.readFileSync;
	flaky.readFileSync = (p) => {
		if (p.includes(".reap-")) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
		return read(p);
	};
	const heldLog = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs: flaky, now: () => AT, pidAlive: () => false, log: (e, d) => heldLog.push([e, d]) })();
	assert.ok("/sbx/.reap-1-2-3/manifest.json" in flaky.files);
	assert.deepEqual(heldLog, [["sandbox_reaper_skipped", { entry: ".reap-1-2-3", reason: "manifest-unread" }]]);
	// A LAPSED pin is an ordinary leftover.
	const lapsed = sandboxDirWith({});
	lapsed.files["/sbx/.reap-1-2-3"] = "<dir>";
	lapsed.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "y", createdAt: hoursAgo(50), keepUntil: hoursAgo(1) });
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs: lapsed, now: () => AT })();
	assert.deepEqual(Object.keys(lapsed.files), ["/sbx"]);
});

test("each expired run's own runtime is asked AGAIN right before the rename, and an open or unanswered one is held (#446, gate round 1)", async () => {
	for (const [isOpen, reason] of [
		[async () => true, "opened-during-pass"],
		[async () => {
			throw new Error("daemon down");
		}, "runtime-unanswered"],
	]) {
		const fs = sandboxDirWith({ a: { createdAt: hoursAgo(50) } });
		const logged = [];
		const asked = [];
		await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, isOpen: (arg) => (asked.push(arg.name), isOpen(arg)), log: (e, d) => logged.push([e, d]) })();
		assert.deepEqual(asked, ["a"]);
		assert.deepEqual(swept(fs), [], reason);
		assert.deepEqual(logged, [["sandbox_reaper_skipped", { entry: "a", reason }]]);
	}
});

test("a pin racing the delete reports the run gone, never pinned (#446)", async () => {
	// The window #446 was opened for: a recursive delete of a large clone takes seconds, and a pin landing before it
	// reached manifest.json reported `pinned: true` over a directory that was then gone.
	const fs = sandboxDirWith({ a: { createdAt: hoursAgo(50) } });
	const rm = fs.rmSync;
	let during = null;
	fs.rmSync = (p, o) => {
		during = pinSandbox({ sandboxDir: "/sbx", jobId: "a", pinDays: 7, fs, now: () => AT });
		rm(p, o);
	};
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT })();
	assert.deepEqual(during, { pinned: false, reason: "absent" });
	assert.deepEqual(swept(fs), ["/sbx/a"]);
});

test("tombstones a crash left are removed at the start of every pass, never placed or asked about, their manifest read only for a live pin (#446)", async () => {
	const fs = sandboxDirWith({ live: { createdAt: hoursAgo(1) } });
	fs.files["/sbx/.reap-1-2-3"] = "<dir>";
	fs.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "dead", createdAt: hoursAgo(1) });
	fs.files["/sbx/.reap-1-2-3/workspace/big"] = "x";
	const read = fs.readFileSync;
	const reads = [];
	fs.readFileSync = (p) => (reads.push(p), read(p));
	const listed = [];
	const logged = [];
	await makeSandboxReaper({
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		listRunning: async ({ names }) => (listed.push(...names), []),
		sweepNetworks: async (arg) => {
			for (const name of arg.retained()) arg.keep.add(name);
			listed.push(`keep:${[...arg.keep].join(",")}`);
			return { swept: [], notes: [] };
		},
		log: (e, d) => logged.push([e, d]),
	})();
	assert.deepEqual(logged, [["reaped_sandbox", { entry: ".reap-1-2-3", reason: "tombstone" }]]);
	assert.deepEqual(listed, ["live", "keep:live"], "the runtimes and the network sweep see only runs");
	assert.deepEqual(reads.filter((p) => p.includes(".reap-")), ["/sbx/.reap-1-2-3/manifest.json"], "read once, for a pin, and never as a run");
	assert.deepEqual(Object.keys(fs.files).sort(), ["/sbx", "/sbx/live", "/sbx/live/manifest.json"]);
});

test("tombstones are invisible to listSandboxes, and no job id can name one (#446)", () => {
	const fs = sandboxDirWith({ "gh-1": { createdAt: "2026-08-01T00:00:00Z" } });
	fs.files["/sbx/.reap-1-2-3"] = "<dir>";
	fs.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: ".reap-1-2-3", createdAt: "2026-08-02T00:00:00Z" });
	assert.deepEqual(listSandboxes({ sandboxDir: "/sbx", fs }).map((r) => r.jobId), ["gh-1"]);
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: ".reap-1-2-3", fs }), null, "an operator typing a tombstone's name reads nothing");
});

test("an id whose sanitized form starts with a dot or an underscore is escaped with one more `_`, the pinned rule (#446)", async () => {
	assert.deepEqual(
		[".reap-9", ".", "..", ".hidden", "_x", ".x", "__", "gh-1", "repeat:a:1", "a.b"].map(sandboxEntryName),
		["_.reap-9", "_.", "_..", "_.hidden", "__x", "_.x", "___", "gh-1", "repeat_a_1", "a.b"],
		"an ESCAPE: `.x` and `_x` never share a directory (gate round 1)",
	);
	const at = Date.parse("2026-08-01T10:00:00Z");
	const fs = fakeFs({ files: { "/jobs/job-xyz": "<dir>", "/sbx": "<dir>" } });
	retainJobDir(prepared({ sandbox: { jobId: ".reap-9", kind: "github", image: "pi-job:latest", backend: "local" } }), { sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at });
	assert.deepEqual(fs.calls.renamed, [["/jobs/job-xyz", "/sbx/_.reap-9"]], "never under the reserved prefix");
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: ".reap-9", fs })?.jobId, ".reap-9", "and read back by the same rule");
	// The sweep treats it as the run it is, not as a leftover tombstone.
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at + HOUR, log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(logged, []);
	assert.ok("/sbx/_.reap-9/manifest.json" in fs.files);
	// And `_x` beside `.x`: two directories, two runs.
	const two = fakeFs({ files: { "/j/a": "<dir>", "/j/b": "<dir>", "/sbx": "<dir>" } });
	retainJobDir(prepared({ jobDir: "/j/a", sandbox: { jobId: "_x", kind: "github", image: "i", backend: "local" } }), { sandboxDir: "/sbx", retentionHours: 24, fs: two, now: () => at });
	retainJobDir(prepared({ jobDir: "/j/b", sandbox: { jobId: ".x", kind: "github", image: "i", backend: "local" } }), { sandboxDir: "/sbx", retentionHours: 24, fs: two, now: () => at });
	assert.deepEqual([readManifest({ sandboxDir: "/sbx", jobId: "_x", fs: two })?.jobId, readManifest({ sandboxDir: "/sbx", jobId: ".x", fs: two })?.jobId], ["_x", ".x"]);
});

// --- issue #446, gate round 2 --------------------------------------------------------------------------------------

test("a foreign tombstone stamped in the FUTURE is not young, and a young one's skip is said once a period (#446)", async () => {
	const fs = sandboxDirWith({});
	const ahead = `.reap-900-${AT + HOUR}-0`;
	const young = `.reap-900-${AT - 60_000}-1`;
	fs.files[`/sbx/${ahead}`] = "<dir>";
	fs.files[`/sbx/${young}`] = "<dir>";
	const logged = [];
	let at = AT;
	const reap = makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, pid: 77, pidAlive: () => true, log: (e, d) => logged.push([e, d]) });
	await reap();
	assert.ok(!(`/sbx/${ahead}` in fs.files), "a clock that ran ahead does not hold a tombstone forever");
	assert.ok(`/sbx/${young}` in fs.files);
	at = AT + 1000;
	await reap();
	assert.deepEqual(logged.filter(([, d]) => d.reason === "tombstone-foreign"), [["sandbox_reaper_skipped", { entry: young, reason: "tombstone-foreign" }]], "said once, not every pass");
});

test("a run retained BEFORE the escape is still read under its old name, and only as its own id (#446)", () => {
	const fs = sandboxDirWith({ _x: { createdAt: "2026-08-01T00:00:00Z" }, _y: { createdAt: "2026-08-01T00:00:00Z" } });
	fs.files["/sbx/_y/manifest.json"] = JSON.stringify({ jobId: "other", createdAt: "2026-08-01T00:00:00Z" });
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "_x", fs })?.dir, "/sbx/_x");
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "_y", fs }), null, "a directory holding another run is never handed over");
	fs.files["/sbx/__x"] = "<dir>";
	fs.files["/sbx/__x/manifest.json"] = JSON.stringify({ jobId: "_x", createdAt: "2026-08-02T00:00:00Z" });
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "_x", fs })?.dir, "/sbx/__x", "the escaped name wins when both exist");
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "..", fs }), null, "never a dot name");
});

test("a pinned tombstone goes back under the directory its manifest's paths name, so a pre-escape run keeps working paths (#446)", async () => {
	const fs = sandboxDirWith({});
	fs.files["/sbx/.reap-1-2-3"] = "<dir>";
	fs.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "_x", workspace: "/sbx/_x/workspace", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pidAlive: () => false })();
	assert.ok("/sbx/_x/manifest.json" in fs.files, "under `_x`, where its workspace path points");
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "_x", fs })?.workspace, "/sbx/_x/workspace");
});

// --- issue #446, gate round 3 --------------------------------------------------------------------------------------

test("a pinned tombstone is restored only under a name its OWN jobId maps to; a crafted workspace path never chooses another run's (#446)", async () => {
	const fs = sandboxDirWith({});
	fs.files["/sbx/.reap-1-2-3"] = "<dir>";
	fs.files["/sbx/.reap-1-2-3/manifest.json"] = JSON.stringify({ jobId: "a", workspace: "/sbx/victim/workspace", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	fs.files["/sbx/.reap-1-2-4"] = "<dir>";
	fs.files["/sbx/.reap-1-2-4/manifest.json"] = JSON.stringify({ workspace: "/sbx/other/workspace", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => AT, pidAlive: () => false, log: (e, d) => logged.push([e, d]) })();
	assert.ok("/sbx/a/manifest.json" in fs.files, "under its own id's name");
	assert.ok(!Object.keys(fs.files).some((k) => k.startsWith("/sbx/victim") || k.startsWith("/sbx/other")), "never under a name its workspace path picked");
	assert.ok("/sbx/.reap-1-2-4/manifest.json" in fs.files, "no usable jobId: held, never restored to a derived name");
	assert.deepEqual(logged.find(([, d]) => d.entry === ".reap-1-2-4"), ["sandbox_reaper_skipped", { entry: ".reap-1-2-4", reason: "tombstone-pinned", restored: false }]);
	// An id with a pre-escape name: the path may only choose between `__b` and `_b`, never `victim`.
	const esc = sandboxDirWith({});
	esc.files["/sbx/.reap-1-2-5"] = "<dir>";
	esc.files["/sbx/.reap-1-2-5/manifest.json"] = JSON.stringify({ jobId: "_b", workspace: "/sbx/victim/workspace", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs: esc, now: () => AT, pidAlive: () => false })();
	assert.ok("/sbx/__b/manifest.json" in esc.files);
	assert.ok(!Object.keys(esc.files).some((k) => k.startsWith("/sbx/victim")));
});

test("the pre-escape name is also tried when the escaped name holds ANOTHER id's run (#446)", () => {
	const fs = sandboxDirWith({ __x: { createdAt: "2026-08-01T00:00:00Z" }, _x: { createdAt: "2026-08-01T00:00:00Z" } });
	fs.files["/sbx/__x/manifest.json"] = JSON.stringify({ jobId: "__x", createdAt: "2026-08-01T00:00:00Z" });
	fs.files["/sbx/_x/manifest.json"] = JSON.stringify({ jobId: "_x", createdAt: "2026-08-01T00:00:00Z" });
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "_x", fs })?.dir, "/sbx/_x");
	// No pre-escape match: the escaped read stands, for `resolveSandbox` to refuse by name.
	delete fs.files["/sbx/_x/manifest.json"];
	assert.equal(readManifest({ sandboxDir: "/sbx", jobId: "_x", fs })?.jobId, "__x");
});

// ── issue #978: bounded, paced passes ───────────────────────────────────────────────────────────────

/**
 * A fake pass clock and the sleep that moves it, both recording into `events` in order: `isOpen:<name>`, `rename:<name>`,
 * `remove:<name>` (the run's own name, through its tombstone) and one `sleep:<ms>` per slice. Nothing here waits on the
 * wall clock, and the run's dates come from `now: () => AT` as everywhere in this file.
 */
function paced(entries, { askMs = () => 0, removeMs = () => 0, open = () => false } = {}) {
	const fs = sandboxDirWith(entries);
	const events = [];
	const logs = [];
	let t = 0;
	const origin = (p) => new Map(fs.calls.renamed.map(([from, to]) => [to, from])).get(p) ?? p;
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		events.push(`rename:${from.slice("/sbx/".length)}`);
		rename(from, to);
	};
	const options = {
		sandboxDir: "/sbx",
		retentionHours: 24,
		fs,
		now: () => AT,
		clock: () => t,
		sleep: async (ms) => {
			events.push(`sleep:${ms}`);
			t += ms;
		},
		isOpen: async ({ name }) => {
			events.push(`isOpen:${name}`);
			t += askMs(name);
			return open(name);
		},
		remove: async (path, opts) => {
			const name = origin(path).slice("/sbx/".length);
			events.push(`remove:${name}`);
			t += removeMs(name);
			fs.rmSync(path, opts);
		},
		log: (event, fields) => logs.push([event, fields]),
	};
	return { fs, events, logs, options, advance: (ms) => (t += ms) };
}

/** Each rest a pass took, in order: the sum of each run of consecutive sleep slices. */
function restsOf(events) {
	const rests = [];
	let open = false;
	for (const e of events) {
		if (!e.startsWith("sleep:")) {
			open = false;
			continue;
		}
		if (!open) rests.push(0);
		rests[rests.length - 1] += Number(e.slice("sleep:".length));
		open = true;
	}
	return rests;
}

const expiredRuns = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${String(i).padStart(3, "0")}`, { createdAt: hoursAgo(50) }]));

test("the pass constants are pinned by literal (issue #978)", () => {
	assert.equal(SANDBOX_PASS_BUDGET_MS, 20_000);
	assert.equal(SANDBOX_PASS_MAX_REAPS, 50);
	assert.equal(SANDBOX_REST_MIN_MS, 100);
	assert.equal(SANDBOX_REST_MAX_MS, 10_000);
	assert.equal(SANDBOX_REST_POLL_MS, 250);
});

test("a pass stops at SANDBOX_PASS_MAX_REAPS removals, says more, skips the networks, and the next pass finishes them (issue #978)", async () => {
	const p = paced(expiredRuns(60));
	let networks = 0;
	const reap = realMakeSandboxReaper({ ...p.options, sweepNetworks: async () => (networks++, { swept: [], notes: [] }) });
	const first = await reap();
	assert.equal(first.reaped, 50);
	assert.equal(first.more, true, "work was left, so a follow-up is asked for");
	assert.equal(p.events.filter((e) => e.startsWith("isOpen:")).length, 50, "the 51st run is not even asked about");
	assert.equal(networks, 0, "a partial pass leaves the networks to the pass that finishes the directories");
	assert.equal(Object.keys(p.fs.files).filter((k) => /^\/sbx\/r\d+$/.test(k)).length, 10);
	const second = await reap();
	assert.deepEqual([second.reaped, second.more, networks], [10, false, 1], "the second pass finishes them, networks included");
	const passes = p.logs.filter(([e]) => e === "sandbox_reaper_pass").map(([, f]) => f);
	assert.deepEqual(passes.map(({ more, reaped, held }) => ({ more, reaped, held })), [{ more: true, reaped: 50, held: 0 }, { more: false, reaped: 10, held: 0 }], "one summary line per pass");
	assert.deepEqual(Object.keys(passes[0]).sort(), ["held", "more", "ms", "reaped", "restedMs", "slowestCheckMs"]);
	// A pass with nothing to do says nothing at all.
	p.logs.length = 0;
	assert.deepEqual(await reap(), { more: false, reaped: 0, held: 0, ms: 0, restedMs: 0, slowestCheckMs: 0 });
	assert.deepEqual(p.logs, [], "a quiet pass on a tidy host logs no line");
});

test("a pass stops at SANDBOX_PASS_BUDGET_MS of its own clock, rests included, and reports where the time went (issue #978)", async () => {
	// Each runtime ask takes 3 s, so each run costs 6 s with its rest: runs start at 0, 6, 12 and 18 s, and at 24 s the
	// budget is spent at the next run's boundary.
	const p = paced(expiredRuns(10), { askMs: () => 3000 });
	const out = await realMakeSandboxReaper(p.options)();
	assert.deepEqual(out, { more: true, reaped: 4, held: 0, ms: 24_000, restedMs: 12_000, slowestCheckMs: 3000 });
	assert.equal(p.events.filter((e) => e.startsWith("isOpen:")).length, 4);
});

test("a pass the budget stops in the leftover tombstones returns at once, before any run is read or asked about (issue #978)", async () => {
	const entries = expiredRuns(1);
	const p = paced(entries);
	for (let i = 0; i < 60; i++) {
		p.fs.files[`/sbx/.reap-4242-1-${i}`] = "<dir>";
		p.fs.files[`/sbx/.reap-4242-1-${i}/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: `t${i}`, createdAt: hoursAgo(50) });
	}
	let listed = 0;
	const out = await realMakeSandboxReaper({ ...p.options, pid: 4242, listRunning: async () => (listed++, []) })();
	assert.deepEqual([out.reaped, out.more], [50, true]);
	assert.equal(Object.keys(p.fs.files).filter((k) => /^\/sbx\/\.reap-[^/]+$/.test(k)).length, 10, "ten tombstones are the next pass's");
	assert.equal(listed, 0, "no runtime was asked which sandboxes are open");
	assert.ok(!p.events.some((e) => e.startsWith("isOpen:")), "and no run was asked about");
	assert.ok("/sbx/r000" in p.fs.files, "the expired run waits for the next pass");
});

test("each entry that asked a runtime rests as long as it took, never under the floor nor over the cap, in stop-aware slices (issue #978)", async () => {
	const took = { a: 0, b: 2000, c: 30_000 };
	const p = paced({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) }, c: { createdAt: hoursAgo(50) } }, { askMs: (name) => took[name] });
	const out = await realMakeSandboxReaper(p.options)();
	assert.equal(out.reaped, 3);
	assert.deepEqual(restsOf(p.events), [SANDBOX_REST_MIN_MS, 2000, SANDBOX_REST_MAX_MS], "the floor, the entry's own time, the cap");
	assert.ok(p.events.filter((e) => e.startsWith("sleep:")).every((e) => Number(e.slice(6)) <= SANDBOX_REST_POLL_MS), "no slice is longer than the stop poll");
	// A HELD run asked the runtime too, and rests like any other; a run inside its window asks nothing and does not.
	const held = paced({ a: { createdAt: hoursAgo(50) }, young: { createdAt: hoursAgo(1) } }, { askMs: () => 700, open: () => true });
	const heldOut = await realMakeSandboxReaper(held.options)();
	assert.deepEqual(restsOf(held.events), [700]);
	assert.deepEqual([heldOut.reaped, heldOut.held], [0, 1]);
	// A leftover tombstone's removal rests the same way, for as long as it took.
	const tomb = paced({}, { removeMs: () => 2000 });
	tomb.fs.files["/sbx/.reap-4242-1-0"] = "<dir>";
	await realMakeSandboxReaper({ ...tomb.options, pid: 4242 })();
	assert.deepEqual(restsOf(tomb.events), [2000], "a tombstone's removal is rested after, not merely yielded");
});

test("nothing rests and no budget is asked between a run's runtime ask and its delete, and a budget spent inside lets the delete finish (issue #978)", async () => {
	// The budget is spent DURING the ask: the run is still renamed and deleted, then rests, and the next run is never asked.
	const during = paced({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) } }, { askMs: (name) => (name === "a" ? 25_000 : 0) });
	const asked = await realMakeSandboxReaper(during.options)();
	assert.deepEqual(during.events.filter((e) => !e.startsWith("sleep:")), ["isOpen:a", "rename:a", "remove:a"]);
	assert.equal(during.events.indexOf("sleep:250"), 3, "the first rest slice comes after the delete, never before it");
	assert.deepEqual(restsOf(during.events), [SANDBOX_REST_MAX_MS]);
	assert.deepEqual([asked.reaped, asked.more], [1, true]);
	assert.deepEqual(swept(during.fs), ["/sbx/a"]);
	// The budget is spent DURING the delete: it finishes and is said, and the next run waits.
	const removing = paced({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) } }, { removeMs: (name) => (name === "a" ? 25_000 : 0) });
	const out = await realMakeSandboxReaper(removing.options)();
	assert.deepEqual(removing.events.filter((e) => !e.startsWith("sleep:")), ["isOpen:a", "rename:a", "remove:a"]);
	assert.ok(removing.logs.some(([e, f]) => e === "reaped_sandbox" && f.entry === "a"), "the delete that outlived the budget is said like any other");
	assert.deepEqual([out.reaped, out.more], [1, true]);
	assert.ok("/sbx/b" in removing.fs.files);
});

test("more is false once the lap is over, held runs left or not, so follow-ups do not repeat on them (issue #978)", async () => {
	const p = paced({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) }, c: { createdAt: hoursAgo(50) } }, { open: () => true });
	let networks = 0;
	const out = await realMakeSandboxReaper({ ...p.options, sweepNetworks: async () => (networks++, { swept: [], notes: [] }) })();
	assert.deepEqual([out.more, out.reaped, out.held], [false, 0, 3]);
	assert.equal(networks, 1, "a pass that visited everything sweeps the networks");
	assert.ok(p.logs.some(([e, f]) => e === "sandbox_reaper_pass" && f.held === 3 && f.more === false), "the holds are in the summary");
});

test("the network sweep is paced by the same budget, and the networks it left are the pass's more (issue #978)", async () => {
	const p = paced({});
	const visited = [];
	const sweepNetworks = async ({ pace }) => {
		for (const name of ["n1", "n2", "n3"]) {
			visited.push(name);
			p.events.push(`network:${name}`);
			p.advance(9000);
			if (!(await pace())) return { swept: [], notes: [], more: true };
		}
		return { swept: [], notes: [] };
	};
	const out = await realMakeSandboxReaper({ ...p.options, sweepNetworks })();
	// n1 takes 9 s and rests 9 s (18 s, under the budget); n2 brings it to 36 s, and the pace says stop.
	assert.deepEqual(visited, ["n1", "n2"]);
	assert.deepEqual(restsOf(p.events), [9000, 9000]);
	assert.equal(out.more, true);
});

test("one pass at a time: a call during a pass answers busy and touches nothing, so this pid's in-flight tombstone is left alone (issue #978)", async () => {
	const p = paced({ a: { createdAt: hoursAgo(50) } });
	let entered;
	const inRemove = new Promise((resolve) => (entered = resolve));
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const removed = [];
	const readdir = p.fs.readdirSync;
	let listings = 0;
	p.fs.readdirSync = (path) => (listings++, readdir(path));
	const reap = realMakeSandboxReaper({
		...p.options,
		pid: 4242,
		remove: async (path, opts) => {
			removed.push(path);
			entered(path);
			await gate;
			p.fs.rmSync(path, opts);
		},
	});
	const first = reap();
	const tomb = await inRemove;
	assert.match(tomb, /^\/sbx\/\.reap-4242-/);
	const before = listings;
	let second = "still running";
	try {
		reap().then((result) => (second = result));
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(second, { busy: true }, "answered at once, while the first pass is still deleting");
		assert.equal(listings, before, "the second call did not even list the root");
		assert.deepEqual(removed, [tomb], "and never took the first pass's tombstone for a leftover");
	} finally {
		release();
	}
	assert.equal((await first).reaped, 1);
	assert.equal((await reap()).busy, undefined, "once the pass is over, the next call runs");
});

test("a pass told to stop during a rest wakes within one slice and leaves the rest alone (issue #978)", async () => {
	let stop = false;
	const p = paced({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) } }, { askMs: (name) => (name === "a" ? 30_000 : 0) });
	const sleep = p.options.sleep;
	const out = await realMakeSandboxReaper({
		...p.options,
		sleep: async (ms) => {
			await sleep(ms);
			stop = true;
		},
	})({ stopped: () => stop });
	assert.deepEqual(restsOf(p.events), [SANDBOX_REST_POLL_MS], "one slice of a ten-second rest");
	assert.deepEqual(p.events.filter((e) => e.startsWith("isOpen:")), ["isOpen:a"]);
	assert.equal(out.stopped, true);
	assert.equal(out.more, false, "a pass stopped for a shutdown never asks for a follow-up");
	assert.ok("/sbx/b" in p.fs.files);
});

/**
 * Drive one reaper as start.mjs does: a first pass, then the REAL follow-ups on a timer this fires, until none is armed
 * (or `max` passes, the guard against a chain that never ends). Resolves every pass's result and what is still armed.
 */
async function chain(reap, { max = 40 } = {}) {
	const armed = [];
	const results = [];
	const followUps = makeSweepFollowUps({
		reap: async (options) => {
			const result = await reap(options);
			results.push(result);
			return result;
		},
		setTimeoutFn: (fn) => (armed.push(fn), { unref() {} }),
		clearTimeoutFn: () => {},
	});
	const first = await reap();
	results.push(first);
	followUps.after(first);
	while (armed.length > 0 && results.length < max) {
		const passes = results.length;
		armed.shift()();
		while (results.length === passes) await new Promise((resolve) => setImmediate(resolve));
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	}
	await followUps.close();
	return { results, armed };
}

const runsLeft = (fs, prefix) => Object.keys(fs.files).filter((k) => new RegExp(`^/sbx/${prefix}[^/]*$`).test(k));

test("a removal that FAILS does not count toward SANDBOX_PASS_MAX_REAPS: 55 undeletable tombstones and runs still go in one pass (issue #978)", async () => {
	// The #363 shape, root-owned files a non-root worker cannot delete: every pass retries them. Counted toward the cap,
	// fifty of them ended every pass before a single run, and the follow-ups re-armed forever.
	const p = paced(expiredRuns(10));
	for (let i = 0; i < 55; i++) p.fs.files[`/sbx/.reap-4242-1-${String(i).padStart(2, "0")}`] = "<dir>";
	const remove = p.options.remove;
	const reap = realMakeSandboxReaper({
		...p.options,
		pid: 4242,
		remove: async (path, opts) => {
			if (path.startsWith("/sbx/.reap-4242-1-")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			return remove(path, opts);
		},
	});
	const { results, armed } = await chain(reap);
	assert.equal(results.length, 1, "one pass, as before the passes were bounded");
	assert.deepEqual([results[0].reaped, results[0].held, results[0].more], [10, 55, false]);
	assert.deepEqual(runsLeft(p.fs, "r"), [], "every run is gone");
	assert.equal(armed.length, 0, "and no follow-up is armed");
	// The same for runs whose own tombstone will not delete: they do not use up the cap either.
	const q = paced(expiredRuns(65));
	const qRemove = q.options.remove;
	const stuckRuns = realMakeSandboxReaper({ ...q.options, remove: async (path, opts) => (Number(q.fs.calls.renamed.find(([, to]) => to === path)?.[0].slice(6)) < 55 ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) : qRemove(path, opts)) });
	const out = await stuckRuns();
	assert.deepEqual([out.reaped, out.held, out.more], [10, 55, false], "ten removed, fifty-five held, the lap over in one pass");
});

test("undeletable tombstones that take the whole budget are passed once a lap, and the runs after them are still reached (issue #978)", async () => {
	// Each failing walk takes 2 s and rests 2 s, so a pass gets through five: the lap carries the place from pass to pass.
	const p = paced(expiredRuns(10));
	for (let i = 0; i < 55; i++) p.fs.files[`/sbx/.reap-4242-1-${String(i).padStart(2, "0")}`] = "<dir>";
	const tried = new Map();
	const reap = realMakeSandboxReaper({
		...p.options,
		pid: 4242,
		remove: async (path, opts) => {
			if (!path.startsWith("/sbx/.reap-4242-1-")) return p.options.remove(path, opts);
			tried.set(path, (tried.get(path) ?? 0) + 1);
			p.advance(2000);
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		},
	});
	const { results, armed } = await chain(reap);
	assert.deepEqual(runsLeft(p.fs, "r"), [], "every run is gone");
	assert.equal(results.at(-1).more, false, "the lap ended");
	assert.equal(armed.length, 0, "and the follow-ups with it");
	assert.ok(results.length <= 12, `55 tombstones at five a pass, then the runs: ${results.length} passes`);
	assert.deepEqual([...new Set(tried.values())], [1], "each undeletable tombstone tried exactly once in the lap");
});

test("runs HELD at the top of the listing cannot starve the expired runs after them, and the follow-ups stop after one lap (issue #978)", async () => {
	// Ten runs whose runtime reports them open sort first, fifteen expired after them, every ask 1.5 s.
	const entries = {};
	for (let i = 0; i < 10; i++) entries[`a-held-${i}`] = { createdAt: hoursAgo(50) };
	for (let i = 0; i < 15; i++) entries[`b-run-${String(i).padStart(2, "0")}`] = { createdAt: hoursAgo(50) };
	const p = paced(entries, { askMs: () => 1500, open: (name) => name.startsWith("a-held-") });
	const reap = realMakeSandboxReaper(p.options);
	const { results, armed } = await chain(reap);
	assert.deepEqual(runsLeft(p.fs, "b-run-"), [], "every expired run is reaped");
	assert.equal(runsLeft(p.fs, "a-held-").length, 10, "and every held one kept");
	assert.equal(results.at(-1).more, false);
	assert.equal(armed.length, 0, "the chain ended with the lap");
	const asks = p.events.filter((e) => e.startsWith("isOpen:a-held-"));
	assert.equal(asks.length, 10, "each held run asked once in the lap, never again in the same chain");
	// A later sweep is a new lap: it starts from the top and asks the held runs again.
	p.events.length = 0;
	await reap();
	assert.equal(p.events.find((e) => e.startsWith("isOpen:")), "isOpen:a-held-0");
});

test("every pass visits at least one entry, so a runtime listing that takes the whole budget cannot stall the lap (issue #978)", async () => {
	const p = paced(expiredRuns(3));
	const { results, armed } = await chain(realMakeSandboxReaper({ ...p.options, listRunning: async () => (p.advance(25_000), []) }));
	assert.deepEqual(results.map((r) => [r.reaped, r.more]), [[1, true], [1, true], [1, false]], "one run a pass, and the lap ends");
	assert.equal(armed.length, 0);
});

test("the budget is asked before a stray entry's unlink too, and the next pass resumes at it (issue #978)", async () => {
	const p = paced({ a: { createdAt: hoursAgo(50) } }, { askMs: () => 25_000 });
	p.fs.files["/sbx/b-stray"] = "a file, not a run";
	const reap = realMakeSandboxReaper(p.options);
	const first = await reap();
	assert.deepEqual([first.reaped, first.more], [1, true]);
	assert.ok("/sbx/b-stray" in p.fs.files, "the budget spent on a, the stray entry waits");
	const second = await reap();
	assert.deepEqual([second.reaped, second.more], [1, false]);
	assert.ok(!("/sbx/b-stray" in p.fs.files));
});

test("a pass that resumes in the networks does not visit the runs again, and the pass after the lap starts over (issue #978)", async () => {
	const p = paced({ a: { createdAt: hoursAgo(50) } }, { open: () => true });
	p.fs.files["/sbx/.reap-4242-1-0"] = "<dir>";
	let tombTries = 0;
	let sweeps = 0;
	const lapIds = [];
	const reap = realMakeSandboxReaper({
		...p.options,
		pid: 4242,
		remove: async () => {
			tombTries += 1;
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		},
		listRunning: async () => ["open-shell"],
		sweepNetworks: async ({ pace, lapId }) => {
			lapIds.push(lapId);
			sweeps += 1;
			if (sweeps > 1) return { swept: [], notes: [] };
			await pace();
			return { swept: [], notes: [], more: true };
		},
	});
	p.fs.files["/sbx/open-shell"] = "<dir>";
	p.fs.files[`/sbx/open-shell/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "open-shell", createdAt: hoursAgo(50) });
	const first = await reap();
	assert.deepEqual([first.more, first.held], [true, 3], "the tombstone, a held by its runtime, and open-shell because a sandbox runs on it");
	const second = await reap();
	assert.deepEqual([second.more, sweeps], [false, 2]);
	assert.equal(p.events.filter((e) => e === "isOpen:a").length, 1, "the resumed pass went straight to the networks");
	assert.equal(tombTries, 1, "past the tombstones too");
	await reap();
	assert.equal(p.events.filter((e) => e === "isOpen:a").length, 2, "and the next lap asks again");
	assert.equal(tombTries, 2);
	assert.equal(lapIds[0], lapIds[1], "the resumed network pass is in the same lap, so each runtime keeps its place");
	assert.notEqual(lapIds[2], lapIds[1], "and the next lap is told it is a new one");
});

test("a pass that resumes in the runs does not walk the leftover tombstones again: they are once a lap (issue #978)", async () => {
	const p = paced(expiredRuns(60));
	p.fs.files["/sbx/.reap-4242-1-0"] = "<dir>";
	let tried = 0;
	const remove = p.options.remove;
	const reap = realMakeSandboxReaper({
		...p.options,
		pid: 4242,
		remove: async (path, opts) => {
			if (path !== "/sbx/.reap-4242-1-0") return remove(path, opts);
			tried += 1;
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		},
	});
	const { results } = await chain(reap);
	assert.deepEqual(results.map((r) => [r.reaped, r.more]), [[50, true], [10, false]]);
	assert.equal(tried, 1, "the second pass went on in the runs, past the tombstone this lap already tried");
});

test("a pass a fault ends mid-lap starts the next sweep on a new lap, so what appeared meanwhile is not left for another (issue #978)", async () => {
	const p = paced(expiredRuns(60));
	let fail = false;
	const reap = realMakeSandboxReaper({ ...p.options, pid: 4242, listRunning: async () => { if (fail) throw new Error("runtime did not answer"); return []; } });
	assert.deepEqual([(await reap()).more, runsLeft(p.fs, "r").length], [true, 10], "the lap stopped at r050");
	fail = true;
	assert.equal((await reap()).more, false, "the fault ends the pass");
	fail = false;
	// Meanwhile a crashed process leaves a tombstone, and a run sorting before the old place expires.
	p.fs.files["/sbx/.reap-4242-1-0"] = "<dir>";
	p.fs.files["/sbx/a-late"] = "<dir>";
	p.fs.files[`/sbx/a-late/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "a-late", createdAt: hoursAgo(50) });
	const next = await reap();
	assert.deepEqual([next.reaped, next.more], [12, false], "a new lap: the tombstone first, a-late, and the ten left");
	assert.deepEqual(Object.keys(p.fs.files), ["/sbx"]);
});

test("the lap follows NAME order whatever order the filesystem lists in (issue #978)", async () => {
	const p = paced(expiredRuns(60));
	const readdir = p.fs.readdirSync;
	p.fs.readdirSync = (path) => readdir(path).reverse();
	const reap = realMakeSandboxReaper(p.options);
	assert.deepEqual(swept(p.fs).length, 0);
	const first = await reap();
	assert.deepEqual([first.reaped, first.more], [50, true]);
	assert.deepEqual(swept(p.fs).slice(0, 2), ["/sbx/r000", "/sbx/r001"], "the first pass starts at the first name");
	const second = await reap();
	assert.deepEqual([second.reaped, second.more], [10, false], "and the second resumes at the right place, missing none");
	assert.deepEqual(runsLeft(p.fs, "r"), []);
});

test("the default rest holds the event loop, so a boot pass with nothing else running finishes (issue #978)", () => {
	// The boot pass runs before anything else holds the loop. An unref'd rest there lets the process exit mid-pass.
	const root = tempDir("sbx-alone-");
	for (const id of ["a", "b"]) {
		mkdirSync(join(root, id));
		writeFileSync(join(root, id, SANDBOX_MANIFEST), JSON.stringify({ jobId: id, createdAt: new Date(Date.now() - 3 * DAY).toISOString() }));
	}
	const script = `const { makeSandboxReaper } = await import(${JSON.stringify(new URL("../src/sandbox-store.mjs", import.meta.url).href)}); process.stdout.write(JSON.stringify(await makeSandboxReaper({ sandboxDir: process.argv[1], retentionHours: 1 })()));`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
	assert.equal(child.status, 0, `the process ran the pass to its end (stderr: ${child.stderr})`);
	assert.equal(JSON.parse(child.stdout).reaped, 2);
});

// ── issue #1023: beside jobs ────────────────────────────────────────────────────────────────────────

/**
 * `paced` with the worker's count of its job containers handed to the reaper, as a pair of functions of the pass's own
 * clock (`t`, in ms) so a test says when a container is starting or running, and with the pass's first runtime call
 * (`listRunning`) recorded as `list` among the events.
 */
function besideJobs(entries, { starting = () => 0, running = () => 0, ...over } = {}) {
	const p = paced(entries, over);
	const at = () => p.options.clock();
	const activity = { starting: () => starting(at()), running: () => running(at()) };
	// A pass that waits without end fails here, at once, where it would otherwise hold the whole file.
	const sleep = async (ms) => {
		if (at() > 3_600_000) throw new Error("the pass has slept for more than an hour of its own clock");
		return p.options.sleep(ms);
	};
	const options = { ...p.options, sleep, activity, listRunning: async () => (p.events.push("list"), []) };
	return { ...p, options, passLines: () => p.logs.filter(([e]) => e === "sandbox_reaper_pass").map(([, f]) => f) };
}
const sleeps = (events) => events.filter((e) => e.startsWith("sleep:")).map((e) => Number(e.slice("sleep:".length)));

test("the bounds beside jobs are pinned by literal (issue #1023)", () => {
	// By literal: a test derived from a constant would follow it to any value.
	assert.equal(SANDBOX_START_WAIT_MAX_MS, 20_000);
	assert.equal(SANDBOX_PASS_MAX_REAPS_BUSY, 5);
	assert.equal(SANDBOX_REST_MIN_BUSY_MS, 1_000);
});

test("a pass waits while a job container is starting, before it asks a runtime anything, and says how long (issue #1023)", async () => {
	// A container is starting for the pass's first 3 s; nothing runs after it.
	const p = besideJobs({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) } }, { starting: (t) => (t < 3000 ? 1 : 0) });
	const out = await realMakeSandboxReaper(p.options)();
	assert.deepEqual(p.events.slice(0, 13), [...Array(12).fill("sleep:250"), "list"], "twelve slices of the stop poll, and only then the first runtime call");
	assert.deepEqual(p.events.slice(13).filter((e) => !e.startsWith("sleep:")), ["isOpen:a", "rename:a", "remove:a", "isOpen:b", "rename:b", "remove:b"]);
	assert.deepEqual(out, { more: false, reaped: 2, held: 0, ms: 3200, restedMs: 200, slowestCheckMs: 0, waitedForStartsMs: 3000 });
	assert.deepEqual(p.passLines(), [{ ...out, busy: true }], "the line says the wait, and that the pass ran beside a job");
	assert.equal(Object.hasOwn(out, "busy"), false, "the result does not: there `busy` is a call that met a pass in flight");
});

test("a start that begins in the middle of a pass is waited for after the entry's rest, before the next entry (issue #1023)", async () => {
	// The first run's removal takes 2 s; a container starts while it runs and is up 1.5 s after the rest began.
	const p = besideJobs({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) } }, { removeMs: (name) => (name === "a" ? 2000 : 0), starting: (t) => (t >= 1000 && t < 5500 ? 1 : 0) });
	const out = await realMakeSandboxReaper(p.options)();
	// a: 2 s, its rest 2 s (to 4 s, the busy floor is under it), then the wait until 5.5 s in six slices, then b, whose
	// rest is the idle floor again: the start is over and nothing runs.
	assert.deepEqual(p.events, ["list", "isOpen:a", "rename:a", "remove:a", ...Array(8).fill("sleep:250"), ...Array(6).fill("sleep:250"), "isOpen:b", "rename:b", "remove:b", "sleep:100"]);
	assert.equal(out.waitedForStartsMs, 1500);
	assert.equal(out.restedMs, 2100, "the wait is not a rest: 2 s after the first run and 100 ms after the second");
});

test("a start that begins while the pass lists the open sandboxes is waited for before the first run is asked about (issue #1023)", async () => {
	// Nothing is starting at the top of the pass. The listing takes 2 s (a slow runtime), a container starts 0.5 s into
	// it and is up at 4 s: without a wait here the first run would be asked about and removed beside that start.
	const p = besideJobs({ a: { createdAt: hoursAgo(50) } }, { starting: (t) => (t >= 500 && t < 4000 ? 1 : 0) });
	const listRunning = async () => {
		p.events.push("list");
		p.advance(2000);
		return [];
	};
	const out = await realMakeSandboxReaper({ ...p.options, listRunning })();
	assert.deepEqual(p.events, ["list", ...Array(8).fill("sleep:250"), "isOpen:a", "rename:a", "remove:a", "sleep:100"]);
	assert.deepEqual([out.reaped, out.waitedForStartsMs, out.ms], [1, 2000, 4100]);
});

test("a pass waits SANDBOX_START_WAIT_MAX_MS for starts in all, at the top and after its rests together, and then goes on (issue #1023)", async () => {
	// A container is always starting. The whole allowance goes at the top; no rest waits again.
	const always = besideJobs(expiredRuns(3), { starting: () => 1 });
	const out = await realMakeSandboxReaper(always.options)();
	assert.equal(always.events.indexOf("list"), 80, "eighty slices of 250 ms, then the pass's first runtime call");
	assert.equal(out.waitedForStartsMs, 20_000);
	assert.equal(out.reaped, 3, "the pass still sweeps");
	assert.deepEqual(restsOf(always.events), [20_000, 1000, 1000, 1000], "after the wait, only the entries' own rests");
	// Split: 15 s at the top, nothing starting at that instant, then a start again for good. What is left is 5 s, used
	// after the first entry's rest (100 ms: nothing was starting when it began); the later rests wait no more.
	const split = besideJobs(expiredRuns(3), { starting: (t) => (t === 15_000 ? 0 : 1) });
	const second = await realMakeSandboxReaper(split.options)();
	assert.equal(split.events.indexOf("list"), 60);
	assert.equal(second.waitedForStartsMs, 20_000, "fifteen at the top and five after the first rest, never more than the bound");
	assert.deepEqual(restsOf(split.events), [15_000, 100 + 5000, 1000, 1000]);
	// The next pass has its own allowance.
	const next = besideJobs(expiredRuns(1), { starting: () => 1 });
	const reap = realMakeSandboxReaper(next.options);
	assert.equal((await reap()).waitedForStartsMs, 20_000);
	next.fs.files["/sbx/z"] = "<dir>";
	next.fs.files[`/sbx/z/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "z", createdAt: hoursAgo(50) });
	assert.equal((await reap()).waitedForStartsMs, 20_000, "a new pass waits anew");
});

test("the wait for a start is not charged to the pass's time budget (issue #1023)", async () => {
	// The #978 budget case again (each runtime ask 3 s, so a run costs 6 s with its rest and the budget stops the pass
	// at 24 s), behind a 20 s wait for a start: charged, the pass would have stopped after its first run.
	const p = besideJobs(expiredRuns(10), { askMs: () => 3000, starting: (t) => (t < 20_000 ? 1 : 0) });
	const out = await realMakeSandboxReaper(p.options)();
	assert.deepEqual(out, { more: true, reaped: 4, held: 0, ms: 44_000, restedMs: 12_000, slowestCheckMs: 3000, waitedForStartsMs: 20_000 });
	assert.equal(p.events.filter((e) => e.startsWith("isOpen:")).length, 4);
});

test("beside a running job a pass removes at most SANDBOX_PASS_MAX_REAPS_BUSY and rests at least SANDBOX_REST_MIN_BUSY_MS after each entry (issue #1023)", async () => {
	const p = besideJobs(expiredRuns(12), { running: () => 1 });
	const reap = realMakeSandboxReaper(p.options);
	const first = await reap();
	assert.deepEqual([first.reaped, first.more], [5, true], "five, and the rest is the next pass's");
	assert.deepEqual(restsOf(p.events), [1000, 1000, 1000, 1000, 1000], "a second after each, where an idle pass rests 100 ms");
	assert.ok(sleeps(p.events).every((ms) => ms <= SANDBOX_REST_POLL_MS), "still in slices of the stop poll");
	assert.equal(Object.hasOwn(first, "waitedForStartsMs"), false, "a running job is not waited for");
	assert.deepEqual(p.events.filter((e) => e.startsWith("isOpen:")), ["isOpen:r000", "isOpen:r001", "isOpen:r002", "isOpen:r003", "isOpen:r004"], "so each run's runtime is asked once, as beside no job");
	assert.equal(Object.hasOwn(first, "askedAgain"), false);
	const [second, third] = [await reap(), await reap()];
	assert.deepEqual([second.reaped, second.more, third.reaped, third.more], [5, true, 2, false], "every pass moves on, so the lap ends");
	assert.deepEqual(p.passLines().map((f) => [f.reaped, f.more, f.busy]), [[5, true, true], [5, true, true], [2, false, true]]);
	// A starting container the wait has given up on is beside the pass as much as a running one.
	const starting = besideJobs(expiredRuns(12), { starting: () => 1 });
	const beside = await realMakeSandboxReaper(starting.options)();
	assert.deepEqual([beside.reaped, beside.more], [5, true]);
});

test("the bounds are read at each boundary: a job that starts in the middle of a pass tightens what is left, one that ends loosens it (issue #1023)", async () => {
	// Each runtime ask takes 50 ms and each idle rest 100, so a run begins every 150 ms. A job starts running at 925 ms,
	// inside the seventh run's ask: that run's rest has the busy floor, and the next boundary finds seven removals, over five.
	const tightened = besideJobs(expiredRuns(60), { askMs: () => 50, running: (t) => (t >= 925 ? 1 : 0) });
	const out = await realMakeSandboxReaper(tightened.options)();
	assert.deepEqual([out.reaped, out.more], [7, true], "the pass stops at the first boundary after the job began");
	assert.deepEqual(restsOf(tightened.events), [...Array(6).fill(100), 1000], "and the rest that follows that start has the busy floor");
	assert.deepEqual(tightened.passLines().map((f) => f.busy), [true]);
	// The other way: a job runs for the first three runs and then ends. The pass goes on to the idle bounds.
	const loosened = besideJobs(expiredRuns(60), { running: (t) => (t < 2500 ? 1 : 0) });
	const idle = await realMakeSandboxReaper(loosened.options)();
	assert.deepEqual([idle.reaped, idle.more], [50, true], "fifty, the idle bound, although it began beside a job");
	assert.deepEqual(restsOf(loosened.events).slice(0, 5), [1000, 1000, 1000, 100, 100]);
});

test("a pass beside jobs still visits one entry before any bound can stop it (issue #1023)", async () => {
	// A container starting for good, a job running, and a runtime whose answer takes longer than the whole time budget.
	const p = besideJobs(expiredRuns(3), { starting: () => 1, running: () => 3, askMs: () => 25_000 });
	const reap = realMakeSandboxReaper(p.options);
	const passes = [await reap(), await reap(), await reap(), await reap()];
	// The third pass removes the last run with its budget long spent, so it leaves the networks to a fourth, which has
	// visited nothing yet and so goes on to them: the lap ends.
	assert.deepEqual(passes.map((o) => [o.reaped, o.more]), [[1, true], [1, true], [1, true], [0, false]], "one run a pass at the least, and the lap ends");
	assert.deepEqual(runsLeft(p.fs, "r"), []);
});

test("a start that begins while a run's runtime is asked is waited for before that run is removed, and the runtime is asked again (issue #1023)", async () => {
	// Each ask takes 1 s. A container starts half a second into the ask about `a` and is up at 2.5 s. Without the look
	// after the answer, `a` was renamed and deleted beside that start with the pass's whole wait unused.
	const p = besideJobs({ a: { createdAt: hoursAgo(50) }, b: { createdAt: hoursAgo(50) } }, { askMs: () => 1000, starting: (t) => (t >= 500 && t < 2500 ? 1 : 0) });
	const out = await realMakeSandboxReaper(p.options)();
	// a: asked (to 1 s), six slices to the end of the start, asked AGAIN (to 3.5 s), and only then renamed and removed.
	// Its rest is as long as its two asks took, 2 s: the wait is not the entry's time. b is asked once.
	assert.deepEqual(p.events, ["list", "isOpen:a", ...Array(6).fill("sleep:250"), "isOpen:a", "rename:a", "remove:a", ...Array(8).fill("sleep:250"), "isOpen:b", "rename:b", "remove:b", ...Array(4).fill("sleep:250")]);
	assert.deepEqual(out, { more: false, reaped: 2, held: 0, ms: 7500, restedMs: 3000, slowestCheckMs: 1000, waitedForStartsMs: 1500, askedAgain: 1 });
	assert.deepEqual(p.passLines(), [{ ...out, busy: true }], "the line says how often a runtime was asked again");
});

test("after a wait before a removal the run's guards are asked anew, and their new answer decides (issue #1023)", async () => {
	// The same start, during the ask about `a`. What the runtime said before the wait is 1.5 s old when the wait ends.
	const scene = (second) => {
		const p = besideJobs({ a: { createdAt: hoursAgo(50) } }, { askMs: () => 1000, starting: (t) => (t >= 500 && t < 2500 ? 1 : 0) });
		const isOpen = p.options.isOpen;
		let asks = 0;
		p.options.isOpen = async (args) => {
			const first = await isOpen(args);
			return ++asks === 1 ? first : second();
		};
		return p;
	};
	const held = (p) => p.logs.filter(([e]) => e === "sandbox_reaper_skipped").map(([, f]) => f);
	// A sandbox was opened on the run during the wait: it is held, not removed.
	const opened = scene(() => true);
	const out = await realMakeSandboxReaper(opened.options)();
	assert.deepEqual(opened.events.filter((e) => !e.startsWith("sleep:")), ["list", "isOpen:a", "isOpen:a"], "asked twice, never renamed, never removed");
	assert.deepEqual(held(opened), [{ entry: "a", reason: "opened-during-pass" }]);
	assert.deepEqual([out.reaped, out.held, out.askedAgain], [0, 1, 1]);
	assert.ok(`/sbx/a/${SANDBOX_MANIFEST}` in opened.fs.files);
	// The runtime no longer answers: held as well.
	const silent = scene(() => {
		throw new Error("timed out");
	});
	await realMakeSandboxReaper(silent.options)();
	assert.deepEqual(held(silent), [{ entry: "a", reason: "runtime-unanswered" }]);
	assert.ok(`/sbx/a/${SANDBOX_MANIFEST}` in silent.fs.files);
	// The run was pinned during the wait, and its runtime still says it is not open: the read that decides is taken
	// after the wait, so the pin holds it.
	const pinned = scene(() => false);
	const sleep = pinned.options.sleep;
	let slices = 0;
	pinned.options.sleep = async (ms) => {
		if (++slices === 3) pinned.fs.files[`/sbx/a/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "a", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
		return sleep(ms);
	};
	await realMakeSandboxReaper(pinned.options)();
	assert.deepEqual(held(pinned), [{ entry: "a", reason: "manifest-changed" }]);
	assert.deepEqual(pinned.events.filter((e) => e.startsWith("rename:") || e.startsWith("remove:")), []);
	// And a pass told to stop during that wait asks nothing again and removes nothing.
	const stopping = scene(() => false);
	const nap = stopping.options.sleep;
	let naps = 0;
	const stoppedOut = await realMakeSandboxReaper({ ...stopping.options, sleep: async (ms) => (naps++, nap(ms)) })({ stopped: () => naps >= 2 });
	assert.deepEqual(stopping.events, ["list", "isOpen:a", "sleep:250", "sleep:250"]);
	assert.deepEqual([stoppedOut.reaped, stoppedOut.stopped, Object.hasOwn(stoppedOut, "askedAgain")], [0, true, false]);
});

test("one run cannot hold a pass: a wait before its removal is taken from the pass's own, and once that is used up the removal goes ahead (issue #1023)", async () => {
	// Nothing is starting until the first run's runtime is asked; from then on a container is starting for good.
	let began = false;
	const p = besideJobs(expiredRuns(3), { starting: () => (began ? 1 : 0) });
	const isOpen = p.options.isOpen;
	p.options.isOpen = async (args) => {
		began = true;
		return isOpen(args);
	};
	const out = await realMakeSandboxReaper(p.options)();
	assert.deepEqual(p.events.slice(0, 2), ["list", "isOpen:r000"]);
	assert.deepEqual(p.events.slice(2, 82), Array(80).fill("sleep:250"), "the pass's whole 20 s, before this one removal");
	assert.deepEqual(p.events.slice(82, 85), ["isOpen:r000", "rename:r000", "remove:r000"], "asked again, and removed beside the start: no wait is left");
	assert.deepEqual(p.events.filter((e) => e.startsWith("isOpen:")).slice(2), ["isOpen:r001", "isOpen:r002"], "the runs after it are asked once and removed");
	assert.deepEqual([out.reaped, out.waitedForStartsMs, out.askedAgain], [3, 20_000, 1]);

	// The worst case: a container that is starting every time the runtime has answered and is up within one slice. Each
	// wait is one slice of the pass's eighty, so the runtime is asked again eighty times and then the run is removed.
	let pending = false;
	const worst = besideJobs({ a: { createdAt: hoursAgo(50) } }, { starting: () => (pending ? ((pending = false), 1) : 0) });
	const ask = worst.options.isOpen;
	worst.options.isOpen = async (args) => {
		pending = true;
		return ask(args);
	};
	const bounded = await realMakeSandboxReaper(worst.options)();
	assert.equal(worst.events.filter((e) => e === "isOpen:a").length, 81);
	assert.deepEqual(worst.events.slice(worst.events.lastIndexOf("isOpen:a") + 1).filter((e) => !e.startsWith("sleep:")), ["rename:a", "remove:a"], "and after the last of them nothing waits");
	assert.deepEqual([bounded.reaped, bounded.waitedForStartsMs, bounded.askedAgain], [1, 20_000, 80]);
});

test("a leftover tombstone's delete is not waited for after its read: the look comes before, and its rest and the wait after (issue #1023)", async () => {
	// A start that begins during the delete: the delete, then its rest (the busy floor), then the wait to the end of it.
	const tomb = besideJobs({}, { starting: (t) => (t >= 500 && t < 2000 ? 1 : 0), removeMs: () => 700 });
	tomb.fs.files["/sbx/.reap-4242-1-0"] = "<dir>";
	tomb.fs.files[`/sbx/.reap-4242-1-0/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "t0", createdAt: hoursAgo(50) });
	await realMakeSandboxReaper({ ...tomb.options, pid: 4242 })();
	assert.equal(tomb.events[0], "remove:.reap-4242-1-0", "the delete first");
	assert.deepEqual(restsOf(tomb.events)[0], 1000 + 500, "its rest (the busy floor), then the wait to the end of the start");

	// A start that begins in the turn a kept tombstone yields. The first leftover holds a live pin and is put back (no
	// delete, one turn); the pass last looked at the count before it, so the second is looked at again before its read.
	const scene = () => {
		let began = null;
		const p = besideJobs({}, { starting: (t) => (began !== null && t < began + 1000 ? 1 : 0) });
		p.fs.files["/sbx/.reap-4242-1-0"] = "<dir>";
		p.fs.files[`/sbx/.reap-4242-1-0/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "kept", createdAt: hoursAgo(50), keepUntil: new Date(AT + DAY).toISOString() });
		p.fs.files["/sbx/.reap-4242-1-1"] = "<dir>";
		p.fs.files[`/sbx/.reap-4242-1-1/${SANDBOX_MANIFEST}`] = JSON.stringify({ jobId: "t1", createdAt: hoursAgo(50) });
		const log = p.options.log;
		p.options.log = (event, fields) => {
			if (fields?.reason === "tombstone-pinned") began = p.options.clock();
			log(event, fields);
		};
		p.options.pid = 4242;
		return p;
	};
	const p = scene();
	const out = await realMakeSandboxReaper(p.options)();
	assert.deepEqual(p.events.slice(0, 6), ["rename:.reap-4242-1-0", ...Array(4).fill("sleep:250"), "remove:.reap-4242-1-1"], "the pinned one put back, the wait for the start, then the delete");
	assert.deepEqual([out.reaped, out.waitedForStartsMs], [1, 1000]);
	assert.equal(Object.hasOwn(out, "askedAgain"), false, "a tombstone has no runtime to ask again: its one read comes after the wait");
	// Told to stop during that wait, the pass deletes nothing.
	const stopping = scene();
	const nap = stopping.options.sleep;
	let naps = 0;
	const stoppedOut = await realMakeSandboxReaper({ ...stopping.options, sleep: async (ms) => (naps++, nap(ms)) })({ stopped: () => naps >= 2 });
	assert.deepEqual(stopping.events.slice(0, 3), ["rename:.reap-4242-1-0", "sleep:250", "sleep:250"]);
	assert.deepEqual(stopping.events.filter((e) => e.startsWith("remove:") || e.startsWith("sleep:")).slice(2), [], "no third slice and no delete");
	assert.deepEqual([stoppedOut.reaped, stoppedOut.stopped], [0, true]);
	assert.ok(`/sbx/.reap-4242-1-1/${SANDBOX_MANIFEST}` in stopping.fs.files);
});

test("beside a job the cap counts the session networks the sweep asked the daemon about, with the runs and tombstones removed (issue #1023)", async () => {
	// A sweeper over `n` networks that keeps its own place from pass to pass, as the real one does.
	const networks = (p, n) => {
		let next = 0;
		return async ({ pace }) => {
			while (next < n) {
				p.events.push(`network:${next++}`);
				if (!(await pace())) return { swept: [], notes: [], more: next < n };
			}
			return { swept: [], notes: [] };
		};
	};
	const visited = (p) => p.events.filter((e) => e.startsWith("network:")).length;
	const passes = async (p, sweepNetworks, n, over = {}) => {
		const reap = realMakeSandboxReaper({ ...p.options, ...over, sweepNetworks });
		const seen = [];
		for (let pass = 0; pass < n; pass++) {
			const before = visited(p);
			const out = await reap();
			seen.push([out.reaped, visited(p) - before, out.more]);
		}
		return seen;
	};
	// Twelve networks and no run, beside a running job: five a pass, where one pass used to take as many as its time
	// allowed (sixteen, measured).
	const busy = besideJobs({}, { running: () => 1 });
	assert.deepEqual(await passes(busy, networks(busy, 12), 3), [[0, 5, true], [0, 5, true], [0, 2, false]]);
	assert.deepEqual(busy.passLines().map((f) => f.busy), [true, true, true]);
	// Beside no job a pass counts no network, as before: sixty in one pass, past the fifty that bound the runs.
	const idle = besideJobs({});
	assert.deepEqual(await passes(idle, networks(idle, 60), 1), [[0, 60, false]]);
	// And a pass that made its fifty removals beside no job still goes on to the networks, as it always did.
	const fifty = besideJobs(expiredRuns(50));
	assert.deepEqual(await passes(fifty, networks(fifty, 3), 1), [[50, 1, true]]);
	// Runs first. A pass that removed its five runs leaves every network to the next pass.
	const both = besideJobs(expiredRuns(5), { running: () => 1 });
	assert.deepEqual(await passes(both, networks(both, 3), 2), [[5, 0, true], [0, 3, false]]);
	// Three runs, then the networks: two of them make the five.
	const mixed = besideJobs(expiredRuns(3), { running: () => 1 });
	assert.deepEqual(await passes(mixed, networks(mixed, 6), 2), [[3, 2, true], [0, 4, false]]);
	// A job that starts running in the middle of the network sweep (at 650 ms, a network every 100 ms) ends the pass
	// at the next network: seven asked about is over five.
	const mid = besideJobs({}, { running: (t) => (t >= 650 ? 1 : 0) });
	assert.deepEqual(await passes(mid, networks(mid, 20), 1), [[0, 7, true]]);
	// A pass that begins at the networks asks about one before any bound can stop it, so the lap still ends: here the
	// listing of the open sandboxes alone takes longer than the pass's time.
	const slow = besideJobs({}, { running: () => 1 });
	const listRunning = async () => (slow.advance(25_000), []);
	assert.deepEqual(await passes(slow, networks(slow, 3), 3, { listRunning }), [[0, 1, true], [0, 1, true], [0, 1, false]]);
});

test("the network sweep is paced beside jobs too: its rests have the busy floor and wait for a start (issue #1023)", async () => {
	const p = besideJobs({}, { running: () => 1, starting: (t) => (t >= 1000 && t < 1500 ? 1 : 0) });
	const sweepNetworks = async ({ pace }) => {
		for (const n of ["n1", "n2"]) {
			p.events.push(`network:${n}`);
			if (!(await pace())) return { swept: [], notes: [], more: true };
		}
		return { swept: [], notes: [] };
	};
	const out = await realMakeSandboxReaper({ ...p.options, sweepNetworks })();
	assert.deepEqual(p.events.filter((e) => !e.startsWith("sleep:")), ["list", "network:n1", "network:n2"]);
	assert.deepEqual(restsOf(p.events), [1000 + 500, 1000], "the first network's rest and the wait behind it, then the second's rest");
	assert.equal(out.waitedForStartsMs, 500);
});

test("with a count that says nothing is starting or running, a pass is exactly the pass without one (issue #1023)", async () => {
	const entries = () => ({ ...expiredRuns(55), young: { createdAt: hoursAgo(1) }, open: { createdAt: hoursAgo(50) } });
	const without = paced(entries(), { askMs: () => 40, open: (name) => name === "open" });
	const withIdle = besideJobs(entries(), { askMs: () => 40, open: (name) => name === "open" });
	const plain = realMakeSandboxReaper({ ...without.options, listRunning: async () => (without.events.push("list"), []) });
	const counted = realMakeSandboxReaper(withIdle.options);
	for (let pass = 0; pass < 3; pass++) assert.deepEqual(await counted(), await plain(), `pass ${pass + 1}: the same result, key for key`);
	assert.deepEqual(withIdle.events, without.events, "the same calls and the same sleeps, in the same order");
	assert.deepEqual(withIdle.logs, without.logs, "and the same lines: no new field on a pass that met no job");
	assert.ok(without.logs.some(([e]) => e === "sandbox_reaper_pass"));
});

test("a count that throws, or answers no number, reads as nothing starting and nothing running, and the pass never throws (issue #1023)", async () => {
	for (const [name, activity] of [
		["throws", { starting: () => { throw new Error("broken"); }, running: () => { throw new Error("broken"); } }],
		["no number", { starting: () => "many", running: () => Number.NaN }],
		["negative", { starting: () => -1, running: () => -5 }],
		["no functions", {}],
	]) {
		const p = paced(expiredRuns(7));
		const out = await realMakeSandboxReaper({ ...p.options, activity })();
		assert.deepEqual(out, { more: false, reaped: 7, held: 0, ms: 700, restedMs: 700, slowestCheckMs: 0 }, name);
		assert.deepEqual(restsOf(p.events), Array(7).fill(100), name);
	}
});

test("a pass told to stop while it waits for a start wakes within one slice and removes nothing (issue #1023)", async () => {
	const p = besideJobs(expiredRuns(2), { starting: () => 1 });
	let slices = 0;
	const sleep = p.options.sleep;
	const out = await realMakeSandboxReaper({ ...p.options, sleep: async (ms) => (slices++, sleep(ms)) })({ stopped: () => slices >= 2 });
	assert.equal(slices, 2, "the stop is asked before each slice");
	assert.deepEqual([out.reaped, out.stopped, out.waitedForStartsMs], [0, true, 500]);
	assert.deepEqual(runsLeft(p.fs, "r").length, 2);
});

test("a pass that only waited for a start says its line (issue #1023)", async () => {
	const p = besideJobs({}, { starting: (t) => (t < 1000 ? 1 : 0) });
	const out = await realMakeSandboxReaper(p.options)();
	assert.deepEqual(out, { more: false, reaped: 0, held: 0, ms: 1000, restedMs: 0, slowestCheckMs: 0, waitedForStartsMs: 1000 });
	assert.deepEqual(p.passLines(), [{ ...out, busy: true }]);
});

test("the reaper reads the worker's own count: a start holds a pass, a run makes it small, and the end frees it (issue #1023)", async () => {
	// The real count on the pass's clock, driven as a run function drives it: the container is up 1 s into the pass (its
	// first output), reported while the pass waits.
	const p = paced(expiredRuns(20));
	const activity = makeContainerActivity({ now: () => p.options.clock() });
	const run = activity.enter();
	let slices = 0;
	const sleep = async (ms) => {
		await p.options.sleep(ms);
		if (++slices === 4) run.started();
	};
	const reap = realMakeSandboxReaper({ ...p.options, sleep, activity });
	const beside = await reap();
	assert.deepEqual([beside.waitedForStartsMs, beside.reaped, beside.more], [1000, 5, true], "held for the start, then small beside the run");
	run.ended();
	const after = await reap();
	assert.deepEqual([after.reaped, after.more, Object.hasOwn(after, "waitedForStartsMs")], [15, false, false], "the job is over: an ordinary pass");

	// A start that never reports: a pass waits its own 20 s for it and goes on, small. Once the count's own bound has
	// passed (two minutes) no pass waits for it any more, and it still makes the passes small.
	const lost = paced(expiredRuns(12));
	const count = makeContainerActivity({ now: () => lost.options.clock() });
	count.enter();
	const sweep = realMakeSandboxReaper({ ...lost.options, activity: count });
	const first = await sweep();
	assert.deepEqual([first.waitedForStartsMs, first.reaped, first.more], [20_000, 5, true]);
	lost.advance(120_000);
	const later = await sweep();
	assert.deepEqual([Object.hasOwn(later, "waitedForStartsMs"), later.reaped, later.more], [false, 5, true]);
});
