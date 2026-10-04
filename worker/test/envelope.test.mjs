import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ENVELOPE_VERSION, ENVELOPE_WINDOWS, envelopeDigest, envelopeInsideJobPaths, loadEnvelope, parseEnvelope } from "../src/envelope.mjs";
import { OTHER, allocate } from "../src/priorities.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const M = 1_000_000;
const PROJECTS = [{ id: "shop", name: null, members: ["github:acme/web"] }, { id: "platform", name: null, members: ["github:acme/platform"] }];
const CONTEXT = { projects: PROJECTS, limits: [], maxCostMicros: 2 * M };

const EXAMPLE = {
	version: 1,
	window: "week",
	totalUsd: 100,
	floorsUsd: { shop: 10, platform: 10, _other: 0 },
	defaultWeights: { shop: 1, platform: 1, _other: 1 },
	delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 },
};

const parse = (body, context = CONTEXT) => parseEnvelope(JSON.stringify(body), "envelope.json", context);
const withField = (patch) => ({ ...EXAMPLE, ...patch });
const withDelegation = (patch) => ({ ...EXAMPLE, delegation: { ...EXAMPLE.delegation, ...patch } });
function refused(body, re, context = CONTEXT) {
	assert.throws(() => parse(body, context), (e) => e.piDispatchConfig === true && re.test(e.message) && e.message.endsWith(": envelope.json"), String(re));
}

// ── the parser ──────────────────────────────────────────────────────────────────────────────────────────

test("parseEnvelope accepts the issue's example and normalizes it to integer micro-dollars", () => {
	assert.deepEqual(parse(EXAMPLE), {
		version: 1,
		window: "week",
		totalMicros: 100 * M,
		floors: { [OTHER]: 0, platform: 10 * M, shop: 10 * M },
		defaultWeights: { [OTHER]: 1, platform: 1, shop: 1 },
		delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 },
	});
	assert.equal(ENVELOPE_VERSION, 1);
	assert.deepEqual(ENVELOPE_WINDOWS, ["day", "week", "month"]);
});

test("_other is always an entry: floor 0 and default weight 1 when the file leaves it out; delegation absent is off", () => {
	const e = parse({ version: 1, window: "month", totalUsd: "50.5", floorsUsd: { shop: "1.000001" } });
	assert.deepEqual(e.floors, { [OTHER]: 0, shop: 1_000_001 });
	assert.deepEqual(e.defaultWeights, { [OTHER]: 1, shop: 1 });
	assert.equal(e.totalMicros, 50_500_000);
	assert.deepEqual(e.delegation, { enabled: false, writers: [], maxStepPct: null, minIntervalHours: null, maxPlanDays: null });
	assert.deepEqual(parse({ version: 1, window: "day", totalUsd: 1, floorsUsd: {} }).floors, { [OTHER]: 0 }, "no project floors: everything is _other");
	// The normalized envelope is what allocate consumes: 49,499,999 splits 1:1, the odd micro-dollar to _other (lower id).
	assert.deepEqual(allocate({ envelope: e, weights: e.defaultWeights }).allocations, { [OTHER]: 24_750_000, shop: 25_750_000 });
});

test("the version: required, an integer >= 1, and a newer one is refused", () => {
	refused(withField({ version: undefined }), /must have "version": 1/);
	refused(withField({ version: "1" }), /must have "version": 1/);
	refused(withField({ version: 0 }), /must have "version": 1/);
	refused(withField({ version: 2 }), /written by a newer pi-dispatch \(version 2; this build understands 1\)/);
});

test("the shape: valid JSON, an object, and no unknown key at the top or in delegation (counted, never quoted)", () => {
	assert.throws(() => parseEnvelope("{ nope", "envelope.json", CONTEXT), (e) => /not valid JSON \(at character \d+\): envelope\.json$/.test(e.message) && !e.message.includes("nope"));
	refused([], /must be an object/);
	refused(withField({ totalUSD: 1 }), /the file has 1 unknown key\(s\)/);
	refused(withDelegation({ maxStepPCT: 5 }), /delegation has 1 unknown key\(s\)/);
	assert.throws(() => parse(withField({ zzSECRETzz: 1 })), (e) => !e.message.includes("zzSECRETzz"));
});

test("an envelope needs a per-job cost cap, naming PI_MAX_COST_USD", () => {
	refused(EXAMPLE, /needs a per-job cost cap: set PI_MAX_COST_USD/, { ...CONTEXT, maxCostMicros: null });
	refused(EXAMPLE, /PI_MAX_COST_USD/, { projects: PROJECTS, limits: [] });
	for (const maxCostMicros of [0, -1, 1.5, "2000000", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
		refused(EXAMPLE, /needs a per-job cost cap/, { ...CONTEXT, maxCostMicros });
	}
	assert.equal(parse(EXAMPLE, { ...CONTEXT, maxCostMicros: 1 }).window, "week", "one micro-dollar is a cap");
});

test("window is one of day, week, month", () => {
	for (const window of [undefined, "year", "Week", 7]) refused(withField({ window }), /window must be one of day, week, month/);
});

test("totalUsd: a plain decimal above 0, at most 6 decimals, never rounded", () => {
	for (const totalUsd of [undefined, 0, "0", -1, "1e3", "1.0000001", 1e-7, "abc", 1_000_001]) refused(withField({ totalUsd }), /totalUsd must be a dollar amount above 0/);
	assert.equal(parse(withField({ totalUsd: "100.000001" })).totalMicros, 100_000_001);
});

test("floorsUsd: an object; each floor a plain decimal of 0 or more with at most 6 decimals", () => {
	for (const floorsUsd of [undefined, [], "shop"]) refused(withField({ floorsUsd }), /floorsUsd must be an object/);
	for (const v of [-1, "1.0000001", "1e2", "x", null]) refused(withField({ floorsUsd: { shop: v } }), /floorsUsd\.shop must be a dollar amount of 0 or more/);
	assert.equal(parse(withField({ floorsUsd: { shop: "0.000000", platform: 0 } })).floors.shop, 0);
});

test("a floor key must be a project in projects.json or _other", () => {
	refused(withField({ floorsUsd: { web: 1 } }), /floorsUsd\.web names a project that is not in the projects file/);
	refused(withField({ floorsUsd: { shop: 1 } }), /floorsUsd\.shop names a project that is not in the projects file/, { ...CONTEXT, projects: [] });
	refused(withField({ floorsUsd: { "Shop/../x": 1 } }), /a key of floorsUsd is neither _other nor a project id/);
	assert.throws(() => parse(withField({ floorsUsd: { "/srv/secret": 1 } })), (e) => !e.message.includes("/srv/secret"), "a malformed key is never quoted");
});

test("the floors may not add up to more than the total", () => {
	refused(withField({ totalUsd: 15, floorsUsd: { shop: 10, platform: 10 } }), /the floors add up to 20\.00, above totalUsd 15\.00/);
	assert.equal(parse(withField({ totalUsd: 20, floorsUsd: { shop: 10, platform: 10 } })).totalMicros, 20 * M, "equal is allowed");
});

test("defaultWeights: entries with a floor, integers 0 to 1000", () => {
	refused(withField({ defaultWeights: [] }), /defaultWeights must be an object/);
	refused(withField({ defaultWeights: { web: 1 } }), /defaultWeights\.web names a project that is not in the projects file/);
	refused(withField({ floorsUsd: { shop: 10 }, defaultWeights: { platform: 1 } }), /defaultWeights\.platform names a project with no floor/);
	for (const w of [-1, 1001, 1.5, "1"]) refused(withField({ defaultWeights: { shop: w } }), /defaultWeights\.shop must be an integer from 0 to 1000/);
	assert.deepEqual(parse(withField({ defaultWeights: { shop: 0 } })).defaultWeights, { [OTHER]: 1, platform: 1, shop: 0 });
});

test("a project's operator dollar row for the envelope's window below its floor refuses the file, naming both", () => {
	const limits = [{ scope: "project:shop", weekUsd: "5.00", dayUsd: null, monthUsd: null }];
	refused(EXAMPLE, /floorsUsd\.shop \(10\.00\) is above the scoped-limits row project:shop weekUsd \(5\.00\)/, { ...CONTEXT, limits });
	// Another window's row is not this envelope's business, and a row at the floor is fine.
	assert.equal(parse(EXAMPLE, { ...CONTEXT, limits: [{ scope: "project:shop", dayUsd: "1.00", weekUsd: null, monthUsd: null }] }).window, "week");
	assert.equal(parse(EXAMPLE, { ...CONTEXT, limits: [{ scope: "project:shop", weekUsd: "10.00" }] }).window, "week");
	refused(withField({ window: "day" }), /floorsUsd\.shop \(10\.00\) is above the scoped-limits row project:shop dayUsd \(1\.00\)/, { ...CONTEXT, limits: [{ scope: "project:shop", dayUsd: "1.00" }] });
	// A LONGER window's row bounds the envelope's window too: a week of $0.000001 caps every day of it.
	refused(withField({ window: "day", floorsUsd: { shop: 50, platform: 10 } }), /floorsUsd\.shop \(50\.00\) is above the scoped-limits row project:shop weekUsd \(0\.000001\)/, { ...CONTEXT, limits: [{ scope: "project:shop", weekUsd: "0.000001" }] });
	refused(withField({ window: "week" }), /project:shop monthUsd \(5\.00\)/, { ...CONTEXT, limits: [{ scope: "project:shop", monthUsd: "5.00" }] });
	refused(withField({ window: "day" }), /project:shop monthUsd \(9\.00\)/, { ...CONTEXT, limits: [{ scope: "project:shop", dayUsd: "20.00", monthUsd: "9.00" }] });
	// A SHORTER window's row is not compared: seven days of $5 can still reach a week floor of $10.
	assert.equal(parse(withField({ window: "month" }), { ...CONTEXT, limits: [{ scope: "project:shop", dayUsd: "1.00", weekUsd: "5.00" }] }).window, "month");
	// A repo row is not a project row.
	assert.equal(parse(EXAMPLE, { ...CONTEXT, limits: [{ scope: "github:acme/web", weekUsd: "1.00" }] }).window, "week");
});

test("delegation: enabled is a boolean, and when on, writers, maxStepPct, minIntervalHours and maxPlanDays are all required", () => {
	refused(withField({ delegation: [] }), /delegation must be an object/);
	refused(withDelegation({ enabled: "yes" }), /delegation\.enabled must be true or false/);
	for (const writers of [undefined, [], ["operator"], ["portfolio-job", "portfolio-job"], "portfolio-job"]) refused(withDelegation({ writers }), /delegation\.writers must be a non-empty list of distinct writers from operator-session, portfolio-job/);
	for (const maxStepPct of [undefined, 0, 101, 2.5, "25"]) refused(withDelegation({ maxStepPct }), /delegation\.maxStepPct must be an integer from 1 to 100/);
	for (const minIntervalHours of [undefined, -1, 1.5, 24 * 366 + 1]) refused(withDelegation({ minIntervalHours }), /delegation\.minIntervalHours must be an integer from 0 to 8784/);
	for (const maxPlanDays of [undefined, 0, 367]) refused(withDelegation({ maxPlanDays }), /delegation\.maxPlanDays must be an integer from 1 to 366/);
	assert.equal(parse(withDelegation({ minIntervalHours: 0 })).delegation.minIntervalHours, 0, "an interval of 0 is allowed");
	assert.deepEqual(parse(withDelegation({ writers: ["portfolio-job"] })).delegation.writers, ["portfolio-job"]);
	// Off: the bounds are optional, but a bound that is written is still judged.
	assert.deepEqual(parse(withField({ delegation: { enabled: false } })).delegation, { enabled: false, writers: [], maxStepPct: null, minIntervalHours: null, maxPlanDays: null });
	refused(withField({ delegation: { enabled: false, maxStepPct: 0 } }), /maxStepPct must be an integer from 1 to 100/);
});

test("envelopeDigest is 16 hex over the normalized envelope: key order and spelling do not move it, a value does", () => {
	const a = envelopeDigest(parse(EXAMPLE));
	assert.match(a, /^[0-9a-f]{16}$/);
	const reordered = { delegation: EXAMPLE.delegation, defaultWeights: { _other: 1, platform: 1, shop: 1 }, floorsUsd: { _other: "0", platform: "10.00", shop: "10" }, totalUsd: "100", window: "week", version: 1 };
	assert.equal(envelopeDigest(parse(reordered)), a);
	assert.notEqual(envelopeDigest(parse(withField({ totalUsd: 101 }))), a);
	assert.notEqual(envelopeDigest(parse(withDelegation({ maxStepPct: 24 }))), a);
});

// ── the loader ──────────────────────────────────────────────────────────────────────────────────────────

test("loadEnvelope: unset is null (no delegation), a missing file and an empty value refuse, a file parses", () => {
	assert.equal(loadEnvelope({ envelopeFile: null }, CONTEXT), null);
	assert.equal(loadEnvelope({}, CONTEXT), null);
	assert.throws(() => loadEnvelope({ envelopeFile: "" }, CONTEXT, { existsSync: () => false }), /envelope file does not exist/);
	assert.throws(() => loadEnvelope({ envelopeFile: "/x/envelope.json" }, CONTEXT, { existsSync: () => false }), /envelope file does not exist: \/x\/envelope\.json/);
	const dir = tempDir("envelope-");
	const path = join(dir, "envelope.json");
	writeFileSync(path, JSON.stringify(EXAMPLE));
	assert.equal(loadEnvelope({ envelopeFile: path }, CONTEXT).totalMicros, 100 * M);
	assert.throws(() => loadEnvelope({ envelopeFile: path }, { ...CONTEXT, projects: [] }), /floorsUsd\.platform names a project/);
});

// ── the inside-path check ───────────────────────────────────────────────────────────────────────────────

/** A temp directory by its canonical path: on macOS the OS temp dir sits under a symlink (/var -> /private/var). */
const realDir = (prefix) => realpathSync.native(tempDir(prefix));

/** Make each folder, write each file, and return the root. */
function tree(prefix, { dirs = [], files = [] } = {}) {
	const root = realDir(prefix);
	for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
	for (const f of files) writeFileSync(join(root, f), "{}");
	return root;
}

const nonCanonical = (path, canonical) => (e) => e.piDispatchConfig === true && e.message.includes(JSON.stringify(path)) && /is not its own canonical path/.test(e.message) && (canonical === undefined || e.message.includes(`write ${JSON.stringify(canonical)} instead`));

test("the envelope path must be its own canonical path: a symlink anywhere on the way refuses, naming the path to write", () => {
	// The mid-chain case: ops/cfg -> ../mid/l2 and mid/l2 -> ../etcpi. A job in mid could repoint l2 and so rewrite
	// its own bounds, however far up the chain the link sits. Such a path is refused outright.
	const root = tree("envelope-chain-", { dirs: ["ops", "mid", "etcpi"], files: ["etcpi/env.json"] });
	symlinkSync("../etcpi", join(root, "mid", "l2"));
	symlinkSync("../mid/l2", join(root, "ops", "cfg"));
	const canonical = join(root, "etcpi", "env.json");
	assert.throws(() => envelopeInsideJobPaths(join(root, "ops", "cfg", "env.json"), { runRoots: [join(root, "mid")] }), nonCanonical(join(root, "ops", "cfg", "env.json"), canonical));
	// A file symlink, too.
	symlinkSync(canonical, join(root, "ops", "env-link.json"));
	assert.throws(() => envelopeInsideJobPaths(join(root, "ops", "env-link.json"), {}), nonCanonical(join(root, "ops", "env-link.json"), canonical));
	// The canonical path itself: mid holds only a link, so it is not a container of the file; etcpi is.
	assert.equal(envelopeInsideJobPaths(canonical, { runRoots: [join(root, "mid"), join(root, "ops")] }), null);
	assert.deepEqual(envelopeInsideJobPaths(canonical, { runRoots: [join(root, "etcpi")] }), { kind: "run-root", path: join(root, "etcpi") });
});

test("a /tmp-style symlinked prefix, a case variant, . and .., a relative path and a missing file all refuse", () => {
	const root = tree("envelope-spell-", { dirs: ["private/tmp", "ops"], files: ["private/tmp/env.json", "ops/env.json"] });
	symlinkSync(join(root, "private", "tmp"), join(root, "tmp"));
	assert.throws(() => envelopeInsideJobPaths(join(root, "tmp", "env.json"), {}), nonCanonical(join(root, "tmp", "env.json"), join(root, "private", "tmp", "env.json")));
	// The host's own temp dir, where it is a symlink (macOS /var/folders under /private/var).
	const raw = tempDir("envelope-rawtmp-");
	if (realpathSync.native(raw) !== raw) {
		writeFileSync(join(raw, "env.json"), "{}");
		assert.throws(() => envelopeInsideJobPaths(join(raw, "env.json"), {}), nonCanonical(join(raw, "env.json"), join(realpathSync.native(raw), "env.json")));
	}
	// A case variant: on a case-insensitive volume it resolves and is named; on a case-sensitive one it does not exist.
	const variant = join(root, "OPS", "env.json");
	assert.throws(() => envelopeInsideJobPaths(variant, {}), (e) => e.piDispatchConfig === true && e.message.includes(JSON.stringify(variant)));
	assert.throws(() => envelopeInsideJobPaths(`${root}/ops/../ops/env.json`, {}), nonCanonical(`${root}/ops/../ops/env.json`, join(root, "ops", "env.json")));
	assert.throws(() => envelopeInsideJobPaths(`${root}/ops/./env.json`, {}), nonCanonical(`${root}/ops/./env.json`, join(root, "ops", "env.json")));
	assert.throws(() => envelopeInsideJobPaths("ops/env.json", {}), (e) => e.piDispatchConfig === true && /must be absolute/.test(e.message));
	assert.throws(() => envelopeInsideJobPaths(join(root, "ops", "nope.json"), {}), (e) => e.piDispatchConfig === true && /cannot be resolved \(ENOENT\)/.test(e.message));
	assert.equal(envelopeInsideJobPaths(join(root, "ops", "env.json"), {}), null, "the canonical path passes");
});

test("an envelope file with more than one hard link refuses: a second name could sit inside a job path", () => {
	const root = tree("envelope-nlink-", { dirs: ["ops", "runs"], files: ["ops/env.json"] });
	linkSync(join(root, "ops", "env.json"), join(root, "runs", "env-copy.json"));
	assert.throws(() => envelopeInsideJobPaths(join(root, "ops", "env.json"), { runRoots: [join(root, "runs")] }), (e) => e.piDispatchConfig === true && /has 2 hard links/.test(e.message));
});

test("an envelope path that names a directory refuses as not a regular file, not by its link count", () => {
	const root = tree("envelope-dir-", { dirs: ["ops/sub", "ops/sub2"], files: [] });
	assert.throws(() => envelopeInsideJobPaths(join(root, "ops"), {}), (e) => e.piDispatchConfig === true && /is not a regular file/.test(e.message));
});

test("the filesystem root as a job path holds every envelope; a sibling with a shared prefix does not", () => {
	const root = tree("envelope-prefix-", { dirs: ["site", "site2"], files: ["site/env.json", "site2/env.json"] });
	assert.deepEqual(envelopeInsideJobPaths(join(root, "site", "env.json"), { globalPiDir: "/" }), { kind: "global-pi-dir", path: "/" });
	assert.equal(envelopeInsideJobPaths(join(root, "site2", "env.json"), { cronFolders: [join(root, "site")] }), null);
	assert.deepEqual(envelopeInsideJobPaths(join(root, "site", "env.json"), { cronFolders: [`${join(root, "site")}/`] }), { kind: "cron-folder", path: `${join(root, "site")}/` }, "a trailing separator");
});

test("envelopeInsideJobPaths names the first job-visible path that holds the envelope, of each kind, equality included", () => {
	const root = tree("envelope-paths-", { dirs: ["ops", "site/sub", "runs/sub", "skills/sub", "pi-global/sub"], files: ["ops/env.json", "site/sub/env.json", "runs/sub/env.json", "skills/sub/env.json", "pi-global/sub/env.json"] });
	const paths = { cronFolders: [join(root, "site")], runRoots: [join(root, "runs")], skillsDirs: [join(root, "skills")], globalPiDir: join(root, "pi-global") };
	assert.equal(envelopeInsideJobPaths(join(root, "ops", "env.json"), paths), null, "outside every job path");
	for (const [kind, dir] of [["cron-folder", "site"], ["run-root", "runs"], ["skills-dir", "skills"], ["global-pi-dir", "pi-global"]]) {
		assert.deepEqual(envelopeInsideJobPaths(join(root, dir, "sub", "env.json"), paths), { kind, path: join(root, dir) }, kind);
	}
	assert.deepEqual(envelopeInsideJobPaths(join(root, "site", "sub", "env.json"), { cronFolders: [join(root, "site", "sub")] }), { kind: "cron-folder", path: join(root, "site", "sub") }, "the envelope's own folder is inside");
	// A job path reached through a symlink is the directory it lands on.
	symlinkSync(join(root, "ops"), join(root, "linked-runs"));
	assert.deepEqual(envelopeInsideJobPaths(join(root, "ops", "env.json"), { runRoots: [join(root, "linked-runs")] }), { kind: "run-root", path: join(root, "linked-runs") });
	assert.equal(envelopeInsideJobPaths(join(root, "ops", "env.json"), { cronFolders: ["", null], runRoots: undefined }), null, "blank and absent lists are skipped");
});

test("a job path is never refused for its spelling: it is judged where the kernel resolves it AND where a runtime mounts it", () => {
	const root = tree("envelope-jobdots-", { dirs: ["ops", "runs/a", "elsewhere"], files: ["ops/env.json", "runs/env.json", "runs/a/env.json", "elsewhere/env.json"] });
	const ops = join(root, "ops");
	const runs = join(root, "runs");
	symlinkSync(join(runs, "a"), join(ops, "up"));
	// `ops/up/..` is runs/ to the kernel (the link is followed, then ..), and ops/ as text: Docker cleans a bind source
	// textually, so `-v ops/up/..:/w` mounts ops/. Either reading holding the envelope refuses.
	const jobViaLink = `${ops}/up/..`;
	assert.deepEqual(envelopeInsideJobPaths(join(runs, "env.json"), { runRoots: [jobViaLink] }), { kind: "run-root", path: jobViaLink }, "the kernel's reading");
	assert.deepEqual(envelopeInsideJobPaths(join(ops, "env.json"), { runRoots: [jobViaLink] }), { kind: "run-root", path: jobViaLink }, "the textual reading, the one a container runtime mounts");
	assert.equal(envelopeInsideJobPaths(join(root, "elsewhere", "env.json"), { runRoots: [jobViaLink] }), null, "an envelope outside both readings passes");
	assert.deepEqual(envelopeInsideJobPaths(join(runs, "env.json"), { cronFolders: [`${ops}/../runs`] }), { kind: "cron-folder", path: `${ops}/../runs` });
	const rel = `./${relative(process.cwd(), runs)}`;
	assert.deepEqual(envelopeInsideJobPaths(join(runs, "env.json"), { cronFolders: [rel] }), { kind: "cron-folder", path: rel });
	assert.equal(envelopeInsideJobPaths(join(ops, "env.json"), { cronFolders: [rel] }), null);
	assert.deepEqual(envelopeInsideJobPaths(join(runs, "env.json"), { globalPiDir: `${runs}/.` }), { kind: "global-pi-dir", path: `${runs}/.` });
	// Only the textual reading exists: `ops/up/x/..` is runs/a/x/.. to the kernel, which fails (there is no x), while
	// as text it is ops/up, which exists (and is runs/a). It is judged by the reading that exists, never skipped.
	const kernelMissing = `${ops}/up/x/..`;
	assert.deepEqual(envelopeInsideJobPaths(join(runs, "a", "env.json"), { runRoots: [kernelMissing] }), { kind: "run-root", path: kernelMissing });
	// Skipped only when no reading exists.
	assert.equal(envelopeInsideJobPaths(join(runs, "env.json"), { runRoots: [join(root, "nope", "x")], skillsDirs: [`${join(runs, "env.json")}/sub`] }), null);
	// A failure other than "not there" is a configuration error naming the path.
	const eacces = () => {
		throw Object.assign(new Error("denied"), { code: "EACCES" });
	};
	const fake = fakeFs({ dirs: ["/srv", "/srv/locked"], files: ["/srv/env.json"] });
	const statSync = (p, o) => (p === "/srv/locked" ? eacces() : fake.statSync(p, o));
	assert.throws(() => envelopeInsideJobPaths("/srv/env.json", { runRoots: ["/srv/locked"] }, { ...fake, statSync }), (e) => e.piDispatchConfig === true && /a job path "\/srv\/locked" cannot be read \(EACCES\)/.test(e.message));
});

test("a relative job path is also judged against $PWD when it names the cwd through a symlink: the runtime CLI's Getwd", () => {
	// root/P/inner is the physical cwd; root/logical/cwd is a link to it, and the shell's $PWD. `./../y` is root/P/y to
	// process.cwd() but root/logical/y to Go's filepath.Abs, which is what `docker -v ./../y:/w` mounts.
	const root = tree("envelope-pwd-", { dirs: ["P/inner", "P/y", "logical/y"], files: ["P/y/env.json", "logical/y/env.json"] });
	const physical = join(root, "P", "inner");
	const pwd = join(root, "logical", "cwd");
	symlinkSync(physical, pwd);
	const inLogical = join(root, "logical", "y", "env.json");
	const inPhysical = join(root, "P", "y", "env.json");
	assert.deepEqual(envelopeInsideJobPaths(inLogical, { cronFolders: ["./../y"] }, { cwd: physical, env: { PWD: pwd } }), { kind: "cron-folder", path: "./../y" }, "the logical parent, through $PWD");
	assert.deepEqual(envelopeInsideJobPaths(inPhysical, { cronFolders: ["./../y"] }, { cwd: physical, env: { PWD: pwd } }), { kind: "cron-folder", path: "./../y" }, "and the physical one still");
	// Without $PWD, or with a $PWD that is not the cwd (Go then ignores it), only the physical reading counts.
	assert.equal(envelopeInsideJobPaths(inLogical, { cronFolders: ["./../y"] }, { cwd: physical, env: {} }), null);
	assert.equal(envelopeInsideJobPaths(inLogical, { cronFolders: ["./../y"] }, { cwd: physical, env: { PWD: join(root, "logical") } }), null);
	assert.equal(envelopeInsideJobPaths(inLogical, { cronFolders: ["./../y"] }, { cwd: physical, env: { PWD: "relative/cwd" } }), null);
	assert.equal(envelopeInsideJobPaths(inLogical, { cronFolders: [join(root, "P", "y")] }, { cwd: physical, env: { PWD: pwd } }), null, "an absolute job path is not read against $PWD");
	assert.equal(envelopeInsideJobPaths(inLogical, { cronFolders: ["./../nope"] }, { cwd: physical, env: { PWD: pwd } }), null, "no reading exists: skipped");
});

test("with an envelope, a relative run root is refused, naming the entry; other relative job paths are judged, not refused", () => {
	const root = tree("envelope-relroot-", { dirs: ["ops"], files: ["ops/env.json"] });
	const env = join(root, "ops", "env.json");
	const isRefusal = (entry) => (e) => e.piDispatchConfig === true && e.message.includes(JSON.stringify(entry)) && /PI_DISPATCH_RUN_ROOTS is relative/.test(e.message);
	assert.throws(() => envelopeInsideJobPaths(env, { runRoots: [join(root, "runs"), "runs"] }), isRefusal("runs"));
	assert.throws(() => envelopeInsideJobPaths(env, { runRoots: ["./runs"] }), isRefusal("./runs"));
	assert.equal(envelopeInsideJobPaths(env, { runRoots: ["", null], cronFolders: ["./nope-relative"] }), null);
});

/**
 * A fake filesystem with symlinks and FIRMLINKS (a second name of a directory, as macOS's /System/Volumes/Data/Users is
 * of /Users, or a bind-mount alias): `stat` follows both and reports one identity, while `realpath` keeps the
 * firmlink's spelling, as `realpathSync.native` does there. Paths resolve the kernel's way: a link is followed before
 * a `..` that comes after it.
 */
function fakeFs({ dirs = [], files = [], symlinks = {}, firmlinks = {} }) {
	const all = ["/", ...dirs, ...files];
	const ids = new Map(all.map((p, i) => [p, BigInt(i + 1)]));
	const enoent = () => {
		throw Object.assign(new Error("no such file"), { code: "ENOENT" });
	};
	function walk(path) {
		let head = null;
		let rest = path;
		for (const [alias, canon] of Object.entries(firmlinks)) {
			if (path === alias || path.startsWith(`${alias}/`)) {
				head = { alias, canon };
				rest = canon + path.slice(alias.length);
			}
		}
		let current = "/";
		for (const seg of rest.split("/")) {
			if (seg === "" || seg === ".") continue;
			current = seg === ".." ? (current === "/" ? "/" : current.slice(0, current.lastIndexOf("/")) || "/") : current === "/" ? `/${seg}` : `${current}/${seg}`;
			while (symlinks[current] !== undefined) current = symlinks[current];
			if (!ids.has(current)) enoent();
		}
		return { current, head };
	}
	return {
		statSync: (path) => {
			const { current } = walk(path);
			return { dev: 1n, ino: ids.get(current), nlink: 1n, isFile: () => files.includes(current) };
		},
		realpathSync: (path) => {
			const { current, head } = walk(path);
			return head && (current === head.canon || current.startsWith(`${head.canon}/`)) ? head.alias + current.slice(head.canon.length) : current;
		},
	};
}

test("containment is judged by identity (device and inode): a firmlink or bind alias of a job path is the same directory", () => {
	const fs = fakeFs({
		dirs: ["/Users", "/Users/rob", "/Users/rob/runs", "/Users/rob/ops", "/Users/rob/P", "/Users/rob/P/inner", "/Users/rob/P/y", "/Users/rob/logical", "/Users/rob/logical/y", "/System", "/System/Volumes", "/System/Volumes/Data"],
		files: ["/Users/rob/runs/env.json", "/Users/rob/ops/env.json", "/Users/rob/logical/y/env.json"],
		symlinks: { "/Users/rob/logical/cwd": "/Users/rob/P/inner" },
		firmlinks: { "/System/Volumes/Data/Users": "/Users" },
	});
	assert.notEqual(fs.realpathSync("/System/Volumes/Data/Users/rob/runs"), fs.realpathSync("/Users/rob/runs"), "the fake's realpath keeps the alias spelling, as the host's does");
	// An absolute job path spelled through the alias names the run root that holds the envelope.
	assert.deepEqual(envelopeInsideJobPaths("/Users/rob/runs/env.json", { runRoots: ["/System/Volumes/Data/Users/rob/runs"] }, { ...fs, cwd: "/Users/rob/ops", env: {} }), { kind: "run-root", path: "/System/Volumes/Data/Users/rob/runs" });
	assert.equal(envelopeInsideJobPaths("/Users/rob/ops/env.json", { runRoots: ["/System/Volumes/Data/Users/rob/runs"] }, { ...fs, cwd: "/Users/rob/ops", env: {} }), null, "and only that one");
	// $PWD spelled through the alias and a symlink has the cwd's identity, so Go uses it: `./../y` mounts logical/y.
	const env = { PWD: "/System/Volumes/Data/Users/rob/logical/cwd" };
	assert.notEqual(fs.realpathSync(env.PWD), fs.realpathSync("/Users/rob/P/inner"), "a realpath string compare would drop this $PWD");
	assert.deepEqual(envelopeInsideJobPaths("/Users/rob/logical/y/env.json", { cronFolders: ["./../y"] }, { ...fs, cwd: "/Users/rob/P/inner", env }), { kind: "cron-folder", path: "./../y" });
	assert.equal(envelopeInsideJobPaths("/Users/rob/logical/y/env.json", { cronFolders: ["./../y"] }, { ...fs, cwd: "/Users/rob/P/inner", env: { PWD: "/System/Volumes/Data/Users/rob/ops" } }), null, "a $PWD with another identity adds nothing");
});
