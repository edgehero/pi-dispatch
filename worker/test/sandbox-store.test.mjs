import assert from "node:assert/strict";
import { test } from "node:test";
import { isSandboxTombstone, listSandboxes, makeSandboxReaper, pinSandbox, readManifest, retainJobDir, sandboxDeadline, sandboxEntryName, sandboxExpiry, sandboxTombstoneAge, SANDBOX_MANIFEST, SANDBOX_TOMBSTONE_PREFIX, SANDBOX_TOMBSTONE_RELOG_MS, SANDBOX_TOMBSTONE_STUCK_MS } from "../src/sandbox-store.mjs";

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
