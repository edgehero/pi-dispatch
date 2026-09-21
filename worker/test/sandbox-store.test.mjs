import assert from "node:assert/strict";
import { test } from "node:test";
import { listSandboxes, makeSandboxReaper, pinSandbox, readManifest, retainJobDir, SANDBOX_MANIFEST } from "../src/sandbox-store.mjs";

const HOUR = 3600000;
const DAY = 86400000;

/**
 * A fake fs recording every mutation, so retention can be asserted without a disk. Paths are plain
 * strings keyed into one map; `files` holds written contents and `dirs` the removed/renamed history.
 */
function fakeFs({ files = {}, failOn = null } = {}) {
	const calls = { removed: [], renamed: [], made: [] };
	return {
		calls,
		files,
		lstatSync(p) {
			if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			return { isDirectory: () => files[p] === "<dir>" };
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
			files[to] = "<dir>";
			delete files[from];
		},
		rmSync(p) {
			calls.removed.push(p);
			for (const k of Object.keys(files)) if (k === p || k.startsWith(`${p}/`)) delete files[k];
		},
		writeFileSync(p, body, opts) {
			if (failOn === "write") throw new Error("ENOSPC");
			files[p] = body;
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

	assert.deepEqual(fs.calls.removed, ["/sbx/old"]);
	assert.deepEqual(logged, [["reaped_sandbox", { entry: "old", reason: "window" }]]);
});

test("a pin outlives the base window, and expires on its own deadline", async () => {
	const at = Date.parse("2026-08-10T00:00:00Z");
	const fs = sandboxDirWith({
		pinned: { createdAt: new Date(at - 200 * HOUR).toISOString(), keepUntil: new Date(at + DAY).toISOString() },
		lapsed: { createdAt: new Date(at - 200 * HOUR).toISOString(), keepUntil: new Date(at - DAY).toISOString() },
	});
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at })();
	assert.deepEqual(fs.calls.removed, ["/sbx/lapsed"], "a live pin survives; a lapsed one does not linger");
});

test("retention off sweeps everything unpinned, and needs no special case to do it", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({
		recent: { createdAt: new Date(at - 60000).toISOString() },
		pinned: { createdAt: new Date(at - 60000).toISOString(), keepUntil: new Date(at + DAY).toISOString() },
	});
	// 0 is the feature being OFF -- the opposite of the log/session sentinels, where 0 is keep-forever.
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 0, fs, now: () => at })();
	assert.deepEqual(fs.calls.removed, ["/sbx/recent"], "turning retention off also cleans up what it retained");
});

test("a directory whose sandbox is RUNNING is never swept out from under the operator", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({
		"gh-1": { createdAt: new Date(at - 99 * HOUR).toISOString() },
		"gh-2": { createdAt: new Date(at - 99 * HOUR).toISOString() },
	});
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, listRunning: async () => ["gh-1"] })();
	assert.deepEqual(fs.calls.removed, ["/sbx/gh-2"], "the live one stays, however old it is");
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

	assert.deepEqual(fs.calls.removed, [], "a directory kept one boot too long is the cheaper mistake");
	assert.deepEqual(logged, [["sandbox_reaper_skipped", { reason: "daemon down" }]]);
});

test("an entry with no usable manifest is reaped -- it can never be resurrected", async () => {
	const at = Date.parse("2026-08-02T00:00:00Z");
	const fs = sandboxDirWith({ bad: "<bad>", undated: {} });
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, log: (e, d) => logged.push([e, d]) })();

	assert.deepEqual(fs.calls.removed.sort(), ["/sbx/bad", "/sbx/undated"]);
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
	fs.rmSync = (p) => {
		if (p === "/sbx/a") throw new Error("EPERM");
		fs.calls.removed.push(p);
	};
	const logged = [];
	await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs, now: () => at, log: (e, d) => logged.push([e, d]) })();
	assert.deepEqual(fs.calls.removed, ["/sbx/b"], "one bad entry cannot abort the rest of the sweep");
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
	assert.deepEqual(fs.calls.removed, ["/sbx/old"], "the expired directory is still removed");
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
	assert.deepEqual(fs.calls.removed, []);
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
