import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_ADDRESSES, parseModelEndpoints } from "../src/model-endpoints.mjs";
import {
	EMPTY_PRIVATE_ENDPOINTS,
	GRANT_ACL_TYPE,
	GRANT_HELPER_TARGET,
	GRANTS_TARGET,
	PRIVATE_ENDPOINTS_VERSION,
	PRIVATE_INCLUDE_HEADER,
	REFUSED_PRIVATE_PORTS,
	endpointsOverlap,
	loadPrivateEndpoints,
	parsePrivateEndpoints,
	privateEndpointsPath,
	privateFolderInsideJobPathSentence,
	privateFoldersInsideJobPaths,
	renderPrivateInclude,
} from "../src/private-endpoints.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const tmp = () => tempDir("pi-private-endpoints-");
const wrap = (endpoints, version = 1) => JSON.stringify({ version, endpoints });
const parse = (endpoints, opts) => parsePrivateEndpoints(wrap(endpoints), "pe.json", opts);
const ep = (over = {}) => ({ id: "bench-device", host: "10.0.5.20", port: 22, ...over });
const HELPER = new URL("../../deploy/egress-endpoint-grant", import.meta.url);

// ── parse ──────────────────────────────────────────────────────────────────────────────────────────────

test("parsePrivateEndpoints normalises an endpoint; slots is optional and null when absent", () => {
	assert.deepEqual(parse([ep()]), [{ id: "bench-device", host: "10.0.5.20", port: 22, slots: null }]);
	assert.equal(parse([ep({ slots: 1 })])[0].slots, 1);
	assert.deepEqual(parse([]), []);
	assert.equal(PRIVATE_ENDPOINTS_VERSION, 1);
	assert.deepEqual(parsePrivateEndpoints(EMPTY_PRIVATE_ENDPOINTS, "pe.json"), [], "the scaffold parses");
});

test("parsePrivateEndpoints canonicalises hosts as model endpoints do (lower case, bracketed IPv6)", () => {
	assert.equal(parse([ep({ host: "Bench.LAN" })])[0].host, "bench.lan");
	assert.equal(parse([ep({ host: "fd00:0::2" })])[0].host, "[fd00::2]");
});

test("parsePrivateEndpoints refuses ports 80 and 443, naming why", () => {
	assert.deepEqual(REFUSED_PRIVATE_PORTS, [80, 443]);
	for (const port of REFUSED_PRIVATE_PORTS) {
		assert.throws(() => parse([ep({ port })]), (e) => e.piDispatchConfig === true && /cannot be private/.test(e.message) && /allowlist opens ports 80 and 443/.test(e.message));
	}
});

test("parsePrivateEndpoints refuses what a model endpoint refuses", () => {
	const refused = [
		[{ host: "localhost" }, /loopback/],
		[{ host: "127.0.0.1" }, /loopback/],
		[{ host: "bench.lan." }, /ends in a dot: write it without the dot/],
		[{ host: "bench.lan:22" }, /carries a port/],
		[{ port: 3128 }, /egress proxy's own port/],
		[{ port: 0 }, /port must be an integer/],
		[{ port: 70000 }, /port must be an integer/],
		[{ id: "Bench" }, /id must be/],
		[{ slots: 0 }, /slots must be an integer/],
		[{ slots: 65 }, /slots must be an integer/],
		[{ keyless: true }, /unknown key\(s\) "keyless"/],
	];
	for (const [over, re] of refused) assert.throws(() => parse([ep(over)]), re, JSON.stringify(over));
	assert.throws(() => parse([ep({ port: 6379 })], { valkeyPort: 6379 }), /job queue's/);
	assert.doesNotThrow(() => parse([ep({ port: 6379 })]));
});

test("parsePrivateEndpoints refuses a trailing dot without naming models.json", () => {
	assert.throws(() => parse([ep({ host: "bench.lan." })]), (e) => !/baseUrl|models\.json/.test(e.message));
});

test("parsePrivateEndpoints refuses duplicate ids, a duplicate pair, a newer file and unknown file keys", () => {
	assert.throws(() => parse([ep(), ep({ host: "10.0.5.21" })]), /duplicate id "bench-device"/);
	assert.throws(() => parse([ep(), ep({ id: "other" })]), /already declared as "bench-device"/);
	assert.throws(() => parsePrivateEndpoints(wrap([], 2), "pe.json"), /written by a newer pi-dispatch \(version 2; this build understands 1\)/);
	assert.throws(() => parsePrivateEndpoints(JSON.stringify({ version: 1, endpoints: [], extra: 1 }), "pe.json"), /unknown key\(s\) "extra"/);
	assert.throws(() => parsePrivateEndpoints("{", "pe.json"), /not valid JSON/);
	assert.throws(() => parsePrivateEndpoints(wrap(Array.from({ length: 65 }, (_, i) => ep({ id: `d${i}`, port: 1000 + i }))), "pe.json"), /more than 64/);
});

// ── load ───────────────────────────────────────────────────────────────────────────────────────────────

test("loadPrivateEndpoints: a missing default file is none; a missing named file or an empty name is refused", () => {
	const dir = tmp();
	assert.deepEqual(loadPrivateEndpoints({}, { cwd: dir }), []);
	assert.throws(() => loadPrivateEndpoints({ privateEndpointsFile: "nope.json" }, { cwd: dir }), /does not exist/);
	assert.throws(() => loadPrivateEndpoints({ privateEndpointsFile: "" }, { cwd: dir }), /set to an empty value/);
	writeFileSync(join(dir, "private-endpoints.json"), wrap([ep()]));
	assert.equal(loadPrivateEndpoints({}, { cwd: dir })[0].id, "bench-device");
	assert.deepEqual(privateEndpointsPath({ privateEndpointsFile: "x/p.json" }, dir), { path: join(dir, "x/p.json"), explicit: true });
	assert.throws(() => loadPrivateEndpoints({ valkeyUrl: "redis://127.0.0.1:22" }, { cwd: dir }), /job queue's/, "the queue's port comes from VALKEY_URL");
});

// ── across the two files ───────────────────────────────────────────────────────────────────────────────

test("endpointsOverlap refuses an id or a host and port in both files, and passes disjoint ones", () => {
	const model = parseModelEndpoints(JSON.stringify({ version: 1, endpoints: [{ id: "mac-ollama", host: "10.0.5.20", port: 11434, slots: 1 }] }), "me.json");
	assert.deepEqual(endpointsOverlap(model, parse([ep()])), []);
	assert.match(endpointsOverlap(model, parse([ep({ id: "mac-ollama" })]))[0], /both as a model endpoint and as a private endpoint/);
	assert.match(endpointsOverlap(model, parse([ep({ port: 11434 })]))[0], /both as model endpoint "mac-ollama", which every job may reach, and as private endpoint "bench-device"/);
});

// ── the include ────────────────────────────────────────────────────────────────────────────────────────

const DECLARED = [ep({ id: "zz-last", host: "fd00::2", port: 2222 }), ep({ slots: 1 }), ep({ id: "lab", host: "lab.lan", port: 8022 })];
const block = (id, host, port) => [
	"",
	`# ${id}`,
	`acl ppe_${id}_host dstdomain -n ${host}`,
	`acl ppe_${id}_port port ${port}`,
	`acl ppe_${id}_local dst ${LOCAL_ADDRESSES}`,
	`acl ppe_${id}_grant external pi_grant ${id}`,
	`http_access deny ppe_${id}_host ppe_${id}_port ppe_${id}_local`,
	`http_access allow CONNECT ppe_${id}_host ppe_${id}_port ppe_${id}_grant`,
	`http_access deny ppe_${id}_host ppe_${id}_port`,
];
const GOLDEN = `${[PRIVATE_INCLUDE_HEADER, "", GRANT_ACL_TYPE, ...block("bench-device", "10.0.5.20", 22), ...block("lab", "lab.lan", 8022), ...block("zz-last", "[fd00::2]", 2222)].join("\n")}\n`;

test("renderPrivateInclude: golden, sorted by id, the type defined once and first", () => {
	assert.equal(renderPrivateInclude(parse(DECLARED)), GOLDEN);
	assert.equal(renderPrivateInclude(parse([...DECLARED].reverse())), GOLDEN, "file order does not matter");
	const text = renderPrivateInclude(parse(DECLARED));
	assert.equal(text.split("external_acl_type").length - 1, 1, "one definition: squid silently keeps the first of two");
	assert.ok(text.indexOf("external_acl_type") < text.indexOf(" external pi_grant "), "defined before any use, or squid's parse dies");
});

test("renderPrivateInclude of no endpoints is the header alone and defines no helper", () => {
	assert.equal(renderPrivateInclude([]), `${PRIVATE_INCLUDE_HEADER}\n`);
	assert.doesNotMatch(renderPrivateInclude([]), /external_acl_type/);
});

test("the helper type stores no answer and starts no helper before it is needed (pinned: either value brings back a fault)", () => {
	// cache=0 with ttl=0 and negative_ttl=0: squid 6.13 stores nothing, so no answer outlives its grant (external_acl.cc
	// maybeCacheable). children-startup=0: the "helpers crashing too rapidly" FATAL fires only below the startup count.
	for (const opt of ["ttl=0", "negative_ttl=0", "cache=0", "children-startup=0", "%>la"]) assert.match(GRANT_ACL_TYPE, new RegExp(`(^| )${opt}( |$)`), opt);
	assert.ok(GRANT_ACL_TYPE.endsWith(` ${GRANT_HELPER_TARGET}`));
});

test("renderPrivateInclude refuses anything that is not parser output", () => {
	assert.throws(() => renderPrivateInclude([{ id: "a\nb", host: "x", port: 22 }]), /bad id/);
	assert.throws(() => renderPrivateInclude([{ id: "a", host: "x y", port: 22 }]), /bad host/);
	assert.throws(() => renderPrivateInclude([{ id: "a", host: "x", port: 443 }]), /bad port/);
	assert.throws(() => renderPrivateInclude([{ id: "a", host: "x", port: 3128 }]), /bad port/);
});

// ── the shipped helper, run by bash as squid runs it ───────────────────────────────────────────────────

/** Run the shipped helper with its grants folder at `dir`: the script's fixed path rewritten, nothing else. */
function runHelper(dir, input) {
	const script = readFileSync(HELPER, "utf8");
	assert.match(script, new RegExp(`^grants=${GRANTS_TARGET}$`, "m"), "the helper reads the folder the proxy mounts");
	const res = spawnSync("bash", ["-c", script.replace(`grants=${GRANTS_TARGET}`, `grants=${dir}`)], { input, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	return res.stdout.split("\n").filter((l, i, all) => i < all.length - 1);
}

test("the shipped helper is executable bash and answers OK only for a granted id at that address", () => {
	assert.equal(statSync(HELPER).mode & 0o111, 0o111, "mode 0755: squid execs it");
	assert.match(readFileSync(HELPER, "utf8"), /^#!\/bin\/bash\n/);
	const dir = tmp();
	writeFileSync(join(dir, "192.168.148.2"), "network pi-job-a-net\nbench-device\nlab\n");
	writeFileSync(join(dir, "fd07:b51a:cc66:d000::2"), "network pi-job-a-net\nbench-device\n");
	assert.deepEqual(
		runHelper(dir, ["192.168.148.2 bench-device", "192.168.148.2 lab", "192.168.148.2 other", "192.168.155.2 bench-device", "fd07:b51a:cc66:d000::2 bench-device", "192.168.148.2 network"].join("\n") + "\n"),
		["OK", "OK", "ERR", "ERR", "OK", "ERR"],
	);
});

test("the shipped helper answers ERR for malformed input, a symlink, a folder, and past its 16-line read", () => {
	const dir = tmp();
	writeFileSync(join(dir, "10.0.0.3"), "network n\nbench-device\n");
	symlinkSync(join(dir, "10.0.0.3"), join(dir, "10.0.0.4"));
	mkdirSync(join(dir, "10.0.0.5"));
	writeFileSync(join(dir, "10.0.0.6"), `${Array.from({ length: 16 }, (_, i) => `x${i}`).join("\n")}\nbench-device\n`);
	const lines = ["../10.0.0.3 bench-device", "10.0.0.3 BENCH", "10.0.0.3 bench-device extra", "", "%2e%2e bench-device", "10.0.0.4 bench-device", "10.0.0.5 bench-device", "10.0.0.6 bench-device", "10.0.0.3/x bench-device", "10.0.0.3 bench-device"];
	assert.deepEqual(runHelper(dir, `${lines.join("\n")}\n`), ["ERR", "ERR", "ERR", "ERR", "ERR", "ERR", "ERR", "ERR", "ERR", "OK"]);
});

// ── where the folders lie ──────────────────────────────────────────────────────────────────────────────

test("privateFoldersInsideJobPaths judges each mounted leaf by its real path, sets a relative run root aside, refuses a symlink, and names the first a job can see", { skip: process.platform === "win32" }, () => {
	const dir = tmp();
	mkdirSync(join(dir, "egress-private"));
	mkdirSync(join(dir, "egress-grants", "local"), { recursive: true });
	const asked = [];
	const jobPaths = { cronFolders: ["/srv/jobs"], runRoots: ["/abs/root", "relative/root"] };
	const none = privateFoldersInsideJobPaths(dir, jobPaths, { inside: (path, paths, opts) => (asked.push([path, paths, opts]), null), realpath: (p) => `/real${p}` });
	assert.equal(none, null);
	assert.deepEqual(asked.map(([path]) => path), [`/real${join(dir, "egress-private")}`, `/real${join(dir, "egress-grants", "local")}`], "each existing leaf the proxy mounts; podman's is not there");
	assert.ok(asked.every(([, paths, opts]) => paths.cronFolders === jobPaths.cronFolders && opts.directory === true), "judged as folders");
	assert.deepEqual(asked[0][1].runRoots, ["/abs/root"], "a relative run root is set aside, as doctor and prepare-local do");
	const found = privateFoldersInsideJobPaths(dir, jobPaths, { inside: (path) => (path.endsWith(join("egress-grants", "local")) ? { kind: "cron-folder", path: "/srv/jobs" } : null), realpath: (p) => p });
	assert.deepEqual(found, { folder: "egress-grants/local", kind: "cron-folder", path: "/srv/jobs" });
	assert.match(privateFolderInsideJobPathSentence(found), /^egress-grants\/local\/ in the deployment folder lies inside a job path \(cron-folder "\/srv\/jobs"\) that a job container can see, so a job could grant itself any private endpoint;/);
	assert.match(privateFolderInsideJobPathSentence({ ...found, folder: "egress-private" }), /could replace the grant helper the egress proxy runs/);
	const linked = tmp();
	symlinkSync(tmp(), join(linked, "egress-private"));
	assert.deepEqual(privateFoldersInsideJobPaths(linked, jobPaths, { inside: () => assert.fail("a link is refused before it is resolved") }), { folder: "egress-private", link: true });
	assert.match(privateFolderInsideJobPathSentence({ folder: "egress-private", link: true }), /is a symlink, which whoever can write where the link lives could point elsewhere/);
	assert.equal(privateFoldersInsideJobPaths(tmp(), jobPaths, { inside: () => assert.fail("a folder that does not exist is not asked about") }), null);
	// A linked egress-grants/ is refused as itself: lstat of a leaf under it follows it.
	const parent = tmp();
	const target = tmp();
	mkdirSync(join(target, "local"));
	symlinkSync(target, join(parent, "egress-grants"));
	assert.deepEqual(privateFoldersInsideJobPaths(parent, jobPaths, { inside: () => assert.fail("a link is refused before it is resolved") }), { folder: "egress-grants", link: true });
});

test("privateFoldersInsideJobPaths finds a real cron folder at the deployment folder, through the real containment rule", { skip: process.platform === "win32" }, () => {
	const dir = realpathSync(tmp());
	mkdirSync(join(dir, "egress-grants", "local"), { recursive: true });
	assert.deepEqual(privateFoldersInsideJobPaths(dir, { cronFolders: [dir] }), { folder: "egress-grants/local", kind: "cron-folder", path: dir });
	assert.equal(privateFoldersInsideJobPaths(dir, { cronFolders: [realpathSync(tmp())] }), null, "a job path beside it holds nothing");
});

test("doctor's private endpoints line refuses what the boot refuses: an id in both files, the model file as the SERVICE reads it from .env", async () => {
	const { BOOT_FILES } = await import("../src/doctor.mjs");
	const row = BOOT_FILES.find((spec) => spec.key === "PI_PRIVATE_ENDPOINTS_FILE");
	const dir = tmp();
	writeFileSync(join(dir, ".env"), "PI_MODEL_ENDPOINTS_FILE=elsewhere/m.json\n");
	mkdirSync(join(dir, "elsewhere"));
	writeFileSync(join(dir, "elsewhere", "m.json"), JSON.stringify({ version: 1, endpoints: [{ id: "bench-device", host: "10.9.9.9", port: 11434, slots: 1 }] }));
	writeFileSync(join(dir, "private-endpoints.json"), wrap([ep()]));
	const io = { cwd: dir, readFileSync, existsSync: (p) => { try { statSync(p); return true; } catch { return false; } } };
	assert.throws(() => row.load(join(dir, "private-endpoints.json"), io, {}), /model-endpoints and private-endpoints disagree: id "bench-device" is declared both/);
	writeFileSync(join(dir, ".env"), "\n");
	assert.equal(row.load(join(dir, "private-endpoints.json"), io, {}).length, 1, "the default model file is absent: nothing to disagree with");
});
